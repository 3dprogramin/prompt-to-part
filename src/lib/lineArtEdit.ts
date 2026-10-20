import { MAX_LINEART_STROKES, MAX_STROKE_POINTS, type LineArtEdits, type LineArtInfo, type LineArtStroke } from '../../shared/lineart';

// Pure helpers of the line-art editor (LineArtEditor): pointer (mm) ↔ drawing units, stroke
// simplification, snapping onto the ink, and the edits value.

type Pt = [number, number];
export type Frame = LineArtInfo['frames'][number];

/** A point of the piece (mm, its XY) in a drawing's own units. */
export function toDrawing(f: Frame, [x, y]: Pt): Pt {
  return [(x - f.tx) / f.k, (y - f.ty) / f.k];
}

/** A point of a drawing (its own units) in the piece, mm. */
export function toPiece(f: Frame, [x, y]: Pt): Pt {
  return [x * f.k + f.tx, y * f.k + f.ty];
}

/**
 * The drawing a point of the piece (mm) belongs to: the one whose bounds (x within ±aspect / 2,
 * y within ±0.5 of its units) hold it, else the nearest. `aspect` gives a drawing's width / height
 * (1 when it isn't known).
 */
export function frameAt(frames: Frame[], p: Pt, aspect: (name: string) => number): Frame | undefined {
  let best: Frame | undefined, bestD = Infinity;
  for (const f of frames) {
    const [u, v] = toDrawing(f, p), a = aspect(f.name) / 2;
    // Distance to the bounds, in mm (0 inside).
    const d = Math.hypot(Math.max(0, Math.abs(u) - a), Math.max(0, Math.abs(v) - 0.5)) * f.k;
    if (d < bestD) { best = f; bestD = d; }
  }
  return best;
}

/** Points closer than `minStep` to the last one kept are dropped (the last point always stays). */
export function dropClose(pts: Pt[], minStep: number): Pt[] {
  if (pts.length < 2) return pts.slice();
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const q = out[out.length - 1];
    if (Math.hypot(pts[i][0] - q[0], pts[i][1] - q[1]) >= minStep) out.push(pts[i]);
  }
  const last = pts[pts.length - 1], q = out[out.length - 1];
  // The end replaces a kept point too close to it, so the stroke ends where the pointer did.
  if (out.length > 1 && Math.hypot(last[0] - q[0], last[1] - q[1]) < minStep) out[out.length - 1] = last;
  else out.push(last);
  return out;
}

