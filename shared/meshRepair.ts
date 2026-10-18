// Turning a mesh file into a printable solid: units and up axis, welding, dropping broken
// triangles, consistent orientation, then Manifold. A mesh that still isn't a closed surface
// (holes, non-manifold edges, overlapping shells) is rebuilt as a watertight solid from a signed
// distance grid (inside/outside by rays along three axes, a majority vote) with Manifold.levelSet.
// Very heavy meshes are simplified, and the result stands on z = 0, centred in X and Y. A coloured
// mesh's colours (one per triangle) are carried over to the repaired triangles, each taking the
// colour of the nearest point of the original surface.
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { RawMesh } from './meshFormats';
import type { MeshData } from './meshes';
import type { Vec3 } from './types';

export interface ImportOptions {
  /** Most triangles kept (heavier meshes are simplified). */
  maxTriangles?: number;
  /** Longest side (mm) for a file without usable units (glTF and OBJ from AI tools are 1–2 units across). */
  defaultHeight?: number;
  /** Grid cells along the longest side when a mesh has to be rebuilt. */
  resolution?: number;
  /** Rebuild it on the grid even if it could be repaired (self-intersecting meshes; tests). */
  rebuild?: boolean;
  /** Keep the file's colours (glTF base colour), one per triangle of the result. */
  colors?: boolean;
}

export interface ImportReport {
  format: string;
  inputTriangles: number;
  triangles: number;
  size: Vec3;
  volume: number;
  components: number;
  /** What was done to the mesh, in words, for Claude and the user. */
  repairs: string[];
  rebuilt: boolean;
  timeMs: number;
  /** Milliseconds per stage. */
  stages: Record<string, number>;
  /** The result has a colour per triangle (MeshData.colors). */
  colored?: boolean;
}

export const DEFAULT_MAX_TRIANGLES = 200_000;
export const DEFAULT_HEIGHT = 80;
const DEFAULT_RESOLUTION = 160;
/** Most points in the rebuild grid (memory and time). */
const MAX_GRID_POINTS = 6_000_000;

const fmt = (n: number, d = 1) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(d));
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

