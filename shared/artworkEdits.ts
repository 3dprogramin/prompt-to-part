// Hand edits of artwork drawings (the Artwork editor's brush): paint and erase strokes, their
// checks, and how they join a drawing as extra shapes.
import { drawingColors, type SvgDrawing } from './svgFeatures';
import { drawingFingerprint } from './lineart/strokes';
import type { Vec2 } from './types';

/** The design's values key holding the edits. */
export const ARTWORK_EDITS_KEY = '$artworkEdits';
/** The most strokes kept per drawing, and points per stroke. */
export const MAX_ARTWORK_STROKES = 400;
export const MAX_ARTWORK_POINTS = 2000;

/**
 * One brush stroke: 'paint' puts `color` (one of the drawing's colours) where the brush goes,
 * 'erase' takes `color` away there. Points and width are in the drawing's own units (1 = its
 * height, centred, y up), so an edit stays put when the piece is resized. `shape` 'square': the
 * brush is an upright square `width` wide rather than round.
 */
export interface ArtworkStroke { mode: 'paint' | 'erase'; color: string; width: number; points: [number, number][]; shape?: 'square' }
/** The strokes on a drawing, with the fingerprint of the drawing they were made on. */
export type ArtworkEdits = Record<string, { fp: string; strokes: ArtworkStroke[] }>;

function cleanStroke(s: unknown): ArtworkStroke | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  if (o.mode !== 'paint' && o.mode !== 'erase') return null;
  if (typeof o.color !== 'string') return null;
  const width = Number(o.width);
  if (!(width > 0 && width <= 1)) return null;
  if (!Array.isArray(o.points)) return null;
  const points: [number, number][] = [];
  for (const p of o.points.slice(0, MAX_ARTWORK_POINTS)) {
    if (!Array.isArray(p)) continue;
    const x = Number(p[0]), y = Number(p[1]);
    if (Number.isFinite(x) && Number.isFinite(y) && p[0] != null && p[1] != null) points.push([x, y]);
  }
  if (!points.length) return null;
  return { mode: o.mode, color: o.color.slice(0, 40).toLowerCase(), width, points, ...(o.shape === 'square' ? { shape: 'square' as const } : {}) };
}

/** A stroke with at most MAX_ARTWORK_POINTS points (all the parser keeps): a longer one as several, each starting where the last ended. */
export function splitLongStroke(st: ArtworkStroke): ArtworkStroke[] {
  if (st.points.length <= MAX_ARTWORK_POINTS) return [st];
  const out: ArtworkStroke[] = [];
  for (let i = 0; i < st.points.length - 1; i += MAX_ARTWORK_POINTS - 1) out.push({ ...st, points: st.points.slice(i, i + MAX_ARTWORK_POINTS) });
  return out;
}

/** Edits from the design's values (a JSON string or the object), checked. */
export function parseArtworkEdits(raw: unknown): ArtworkEdits {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return {}; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: ArtworkEdits = {};
  for (const [name, e] of Object.entries(o as Record<string, { fp?: unknown; strokes?: unknown }>).slice(0, 12)) {
    if (!e || typeof e !== 'object' || typeof e.fp !== 'string' || !Array.isArray(e.strokes)) continue;
    const strokes = e.strokes.slice(-MAX_ARTWORK_STROKES).map(cleanStroke).filter((s): s is ArtworkStroke => !!s);
    if (strokes.length) out[name] = { fp: e.fp.slice(0, 80), strokes };
  }
  return out;
}

const circle = (cx: number, cy: number, r: number, n: number): Vec2[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)] as Vec2);

const squareAt = (cx: number, cy: number, r: number): Vec2[] => [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]];

/** Convex hull, counter-clockwise (monotone chain). */
function hull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list: Vec2[]) => {
    const h: Vec2[] = [];
    for (const q of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop(); h.push(q); }
    h.pop();
    return h;
  };
  return [...build(p), ...build([...p].reverse())];
}

/**
 * A stroke's pieces, whose NonZero union is the brush swept along it: round = a circle (`circle`,
 * centred on the origin, radius width / 2) at each of `centres` plus a quad joining each pair's
 * tangent points; square = for each segment the hull of the two upright squares. One point = one
 * circle or square. All counter-clockwise.
 */
export function strokePieces(st: ArtworkStroke, segments = 24): { circle: Vec2[]; centres: Vec2[]; polys: Vec2[][] } {
  const r = st.width / 2, square = st.shape === 'square';
  const polys: Vec2[][] = [];
  const pts = st.points;
  if (square && pts.length === 1) polys.push(squareAt(pts[0][0], pts[0][1], r));
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (len < 1e-9) { if (square && i === 1) polys.push(squareAt(ax, ay, r)); continue; }
    if (square) { polys.push(hull([...squareAt(ax, ay, r), ...squareAt(bx, by, r)])); continue; }
    const nx = (-dy / len) * r, ny = (dx / len) * r;
    polys.push([[ax - nx, ay - ny], [bx - nx, by - ny], [bx + nx, by + ny], [ax + nx, ay + ny]]);
  }
  return { circle: circle(0, 0, r, segments), centres: square ? [] : pts.map(([x, y]) => [x, y] as Vec2), polys };
}

/** The stroke as contours (its pieces, the circles placed). */
export function strokeContours(st: ArtworkStroke, segments = 24): Vec2[][] {
  const { centres, polys } = strokePieces(st, segments);
  return [...centres.map(([x, y]) => circle(x, y, st.width / 2, segments)), ...polys];
}

/** The drawings with the strokes added as shapes (those made on the drawing as it is now, in colours it has). */
export function withArtworkEdits(drawings: Record<string, SvgDrawing>, edits: ArtworkEdits): Record<string, SvgDrawing> {
  const out: Record<string, SvgDrawing> = {};
  for (const [name, d] of Object.entries(drawings)) {
    const e = edits[name];
    if (!e || e.fp !== drawingFingerprint(d)) { out[name] = d; continue; }
    const colours = new Set(drawingColors(d));
    const extra = e.strokes.filter((st) => colours.has(st.color))
      .map((st) => ({ rule: 'NonZero' as const, contours: strokeContours(st), color: st.color, edit: st.mode, stroke: st }));
    out[name] = extra.length ? { ...d, shapes: [...d.shapes, ...extra] } : d;
  }
  return out;
}

/** The edits of drawings that are still there; the same object when nothing goes. */
export function pruneArtworkEdits(edits: ArtworkEdits, drawings: Record<string, SvgDrawing>): ArtworkEdits {
  const keep = Object.keys(edits).filter((n) => n in drawings);
  if (keep.length === Object.keys(edits).length) return edits;
  return Object.fromEntries(keep.map((n) => [n, edits[n]]));
}
