// The artwork editor's picture: its colours named after the model's parts, its printed size, and
// either the model as built seen from the top (registered on the drawing, with this session's
// strokes drawn over it) or, when the model's layout can't be matched, each colour drawn flat with
// the hand edits, the way the build reads it (drawingSection).
import type { Box3 } from '../../../shared/types';
import { defaultColors, drawingColors, type SvgDrawing } from '../../../shared/svgFeatures';
import { strokeContours, type ArtworkStroke } from '../../../shared/artworkEdits';

/** The plate under the picture, where no colour is. */
export const PLATE = '#cfd2d6';
/** A part's colour this close (RGB distance) to a drawing colour gives that colour its name. */
const NEAR = 60;

const rgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [v >> 16, (v >> 8) & 255, v & 255];
};

/** The index of the part whose colour is nearest `colour` (RGB distance, within NEAR), else -1. */
export function nearestPart(colour: string, parts: { color: string }[]): number {
  const a = rgb(colour);
  let best = NEAR, out = -1;
  if (!a) return out;
  parts.forEach((p, i) => {
    const b = rgb(p.color);
    if (!b) return;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d <= best) { best = d; out = i; }
  });
  return out;
}

/** Each drawing colour named after the part whose colour is nearest it (within NEAR), else its hex. */
export function colourNames(colors: string[], parts: { name: string; color: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of colors) {
    const i = nearestPart(c, parts);
    out[c] = i < 0 ? c : parts[i].name;
  }
  return out;
}

/** The box (drawing units) of the colours raised by default, which paint stays inside; null when the drawing is empty. */
export function pictureBox(d: SvgDrawing): { x0: number; y0: number; x1: number; y1: number } | null {
  const raised = new Set(defaultColors(d) ?? drawingColors(d));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sh of d.shapes) {
    if (sh.edit || !raised.has(sh.color ?? '')) continue;
    for (const c of sh.contours) for (const [x, y] of c) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** Millimetres per drawing unit: the model's height (`bbox`, Y) over that of the colours raised by default; null when unknown. */
export function mmPerUnit(drawing: SvgDrawing, bbox: Box3 | null): number | null {
  const box = pictureBox(drawing);
  if (!bbox || !box) return null;
  const k = (bbox.max[1] - bbox.min[1]) / (box.y1 - box.y0);
  return k > 0 && Number.isFinite(k) ? k : null;
}

/** Where the drawing lies on the model: mm = k * unit + (tx, ty) (drawing units: 1 = its height, centred, y up). */
export interface Registration { k: number; tx: number; ty: number }
/** Sizes (and places) agree within this fraction. */
const AGREE = 0.02;

/**
 * The drawing placed on the model from its parts' sizes: each part named after drawing colours
 * (nearestPart) against those colours' extent (their shapes, and the paint in them inside the
 * picture's box, `pictureBox`) gives mm per unit across and up; it counts when the two agree (a part
 * that also holds the plate or a frame doesn't). Those that count must agree with each other in size
 * and place, and give their median; null when none counts or they disagree.
 */
export function registerDrawing(d: SvgDrawing, parts: { name: string; color: string; bbox: Box3 }[]): Registration | null {
  const box = pictureBox(d);
  const ext = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  for (const sh of d.shapes) {
    if (sh.edit === 'erase' || (sh.edit && !box)) continue;
    const i = nearestPart(sh.color ?? '', parts);
    if (i < 0) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of sh.contours) for (const [x, y] of c) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    // (Paint shows only inside the picture's box.)
    if (sh.edit && box) { x0 = Math.max(x0, box.x0); y0 = Math.max(y0, box.y0); x1 = Math.min(x1, box.x1); y1 = Math.min(y1, box.y1); }
    if (!(x1 >= x0 && y1 >= y0)) continue;
    const e = ext.get(i);
    ext.set(i, e ? { x0: Math.min(e.x0, x0), y0: Math.min(e.y0, y0), x1: Math.max(e.x1, x1), y1: Math.max(e.y1, y1) } : { x0, y0, x1, y1 });
  }
  const found: Registration[] = [];
  for (const [i, e] of ext) {
    const { min, max } = parts[i].bbox;
    const kx = (max[0] - min[0]) / (e.x1 - e.x0), ky = (max[1] - min[1]) / (e.y1 - e.y0);
    if (!(kx > 0 && ky > 0 && Number.isFinite(kx) && Number.isFinite(ky))) continue;
    const k = (kx + ky) / 2;
    if (Math.abs(kx - ky) > AGREE * k) continue;
    found.push({ k, tx: (min[0] + max[0]) / 2 - k * (e.x0 + e.x1) / 2, ty: (min[1] + max[1]) / 2 - k * (e.y0 + e.y1) / 2 });
  }
  if (!found.length) return null;
  const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  const r = { k: median(found.map((f) => f.k)), tx: median(found.map((f) => f.tx)), ty: median(found.map((f) => f.ty)) };
  // (Places agree within AGREE of the picture's height.)
  return found.every((f) => Math.abs(f.k - r.k) <= AGREE * r.k && Math.abs(f.tx - r.tx) <= AGREE * r.k && Math.abs(f.ty - r.ty) <= AGREE * r.k) ? r : null;
}