/** Ramer–Douglas–Peucker: the fewest points within `tol` of the path. */
export function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let far = -1, farD = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > farD) { far = i; farD = d; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** A stroke as drawn (mm), made lean: close points dropped, then simplified, within MAX_STROKE_POINTS. */
export function leanStroke(pts: Pt[], tol = 0.1, minStep = 0.15): Pt[] {
  let out = simplify(dropClose(pts, minStep), tol);
  for (let t = tol * 2; out.length > MAX_STROKE_POINTS; t *= 2) out = simplify(out, t);
  return out;
}

/** The piece's ink on a grid: 1 where it is, row 0 at the top (y1), `res` mm per cell. */
export interface InkMask { data: Uint8Array; w: number; h: number; x0: number; y1: number; res: number }

export function inkAt(m: InkMask, [x, y]: Pt): boolean {
  const i = Math.floor((x - m.x0) / m.res), j = Math.floor((m.y1 - y) / m.res);
  return i >= 0 && j >= 0 && i < m.w && j < m.h && m.data[j * m.w + i] === 1;
}

/** The nearest point of the ink (on its edge, as the grid has it) within `radius` mm of p, or null (also when p is on ink already). */
export function nearestInk(m: InkMask, p: Pt, radius: number): Pt | null {
  if (inkAt(m, p)) return null;
  const ci = (p[0] - m.x0) / m.res, cj = (m.y1 - p[1]) / m.res, R = radius / m.res;
  let best: Pt | null = null, bestD = R * R;
  for (let j = Math.max(0, Math.floor(cj - R)); j <= Math.min(m.h - 1, Math.floor(cj + R)); j++) {
    for (let i = Math.max(0, Math.floor(ci - R)); i <= Math.min(m.w - 1, Math.floor(ci + R)); i++) {
      if (!m.data[j * m.w + i]) continue;
      // The cell's nearest point to p.
      const u = Math.min(i + 1, Math.max(i, ci)), v = Math.min(j + 1, Math.max(j, cj));
      const d = (u - ci) ** 2 + (v - cj) ** 2;
      if (d < bestD) { bestD = d; best = [m.x0 + u * m.res, m.y1 - v * m.res]; }
    }
  }
  return best;
}

/**
 * Where a stroke's end near the ink snaps to: the nearest ink, then on into it along the way the
 * stroke reaches it, by half the stroke's width (at most half the ink's depth there, so a line
 * ending on a thin line ends on its middle). `from` is the end as drawn, `prev` the point before it.
 */
export function snapEnd(m: InkMask, from: Pt, prev: Pt | undefined, width: number, radius: number): Pt | null {
  const q = nearestInk(m, from, radius);
  if (!q) return null;
  let dx = q[0] - from[0], dy = q[1] - from[1], L = Math.hypot(dx, dy);
  if (L < 1e-6 && prev) { dx = from[0] - prev[0]; dy = from[1] - prev[1]; L = Math.hypot(dx, dy); }
  if (L < 1e-6) return q;
  dx /= L; dy /= L;
  // How deep the ink goes that way.
  let depth = 0;
  while (depth < width && inkAt(m, [q[0] + dx * (depth + m.res / 2), q[1] + dy * (depth + m.res / 2)])) depth += m.res;
  const d = Math.min(width / 2, depth / 2);
  return [q[0] + dx * d, q[1] + dy * d];
}

/** The strokes on a drawing that apply (made on this version of it, `fp`). */
export function strokesOf(edits: LineArtEdits, name: string, fp: string): LineArtStroke[] {
  const e = edits[name];
  return e && e.fp === fp ? e.strokes : [];
}

/** The edits with a stroke added to a drawing (strokes made on an earlier version of it are dropped). */
export function addStroke(edits: LineArtEdits, name: string, fp: string, stroke: LineArtStroke): LineArtEdits {
  const strokes = [...strokesOf(edits, name, fp), stroke].slice(-MAX_LINEART_STROKES);
  return { ...edits, [name]: { fp, strokes } };
}

/** The edits without the last stroke of a drawing equal to `stroke` (unchanged when there is none). */
export function removeStroke(edits: LineArtEdits, name: string, stroke: LineArtStroke): LineArtEdits {
  const e = edits[name];
  if (!e) return edits;
  // Compared by content (a stroke read back from the design has its keys in another order).
  const same = (s: LineArtStroke) => JSON.stringify([s.mode, s.width ?? null, s.points]);
  const i = e.strokes.map(same).lastIndexOf(same(stroke));
  if (i < 0) return edits;
  const strokes = e.strokes.filter((_, k) => k !== i);
  const out = { ...edits };
  if (strokes.length) out[name] = { ...e, strokes }; else delete out[name];
  return out;
}

/** The edits without those on the given drawings. */
export function withoutDrawings(edits: LineArtEdits, names: string[]): LineArtEdits {
  const out = { ...edits };
  for (const n of names) delete out[n];
  return out;
}

/** Edits on the piece's drawings made on an earlier version of them (they no longer apply): their count. */
export function staleEdits(edits: LineArtEdits, frames: Frame[]): { names: string[]; strokes: number } {
  const names = frames.filter((f) => edits[f.name] && edits[f.name].fp !== f.fp).map((f) => f.name);
  return { names, strokes: names.reduce((n, k) => n + edits[k].strokes.length, 0) };
}

/** A round length for a scale bar about `target` mm long: 1, 2 or 5 × 10ⁿ. */
export function niceLength(target: number): number {
  const p = 10 ** Math.floor(Math.log10(target));
  const m = target / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}
