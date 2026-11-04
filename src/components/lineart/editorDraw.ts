// The Edit drawing brush's tools, brush widths and colours, and its drawing: the piece seen from
// above as paths, a bitmap and an ink grid, and strokes on a canvas or stamped into the grid.
import type { PartMesh } from '../../../shared/types';
import { squareOutlines, type LineArtEdits, type LineArtStroke } from '../../../shared/lineart';
import { inkAt, type InkMask } from '../../lib/lineArtEdit';

export type Pt = [number, number];
export type Tool = 'draw' | 'erase' | 'paint' | 'fill' | 'clear';
/** A step of this session, for Undo / Redo: a stroke added, edits cleared, or cleared where selected (the selection it cleared kept for Undo). */
export type Op = { kind: 'add'; name: string; fp: string; stroke: LineArtStroke; shown: ShownStroke } | { kind: 'clear'; names: string[]; before: LineArtEdits; shown: ShownStroke[] }
  | { kind: 'here'; names: string[]; before: LineArtEdits; after: LineArtEdits; shown: ShownStroke[]; selection: ShownStroke[] };
/**
 * A stroke of this session on the screen (mm, the piece's XY), drawn over the piece: it is only
 * built when the editor closes with Done. `src` is the stroke as saved; `color` its filament's
 * (none: the piece's own). A 'clear' one is where edits were cleared (the piece as the AI made it shows there).
 * `shape` 'square': brushed with a square `width` wide.
 */
export interface ShownStroke { mode: Tool; width: number; points: Pt[]; name?: string; src?: LineArtStroke; live?: boolean; color?: string; shape?: 'square' }

/** Brush widths (mm): draw, erase, paint, fill, and the selection to clear edits in. */
export const WIDTH = { draw: { min: 0.6, max: 5 }, erase: { min: 1, max: 15 }, paint: { min: 0.5, max: 15 }, fill: { min: 0.5, max: 15 }, clear: { min: 1, max: 50 } };
/** Paint shows only on the piece, a fill only off it. */
export const masked = (mode: Tool) => mode === 'paint' || mode === 'fill';
/** Strokes put together off screen (composed): those masked, and where edits were cleared. */
export const composite = (mode: Tool) => masked(mode) || mode === 'clear';
/** Snap within this many mm of the ink (and at least SNAP_PX screen pixels). */
export const SNAP_MM = 1.5;
export const SNAP_PX = 10;
/** The piece's colour on the white page, and the bar, frame or pegs (raised above the lines) a little lighter. */
export const INK = '#141414';
const RAISED = ['#3a3d42', '#6a6e75'];
export const ERASE = 'rgba(229, 103, 95, 0.5)';
/** The area selected to clear edits in, see-through over the piece, and the brush's ring. */
export const SELECT = ['#3d8bfd', 0.35] as const;
export const SELECT_RING = '#1f6fe0';
/** The seams of a piece split into pieces. */
export const SEAM = '#2f80d1';
/** Where a loose end was joined to a line, and the loose ends left (as in the 3D view). */
export const JOIN = ['#ff4fd8', '#ffb020'];
export const PAPER = '#fff';
/** The hit-test grid: this many mm per cell at least, and at most this many cells. */
const MASK_RES = 0.05;
const MASK_CELLS = 8_000_000;
/** The largest zoom, screen pixels per mm. */
export const MAX_ZOOM = 400;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** A stroke (mm) in `color`, on a context set to mm. */
export function strokeOn(ctx: CanvasRenderingContext2D, st: ShownStroke, color: string) {
  ctx.fillStyle = ctx.strokeStyle = color;
  if (st.shape === 'square') {
    // The outlines the piece is built with.
    ctx.beginPath();
    for (const c of squareOutlines([st.points], st.width / 2)) { c.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
    ctx.fill('nonzero');
    return;
  }
  if (st.points.length === 1 || st.points.every((p) => p[0] === st.points[0][0] && p[1] === st.points[0][1])) {
    ctx.beginPath(); ctx.arc(st.points[0][0], st.points[0][1], st.width / 2, 0, 2 * Math.PI); ctx.fill();
    return;
  }
  ctx.lineWidth = st.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

/**
 * The piece seen from above, ready to draw: its up-facing triangles as paths (all of them in INK,
 * then those raised above the lines lighter, by height, and the lines in other filaments in
 * theirs: `paints`, ranges of its triangles), a bitmap of it for quick pans and zooms, and its ink
 * on a grid for snapping.
 */
export function pieceImage(part: PartMesh & { paints?: { color: string; from: number; to: number }[] }, thickness: number) {
  const P = part.positions, I = part.indices;
  const all = new Path2D();
  const raised = new Map<number, Path2D>();
  const colours = new Map<string, Path2D>();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1], cx = P[c], cy = P[c + 1];
    // Facing up (counter-clockwise seen from above): the walls and the back are left out.
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) <= 1e-9) continue;
    all.moveTo(ax, ay); all.lineTo(bx, by); all.lineTo(cx, cy); all.closePath();
    const paint = part.paints?.find((r) => t >= r.from && t < r.to);
    if (paint) {
      let p = colours.get(paint.color);
      if (!p) colours.set(paint.color, (p = new Path2D()));
      p.moveTo(ax, ay); p.lineTo(bx, by); p.lineTo(cx, cy); p.closePath();
    }
    const z = Math.max(P[a + 2], P[b + 2], P[c + 2]);
    if (!paint && z > thickness + 0.05) {
      const k = Math.round(z * 2) / 2;
      let p = raised.get(k);
      if (!p) raised.set(k, (p = new Path2D()));
      p.moveTo(ax, ay); p.lineTo(bx, by); p.lineTo(cx, cy); p.closePath();
    }
    x0 = Math.min(x0, ax, bx, cx); x1 = Math.max(x1, ax, bx, cx);
    y0 = Math.min(y0, ay, by, cy); y1 = Math.max(y1, ay, by, cy);
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  const zs = [...raised.keys()].sort((a, b) => a - b);
  const lo = zs[0] ?? 0, hi = zs[zs.length - 1] ?? 1;
  const mix = (z: number) => {
    const t = hi > lo ? (z - lo) / (hi - lo) : 0;
    const [r0, g0, b0] = [1, 3, 5].map((i) => parseInt(RAISED[0].slice(i, i + 2), 16));
    const [r1, g1, b1] = [1, 3, 5].map((i) => parseInt(RAISED[1].slice(i, i + 2), 16));
    return `rgb(${Math.round(r0 + (r1 - r0) * t)}, ${Math.round(g0 + (g1 - g0) * t)}, ${Math.round(b0 + (b1 - b0) * t)})`;
  };
  const layers = [{ path: all, color: INK }, ...zs.map((z) => ({ path: raised.get(z)!, color: mix(z) })), ...[...colours].map(([color, path]) => ({ path, color }))];
  const fill = (ctx: CanvasRenderingContext2D) => { for (const l of layers) { ctx.fillStyle = l.color; ctx.fill(l.path); } };

  // The bitmap, also the ink grid (a cell is ink where the piece covers most of it).
  const res = Math.max(MASK_RES, Math.sqrt(((x1 - x0) * (y1 - y0)) / MASK_CELLS));
  const w = Math.ceil((x1 - x0) / res) + 2, h = Math.ceil((y1 - y0) / res) + 2;
  const mx0 = x0 - res, my1 = y1 + res;
  const bitmap = document.createElement('canvas');
  bitmap.width = w; bitmap.height = h;
  const bctx = bitmap.getContext('2d', { willReadFrequently: true })!;
  bctx.setTransform(1 / res, 0, 0, -1 / res, -mx0 / res, my1 / res);
  fill(bctx);
  const px = bctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  const mask: InkMask = { data, w, h, x0: mx0, y1: my1, res };
  return { fill, bitmap, mask, box: { x0, y0, x1, y1 } };
}