export function repairMesh(wasm: ManifoldToplevel, raw: RawMesh, opts: ImportOptions = {}): { mesh: MeshData; report: ImportReport } {
  const t0 = performance.now();
  const stages: Record<string, number> = {};
  let tick = performance.now();
  const stage = (name: string) => { const now = performance.now(); stages[name] = Math.round(now - tick); tick = now; };
  const repairs: string[] = [...raw.warnings];
  const maxTriangles = opts.maxTriangles ?? DEFAULT_MAX_TRIANGLES;
  const inputTriangles = raw.indices.length / 3;

  // ---- units and up axis, so every tolerance below is in mm
  const pos = new Float32Array(raw.positions.length);
  const rawColors = opts.colors && raw.colors?.length === raw.indices.length ? raw.colors : undefined;
  if (opts.colors && !rawColors) repairs.push('The file has no colours: it prints in one');
  if (raw.up === 'y') {
    // Y-up (glTF, OBJ) to Z-up: their front (+Z) becomes Jig's front (−Y).
    for (let i = 0; i < pos.length; i += 3) { pos[i] = raw.positions[i]; pos[i + 1] = -raw.positions[i + 2]; pos[i + 2] = raw.positions[i + 1]; }
    repairs.push('Turned from Y-up to Z-up');
  } else pos.set(raw.positions);
  let tris = dropNonFinite(pos, raw.indices);
  if (tris.length < raw.indices.length) repairs.push(`Dropped ${count((raw.indices.length - tris.length) / 3, 'triangle')} with invalid coordinates`);
  let box = bounds(pos, tris);
  if (!box) throw new Error('The mesh has no usable triangles');
  const ext = (b: { min: Vec3; max: Vec3 }) => Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  let scale = raw.mmPerUnit ?? 1;
  const extentMm = ext(box) * scale;
  const height = opts.defaultHeight ?? DEFAULT_HEIGHT;
  if (raw.mmPerUnit === 1000 && extentMm >= 3 && extentMm <= 400) repairs.push(`Metres to millimetres (${fmt(extentMm)} mm across)`);
  else if (raw.mmPerUnit != null && raw.mmPerUnit !== 1000 && raw.mmPerUnit !== 1) repairs.push(`Converted to millimetres (×${raw.mmPerUnit})`);
  if (raw.format === 'glb' || raw.format === 'gltf' || raw.format === 'obj' ? extentMm < 3 || extentMm > 400 : extentMm < 3) {
    // No usable units: AI tools make models 1–2 units across, and an STL a few units across was
    // made in metres, inches or centimetres.
    scale = height / ext(box);
    repairs.push(`No usable units (${fmt(ext(box), 2)} units across): scaled so its longest side is ${height} mm`);
  }
  if (scale !== 1) for (let i = 0; i < pos.length; i++) pos[i] *= scale;
  box = bounds(pos, tris)!;
  const size = ext(box);
  stage('read');

  // ---- weld, then drop degenerate and duplicate triangles
  const welded = weld(pos, tris, size * 2 ** -17);
  // (An STL stores every triangle's corners separately, so welding it is no repair.)
  if (welded.merged && raw.format !== 'stl') repairs.push(`Welded ${count(welded.merged, 'duplicate vertex', 'duplicate vertices')}`);
  tris = welded.tris;
  const verts = welded.positions;
  const cleaned = dropBadTriangles(verts, tris, (size * 1e-7) ** 2);
  tris = cleaned.tris;
  if (cleaned.degenerate) repairs.push(`Dropped ${count(cleaned.degenerate, 'degenerate triangle')}`);
  if (cleaned.duplicate) repairs.push(`Dropped ${count(cleaned.duplicate, 'duplicate triangle')}`);
  if (cleaned.internal) repairs.push(`Dropped ${count(cleaned.internal, 'double-sided face')} (back-to-back pairs)`);
  stage('weld');

  // ---- consistent orientation, outward
  const orient = orientTriangles(verts, tris);
  if (orient.flipped) repairs.push(`Flipped ${count(orient.flipped, 'inside-out triangle')}`);
  stage('orient');

  // ---- a closed surface becomes a Manifold directly; anything else is rebuilt
  let solid: Manifold | null = null;
  let rebuilt = false;
  let cell = 0;
  const toManifold = (v: Float32Array, t: Uint32Array) => {
    try {
      const mesh = new wasm.Mesh({ numProp: 3, vertProperties: v, triVerts: t });
      mesh.merge();
      const m = new wasm.Manifold(mesh);
      return m.status() === 'NoError' && !m.isEmpty() ? m : null;
    } catch { return null; }
  };
  let shellsFlipped = 0;
  if (opts.rebuild) { /* straight to the rebuild below */ } else if (!orient.open && !orient.nonManifold) {
    shellsFlipped = orientShells(verts, tris);
    solid = toManifold(verts, tris);
  } else {
    // Keeping every detail where possible: shells that only touch along an edge or at a corner
    // are pulled apart (each keeps its own copy of the shared vertices), then holes with clean rims
    // (a missing patch, the open bottom of a scan) are capped. Anything still open is rebuilt below.
    const t2 = tris.slice();
    const split = splitVertices(verts, t2);
    const filled = fillHoles(split.positions, t2);
    // Closed now, so each shell's volume says which way it faces.
    shellsFlipped = orientShells(filled?.positions ?? split.positions, filled?.tris ?? t2);
    solid = toManifold(filled?.positions ?? split.positions, filled?.tris ?? t2);
    if (solid) {
      if (split.split) repairs.push(`Separated ${count(split.split, 'vertex', 'vertices')} where shells or holes only touch${orient.nonManifold ? ` (${count(orient.nonManifold, 'non-manifold edge')})` : ''}`);
      if (filled) repairs.push(`Closed ${count(filled.holes, 'hole')} (${count(filled.edges, 'open edge')})`);
    }
  }
  if (solid && shellsFlipped) repairs.push(`Turned ${count(shellsFlipped, 'inside-out shell')} the right way out`);
  stage('manifold');
  if (!solid) {
    const why = opts.rebuild ? 'it was asked for' : [orient.open && `${count(orient.open, 'open edge')} (holes)`, orient.nonManifold && `${count(orient.nonManifold, 'non-manifold edge')}`].filter(Boolean).join(' and ') || 'its faces don\'t agree on inside and outside';
    const cells = opts.resolution ?? DEFAULT_RESOLUTION;
    const r = rebuildSolid(wasm, verts, tris, cells);
    solid = r.solid;
    cell = r.cell;
    rebuilt = true;
    repairs.push(`Rebuilt as a watertight solid on a ${fmt(r.cell, 2)} mm grid, because of ${why}; details finer than about ${fmt(r.cell, 2)} mm are softened`);
    stage('rebuild');
  }

  // ---- loose specks go; overlapping shells (separately modelled eyes, horns…) become one solid
  const pieces = solid.decompose();
  const vols = pieces.map((p) => p.volume());
  const total = vols.reduce((s, v) => s + Math.max(0, v), 0);
  const keep = pieces.filter((_, i) => vols[i] < 0 || vols[i] >= Math.max(total * 1e-3, 0.5));
  const specks = pieces.length - keep.length;
  if (specks) repairs.push(`Removed ${count(specks, 'loose fragment')} smaller than ${fmt(Math.max(total * 1e-3, 0.5), 2)} mm³`);
  const shells = keep.filter((p) => p.volume() > 0).length;
  // A sealed cavity (negative volume) can't take part in a union of its own: then only recombine.
  if (shells > 1 && shells === keep.length) {
    solid = wasm.Manifold.union(keep);
    const after = solid.decompose().filter((p) => p.volume() > 0).length;
    if (after < shells) repairs.push(`Fused ${count(shells, 'overlapping shell')} into ${count(after, 'solid')}`);
  } else if (specks) solid = wasm.Manifold.compose(keep);
  stage('cleanup');

  // ---- simplify very heavy meshes (and the rebuild's dense grid surface)
  // The grid surface is dense and flat almost everywhere.
  if (rebuilt) solid = solid.simplify(cell * 0.12);
  const before = solid.numTri();
  if (before > maxTriangles) {
    let tol = size * 5e-5;
    let s = solid;
    for (let i = 0; i < 12 && s.numTri() > maxTriangles; i++, tol *= 1.8) s = solid.simplify(tol);
    solid = s;
    repairs.push(`Simplified from ${count(before, 'triangle')} to ${count(solid.numTri(), 'triangle')} (surface moved by under ${fmt(tol / 1.8, 3)} mm)`);
  }
  stage('simplify');

  // ---- on the bed, centred
  const bb = solid.boundingBox();
  solid = solid.translate([-(bb.min[0] + bb.max[0]) / 2, -(bb.min[1] + bb.max[1]) / 2, -bb.min[2]]);
  const out = solid.getMesh();
  const np = out.numProp;
  let positions: Float32Array;
  if (np === 3) positions = Float32Array.from(out.vertProperties);
  else {
    positions = new Float32Array((out.vertProperties.length / np) * 3);
    for (let v = 0; v < positions.length / 3; v++) for (let k = 0; k < 3; k++) positions[v * 3 + k] = out.vertProperties[v * np + k];
  }
  const indices = Uint32Array.from(out.triVerts);
  // Colours: each new triangle takes the colour of the original surface nearest to its centre.
  const colors = rawColors ? transferColors(pos, raw.indices, rawColors, positions, indices, [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, bb.min[2]]) : undefined;
  if (rawColors) stage('colors');
  const fb = solid.boundingBox();
  const report: ImportReport = {
    format: raw.format, inputTriangles, triangles: indices.length / 3,
    size: [fb.max[0] - fb.min[0], fb.max[1] - fb.min[1], fb.max[2] - fb.min[2]],
    volume: solid.volume(), components: solid.decompose().filter((p) => p.volume() > 0).length,
    repairs, rebuilt, timeMs: Math.round(performance.now() - t0), stages, ...(colors ? { colored: true } : {}),
  };
  stage('output');
  return { mesh: { positions, indices, ...(colors ? { colors } : {}) }, report };
}

