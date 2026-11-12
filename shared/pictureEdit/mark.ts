// The picture mark: the area a user brushes on a picture to say where an edit goes. It is a set of
// brush strokes in picture units (1 = the picture's height, centred on the origin, y up), shared by
// the editors, the mask for the image model and the 2D booleans that join the result to the piece.
import { MAX_ARTWORK_POINTS, MAX_ARTWORK_STROKES, strokeContours } from '../artworkEdits';
import type { LineArtGrid } from '../lineart/raster';

/** The design's values key holding the marks. */
export const PICTURE_MARKS_KEY = '$pictureMarks';

/** One brush stroke; `shape` 'square': the brush is an upright square `width` wide rather than round. */
export interface MarkStroke { width: number; points: [number, number][]; shape?: 'square' }
export interface PictureMark { strokes: MarkStroke[] }
/** The mark on each picture, with the fingerprint of the picture it was made on. */
export type PictureMarks = Record<string, { fp: string; mark: PictureMark }>;

function cleanStroke(s: unknown): MarkStroke | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  const width = Number(o.width);
  if (!(width > 0 && Number.isFinite(width)) || !Array.isArray(o.points)) return null;
  const points: [number, number][] = [];
  for (const p of o.points.slice(0, MAX_ARTWORK_POINTS)) {
    if (!Array.isArray(p) || p[0] == null || p[1] == null) continue;
    const x = Number(p[0]), y = Number(p[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  if (!points.length) return null;
  return { width, points, ...(o.shape === 'square' ? { shape: 'square' as const } : {}) };
}

/** Marks from the design's values (a JSON string or the object), checked: bad strokes are dropped, at most 400 strokes of 2000 points. */
export function parsePictureMarks(raw: unknown): PictureMarks {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return {}; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: PictureMarks = {};
  for (const [name, e] of Object.entries(o as Record<string, { fp?: unknown; mark?: { strokes?: unknown } }>).slice(0, 12)) {
    if (!e || typeof e !== 'object' || typeof e.fp !== 'string' || !e.mark || !Array.isArray(e.mark.strokes)) continue;
    const strokes = e.mark.strokes.slice(-MAX_ARTWORK_STROKES).map(cleanStroke).filter((s): s is MarkStroke => !!s);
    if (strokes.length) out[name.slice(0, 120)] = { fp: e.fp.slice(0, 80), mark: { strokes } };
  }
  return out;
}

/** The box the brush reaches (every point grown by half the width), or null for an empty mark. */
export function markBounds(m: PictureMark): { min: [number, number]; max: [number, number] } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of m.strokes) {
    const r = st.width / 2;
    for (const [x, y] of st.points) { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); }
  }
  return x0 <= x1 ? { min: [x0, y0], max: [x1, y1] } : null;
}

/** The contours of the strokes' pieces, whose NonZero union is the brushed area. */
export function markContours(m: PictureMark, segments = 24): [number, number][][] {
  return m.strokes.flatMap((st) => strokeContours({ mode: 'paint', color: '', ...st }, segments));
}

/** Fills a convex polygon into `out` (a pixel is in when its centre is, as `rasterize` decides), looking only at the rows it spans. */
export function fillConvex(c: [number, number][], g: LineArtGrid, out: Uint8Array) {
  let lo = Infinity, hi = -Infinity;
  for (const p of c) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
  const jTop = Math.max(0, Math.ceil((g.y1 - hi) / g.px - 0.5) - 1), jBot = Math.min(g.h - 1, Math.floor((g.y1 - lo) / g.px - 0.5) + 1);
  for (let j = jTop; j <= jBot; j++) {
    const y = g.y1 - (j + 0.5) * g.px;
    let xa = Infinity, xb = -Infinity;
    let b = c[c.length - 1], bx = b[0], by = b[1];
    for (let k = 0; k < c.length; k++) {
      const ax = bx, ay = by;
      b = c[k]; bx = b[0]; by = b[1];
      if ((ay <= y) === (by <= y)) continue;
      const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
      if (x < xa) xa = x;
      if (x > xb) xb = x;
    }
    if (xa > xb) continue;
    const i0 = Math.max(0, Math.ceil((xa - g.x0) / g.px - 0.5)), i1 = Math.min(g.w - 1, Math.floor((xb - g.x0) / g.px - 0.5));
    if (i1 >= i0) out.fill(1, j * g.w + i0, j * g.w + i1 + 1);
  }
}

/** 1 inside the brushed area on the grid (picture units): the union of the strokes' pieces, each convex and filled on its own. */
export function markMask(m: PictureMark, g: LineArtGrid): Uint8Array {
  const out = new Uint8Array(g.w * g.h);
  for (const c of markContours(m)) fillConvex(c, g, out);
  return out;
}

/** A mark from a box of fractions (x0, y0, x1, y1 of the picture's width and height from the top left; each clamps to 0..1, and an empty box gives no strokes): one round stroke along the box's longer side, so its outline is the box's stadium. */
export function boxMark(box: [number, number, number, number], aspect: number): PictureMark {
  const [fx0, fy0, fx1, fy1] = box.map((f) => Math.min(1, Math.max(0, f)));
  if (!(fx1 > fx0 && fy1 > fy0)) return { strokes: [] };
  const x0 = -aspect / 2 + fx0 * aspect, x1 = -aspect / 2 + fx1 * aspect;
  const yTop = 0.5 - fy0, yBot = 0.5 - fy1;
  const w = x1 - x0, h = yTop - yBot, width = Math.min(w, h), r = width / 2;
  const cx = (x0 + x1) / 2, cy = (yTop + yBot) / 2;
  const points: [number, number][] = w >= h ? [[x0 + r, cy], [x1 - r, cy]] : [[cx, yBot + r], [cx, yTop - r]];
  return { strokes: [{ width, points }] };
}
