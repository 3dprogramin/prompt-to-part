// The artwork editor's picture: its colours named after the model's parts, its printed size, and
// each colour drawn flat with the hand edits, the way the build reads it (drawingSection).
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

/** Each drawing colour named after the part whose colour is nearest it (within NEAR), else its hex. */
export function colourNames(colors: string[], parts: { name: string; color: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of colors) {
    const a = rgb(c);
    let best = NEAR, name = c;
    for (const p of parts) {
      const b = a && rgb(p.color);
      if (!a || !b) continue;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d <= best) { best = d; name = p.name; }
    }
    out[c] = name;
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
      if (shape.mode !== 'paint') { l.fill(strokePath(shape)); continue; }
      // Paint only inside the picture's box (none without one).
      if (!box) continue;
      l.save();
      l.beginPath(); l.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0); l.clip();
      l.fill(strokePath(shape));
      l.restore();
    }
    l.globalCompositeOperation = 'source-over';
    // Twice: where two colours meet, their soft edges cover the plate (no grey seam between them).
    ctx.drawImage(c, 0, 0);
    ctx.drawImage(c, 0, 0);
  });
}