/**
 * The colour of each triangle of the repaired mesh (`positions`/`indices`, moved by −`shift` from
 * where the original was): that of the original triangle nearest to its centre, found with a BVH
 * over the original triangles (each with corners of its own, so its index survives the BVH's
 * reordering of the triangles).
 */
export function transferColors(srcPos: Float32Array, srcTris: Uint32Array, srcColors: Uint8Array, positions: Float32Array, indices: Uint32Array, shift: Vec3 = [0, 0, 0]): Uint8Array {
  const keep: number[] = [];
  for (let t = 0; t < srcTris.length / 3; t++) {
    let ok = true;
    for (let k = 0; k < 9 && ok; k++) ok = Number.isFinite(srcPos[srcTris[3 * t + Math.floor(k / 3)] * 3 + (k % 3)]);
    if (ok) keep.push(t);
  }
  const out = new Uint8Array(indices.length);
  if (!keep.length) return out.fill(128);
  const soup = new Float32Array(keep.length * 9);
  keep.forEach((t, i) => { for (let k = 0; k < 9; k++) soup[i * 9 + k] = srcPos[srcTris[3 * t + Math.floor(k / 3)] * 3 + (k % 3)]; });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(soup, 3));
  g.setIndex(new BufferAttribute(Uint32Array.from({ length: keep.length * 3 }, (_, i) => i), 1));
  const bvh = new MeshBVH(g);
  const order = g.index!.array;
  const p = new Vector3();
  const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
  for (let t = 0; t < indices.length / 3; t++) {
    const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
    p.set((positions[a] + positions[b] + positions[c]) / 3 + shift[0], (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3 + shift[1], (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3 + shift[2]);
    const r = bvh.closestPointToPoint(p, hit as never) as typeof hit | null;
    const src = keep[r ? Math.floor(order[3 * r.faceIndex] / 3) : 0];
    out[3 * t] = srcColors[3 * src]; out[3 * t + 1] = srcColors[3 * src + 1]; out[3 * t + 2] = srcColors[3 * src + 2];
  }
  return out;
}

function bounds(pos: Float32Array, tris: Uint32Array): { min: Vec3; max: Vec3 } | null {
  if (!tris.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i++) {
    const v = tris[i] * 3;
    for (let k = 0; k < 3; k++) { const x = pos[v + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
  }
  return { min, max };
}

function dropNonFinite(pos: Float32Array, tris: Uint32Array): Uint32Array {
  const nv = pos.length / 3;
  const ok = (v: number) => v < nv && Number.isFinite(pos[v * 3]) && Number.isFinite(pos[v * 3 + 1]) && Number.isFinite(pos[v * 3 + 2]);
  const out = new Uint32Array(tris.length);
  let n = 0;
  for (let t = 0; t < tris.length; t += 3) {
    if (!ok(tris[t]) || !ok(tris[t + 1]) || !ok(tris[t + 2])) continue;
    out[n++] = tris[t]; out[n++] = tris[t + 1]; out[n++] = tris[t + 2];
  }
  return n === tris.length ? tris : out.slice(0, n);
}

/** Merges vertices closer than `eps` (snapped to a grid of that size). */
function weld(pos: Float32Array, tris: Uint32Array, eps: number): { positions: Float32Array; tris: Uint32Array; merged: number } {
  const nv = pos.length / 3;
  const used = new Uint8Array(nv);
  for (let i = 0; i < tris.length; i++) used[tris[i]] = 1;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (let v = 0; v < nv; v++) if (used[v]) { minX = Math.min(minX, pos[v * 3]); minY = Math.min(minY, pos[v * 3 + 1]); minZ = Math.min(minZ, pos[v * 3 + 2]); }
  // Keys stay below 2^53: under 2^17 steps per axis (eps is the size / 2^17).
  const K = 2 ** 17 + 2;
  const map = new Map<number, number>();
  const remap = new Uint32Array(nv);
  const out: number[] = [];
  let usedCount = 0;
  for (let v = 0; v < nv; v++) {
    if (!used[v]) continue;
    usedCount++;
    const qx = Math.round((pos[v * 3] - minX) / eps), qy = Math.round((pos[v * 3 + 1] - minY) / eps), qz = Math.round((pos[v * 3 + 2] - minZ) / eps);
    const key = (qx * K + qy) * K + qz;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      map.set(key, id);
      out.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    }
    remap[v] = id;
  }
  const t2 = new Uint32Array(tris.length);
  for (let i = 0; i < tris.length; i++) t2[i] = remap[tris[i]];
  return { positions: Float32Array.from(out), tris: t2, merged: usedCount - out.length / 3 };
}

/** Triangles grouped by their smallest vertex (a cheap stand-in for a hash of the triple). */
function bucketBy(nv: number, n: number, key: (i: number) => number): { start: Uint32Array; items: Uint32Array } {
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < n; i++) start[key(i) + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const items = new Uint32Array(n);
  for (let i = 0; i < n; i++) items[fill[key(i)]++] = i;
  return { start, items };
}

function dropBadTriangles(pos: Float32Array, tris: Uint32Array, minArea2: number) {
  const nt = tris.length / 3, nv = pos.length / 3;
  const drop = new Uint8Array(nt);
  let degenerate = 0, duplicate = 0, internal = 0;
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    if (a === b || b === c || a === c) { drop[t] = 1; degenerate++; continue; }
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz <= minArea2 * 4) { drop[t] = 1; degenerate++; }
  }
  const minOf = (t: number) => Math.min(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]);
  const { start, items } = bucketBy(nv, nt, minOf);
  // The other two vertices in order, and whether the triangle runs the other way round.
  const sorted = (t: number) => {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const m = Math.min(a, b, c);
    // Rotate so the smallest comes first; then (p, q) keeps the winding.
    const [p, q] = m === a ? [b, c] : m === b ? [c, a] : [a, b];
    return p < q ? { lo: p, hi: q, rev: false } : { lo: q, hi: p, rev: true };
  };
  for (let v = 0; v < nv; v++) {
    const s = start[v], e = start[v + 1];
    if (e - s < 2) continue;
    for (let i = s; i < e; i++) {
      const ti = items[i];
      if (drop[ti]) continue;
      const a = sorted(ti);
      for (let j = i + 1; j < e; j++) {
        const tj = items[j];
        if (drop[tj]) continue;
        const b = sorted(tj);
        if (a.lo !== b.lo || a.hi !== b.hi) continue;
        if (a.rev === b.rev) { drop[tj] = 1; duplicate++; } else { drop[ti] = 1; drop[tj] = 1; internal += 2; break; }
      }
    }
  }
  if (!degenerate && !duplicate && !internal) return { tris, degenerate, duplicate, internal };
  const out = new Uint32Array(tris.length);
  let n = 0;
  for (let t = 0; t < nt; t++) if (!drop[t]) { out[n++] = tris[t * 3]; out[n++] = tris[t * 3 + 1]; out[n++] = tris[t * 3 + 2]; }
  return { tris: out.slice(0, n), degenerate, duplicate, internal };
}

