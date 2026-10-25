// Hand edits of line-art drawings (the Line art editor's brush): strokes, their checks, and the
// drawing as a picture with them drawn in.
import { defaultColors, type SvgDrawing } from '../svgFeatures';
import { cleanFilament, type PartFilament } from '../params';
import { squareOutlines } from './outlines';
import { capsuleXY, type LineArtGrid, type Pt, rasterize } from './raster';

/** The most strokes kept per drawing, and points per stroke. */
export const MAX_LINEART_STROKES = 400;
export const MAX_STROKE_POINTS = 2000;

/**
 * One brush stroke on a drawing: 'draw' adds a line `width` mm wide (default: the piece's
 * lineWidth), 'erase' removes everything within width / 2 of its path (default 3 mm) – also what
 * Jig drew there, so a join or bridge can be erased; 'paint' colours the lines under it
 * (default 3 mm wide) in `filament`, adding nothing; 'fill' (default FILL_WIDTH wide) is the
 * opposite of paint: it adds material only where the piece has none yet (inside an outline), in
 * `filament`, never over its lines. A drawn line is in `filament` too; without one, any of them is
 * the piece's own filament (paint puts it back). 'restore' (Clear edits here) takes back the strokes
 * before it under its brush: there the piece is as Jig made it again (lines drawn go, erased ones
 * come back, paint and fills go). Points are in the drawing's own units (1 = its height, centred,
 * y up), so an edit stays put when the piece is resized. `shape` 'square': the brush is a square
 * `width` wide (upright in the drawing) rather than round; a drawn line is always round.
 */
export interface LineArtStroke { mode: 'draw' | 'erase' | 'paint' | 'fill' | 'restore'; width?: number; points: [number, number][]; filament?: PartFilament; shape?: 'square'; k?: number }
/** A fill brush's width when the stroke gives none, mm. */
export const FILL_WIDTH = 4;
const STROKE_MODES: readonly string[] = ['draw', 'erase', 'paint', 'fill', 'restore'];
/** The strokes on a drawing, with the fingerprint of the drawing they were made on: a new drawing under the same name leaves them out. */
export type LineArtEdits = Record<string, { fp: string; strokes: LineArtStroke[] }>;

/** A drawing's fingerprint: hand edits only apply to the drawing they were drawn on. */
export function drawingFingerprint(d: SvgDrawing): string {
  let h = 0, pts = 0;
  for (const sh of d.shapes) for (const c of sh.contours) for (const [x, y] of c) { h = (h * 31 + Math.round(x * 1e5) * 7 + Math.round(y * 1e5)) | 0; pts++; }
  return `${d.aspect.toFixed(6)}:${pts}:${h}`;
}

/** Hand edits from the design's values (LINEART_EDITS_KEY), checked. */
export function parseLineArtEdits(raw: unknown): LineArtEdits {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return {}; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: LineArtEdits = {};
  for (const [name, e] of Object.entries(o as Record<string, { fp?: unknown; strokes?: unknown }>).slice(0, 12)) {
    if (!e || typeof e.fp !== 'string' || !Array.isArray(e.strokes)) continue;
    const strokes: LineArtStroke[] = [];
    for (const st of e.strokes.slice(-MAX_LINEART_STROKES) as LineArtStroke[]) {
      if (!st || !STROKE_MODES.includes(st.mode) || !Array.isArray(st.points)) continue;
      const points = st.points.slice(0, MAX_STROKE_POINTS).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]] as [number, number]);
      if (!points.length) continue;
      const width = Number(st.width);
      // (An eraser has no filament, nor does clearing.)
      const filament = st.mode === 'erase' || st.mode === 'restore' ? undefined : cleanFilament(st.filament);
      const square = st.shape === 'square' && st.mode !== 'draw';
      // (The piece's mm per drawing unit it was drawn at: its width follows the piece's size.)
      const k = Number(st.k);
      strokes.push({ mode: st.mode, points, ...(width > 0 && width <= 50 ? { width } : {}), ...(filament ? { filament } : {}), ...(square ? { shape: 'square' as const } : {}), ...(k > 0 && Number.isFinite(k) ? { k } : {}) });
    }
    if (strokes.length) out[name.slice(0, 120)] = { fp: e.fp.slice(0, 80), strokes };
  }
  return out;
}

