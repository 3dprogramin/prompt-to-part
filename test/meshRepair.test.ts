import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { dropBadTriangles, edgePartners, fillHoles, repairMesh } from '../shared/meshRepair';
import type { RawMesh } from '../shared/meshFormats';

const wasm = await Module();
wasm.setup();

const raw = (positions: number[] | Float32Array, indices: number[] | Uint32Array): RawMesh =>
  ({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices), format: '3mf', up: 'z', mmPerUnit: 1, warnings: [] });

/** A box from (x, y, z) of the given size, 8 vertices from `base` on, outward. */
function box(p: number[], t: number[], [x, y, z]: number[], [sx, sy, sz]: number[]) {
  const b = p.length / 3;
  for (let k = 0; k < 8; k++) p.push(x + (k & 1 ? sx : 0), y + (k & 2 ? sy : 0), z + (k & 4 ? sz : 0));
  for (const [a, c, d, e] of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) t.push(b + a, b + c, b + d, b + a, b + d, b + e);
}

/** A cone of n segments (radius 20) around the apex (vertex 0), open at the base. */
function cone(n: number, height = 60) {
  const pos = new Float32Array((n + 1) * 3);
  pos[2] = height;
  for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; pos[(i + 1) * 3] = 20 * Math.cos(a); pos[(i + 1) * 3 + 1] = 20 * Math.sin(a); }
  const t: number[] = [];
  for (let i = 0; i < n; i++) { const a = i + 1, b = ((i + 1) % n) + 1; t.push(0, a, b); }
  return { pos, tris: Uint32Array.from(t) };
}

// The pairwise versions these replaced (quadratic at a busy vertex), to check the results match.
function bucketBy(nv: number, n: number, key: (i: number) => number) {
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < n; i++) start[key(i) + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv), items = new Uint32Array(n);
  for (let i = 0; i < n; i++) items[fill[key(i)]++] = i;
  return { start, items };
}
function oldPartners(nv: number, tris: Uint32Array) {
  const eu = (e: number) => tris[e], ev = (e: number) => tris[e - (e % 3) + ((e % 3) + 1) % 3];
  const { start, items } = bucketBy(nv, tris.length, (e) => Math.min(eu(e), ev(e)));
  const partner = new Int32Array(tris.length).fill(-1);
  let open = 0, nonManifold = 0;
  for (let v = 0; v < nv; v++) for (let i = start[v]; i < start[v + 1]; i++) {
    const a = items[i], other = Math.max(eu(a), ev(a));
    let found = -1, n = 1, first = true;
    for (let j = start[v]; j < start[v + 1]; j++) {
      const b = items[j];
      if (j === i || Math.max(eu(b), ev(b)) !== other) continue;
      n++;
      if (found === -1) found = b;
      if (j < i) first = false;
    }
    if (n === 2) partner[a] = found; else if (n === 1) open++; else if (first) nonManifold++;
  }
  return { partner, open, nonManifold };
}
function oldDrop(pos: Float32Array, tris: Uint32Array, nv: number) {
  const nt = tris.length / 3, drop = new Uint8Array(nt);
  let degenerate = 0, duplicate = 0, internal = 0;
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = tris.subarray(t * 3, t * 3 + 3);
    const u = [0, 1, 2].map((k) => pos[b * 3 + k] - pos[a * 3 + k]), w = [0, 1, 2].map((k) => pos[c * 3 + k] - pos[a * 3 + k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    if (a === b || b === c || a === c || n[0] ** 2 + n[1] ** 2 + n[2] ** 2 <= 0) { drop[t] = 1; degenerate++; }
  }
  const { start, items } = bucketBy(nv, nt, (t) => Math.min(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]));
  const sorted = (t: number) => {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2], m = Math.min(a, b, c);
    const [p, q] = m === a ? [b, c] : m === b ? [c, a] : [a, b];
    return p < q ? { lo: p, hi: q, rev: false } : { lo: q, hi: p, rev: true };
  };
  for (let v = 0; v < nv; v++) for (let i = start[v]; i < start[v + 1]; i++) {
    const ti = items[i];
    if (drop[ti]) continue;
    const a = sorted(ti);
    for (let j = i + 1; j < start[v + 1]; j++) {
      const tj = items[j];
      if (drop[tj]) continue;
      const b = sorted(tj);
      if (a.lo !== b.lo || a.hi !== b.hi) continue;
      if (a.rev === b.rev) { drop[tj] = 1; duplicate++; } else { drop[ti] = 1; drop[tj] = 1; internal += 2; break; }
    }
  }
  const out: number[] = [];
  for (let t = 0; t < nt; t++) if (!drop[t]) out.push(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]);
  return { tris: out, degenerate, duplicate, internal };
}