/** Each edge slot's partner across an edge shared by exactly two triangles (−1: open or non-manifold), and the counts of both. */
function edgePartners(nv: number, tris: Uint32Array): { partner: Int32Array; open: number; nonManifold: number } {
  const ne = tris.length;
  const eu = (e: number) => tris[e];
  const ev = (e: number) => tris[e - (e % 3) + ((e % 3) + 1) % 3];
  const { start, items } = bucketBy(nv, ne, (e) => Math.min(eu(e), ev(e)));
  const partner = new Int32Array(ne).fill(-1);
  let open = 0, nonManifold = 0;
  for (let v = 0; v < nv; v++) {
    const s = start[v], e = start[v + 1];
    for (let i = s; i < e; i++) {
      const a = items[i];
      const other = Math.max(eu(a), ev(a));
      let found = -1, n = 1, first = true;
      for (let j = s; j < e; j++) {
        if (j === i) continue;
        const b = items[j];
        if (Math.max(eu(b), ev(b)) !== other) continue;
        n++;
        if (found === -1) found = b;
        if (j < i) first = false;
      }
      if (n === 2) partner[a] = found;
      else if (n === 1) open++;
      else if (first) nonManifold++;
    }
  }
  return { partner, open, nonManifold };
}

/**
 * Makes neighbouring triangles agree on their winding (across edges shared by exactly two), each
 * connected piece keeping the winding most of its triangles have. Edits `tris` in place. Also
 * counts the open edges (holes) and the edges shared by more than two triangles.
 */
