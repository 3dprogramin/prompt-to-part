// The picture mark: the area a user brushes on a picture to say where an edit goes. It is a set of
// brush strokes in picture units (1 = the picture's height, centred on the origin, y up), shared by
// the editors, the mask for the image model and the 2D booleans that join the result to the piece.
import { MAX_ARTWORK_POINTS, MAX_ARTWORK_STROKES, strokeContours } from '../artworkEdits';
import { rasterize, type LineArtGrid } from '../lineart/raster';

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

/** 1 inside the brushed area on the grid (picture units). Each piece is filled on its own, so overlaps stay filled. */
export function markMask(m: PictureMark, g: LineArtGrid): Uint8Array {
  const out = new Uint8Array(g.w * g.h);
  for (const c of markContours(m)) rasterize([c], g, out);
  return out;
}

/** A mark from a box of fractions (x0, y0, x1, y1 of the picture's width and height from the top left): one round stroke along the box's longer side, so its outline is the box's stadium. */
export function boxMark(box: [number, number, number, number], aspect: number): PictureMark {
  const x0 = -aspect / 2 + box[0] * aspect, x1 = -aspect / 2 + box[2] * aspect;
  const yTop = 0.5 - box[1], yBot = 0.5 - box[3];
  const w = x1 - x0, h = yTop - yBot, width = Math.min(w, h), r = width / 2;
  const cx = (x0 + x1) / 2, cy = (yTop + yBot) / 2;
  const points: [number, number][] = w >= h ? [[x0 + r, cy], [x1 - r, cy]] : [[cx, yBot + r], [cx, yTop - r]];
  return { strokes: [{ width, points }] };
}