/**
 * The colours of a drawing's hand edits, to keep when the edits are drawn into a new picture of it
 * (Jig changing part of the drawing): its paint strokes, and its lines as paint along them (a line
 * in the piece's own filament takes the colour back there, as it did). Fills aren't in the picture
 * (drawingPicture): they stay as they are and fill the new drawing where it is empty. A clear stays
 * too, so the colours before it stay off there.
 */
export function colourStrokes(strokes: LineArtStroke[], lineWidth = 1): LineArtStroke[] {
  const out = strokes.flatMap((st): LineArtStroke[] => (st.mode === 'paint' || st.mode === 'fill' || st.mode === 'restore' ? [st] : st.mode === 'draw' ? [{ mode: 'paint', width: Math.max(st.width ?? lineWidth, lineWidth), points: st.points, ...(st.filament ? { filament: st.filament } : {}), ...(st.k ? { k: st.k } : {}) }] : []));
  const first = out.findIndex((st) => st.filament || st.mode === 'fill');
  return first < 0 ? [] : out.slice(first);
}

/** Same colour and name: the same filament. */
export const filamentKey = (f: PartFilament) => `${f.color.toLowerCase()}|${f.name ?? ''}`;

/**
 * A drawing as a black-on-white picture `heightPx` high (RGBA, anti-aliased), with its hand edits
 * drawn in – what the image model gets to change part of a drawing. `mmPerUnit`: the drawing's
 * size in the piece (its frame's k), for the strokes' widths; `drawnAt`: its k0.
 */
export function drawingPicture(d: SvgDrawing, strokes: LineArtStroke[], heightPx: number, mmPerUnit: number, lineWidth = 1, drawnAt = mmPerUnit): { width: number; height: number; rgba: Uint8Array } {
  const S = 2, H = Math.round(heightPx) * S, W = Math.round(d.aspect * heightPx) * S;
  const g: LineArtGrid = { w: W, h: H, px: 1 / H, x0: -d.aspect / 2, y1: 0.5 };
  const ink = new Uint8Array(W * H);
  // Shapes in paint order: the line colours add ink, the others (white-ish paper) cover it.
  const dark = defaultColors(d), lines = dark ? new Set(dark) : null;
  for (const sh of d.shapes) {
    const m = rasterize(sh.contours as Pt[][], g);
    const on = !lines || lines.has(sh.color ?? '');
    for (let i = 0; i < m.length; i++) if (m[i]) ink[i] = on ? 1 : 0;
  }
  const toPx = ([x, y]: [number, number]): Pt => [(x - g.x0) * H - 0.5, (g.y1 - y) * H - 0.5];
  // (Paint adds no ink; fills stay strokes of their own, kept by colourStrokes. A clear puts the drawing's own ink back.)
  const own = strokes.some((st) => st.mode === 'restore') ? ink.slice() : null;
  for (const st of strokes) {
    if (st.mode === 'paint' || st.mode === 'fill') continue;
    // (A width in mm at the size it was drawn at: `k`, else `drawnAt`.)
    const r = (st.width != null ? st.width / 2 / (st.k ?? drawnAt) : (st.mode === 'draw' ? lineWidth : 3) / 2 / mmPerUnit) * H;
    const m = new Uint8Array(W * H), pts = st.points.map(toPx);
    // (A square brush: its outlines on the pixels, y up as rasterize has it.)
    if (st.shape === 'square') for (const c of squareOutlines([pts.map(([x, y]): Pt => [x, -y])], r)) rasterize([c], { w: W, h: H, px: 1, x0: -0.5, y1: 0.5 }, m);
    else if (pts.length === 1) capsuleXY(m, W, H, pts[0], pts[0], r);
    else for (let k = 0; k + 1 < pts.length; k++) capsuleXY(m, W, H, pts[k], pts[k + 1], r);
    for (let i = 0; i < m.length; i++) if (m[i]) ink[i] = st.mode === 'draw' ? 1 : st.mode === 'restore' ? own![i] : 0;
  }
  const w = W / S, h = H / S, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let n = 0;
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) n += ink[(y * S + dy) * W + x * S + dx];
    const v = 255 - Math.round((255 * n) / (S * S)), o = (y * w + x) * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = 255;
  }
  return { width: w, height: h, rgba };
}