function orientTriangles(pos: Float32Array, tris: Uint32Array): { flipped: number; open: number; nonManifold: number } {
  const nt = tris.length / 3;
  const { partner, open, nonManifold } = edgePartners(pos.length / 3, tris);
  const flip = new Uint8Array(nt);
  const comp = new Int32Array(nt).fill(-1);
  const queue = new Uint32Array(nt);
  const flips: number[] = [], sizes: number[] = [];
  for (let seed = 0; seed < nt; seed++) {
    if (comp[seed] !== -1) continue;
    const c = flips.length;
    let head = 0, tail = 0, nf = 0;
    queue[tail++] = seed;
    comp[seed] = c;
    while (head < tail) {
      const t = queue[head++];
      for (let k = 0; k < 3; k++) {
        const e = t * 3 + k, o = partner[e];
        if (o < 0) continue;
        const n = Math.floor(o / 3);
        if (comp[n] !== -1) continue;
        // Same direction along the shared edge means one of the two is reversed.
        comp[n] = c;
        flip[n] = tris[e] === tris[o] ? flip[t] ^ 1 : flip[t];
        nf += flip[n];
        queue[tail++] = n;
      }
    }
    flips.push(nf);
    sizes.push(tail);
  }
  let flipped = 0;
  for (let t = 0; t < nt; t++) {
    const c = comp[t];
    // Flip the minority: the seed may have been the odd one out.
    if (flip[t] === (flips[c] * 2 > sizes[c] ? 1 : 0)) continue;
    const s = tris[t * 3 + 1]; tris[t * 3 + 1] = tris[t * 3 + 2]; tris[t * 3 + 2] = s;
    flipped++;
  }
  return { flipped, open, nonManifold };
}

/**
 * Turns closed shells that are inside out (negative volume) the right way round, unless they lie
 * inside another shell: then they are a cavity, which is meant to face inward. Edits `tris` in place.
 */