/** Heights are grouped to this many mm. */
const Z_STEP = 0.05;

/**
 * The parts seen from the top: their up-facing triangles (counter-clockwise seen from above), by
 * part and height (the triangle's highest corner, to Z_STEP), lowest first. `tris`: triangle indices.
 */
export function topGroups(parts: { positions: ArrayLike<number>; indices: ArrayLike<number> }[]): { part: number; z: number; tris: number[] }[] {
  const groups = new Map<string, { part: number; z: number; tris: number[] }>();
  parts.forEach(({ positions: P, indices: I }, part) => {
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      if ((P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]) <= 1e-9) continue;
      const z = Math.round(Math.max(P[a + 2], P[b + 2], P[c + 2]) / Z_STEP) / Math.round(1 / Z_STEP);
      const key = `${part} ${z}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { part, z, tris: [] }));
      g.tris.push(t / 3);
    }
  });
  return [...groups.values()].sort((a, b) => a.z - b.z || a.part - b.part);
}

/** Around the model, in the built view. */
export const BACKDROP = '#dcdfe3';

/**
 * The model seen from the top, ready to draw (mm): the lowest surface's colour under all of it (the
 * plate, which shows where something is erased), and the surfaces above it, lowest first, as runs of
 * one part each. `box`: its extent. Null when nothing faces up.
 */
export function builtView(parts: { color: string; positions: ArrayLike<number>; indices: ArrayLike<number> }[]) {
  const groups = topGroups(parts);
  if (!groups.length) return null;
  const all = new Path2D();
  const runs: { part: number; color: string; path: Path2D }[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  groups.forEach((g, n) => {
    const P = parts[g.part].positions, I = parts[g.part].indices;
    // The lowest surface is drawn with all of it (below); a part's surfaces one after the other make one run.
    let run: Path2D | null = null;
    if (n) {
      const last = runs[runs.length - 1];
      if (last && last.part === g.part) run = last.path;
      else runs.push({ part: g.part, color: parts[g.part].color, path: (run = new Path2D()) });
    }
    for (const t of g.tris) {
      const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
      for (const p of run ? [all, run] : [all]) { p.moveTo(P[a], P[a + 1]); p.lineTo(P[b], P[b + 1]); p.lineTo(P[c], P[c + 1]); p.closePath(); }
      x0 = Math.min(x0, P[a], P[b], P[c]); x1 = Math.max(x1, P[a], P[b], P[c]);
      y0 = Math.min(y0, P[a + 1], P[b + 1], P[c + 1]); y1 = Math.max(y1, P[a + 1], P[b + 1], P[c + 1]);
    }
  });
  return { all, base: parts[groups[0].part].color, runs, box: { x0, y0, x1, y1 } };
}
export type BuiltView = NonNullable<ReturnType<typeof builtView>>;

type Matrix = [number, number, number, number, number, number];
/** `m` after mm to drawing units (the inverse of `r`): mm to the canvas's pixels. */
const mmMatrix = ([a, b, c, d, e, f]: Matrix, r: Registration): Matrix =>
  [a / r.k, b / r.k, c / r.k, d / r.k, e - (a * r.tx + c * r.ty) / r.k, f - (b * r.tx + d * r.ty) / r.k];

/** A paint stroke, inside the picture's box (none without one). */
function paintIn(l: CanvasRenderingContext2D, st: ArtworkStroke, box: ReturnType<typeof pictureBox>) {
  if (!box) return;
  l.save();
  l.beginPath(); l.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0); l.clip();
  fillStroke(l, st);
  l.restore();
}

/**
 * The model as built on `ctx` (all of it, over BACKDROP), with this session's strokes (`strokes`,
 * drawing units, in the order made) as a preview of the rebuild: erasing X takes X's part away under
 * the stroke (not the plate); painting X takes every other part away there (not the plate) and lays
 * X on top in its part's colour (which a later erase of X or paint of another colour takes away).
 * `partOf`: the part a drawing colour is named after (nearestPart, -1 for none); `colourOf`: the
 * colour it shows in. `m`: drawing units to the canvas's pixels; `tmp`: an off-screen canvas, kept between calls.
 */
export function drawBuilt(ctx: CanvasRenderingContext2D, v: BuiltView, r: Registration, strokes: ArtworkStroke[], partOf: (colour: string) => number,
  colourOf: (colour: string) => string, box: ReturnType<typeof pictureBox>, m: Matrix, tmp: HTMLCanvasElement) {
  const { width, height } = ctx.canvas;
  const mm = mmMatrix(m, r);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(...mm);
  ctx.fillStyle = v.base;
  ctx.fill(v.all);
  let off: CanvasRenderingContext2D | null = null;
  /** The off-screen canvas cleared, for a layer. */
  const layer = () => {
    if (tmp.width !== width || tmp.height !== height) { tmp.width = width; tmp.height = height; }
    const l = (off ??= tmp.getContext('2d')!);
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = 'source-over';
    l.clearRect(0, 0, width, height);
    return l;
  };
  /** A layer's steps (fill or cut, a stroke each) in drawing units, then the layer laid on. */
  const steps = (l: CanvasRenderingContext2D, ops: { cut: boolean; st: ArtworkStroke }[]) => {
    l.setTransform(...m);
    for (const { cut, st } of ops) {
      l.globalCompositeOperation = cut ? 'destination-out' : 'source-over';
      if (st.mode === 'paint') paintIn(l, st, box); else fillStroke(l, st);
    }
    l.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  };
  for (const run of v.runs) {
    const cuts = strokes.filter((st) => (partOf(st.color) === run.part) === (st.mode === 'erase'));
    if (!cuts.length) { ctx.setTransform(...mm); ctx.fillStyle = run.color; ctx.fill(run.path); continue; }
    const l = layer();
    l.setTransform(...mm);
    l.fillStyle = run.color;
    l.fill(run.path);
    steps(l, cuts.map((st) => ({ cut: true, st })));
  }
  // The paint on top, a layer per colour.
  for (const colour of new Set(strokes.filter((st) => st.mode === 'paint').map((st) => st.color))) {
    const ops = strokes.filter((st) => st.mode === 'paint' || st.color === colour).map((st) => ({ cut: st.mode === 'erase' || st.color !== colour, st }));
    while (ops.length && ops[0].cut) ops.shift();
    const l = layer();
    l.fillStyle = colourOf(colour) || '#000';
    steps(l, ops);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * The steps that draw one colour's layer, in paint order, as the build does for that colour alone:
 * the drawing's own shapes fill in their colour and cut the others; a paint stroke fills in its
 * colour and cuts the others (inside the picture's box, `pictureBox`); an erase stroke cuts only its
 * own colour. Strokes in a colour the drawing doesn't have are left out. `shape`: a shape's index, or the stroke.
 */
export function colourOps(d: SvgDrawing, strokes: ArtworkStroke[], colour: string): { op: 'fill' | 'cut'; shape: number | ArtworkStroke }[] {
  const out: { op: 'fill' | 'cut'; shape: number | ArtworkStroke }[] = d.shapes.map((sh, i) => ({ op: (sh.color ?? '') === colour ? 'fill' : 'cut', shape: i }));
  // (Cuts before anything is filled change nothing.)
  while (out.length && out[0].op === 'cut') out.shift();
  const colours = new Set(drawingColors(d));
  for (const st of strokes) {
    if (!colours.has(st.color)) continue;
    if (st.mode === 'paint') out.push({ op: st.color === colour ? 'fill' : 'cut', shape: st });
    else if (st.color === colour) out.push({ op: 'cut', shape: st });
  }
  return out;
}

const strokePaths = new WeakMap<ArtworkStroke, Path2D>();
/** A stroke as the build makes it (its contours), as a path in drawing units. */
function strokePath(st: ArtworkStroke): Path2D {
  let p = strokePaths.get(st);
  if (!p) {
    p = new Path2D();
    for (const c of strokeContours(st)) { c.forEach(([x, y], i) => (i ? p!.lineTo(x, y) : p!.moveTo(x, y))); p.closePath(); }
    strokePaths.set(st, p);
  }
  return p;
}

const cutPaths = new WeakMap<ArtworkStroke, Path2D>();
/** A stroke's cut as a path in drawing units (NonZero). */
function cutPath(st: ArtworkStroke): Path2D {
  let p = cutPaths.get(st);
  if (!p) {
    p = new Path2D();
    for (const c of st.cut ?? []) { c.forEach(([x, y], i) => (i ? p!.lineTo(x, y) : p!.moveTo(x, y))); p.closePath(); }
    cutPaths.set(st, p);
  }
  return p;
}

let cutCanvas: HTMLCanvasElement | null = null;
/**
 * A stroke filled on `l` as `l` is set (transform, colour, compositing, clip), less its cut (where a
 * picture edit replaced the picture). A stroke with a cut is drawn on a canvas of its own first and
 * the cut taken away there, over the stroke's reach only: the cut's pieces overlap, so no clip path
 * leaves them out.
 */
function fillStroke(l: CanvasRenderingContext2D, st: ArtworkStroke) {
  if (!st.cut?.length) { l.fill(strokePath(st)); return; }
  const { width, height } = l.canvas, m = l.getTransform(), r = st.width / 2;
  // The stroke's reach in pixels.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of st.points) for (const [x, y] of [[px - r, py - r], [px + r, py - r], [px + r, py + r], [px - r, py + r]]) {
    const sx = m.a * x + m.c * y + m.e, sy = m.b * x + m.d * y + m.f;
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  x0 = Math.max(0, Math.floor(x0) - 1); y0 = Math.max(0, Math.floor(y0) - 1);
  x1 = Math.min(width, Math.ceil(x1) + 1); y1 = Math.min(height, Math.ceil(y1) + 1);
  if (!(x1 > x0 && y1 > y0)) return;
  const c = (cutCanvas ??= document.createElement('canvas'));
  if (c.width < width || c.height < height) { c.width = Math.max(c.width, width); c.height = Math.max(c.height, height); }
  const s = c.getContext('2d')!;
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.globalCompositeOperation = 'source-over';
  s.clearRect(x0, y0, x1 - x0, y1 - y0);
  s.setTransform(m);
  s.fillStyle = l.fillStyle;
  s.fill(strokePath(st));
  s.globalCompositeOperation = 'destination-out';
  s.fill(cutPath(st));
  l.save();
  l.setTransform(1, 0, 0, 1, 0, 0);
  l.drawImage(c, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  l.restore();
}

/** The drawing's shapes as paths in drawing units, with their fill rules. */
export function shapePaths(d: SvgDrawing): { path: Path2D; rule: CanvasFillRule }[] {
  return d.shapes.map((sh) => {
    const path = new Path2D();
    for (const c of sh.contours) { c.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath(); }
    return { path, rule: sh.rule === 'EvenOdd' ? 'evenodd' : 'nonzero' };
  });
}

/**
 * The picture on `ctx` (all of it, over the plate): each colour's layer drawn off screen from its
 * steps (fill = source-over, cut = destination-out) and laid on in paint order. `m`: the transform
 * from drawing units to the canvas's pixels; `scratch`: the off-screen canvases, kept between calls.
 */
export function drawPicture(ctx: CanvasRenderingContext2D, layers: { colour: string; ops: ReturnType<typeof colourOps> }[], paths: ReturnType<typeof shapePaths>,
  box: ReturnType<typeof pictureBox>, m: [number, number, number, number, number, number], scratch: HTMLCanvasElement[]) {
  const { width, height } = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PLATE;
  ctx.fillRect(0, 0, width, height);
  layers.forEach(({ colour, ops }, i) => {
    const c = (scratch[i] ??= document.createElement('canvas'));
    if (c.width !== width || c.height !== height) { c.width = width; c.height = height; }
    const l = c.getContext('2d')!;
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.clearRect(0, 0, width, height);
    l.setTransform(...m);
    l.fillStyle = colour || '#000';
    for (const { op, shape } of ops) {
      l.globalCompositeOperation = op === 'fill' ? 'source-over' : 'destination-out';
      if (typeof shape === 'number') { l.fill(paths[shape].path, paths[shape].rule); continue; }
      if (shape.mode !== 'paint') { fillStroke(l, shape); continue; }
      // Paint only inside the picture's box (none without one).
      paintIn(l, shape, box);
    }
    l.globalCompositeOperation = 'source-over';
    // Twice: where two colours meet, their soft edges cover the plate (no grey seam between them).
    ctx.drawImage(c, 0, 0);
    ctx.drawImage(c, 0, 0);
  });
}