test('duplicate, back-to-back and shared-edge checks hash busy vertices with the same results as pairwise', () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let round = 0; round < 40; round++) {
    // Few vertices and many triangles: low vertices get buckets of dozens (the hashed path), with
    // repeats, reversed copies and edges shared by three or more.
    const nv = 6 + rnd(20), nt = 20 + rnd(300);
    const pos = new Float32Array(nv * 3).map(() => rnd(1000) / 10);
    const t: number[] = [];
    for (let i = 0; i < nt; i++) {
      if (t.length && rnd(3) === 0) { const k = 3 * rnd(t.length / 3); const [a, b, c] = t.slice(k, k + 3); t.push(...(rnd(2) ? [b, c, a] : [a, c, b])); } else t.push(rnd(nv), rnd(nv), rnd(nv));
    }
    const tris = Uint32Array.from(t);
    const got = dropBadTriangles(pos, tris, 0);
    const want = oldDrop(pos, tris, nv);
    assert.deepEqual({ ...got, tris: [...got.tris] }, want, `round ${round}`);
    const p = edgePartners(nv, tris), q = oldPartners(nv, tris);
    assert.deepEqual({ ...p, partner: [...p.partner] }, { ...q, partner: [...q.partner] }, `round ${round}`);
  }
  // Holes next to a busy apex (80 edges in its bucket) are found and capped (a tall cone, so a
  // cap through the apex is still small next to the surface).
  const { pos, tris } = cone(40, 200);
  const capped = (t: Uint32Array) => {
    const f = fillHoles(pos, t);
    if (!f) return null;
    const after = edgePartners(f.positions.length / 3, f.tris);
    assert.deepEqual([after.open, after.nonManifold], [0, 0]);
    return [f.holes, f.edges];
  };
  assert.deepEqual(capped(tris), [1, 40]);
  // One fan triangle gone: the rim runs through the apex.
  assert.deepEqual(capped(tris.slice(3)), [1, 41]);
  // Two gone: two open edges leave the apex, which isn't a simple loop.
  assert.equal(capped(Uint32Array.from([...tris.slice(3, 60), ...tris.slice(63)])), null);
});

test('a fan of 200,000 triangles round one vertex repairs in seconds, not hours', () => {
  const { pos, tris } = cone(200_000);
  const t0 = performance.now();
  const r = repairMesh(wasm, raw(pos, tris), { maxTriangles: 1e6 });
  const ms = performance.now() - t0;
  assert.match(r.report.repairs.join('\n'), /Closed 1 hole/);
  assert.ok(Math.abs(r.report.volume - (Math.PI * 400 * 60) / 3) < 1, `${r.report.volume}`);
  assert.ok(ms < 10_000, `${Math.round(ms)} ms`);
});

test('a tiny thin piece keeps its shells; specks next to it still go', () => {
  // 3.2 x 3.2 x 0.04 mm is 0.41 mm³, under the 0.5 mm³ speck floor.
  const p: number[] = [], t: number[] = [];
  box(p, t, [0, 0, 0], [3.2, 3.2, 0.04]);
  const tag = repairMesh(wasm, raw(p, t)).report;
  assert.ok(Math.abs(tag.volume - 0.4096) < 1e-3, `${tag.volume}`);
  assert.equal(tag.components, 1);
  assert.doesNotMatch(tag.repairs.join('\n'), /Removed/);
  // Two equal tiny pieces both stay; a much smaller one beside them goes.
  box(p, t, [5, 0, 0], [3.2, 3.2, 0.04]);
  box(p, t, [10, 0, 0], [0.1, 0.1, 0.04]);
  const pair = repairMesh(wasm, raw(p, t)).report;
  assert.equal(pair.components, 2);
  assert.match(pair.repairs.join('\n'), /Removed 1 loose fragment smaller than 0\.20 mm³/);
});