function orientShells(pos: Float32Array, tris: Uint32Array): number {
  const nt = tris.length / 3, nv = pos.length / 3;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let t = 0; t < nt; t++) for (let k = 1; k < 3; k++) { const a = find(tris[t * 3]), b = find(tris[t * 3 + k]); if (a !== b) parent[a] = b; }
  const shellOf = new Int32Array(nt);
  const vol = new Map<number, number>();
  for (let t = 0; t < nt; t++) {
    const r = find(tris[t * 3]);
    shellOf[t] = r;
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const d = pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
    vol.set(r, (vol.get(r) ?? 0) + d);
  }
  const negative = [...vol].filter(([, v]) => v < 0).map(([r]) => r);
  if (!negative.length) return 0;
  // Containment by a ray along +X from one vertex of the shell (a few shells at most are checked).
  const inside = (r: number) => {
    if (vol.size > 200) return false;
    const v = tris[shellOf.indexOf(r) * 3] * 3;
    const px = pos[v], py = pos[v + 1] + 1.3e-7, pz = pos[v + 2] + 2.9e-7;
    let crossings = 0;
    for (let t = 0; t < nt; t++) {
      if (shellOf[t] === r) continue;
      const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
      const det = (pos[b + 1] - pos[a + 1]) * (pos[c + 2] - pos[a + 2]) - (pos[c + 1] - pos[a + 1]) * (pos[b + 2] - pos[a + 2]);
      if (Math.abs(det) < 1e-30) continue;
      const l1 = ((py - pos[a + 1]) * (pos[c + 2] - pos[a + 2]) - (pos[c + 1] - pos[a + 1]) * (pz - pos[a + 2])) / det;
      const l2 = ((pos[b + 1] - pos[a + 1]) * (pz - pos[a + 2]) - (py - pos[a + 1]) * (pos[b + 2] - pos[a + 2])) / det;
      if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
      if (pos[a] + l1 * (pos[b] - pos[a]) + l2 * (pos[c] - pos[a]) > px) crossings++;
    }
    return crossings % 2 === 1;
  };
  const flip = new Set(negative.filter((r) => !inside(r)));
  let flipped = 0;
  for (let t = 0; t < nt; t++) {
    if (!flip.has(shellOf[t])) continue;
    const s = tris[t * 3 + 1]; tris[t * 3 + 1] = tris[t * 3 + 2]; tris[t * 3 + 2] = s;
    flipped++;
  }
  return flip.size;
}

/**
 * Gives each fan of triangles around a vertex its own copy of it, where fans are triangles joined
 * through edges shared by exactly two of them: shells that touch only at an edge or a corner come
 * apart, and two holes meeting at a vertex become two clean rims. `tris` is renumbered in place.
 */
function splitVertices(pos: Float32Array, tris: Uint32Array): { positions: Float32Array; split: number } {
  const nc = tris.length;
  const { partner } = edgePartners(pos.length / 3, tris);
  // Union-find over triangle corners: across a manifold edge, the corners at each end are one.
  const parent = new Int32Array(nc);
  for (let i = 0; i < nc; i++) parent[i] = i;
  const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const cornerAt = (t: number, v: number) => (tris[t * 3] === v ? t * 3 : tris[t * 3 + 1] === v ? t * 3 + 1 : t * 3 + 2);
  for (let e = 0; e < nc; e++) {
    const o = partner[e];
    if (o < e) continue; // each pair once (and not the unpaired)
    const t = Math.floor(e / 3), n = Math.floor(o / 3);
    const u = tris[e], v = tris[t * 3 + ((e % 3) + 1) % 3];
    join(cornerAt(t, u), cornerAt(n, u));
    join(cornerAt(t, v), cornerAt(n, v));
  }
  const nv = pos.length / 3;
  const firstRoot = new Int32Array(nv).fill(-1);
  const copies = new Map<number, number>();
  const extra: number[] = [];
  for (let c = 0; c < nc; c++) {
    const v = tris[c], r = find(c);
    if (firstRoot[v] === -1) { firstRoot[v] = r; continue; }
    if (firstRoot[v] === r) continue;
    let id = copies.get(r);
    if (id === undefined) {
      id = nv + extra.length / 3;
      copies.set(r, id);
      extra.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    }
    tris[c] = id;
  }
  if (!extra.length) return { positions: pos, split: 0 };
  const positions = new Float32Array(pos.length + extra.length);
  positions.set(pos);
  positions.set(extra, pos.length);
  return { positions, split: extra.length / 3 };
}

/**
 * Caps every hole: each loop of open edges gets a fan of triangles around its centre, wound to
 * match its neighbours. Null when a rim isn't a simple loop (two holes touching at a vertex).
 */
