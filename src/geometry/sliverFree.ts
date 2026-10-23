import * as THREE from 'three';

/** Points closer than this (mm) are one in the view. */
const WELD = 5e-4;
/** A triangle lower than this (mm) over its longest side has no area to show. */
const FLAT = 1e-5;

/**
 * A mesh as the view draws it, without slivers: the booleans that make a part leave triangles of
 * no area in it (points a fraction of a micron apart, or three on a line) that keep the mesh
 * closed, but have no direction to shade or outline by (in the view's 32-bit points they turned
 * every way, drawn as stripes and lines). Points closer than WELD are merged; a triangle with
 * three points on a line goes, the one beside its long side split at the middle point, so the
 * mesh stays closed. Only for a plain mesh (positions and an index, no colours).
 */
export function sliverFree(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geom.getAttribute('position'), index = geom.getIndex();
  if (!index || geom.getAttribute('color')) return geom;
  // Merged points.
  const id = new Map<string, number>(), xyz: number[] = [], map = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.round(x / WELD)},${Math.round(y / WELD)},${Math.round(z / WELD)}`;
    let v = id.get(k);
    if (v === undefined) { v = xyz.length / 3; id.set(k, v); xyz.push(x, y, z); }
    map[i] = v;
  }
  const P = (v: number, j: number) => xyz[3 * v + j];
  const tris: number[][] = [];
  for (let t = 0; t + 2 < index.count; t += 3) {
    const f = [map[index.getX(t)], map[index.getX(t + 1)], map[index.getX(t + 2)]];
    if (f[0] !== f[1] && f[1] !== f[2] && f[2] !== f[0]) tris.push(f);
  }
  // Each directed edge's triangle, to find the one beside a flat one.
  const edge = (a: number, b: number) => a * 0x4000000 + b;
  const at = new Map<number, number>();
  const add = (t: number) => { const f = tris[t]; for (let j = 0; j < 3; j++) at.set(edge(f[j], f[(j + 1) % 3]), t); };
  const drop = (t: number) => { const f = tris[t]; for (let j = 0; j < 3; j++) if (at.get(edge(f[j], f[(j + 1) % 3])) === t) at.delete(edge(f[j], f[(j + 1) % 3])); };
  tris.forEach((_, t) => add(t));
  const len = (a: number, b: number) => Math.hypot(P(a, 0) - P(b, 0), P(a, 1) - P(b, 1), P(a, 2) - P(b, 2));
  const flat = (f: number[]) => {
    const u = [0, 1, 2].map((j) => P(f[1], j) - P(f[0], j)), w = [0, 1, 2].map((j) => P(f[2], j) - P(f[0], j));
    const c = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
    const longest = Math.max(len(f[0], f[1]), len(f[1], f[2]), len(f[2], f[0]));
    return c / longest < FLAT;
  };
  const gone = new Set<number>();
  let todo = tris.map((_, t) => t).filter((t) => flat(tris[t]));
  for (let pass = 0; todo.length && pass < 50; pass++) {
    const left: number[] = [];
    for (const t of todo) {
      if (gone.has(t)) continue;
      const f = tris[t];
      // Its middle point: the one across its longest side (a → c, the side the neighbour shares as c → a).
      let j = 0, most = -1;
      for (let i = 0; i < 3; i++) { const l = len(f[(i + 1) % 3], f[(i + 2) % 3]); if (l > most) { most = l; j = i; } }
      const b = f[j], c = f[(j + 1) % 3], a = f[(j + 2) % 3];
      const n = at.get(edge(a, c));
      // (Its side shared with nothing, or with another flat one first: later.)
      if (n === undefined || n === t || gone.has(n)) { left.push(t); continue; }
      const g = tris[n], k = g.indexOf(a), x = g[(k + 2) % 3];
      if (g[(k + 1) % 3] !== c) { left.push(t); continue; }
      drop(t); drop(n); gone.add(t); gone.add(n);
      const s1 = tris.push([a, b, x]) - 1, s2 = tris.push([b, c, x]) - 1;
      add(s1); add(s2);
      for (const s of [s1, s2]) if (flat(tris[s])) left.push(s);
    }
    if (left.length === todo.length) break;
    todo = left;
  }
  const out: number[] = [];
  tris.forEach((f, t) => { if (!gone.has(t) && !flat(f)) out.push(...f); });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
  g.setIndex(out);
  return g;
}
