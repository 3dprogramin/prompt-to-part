// The picture editors' shared drawing of the area selected for a picture edit (the mark): drawn
// see-through over the picture, brushed into the strokes a mark holds, and the brush's ring.
import { splitLongStroke } from '../../../shared/artworkEdits';
import type { MarkStroke } from '../../../shared/pictureEdit/mark';
import { leanStroke } from '../../lib/lineArtEdit';
import { clamp, round, SELECT, strokeOn, type Pt } from '../lineart/editorDraw';

/** The selection brush's widths: in mm when the picture's printed size is known, else in % of its height. */
export const SEL_MM = { min: 1, max: 60, start: 10 }, SEL_PCT = { min: 0.5, max: 40, start: 5 };

/** A canvas transform: picture units to canvas pixels. */
export type Matrix = [number, number, number, number, number, number];

/**
 * The selection's strokes see-through over the picture on `ctx` (`m` takes picture units to its
 * pixels): drawn whole on `layer` first, off screen, so where strokes cross it is no darker.
 */
export function drawSelection(ctx: CanvasRenderingContext2D, layer: HTMLCanvasElement, m: Matrix, strokes: MarkStroke[]) {
  const c = ctx.canvas;
  if (layer.width !== c.width || layer.height !== c.height) { layer.width = c.width; layer.height = c.height; }
  const sctx = layer.getContext('2d')!;
  sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.clearRect(0, 0, layer.width, layer.height);
  sctx.setTransform(...m);
  for (const st of strokes) strokeOn(sctx, { mode: 'clear', ...st }, SELECT[0]);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = SELECT[1]; ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

/**
 * A selection stroke brushed through `points` (picture units), `width` wide: made lean in mm (`per`
 * mm per picture unit, or as if the picture were 100 mm high), in the pieces a mark can hold.
 */
export function selectionStrokes(points: Pt[], width: number, square: boolean, per: number): MarkStroke[] {
  const pts = leanStroke(points.map(([x, y]): Pt => [x * per, y * per])).map(([x, y]): [number, number] => [round(x / per, 5), round(y / per, 5)]);
  const st = { mode: 'paint' as const, color: '', width: round(clamp(width, 1e-5, 2), 5), points: pts, ...(square ? { shape: 'square' as const } : {}) };
  return splitLongStroke(st).map(({ width: w, points: p, shape }): MarkStroke => ({ width: w, points: p, ...(shape ? { shape } : {}) }));
}

/**
 * The brush at screen point `at` (the context set to CSS pixels), `r` its radius: edged light and
 * dark, so a white or a black brush shows on any colour, `colour` inside, and its centre.
 */
export function drawBrush(ctx: CanvasRenderingContext2D, [x, y]: Pt, r: number, square: boolean, colour: string) {
  const outline = (color: string, lw: number) => {
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
    if (square) ctx.rect(x - r, y - r, 2 * r, 2 * r); else ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.stroke();
  };
  outline('#ffffffcc', 4.4); outline('#1d1d1f', 2.6); outline(colour, 1.2);
  ctx.fillStyle = colour;
  ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
}