function fillHoles(pos: Float32Array, tris: Uint32Array): { positions: Float32Array; tris: Uint32Array; holes: number; edges: number } | null {
  const nt = tris.length / 3;
  const nv = pos.length / 3;
  // Open edges: a → b with no b → a (edges grouped by their smaller vertex to find the reverse).
  const ev = (e: number) => tris[e - (e % 3) + ((e % 3) + 1) % 3];
  const { start, items } = bucketBy(nv, tris.length, (e) => Math.min(tris[e], ev(e)));
  const next = new Map<number, number>();
  for (let v = 0; v < nv; v++) {
    for (let i = start[v]; i < start[v + 1]; i++) {
      const e = items[i], a = tris[e], b = ev(e);
      let reversed = false;
      for (let j = start[v]; j < start[v + 1] && !reversed; j++) reversed = tris[items[j]] === b && ev(items[j]) === a;
      if (reversed) continue;
      if (next.has(a)) return null; // two open edges leave one vertex
      next.set(a, b);
    }
  }
  const extraPos: number[] = [];
  const extraTris: number[] = [];
  let holes = 0, edges = 0;
  const seen = new Set<number>();
  for (const startV of next.keys()) {
    if (seen.has(startV)) continue;
    const loop: number[] = [];
    for (let v = startV; !seen.has(v); v = next.get(v)!) {
      if (!next.has(v)) return null;
      seen.add(v);
      loop.push(v);
    }
    if (loop.length < 3 || next.get(loop[loop.length - 1]) !== startV) return null;
    const c = [0, 0, 0];
    for (const v of loop) for (let k = 0; k < 3; k++) c[k] += pos[v * 3 + k] / loop.length;
    const ci = nv + extraPos.length / 3;
    extraPos.push(c[0], c[1], c[2]);
    // The rim runs a → b on the mesh, so the cap runs b → a.
    for (let i = 0; i < loop.length; i++) extraTris.push(loop[(i + 1) % loop.length], loop[i], ci);
    holes++;
    edges += loop.length;
  }
  if (!holes) return null;
  // Caps as big as the surface itself mean an open sheet (a relief, a scanned face), not a hole.
  const at = (i: number, k: number) => (i < nv ? pos[i * 3 + k] : extraPos[(i - nv) * 3 + k]);
  const area = (a: number, b: number, c: number) => {
    const ux = at(b, 0) - at(a, 0), uy = at(b, 1) - at(a, 1), uz = at(b, 2) - at(a, 2);
    const vx = at(c, 0) - at(a, 0), vy = at(c, 1) - at(a, 1), vz = at(c, 2) - at(a, 2);
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  };
  let surface = 0, caps = 0;
  for (let t = 0; t < nt; t++) surface += area(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]);
  for (let i = 0; i < extraTris.length; i += 3) caps += area(extraTris[i], extraTris[i + 1], extraTris[i + 2]);
  if (caps > surface * 0.5) return null;
  const positions = new Float32Array(pos.length + extraPos.length);
  positions.set(pos);
  positions.set(extraPos, pos.length);
  const out = new Uint32Array(tris.length + extraTris.length);
  out.set(tris);
  out.set(extraTris, tris.length);
  return { positions, tris: out, holes, edges };
}

/**
 * A watertight solid from any triangle soup: inside/outside of each grid point by rays along X, Y
 * and Z (a point is inside when at least two of the three cross the surface an odd number of
 * times, which outvotes rays slipping through holes), its distance to the nearest triangle near
 * the surface, and Manifold.levelSet through the signed distance.
 */
