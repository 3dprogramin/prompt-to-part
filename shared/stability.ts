// Tipping check: where a design's centre of mass falls relative to the base it stands on.
// Parts are weighed as printed PLA (walls + sparse infill), a declared load adds a point mass.

import type { PrintSettings } from './print';

export const PLA_DENSITY = 1.24; // g/cm³
/** The centre of mass must stay inside the base shrunk by this fraction. */
export const STABILITY_MARGIN = 0.15;
export interface Load { name: string; mass: number; at: [number, number, number] } // g, mm
export interface MassPoint { name: string; mass: number; at: [number, number, number] }
type V2 = [number, number];

/** Volume centroid: signed tetrahedra (origin, a, b, c) weighted by their volume. */
export function meshCentroid(positions: Float32Array, indices: Uint32Array): [number, number, number] {
  let v = 0, x = 0, y = 0, z = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    const vol = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    v += vol; x += vol * (ax + bx + cx) / 4; y += vol * (ay + by + cy) / 4; z += vol * (az + bz + cz) / 4;
  }
  return Math.abs(v) < 1e-12 ? [0, 0, 0] : [x / v, y / v, z / v];
}

/** Grams of PLA in a part: the wall shell is solid, the rest is filled at the infill percentage. */
export function partMass(volume: number, surfaceArea: number, s: Required<PrintSettings>, nozzle: number): number {
  const shell = Math.min(volume, surfaceArea * s.walls * nozzle * 1.1); // 1.1: a wall line is a little wider than the nozzle
  return PLA_DENSITY * (shell + (s.infill / 100) * (volume - shell)) / 1000;
}

/** Andrew's monotone chain: counter-clockwise, no duplicate or collinear points. */
function hull(points: V2[]): V2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((q, i, a) => i === 0 || q[0] !== a[i - 1][0] || q[1] !== a[i - 1][1]);
  if (p.length < 3) return p;
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts: V2[]) => { const h: V2[] = []; for (const q of pts) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop(); h.push(q); } h.pop(); return h; };
  return [...half(p), ...half([...p].reverse())];
}

/** The base: hull of every vertex within `tolerance` mm of the lowest point (what touches the bed). */
export function footprint(parts: { positions: Float32Array }[], tolerance = 0.5): V2[] {
  let low = Infinity;
  for (const { positions } of parts) for (let i = 2; i < positions.length; i += 3) low = Math.min(low, positions[i]);
  const pts: V2[] = [];
  for (const { positions } of parts) for (let i = 0; i < positions.length; i += 3) if (positions[i + 2] <= low + tolerance) pts.push([positions[i], positions[i + 1]]);
  return hull(pts);
}

/**
 * One pose checked. `base`: the x/y extent of what touches the bed (which way it tips, against `com`);
 * `noBase`: it rests on a point or a line (a round or pointed bottom), so there is no base to check.
 */
export interface PoseCheck {
  pose: string; ok: boolean; mass: number; com: [number, number, number]; edgeMm: number; tiltDeg: number; error?: string;
  base?: { min: [number, number]; max: [number, number] }; noBase?: true;
}

/** submit_model's tipping check, kept with the version: every pose checked, the loads the script declared, and the AI's reason if it was let through anyway. */
export interface StabilityReport { poses: PoseCheck[]; loads: string[]; explanation?: string }

/** The lines the Code tab lists: the AI's reason first when it let a failing pose through, then one line per pose, then the loads. */
export function stabilityLines(r: StabilityReport): string[] {
  return [...(r.explanation ? [`Explained: ${r.explanation}`] : []), ...r.poses.map(formatPose), ...(r.loads.length ? [`Loads: ${r.loads.join(', ')}`] : [])];
}