/**
 * A stroke stamped into the ink grid: a drawn line or a fill adds ink (all under it is ink then),
 * erasing takes it away (paint changes none), clearing puts the ink of the piece as the AI made it
 * back (`own`, when it is known).
 */
export function stamp(m: InkMask, st: ShownStroke, own?: InkMask | null) {
  if (st.mode === 'paint' || (st.mode === 'clear' && !own)) return;
  const r = st.width / 2 / m.res, v = st.mode === 'erase' ? 0 : 1;
  const set = (x: number, y: number) => { m.data[y * m.w + x] = st.mode === 'clear' ? (inkAt(own!, [m.x0 + (x + 0.5) * m.res, m.y1 - (y + 0.5) * m.res]) ? 1 : 0) : v; };
  if (st.shape === 'square') {
    // A square brush: the cells inside its outlines (mm, counter-clockwise).
    for (const c of squareOutlines([st.points], st.width / 2)) {
      const x0 = Math.max(0, Math.floor((Math.min(...c.map((p) => p[0])) - m.x0) / m.res)), x1 = Math.min(m.w - 1, Math.ceil((Math.max(...c.map((p) => p[0])) - m.x0) / m.res));
      const y0 = Math.max(0, Math.floor((m.y1 - Math.max(...c.map((p) => p[1]))) / m.res)), y1 = Math.min(m.h - 1, Math.ceil((m.y1 - Math.min(...c.map((p) => p[1]))) / m.res));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = m.x0 + (x + 0.5) * m.res, py = m.y1 - (y + 0.5) * m.res;
        if (c.every(([ax, ay], k) => { const [bx, by] = c[(k + 1) % c.length]; return (bx - ax) * (py - ay) - (by - ay) * (px - ax) >= 0; })) set(x, y);
      }
    }
    return;
  }
  const px = st.points.map(([x, y]): Pt => [(x - m.x0) / m.res, (m.y1 - y) / m.res]);
  const segs = px.length === 1 ? [[px[0], px[0]]] : px.slice(1).map((p, i) => [px[i], p]);
  for (const [[ax, ay], [bx, by]] of segs) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(m.w - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(m.h - 1, Math.ceil(Math.max(ay, by) + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= r * r) set(x, y);
    }
  }
}
