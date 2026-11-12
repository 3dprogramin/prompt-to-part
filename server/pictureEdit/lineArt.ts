// Picture edits of a line-art drawing (one black shape for H.lineart). The whole drawing: as it is
// now, the user's hand edits drawn in, sent with lineArtEditPrompt, the answer traced with
// traceLineArt and the hand edits baked in (their colours kept, re-keyed to the new drawing);
// generate_line_art's `edit` and a picture edit without a mark both run this. A marked edit: the
// pasted crop traced back into the drawing's units, and the mark as clears of the hand edits under it.
import { encode as encodePng } from 'fast-png';
import { decodeImage, LINE_TRACE_MAX_SIDE, lineArtEditPrompt, traceLineArt, type requestImage } from '../artwork';
import { colourStrokes, drawingFingerprint, drawingPicture, type LineArtStroke, type LineArtStyle } from '../../shared/lineart';
import type { Raster } from '../../shared/meshFormats';
import type { PictureMark } from '../../shared/pictureEdit/mark';
import type { PictureWindow } from '../../shared/pictureEdit/render';
import type { SvgDrawing } from '../../shared/svgFeatures';
import type { Vec2 } from '../../shared/types';

/** Where a drawing sits in the piece: mm per drawing unit now (`k`) and as built at the script's own size (`k0`), and the piece's line width (mm). */
export interface LineArtFrame { k: number; k0: number; lineWidth: number }

/** The long side of the picture of the drawing sent (pixels). */
const SENT_HEIGHT = 1024;

/**
 * The drawing `drawing` changed by the image model as `change` says, whole: drawn with its hand
 * edits `strokes` at `frame`'s size (their widths in mm) and sent first, then the `photos`; asked in
 * `aspect`. The answer is traced as a drawing named `name`. `edits`: the hand edits kept on the new
 * drawing (their colours: lines and erasing are in it now), or none when nothing is left of them.
 */
export async function editWholeLineArt(
  r: { drawing: SvgDrawing; name: string; strokes: LineArtStroke[]; frame: LineArtFrame; change: string; photos?: string[]; width?: number; style: LineArtStyle; aspect: string },
  deps: { image: typeof requestImage; signal?: AbortSignal; onStatus?: (text: string) => void },
) {
  const { k, k0, lineWidth } = r.frame;
  const pic = drawingPicture(r.drawing, r.strokes, SENT_HEIGHT, k, lineWidth, k0);
  const sent: Raster = { width: pic.width, height: pic.height, data: pic.rgba };
  const references = [`data:image/png;base64,${Buffer.from(encodePng({ width: pic.width, height: pic.height, data: pic.rgba, channels: 4 })).toString('base64')}`, ...(r.photos ?? [])];
  const prompt = lineArtEditPrompt({ change: r.change, references: r.photos, width: r.width, style: r.style });
  const { image, model, cost } = await deps.image(prompt, r.aspect, references, deps.signal, deps.onStatus);
  const answer = decodeImage(Buffer.from(image.data, 'base64'));
  const traced = traceLineArt(answer, r.name);
  const kept = colourStrokes(r.strokes, lineWidth);
  const edits = kept.length ? { fp: drawingFingerprint(traced.drawing), strokes: kept } : undefined;
  return { traced, edits, image, answer, sent, prompt, model, cost };
}

/**
 * The edited crop traced as line art, in the WHOLE drawing's units: the crop covers `win`, its
 * pixels `win.h / crop.height` wide from the window's top-left corner (as drawingPicture draws a
 * window). One shape, in `colour` (the drawing's own). traceLineArt traces a crop over
 * LINE_TRACE_MAX_SIDE box-filtered down by a whole factor f, keeping only whole blocks, so a unit
 * of its drawing is (traced height x f) crop pixels.
 */
export function traceLineCrop(crop: Raster, win: PictureWindow, name: string, colour: string): SvgDrawing {
  const { drawing } = traceLineArt(crop, name);
  const f = Math.max(1, Math.ceil(Math.max(crop.width, crop.height) / LINE_TRACE_MAX_SIDE));
  const tracedH = f > 1 ? Math.floor(crop.height / f) : crop.height;
  const s = (win.h * tracedH * f) / crop.height, half = drawing.aspect / 2;
  const map = ([x, y]: Vec2): Vec2 => [win.x0 + (x + half) * s, win.y1 + (y - 0.5) * s];
  return { name, aspect: crop.width / crop.height, shapes: drawing.shapes.map((sh) => ({ ...sh, color: colour, contours: sh.contours.map((c) => c.map(map)) })) };
}

/** The widest a saved stroke may be (parseLineArtEdits drops a wider width). */
const MAX_STROKE_WIDTH = 50;

/**
 * The mark as clears ('restore' strokes) of the hand edits under it: the same brush, in drawing
 * units (`k` 1: a width of 1 is the drawing's height; scaled down together when a stroke is wider
 * than a saved width may be), so it reaches the same area at any size of the piece.
 */
export function markClears(mark: PictureMark): LineArtStroke[] {
  const k = Math.min(1, MAX_STROKE_WIDTH / Math.max(...mark.strokes.map((st) => st.width)));
  return mark.strokes.map((st) => ({ mode: 'restore', width: st.width * k, k, points: st.points.map(([x, y]) => [x, y]), ...(st.shape === 'square' ? { shape: 'square' as const } : {}) }));
}
