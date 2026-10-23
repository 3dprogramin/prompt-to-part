// Checks on a built piece's mesh for the artifacts the coloured parts must not have: skins of one
// part on another, slits, holes and faces looking down inside a body (lineArtFill, lineArtSquare).
import type { PartMesh, Vec2 } from '../shared/types';

/** The area of a part's faces looking down, above the bed (mm²): none in one solid body on the bed. */
export function downAbove(p: PartMesh): number {
  const P = p.positions, I = p.indices;
  let a = 0;
  for (let k = 0; k < I.length; k += 3) {
    const v = [I[k], I[k + 1], I[k + 2]].map((i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
    if (v.some((q) => q[2] < 1e-3)) continue;
    a += Math.max(0, -((v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[1][1] - v[0][1]) * (v[2][0] - v[0][0])) / 2);
  }
  return a;
}

/** Walls of a part with its own top just outside them (a slit, which the view outlines as a line). */
export function slits(p: PartMesh): number {
  const P = p.positions, I = p.indices, walls: { c: Vec2; n: Vec2; z: number }[] = [], tops: { t: Vec2[]; z: number }[] = [];
  for (let k = 0; k < I.length; k += 3) {
    const v = [I[k], I[k + 1], I[k + 2]].map((i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
    const u = [0, 1, 2].map((j) => v[1][j] - v[0][j]), w = [0, 1, 2].map((j) => v[2][j] - v[0][j]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], L = Math.hypot(...n);
    if (L < 1e-9) continue;
    const z = Math.max(v[0][2], v[1][2], v[2][2]);
    if (n[2] / L > 0.999) tops.push({ t: v.map((q) => [q[0], q[1]] as Vec2), z });
    else if (Math.abs(n[2] / L) < 1e-3 && v.some((q, i) => Math.hypot(q[0] - v[(i + 1) % 3][0], q[1] - v[(i + 1) % 3][1]) > 0.02))
      walls.push({ c: [(v[0][0] + v[1][0] + v[2][0]) / 3 + (n[0] / L) * 0.005, (v[0][1] + v[1][1] + v[2][1]) / 3 + (n[1] / L) * 0.005], n: [n[0] / L, n[1] / L], z });
  }
  return walls.filter((w) => tops.some((t) => t.z >= w.z - 1e-4 && inTri(w.c, t.t))).length;
}

function inTri([x, y]: Vec2, [p, q, r]: Vec2[]): boolean {
  const s = (a: Vec2, b: Vec2) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const d1 = s(p, q), d2 = s(q, r), d3 = s(r, p);
  return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0);
}

/**
 * How many holes go through a part (its genus, from V − E + F = 2 − 2g of one body), its points
 * the same to `digits` decimals (fewer: a sliver under a micron, where two layers meet, is none).
 */
export function holes(p: PartMesh, digits = 5): number {
  const P = p.positions, I = p.indices, id = new Map<string, number>(), v: number[] = [];
  for (let i = 0; i < P.length / 3; i++) { const k = `${P[3 * i].toFixed(digits)},${P[3 * i + 1].toFixed(digits)},${P[3 * i + 2].toFixed(digits)}`; if (!id.has(k)) id.set(k, id.size); v.push(id.get(k)!); }
  const edges = new Set<string>();
  let faces = 0;
  for (let t = 0; t < I.length; t += 3) {
    const f = [v[I[t]], v[I[t + 1]], v[I[t + 2]]];
    // (A triangle gone to a line or a point: none.)
    if (f[0] === f[1] || f[1] === f[2] || f[0] === f[2]) continue;
    faces++;
    for (let j = 0; j < 3; j++) { const a = f[j], b = f[(j + 1) % 3]; edges.add(a < b ? `${a},${b}` : `${b},${a}`); }
  }
  return (2 - (id.size - edges.size + faces)) / 2;
}

/**
 * Walls of `a` with the other part `b` on their inner side (just inside the wall, seen from above)
 * and the other way round: a skin of one left on the other's walls. Both through the same height
 * at their top (the footprints are their highest up-facing triangles).
 */
export function skins(a: PartMesh, b: PartMesh): number {
  const tris = (p: PartMesh) => {
    const out: { c: Vec2; n: Vec2; wall: boolean; up: boolean; z: number; t: Vec2[] }[] = [];
    const P = p.positions, I = p.indices;
    for (let k = 0; k < I.length; k += 3) {
      const v = [I[k], I[k + 1], I[k + 2]].map((i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
      const u = [0, 1, 2].map((j) => v[1][j] - v[0][j]), w = [0, 1, 2].map((j) => v[2][j] - v[0][j]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], L = Math.hypot(...n);
      if (L < 1e-9) continue;
      out.push({ c: [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3], n: [n[0] / L, n[1] / L], wall: Math.abs(n[2] / L) < 1e-3, up: n[2] / L > 0.999, z: Math.max(v[0][2], v[1][2], v[2][2]), t: v.map((q) => [q[0], q[1]] as Vec2) });
    }
    return out;
  };
  const ta = tris(a), tb = tris(b);
  const footprint = (t: ReturnType<typeof tris>) => { const z = Math.max(...t.filter((x) => x.up).map((x) => x.z)); return t.filter((x) => x.up && x.z > z - 1e-4).map((x) => x.t); };
  const inTri = ([x, y]: Vec2, [p, q, r]: Vec2[]) => {
    if (x < Math.min(p[0], q[0], r[0]) || x > Math.max(p[0], q[0], r[0]) || y < Math.min(p[1], q[1], r[1]) || y > Math.max(p[1], q[1], r[1])) return false;
    const s = (a: Vec2, b: Vec2) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const d1 = s(p, q), d2 = s(q, r), d3 = s(r, p);
    return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0);
  };
  // (Walls longer than a rounding: a speck of one at a corner where the parts meet is no skin.)
  const long = (t: ReturnType<typeof tris>[number]) => t.t.some((q, i) => Math.hypot(q[0] - t.t[(i + 1) % 3][0], q[1] - t.t[(i + 1) % 3][1]) > 0.02);
  const count = (walls: ReturnType<typeof tris>, other: Vec2[][]) => walls.filter((t) => t.wall && long(t)).filter((t) => {
    const p: Vec2 = [t.c[0] - t.n[0] * 0.01, t.c[1] - t.n[1] * 0.01];
    return other.some((o) => inTri(p, o));
  }).length;
  return count(ta, footprint(tb)) + count(tb, footprint(ta));
}