function rebuildSolid(wasm: ManifoldToplevel, pos: Float32Array, tris: Uint32Array, cells: number): { solid: Manifold; cell: number } {
  const b = bounds(pos, tris)!;
  const span = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
  let h = Math.max(...span) / cells;
  const dims = () => span.map((s) => Math.ceil(s / h) + 5);
  while (dims().reduce((p, n) => p * n, 1) > MAX_GRID_POINTS) h *= 1.1;
  const [nx, ny, nz] = dims();
  const o: Vec3 = [b.min[0] - 2 * h, b.min[1] - 2 * h, b.min[2] - 2 * h];
  const N = nx * ny * nz;
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const votes = new Uint8Array(N);
  const n = [nx, ny, nz];
  const nt = tris.length / 3;
  // Rays along `axis` through the grid points (slightly off them, so they never hit an edge exactly).
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, w = (axis + 2) % 3;
    const nu = n[u], nw = n[w];
    const hits: (number[] | undefined)[] = new Array(nu * nw);
    const du = 1.37e-4 * h, dw = 2.91e-4 * h;
    for (let t = 0; t < nt; t++) {
      const A = tris[t * 3] * 3, B = tris[t * 3 + 1] * 3, C = tris[t * 3 + 2] * 3;
      const au = pos[A + u], aw = pos[A + w], bu = pos[B + u], bw = pos[B + w], cu = pos[C + u], cw = pos[C + w];
      const i0 = Math.max(0, Math.ceil((Math.min(au, bu, cu) - o[u] - du) / h)), i1 = Math.min(nu - 1, Math.floor((Math.max(au, bu, cu) - o[u] - du) / h));
      const j0 = Math.max(0, Math.ceil((Math.min(aw, bw, cw) - o[w] - dw) / h)), j1 = Math.min(nw - 1, Math.floor((Math.max(aw, bw, cw) - o[w] - dw) / h));
      if (i0 > i1 || j0 > j1) continue;
      const det = (bu - au) * (cw - aw) - (cu - au) * (bw - aw);
      if (Math.abs(det) < 1e-30) continue; // edge-on to the ray
      const aa = pos[A + axis], ba = pos[B + axis], ca = pos[C + axis];
      for (let j = j0; j <= j1; j++) {
        const pw = o[w] + j * h + dw;
        for (let i = i0; i <= i1; i++) {
          const pu = o[u] + i * h + du;
          // Barycentric coordinates of the ray in the triangle's projection.
          const l1 = ((pu - au) * (cw - aw) - (cu - au) * (pw - aw)) / det;
          const l2 = ((bu - au) * (pw - aw) - (pu - au) * (bw - aw)) / det;
          if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
          const x = aa + l1 * (ba - aa) + l2 * (ca - aa);
          (hits[j * nu + i] ??= []).push(x);
        }
      }
    }
    for (let j = 0; j < nw; j++) {
      for (let i = 0; i < nu; i++) {
        const list = hits[j * nu + i];
        if (!list || list.length < 2) continue;
        list.sort((p, q) => p - q);
        let c = 0;
        for (let k = 0; k < n[axis]; k++) {
          const x = o[axis] + k * h;
          while (c < list.length && list[c] < x) c++;
          if (c % 2 === 0) continue;
          const g = [0, 0, 0];
          g[axis] = k; g[u] = i; g[w] = j;
          votes[at(g[0], g[1], g[2])]++;
        }
      }
    }
  }
  // Distance to the nearest triangle, only near the surface (farther points just need the sign).
  const band = 1.75 * h;
  const dist = new Float32Array(N).fill(band);
  for (let t = 0; t < nt; t++) {
    const A = tris[t * 3] * 3, B = tris[t * 3 + 1] * 3, C = tris[t * 3 + 2] * 3;
    const lo = [0, 1, 2].map((k) => Math.max(0, Math.ceil((Math.min(pos[A + k], pos[B + k], pos[C + k]) - band - o[k]) / h)));
    const hi = [0, 1, 2].map((k) => Math.min(n[k] - 1, Math.floor((Math.max(pos[A + k], pos[B + k], pos[C + k]) + band - o[k]) / h)));
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const g = at(i, j, k);
      const d = pointTriangleDistance(o[0] + i * h, o[1] + j * h, o[2] + k * h, pos, A, B, C);
      if (d < dist[g]) dist[g] = d;
    }
  }
  const sdf = new Float32Array(N);
  for (let g = 0; g < N; g++) sdf[g] = votes[g] >= 2 ? dist[g] : -dist[g];
  const value = (p: number[]) => {
    const fx = Math.min(nx - 1.001, Math.max(0, (p[0] - o[0]) / h)), fy = Math.min(ny - 1.001, Math.max(0, (p[1] - o[1]) / h)), fz = Math.min(nz - 1.001, Math.max(0, (p[2] - o[2]) / h));
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const x = fx - i, y = fy - j, z = fz - k;
    const g = at(i, j, k), sx = 1, sy = nx, sz = nx * ny;
    const c00 = sdf[g] * (1 - x) + sdf[g + sx] * x, c10 = sdf[g + sy] * (1 - x) + sdf[g + sy + sx] * x;
    const c01 = sdf[g + sz] * (1 - x) + sdf[g + sz + sx] * x, c11 = sdf[g + sz + sy] * (1 - x) + sdf[g + sz + sy + sx] * x;
    return (c00 * (1 - y) + c10 * y) * (1 - z) + (c01 * (1 - y) + c11 * y) * z;
  };
  const max: Vec3 = [o[0] + (nx - 1) * h, o[1] + (ny - 1) * h, o[2] + (nz - 1) * h];
  const solid = wasm.Manifold.levelSet(value as (p: Vec3) => number, { min: o, max }, h, 0);
  if (solid.isEmpty()) throw new Error('The mesh encloses no volume, so it can\'t be made solid (is it a flat surface or a single sheet?)');
  return { solid, cell: h };
}

/** Distance from point p to triangle (A, B, C given as offsets into pos), after Ericson. */
function pointTriangleDistance(px: number, py: number, pz: number, pos: Float32Array, A: number, B: number, C: number): number {
  const ax = pos[A], ay = pos[A + 1], az = pos[A + 2];
  const abx = pos[B] - ax, aby = pos[B + 1] - ay, abz = pos[B + 2] - az;
  const acx = pos[C] - ax, acy = pos[C + 1] - ay, acz = pos[C + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - pos[B], bpy = py - pos[B + 1], bpz = pz - pos[B + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - pos[C], cpy = py - pos[C + 1], cpz = pz - pos[C + 2];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) { qx = pos[B]; qy = pos[B + 1]; qz = pos[B + 2]; }
    else if (d6 >= 0 && d5 <= d6) { qx = pos[C]; qy = pos[C + 1]; qz = pos[C + 2]; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const v = d2 / (d2 - d6); qx = ax + v * acx; qy = ay + v * acy; qz = az + v * acz; }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const v = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      qx = pos[B] + v * (pos[C] - pos[B]); qy = pos[B + 1] + v * (pos[C + 1] - pos[B + 1]); qz = pos[B + 2] + v * (pos[C + 2] - pos[B + 2]);
    } else {
      const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
      qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
    }
  }
  return Math.hypot(px - qx, py - qy, pz - qz);
}