/** The tipping check for the code shown: the latest AI version's report at or below `current`, only while that version's code is the code now shown. */
export function stabilityFor(versions: { code: string; source: string; stability?: StabilityReport }[], current: number): StabilityReport | undefined {
  const shown = versions[current];
  if (!shown) return undefined;
  for (let i = current; i >= 0; i--) if (versions[i].source === 'ai') return versions[i].code === shown.code ? versions[i].stability : undefined;
  return undefined;
}

/** Signed distance from p to the nearest edge of a CCW polygon, negative outside. */
function edgeDistance(p: V2, poly: V2[]): number {
  let d = Infinity, inside = true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey)));
    d = Math.min(d, Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey));
    if (ex * (p[1] - a[1]) - ey * (p[0] - a[0]) < 0) inside = false;
  }
  return inside ? d : -d;
}

export function checkPose(pose: string, points: MassPoint[], hullPts: V2[]): PoseCheck {
  const mass = points.reduce((n, p) => n + p.mass, 0);
  const com: [number, number, number] = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; k++) com[k] += p.at[k] * p.mass / (mass || 1);
  const base = hullPts.length ? {
    min: [Math.min(...hullPts.map((p) => p[0])), Math.min(...hullPts.map((p) => p[1]))] as V2,
    max: [Math.max(...hullPts.map((p) => p[0])), Math.max(...hullPts.map((p) => p[1]))] as V2,
  } : undefined;
  const fail = (error: string, more: Partial<PoseCheck> = {}): PoseCheck => ({ pose, ok: false, mass, com, edgeMm: 0, tiltDeg: 0, error, ...more });
  if (!(mass > 0)) return fail('nothing to weigh');
  // Area centroid of the hull (shoelace), the fixed point of the margin shrink.
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < hullPts.length; i++) {
    const a = hullPts[i], b = hullPts[(i + 1) % hullPts.length], w = a[0] * b[1] - b[0] * a[1];
    area += w; cx += (a[0] + b[0]) * w; cy += (a[1] + b[1]) * w;
  }
  // Fewer than 3 corners, or a sliver (shoelace area is twice the area): a round or pointed bottom.
  if (hullPts.length < 3 || Math.abs(area) / 2 < 0.01) return fail('no flat base to stand on: it rests on a point or a line', { noBase: true, ...(base ? { base } : {}) });
  const edgeMm = edgeDistance([com[0], com[1]], hullPts);
  const c: V2 = [cx / (3 * area), cy / (3 * area)];
  const k = 1 - STABILITY_MARGIN;
  const shrunk = hullPts.map((p): V2 => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]);
  const ok = edgeDistance([com[0], com[1]], shrunk) >= 0;
  const tiltDeg = edgeMm > 0 ? Math.atan2(edgeMm, Math.max(com[2], 1e-9)) * 180 / Math.PI : 0;
  return { pose, ok, mass, com, edgeMm, tiltDeg, ...(base ? { base } : {}) };
}

/** One line per pose; with the base known, also where the centre of mass is against it (which way it tips). */
export function formatPose(c: PoseCheck): string {
  const one = (x: number) => (Math.abs(x) < 0.05 ? 0 : x).toFixed(1);
  const short = (x: number) => String(+x.toFixed(1) || 0);
  const where = c.base ? `; centre of mass at x ${one(c.com[0])}, y ${one(c.com[1])}; base spans x ${short(c.base.min[0])}..${short(c.base.max[0])}, y ${short(c.base.min[1])}..${short(c.base.max[1])}` : '';
  if (c.error) return `${c.pose}: ${c.error}${where}`;
  if (c.edgeMm < 0) return `${c.pose}: tips, centre of mass ${(-c.edgeMm).toFixed(1)} mm outside the base${where}`;
  const past = `tips past ${Math.round(c.tiltDeg)}°`;
  return `${c.ok ? `${c.pose}: stable, ${c.edgeMm.toFixed(1)} mm inside the base edge` : `${c.pose}: marginal, only ${c.edgeMm.toFixed(1)} mm inside the base edge`}, ${past}${where}`;
}
