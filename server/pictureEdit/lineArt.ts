// A change to a whole line-art drawing by the image model: the drawing as it is now, the user's hand
// edits drawn in, is sent with lineArtEditPrompt, the answer traced with traceLineArt, and the hand
// edits baked in (their colours kept, re-keyed to the new drawing). generate_line_art's `edit` and a
// picture edit of a line-art drawing without a mark both run this.
import { encode as encodePng } from 'fast-png';
import { decodeImage, lineArtEditPrompt, traceLineArt, type requestImage } from '../artwork';
import { colourStrokes, drawingFingerprint, drawingPicture, type LineArtStroke, type LineArtStyle } from '../../shared/lineart';
import type { Raster } from '../../shared/meshFormats';
import type { SvgDrawing } from '../../shared/svgFeatures';

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
