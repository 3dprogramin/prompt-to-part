// A picture edit: part of a design's picture changed by the image model and nothing else. The
// picture is rendered as it prints (hand edits in), cropped around the user's mark at the size sent
// so a small face gets full detail, sent with the same crop outlined and the whole picture; the
// answer is lined up with what was sent using only the area outside the mark, pasted inside the
// mark with a soft edge, and brought back to the picture's source (artwork: traced in the drawing's
// own colours and joined to the old drawing so outside the mark nothing changes; line art: traced as
// line art and joined the same way, the hand edits in the mark taken back).
import Module, { type CrossSection } from 'manifold-3d';
import { encode as encodePng } from 'fast-png';
import { ASPECTS, decodeImage, imageModel, rgb, type ImageSize, type requestImage } from '../artwork';
import type { PictureEditRequest, PictureEditResponse, PictureMode } from '../../shared/api';
import type { Raster } from '../../shared/meshFormats';
import { ARTWORK_EDITS_KEY, cutStrokes, parseArtworkEdits } from '../../shared/artworkEdits';
import { drawingFingerprint, drawingPicture, LINE_ART_STYLES, LINEART_EDITS_KEY, MAX_LINEART_STROKES, parseLineArtEdits, type LineArtStroke, type LineArtStyle } from '../../shared/lineart';
import { markBounds, markMask, parsePictureMarks, PICTURE_MARKS_KEY, type PictureMark } from '../../shared/pictureEdit/mark';
import { renderDrawing, wholeWindow, type PictureWindow } from '../../shared/pictureEdit/render';
import { cleanDrawing, drawingColors, DRAWINGS_KEY, MAX_SVG_POINTS, parseDrawings, type SvgDrawing } from '../../shared/svgFeatures';
import { LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, layerToneLuma, parseLayerToneImages, toLayerToneImage } from '../../shared/layertone';
import { alignTo, chooseCrop, featherPaste, resizeTo, type AlignFailure } from './raster';
import { cleanBuild, greyRaster, sharedSwaps, SWAPS_NOT_KEPT_NOTE, swapsKeptNote, swapsToKeep } from './layerTone';
import { combineDrawing, offPalette, traceCrop } from './artwork';
import { pictureEditPrompt } from './prompt';
import { editWholeLineArt, markClears, traceLineCrop, type LineArtFrame } from './lineArt';

/** The picture size asked of the image model; the picture sent is drawn at the same size. */
export const PICTURE_EDIT_SIZE: ImageSize = '1K';
const LONG_SIDE: Record<ImageSize, number> = { '1K': 1024, '2K': 2048, '4K': 4096 };
/** The long side of the picture sent (pixels). */
const SENT_LONG_SIDE = LONG_SIDE[PICTURE_EDIT_SIZE];
/** Context around the mark in the crop: the mark's size again on each side (chooseCrop's margin). */
const CONTEXT_MARGIN = 1;
/** The finest crop: at most this many pixels per picture height (a tiny mark gets a smaller crop). */
const MAX_PX_PER_HEIGHT = 16 * SENT_LONG_SIDE;
/** How wide the paste's soft edge is, inside the mark (pixels of the crop). */
const FEATHER_PX = 4;
/** The same for a photo, in pixels of the stored picture (at most 800 a side: each a few of those sent). */
const PHOTO_FEATHER_PX = 3;
/** How thick the magenta outline of the mark is on the picture that shows the model where to change (pixels). */
const OUTLINE_PX = 3;
const MAGENTA = [255, 0, 255];
/**
 * Near-magenta in the image model's answer: the outline as it comes back, re-toned and softened a
 * little (pure magenta is 255, 0, 255; the design's filament colours are rarely this far toward it).
 */
const nearMagenta = (d: ArrayLike<number>, o: number) => d[o] > 200 && d[o + 1] < 80 && d[o + 2] > 200;
/** How far on both sides of the outline's band the check for an outline left in looks (pixels). */
const OUTLINE_SLACK_PX = 3;
/**
 * The most of that band that may be near-magenta (where the picture sent was not) before the answer
 * counts as keeping the outline. The band is OUTLINE_PX + 2 x OUTLINE_SLACK_PX = 9 pixels wide, so
 * an outline left in fills about a third of it, a thin or broken one still well over this; a magenta
 * shape of the change that only touches the mark's edge stays under it.
 */
export const MAX_OUTLINE_SHARE = 0.05;
/** The share of the mark (paper left out) that may want a colour the design has no filament for before the result says so. */
export const OFF_PALETTE_SHARE = 0.05;
/** The most photos sent with an edit, and the longest change. */
const MAX_PHOTOS = 4, MAX_CHANGE = 2000;
/** The most points a mark may have in all (a brushed mark has a few thousand; parsing alone allows 400 strokes of 2000). */
export const MAX_MARK_POINTS = 20_000;
/** The modes whose picture is a stored photo (greyscale under $images): LayerTone's and the lithophane's. */
const isPhoto = (m: PictureMode) => m === 'layertone' || m === 'lithophane';
const MODES: readonly PictureMode[] = ['artwork', 'layertone', 'lithophane', 'lineart'];
/** What a marked line-art edit says about the piece built from it. */
export const LINE_ART_JOINS_NOTE = 'Joins and bridges are worked out again for the whole piece: check them near the mark.';

/** A picture edit that failed with an HTTP status: 400 the request, 502 the image model's answer. */
export class PictureEditError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Why a marked edit's answer cannot be pasted: it does not line up, or it kept the guide outline. */
type PasteFailure = AlignFailure | 'outline left in';

/** What the user is told when the answer cannot be pasted. */
const PASTE_MESSAGES: Record<PasteFailure, string> = {
  'too little outside the mark': 'The mark covers nearly all of what was sent, so the answer can\'t be lined up with the picture: mark a smaller area, or edit the whole picture without a mark.',
  'different picture': 'The image model drew a different picture instead of changing only the marked area, so it can\'t be pasted in: try again, or describe the change more simply.',
  'moved past the range': 'The image model moved or resized the picture too much to line its answer up with it: try again.',
  'mark leaves the answer': 'The image model cut off part of the marked area at the edge of its answer: try again.',
  'outline left in': 'The image model left the guide outline in the picture: try again',
};

let manifold: Promise<typeof CrossSection> | null = null;
/** Manifold's CrossSection, started on first use (the 2D booleans that join the edit to the drawing). */
const crossSection = () => (manifold ??= Module().then((w) => { w.setup(); return w.CrossSection; }, (e) => { manifold = null; throw e; }));

/** A design value holding JSON (or the object itself) as an object to change one key of; {} when it is none. */
function rawObject(v: unknown): Record<string, unknown> {
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch { return {}; } }
  return o && typeof o === 'object' && !Array.isArray(o) ? { ...(o as Record<string, unknown>) } : {};
}

/** The request's mark, checked (bad strokes dropped), or null when it has none. */
function cleanMark(mark: unknown): PictureMark | null {
  return mark == null ? null : parsePictureMarks({ m: { fp: '', mark } }).m?.mark ?? { strokes: [] };
}

/** What is wrong with a picture edit request, or null. */
export function pictureEditProblem(r: Partial<PictureEditRequest> | null | undefined): string | null {
  if (!r || typeof r !== 'object') return 'Send a picture edit';
  if (!MODES.includes(r.mode as PictureMode)) return `mode: one of ${MODES.join(', ')}`;
  if (typeof r.change !== 'string' || !r.change.trim() || r.change.length > MAX_CHANGE) return `Say what to change (up to ${MAX_CHANGE} characters)`;
  const photos = r.photos ?? [];
  if (!Array.isArray(photos)) return 'photos: a list of data URLs';
  if (photos.length > MAX_PHOTOS) return `Send at most ${MAX_PHOTOS} photos`;
  if (!photos.every((p) => typeof p === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p))) return 'Each photo must be a PNG, JPEG or WebP data URL';
  if (!r.values || typeof r.values !== 'object' || typeof r.picture !== 'string') return 'Send the design\'s values and the picture\'s name';
  // Own keys only: 'constructor' or '__proto__' must not find the object's prototype.
  let aspect: number;
  if (isPhoto(r.mode as PictureMode)) {
    const images = parseLayerToneImages(r.values[LAYERTONE_IMAGES_KEY]);
    if (!Object.hasOwn(images, r.picture) || !Object.hasOwn(rawObject(r.values[LAYERTONE_IMAGES_KEY]), r.picture)) return `There is no picture "${r.picture}" in this design`;
    aspect = images[r.picture].width / images[r.picture].height;
  } else {
    const drawings = parseDrawings(r.values[DRAWINGS_KEY]);
    if (!Object.hasOwn(drawings, r.picture) || !Object.hasOwn(rawObject(r.values[DRAWINGS_KEY]), r.picture)) return `There is no drawing "${r.picture}" in this design`;
    const d = drawings[r.picture];
    const bad = drawingColors(d).filter((c) => !/^#[0-9a-f]{6}$/i.test(c));
    if (bad.length) return `Only a drawing in #rrggbb colours can be edited; "${r.picture}" has ${bad.map((c) => `"${c}"`).join(', ')}`;
    // Line art is one shape in one colour (traceLineArt's black): what is traced in the mark takes it.
    if (r.mode === 'lineart' && drawingColors(d).length !== 1) return `Only a line-art drawing in one colour can be edited; "${r.picture}" has ${drawingColors(d).length}`;
    aspect = d.aspect;
  }
  const mark = cleanMark(r.mark);
  if (mark) {
    const b = markBounds(mark), w = wholeWindow({ aspect });
    if (!b) return 'The mark is empty';
    if (mark.strokes.reduce((n, st) => n + st.points.length, 0) > MAX_MARK_POINTS) return `The mark has too many points (at most ${MAX_MARK_POINTS}): select the area with fewer strokes`;
    // A brush stroke wider than twice the picture's longer side covers it all from anywhere: not a brushed mark.
    if (mark.strokes.some((st) => st.width > 2 * Math.max(aspect, 1))) return 'A stroke of the mark is wider than twice the picture: select with a smaller brush';
    if (b.max[0] <= w.x0 || b.min[0] >= w.x0 + w.w || b.max[1] <= w.y1 - w.h || b.min[1] >= w.y1) return 'The mark is outside the picture';
    // Its automatic swap layers are kept as the part was built with them (editPhoto).
    if (r.mode === 'layertone' && !cleanBuild(r.layerTone)) return 'A marked LayerTone edit needs how the picture\'s part was built (its options and filaments): build the model first';
    // The mark goes after the drawing's hand edits as clears of them: the strokes kept are the last MAX_LINEART_STROKES.
    const hand = r.mode === 'lineart' ? handStrokes(r.values, r.picture).length : 0;
    if (hand && hand + mark.strokes.length > MAX_LINEART_STROKES) return `The drawing has ${hand} hand edits and the mark ${mark.strokes.length} strokes, over the ${MAX_LINEART_STROKES} a drawing keeps: select the area with fewer strokes, or clear some hand edits first`;
  }
  return null;
}

/** Which sides of a crop lie inside the picture (the mark may go on past them), not on its border. */
export interface Sides { left: boolean; top: boolean; right: boolean; bottom: boolean }

/** The crop sent for a marked edit: its window of the picture, its size in pixels, the image model's aspect for it. */
export interface Crop { win: PictureWindow; width: number; height: number; aspect: string; open: Sides }

/**
 * The crop around the mark (chooseCrop on a grid of the whole picture), on a grid fine enough that
 * the crop's long side is about `longSide` pixels: the window lies on whole pixels of that grid, so
 * rendering it at `height` pixels gives exactly `width` x `height`.
 */
export function cropAround(d: SvgDrawing, mark: PictureMark, longSide = SENT_LONG_SIDE): Crop {
  const b = markBounds(mark);
  if (!b) throw new Error('The mark is empty');
  const pick = (P: number) => {
    const W = Math.max(1, Math.round(d.aspect * P));
    const box = { x: (b.min[0] + d.aspect / 2) * P, y: (0.5 - b.max[1]) * P, w: (b.max[0] - b.min[0]) * P, h: (b.max[1] - b.min[1]) * P };
    return { ...chooseCrop(box, { width: W, height: P }, ASPECTS, CONTEXT_MARGIN), W, P };
  };
  // The crop's share of the picture barely depends on the grid: two refinements land it on size.
  let c = pick(longSide);
  for (let k = 0; k < 2; k++) c = pick(Math.max(1, Math.min(MAX_PX_PER_HEIGHT, Math.round((c.P * longSide) / Math.max(c.w, c.h)))));
  const { P } = c;
  return {
    win: { x0: -d.aspect / 2 + c.x / P, y1: 0.5 - c.y / P, w: c.w / P, h: c.h / P },
    width: c.w, height: c.h, aspect: c.aspect,
    open: { left: c.x > 0, top: c.y > 0, right: c.x + c.w < c.W, bottom: c.y + c.h < P },
  };
}

/**
 * Pastes `edited` into `orig` inside `mask` with a soft edge `featherPx` wide that ramps from 0 at
 * every edge of the mark, including where it runs into an `open` side of the crop (the mark goes on
 * past it, so that is an edge too); only the picture's own border is not one. Outside the mask every
 * pixel stays `orig`'s.
 */
export function pasteMark(orig: Raster, edited: Raster, mask: Uint8Array, featherPx: number, open: Sides): Raster {
  const l = +open.left, t = +open.top, r = +open.right, b = +open.bottom;
  if (!(l || t || r || b)) return featherPaste(orig, edited, mask, featherPx);
  // A ring of unmarked pixels on the open sides makes them edges.
  const w = orig.width, h = orig.height, W = w + l + r, H = h + t + b;
  const pad = (img: Raster): Raster => {
    const data = new Uint8Array(W * H * 4);
    for (let j = 0; j < h; j++) data.set(img.data.subarray(j * w * 4, (j + 1) * w * 4), ((j + t) * W + l) * 4);
    return { width: W, height: H, data };
  };
  const m = new Uint8Array(W * H);
  for (let j = 0; j < h; j++) m.set(mask.subarray(j * w, (j + 1) * w), (j + t) * W + l);
  const out = featherPaste(pad(orig), pad(edited), m, featherPx);
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) data.set(out.data.subarray(((j + t) * W + l) * 4, ((j + t) * W + l + w) * 4), j * w * 4);
  return { width: w, height: h, data };
}

/** The mark shrunk by `r` pixels (a square neighbourhood; past the picture's edge counts as outside). */
function shrinkMark(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let inner = mask;
  for (let k = 0; k < r; k++) {
    const across = new Uint8Array(w * h), down = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = j * w + i;
      across[p] = inner[p] && i > 0 && inner[p - 1] && i < w - 1 && inner[p + 1] ? 1 : 0;
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = j * w + i;
      down[p] = across[p] && j > 0 && across[p - w] && j < h - 1 && across[p + w] ? 1 : 0;
    }
    inner = down;
  }
  return inner;
}

/** The mark grown by `r` pixels (a square neighbourhood). */
function growMark(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const across = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!mask[j * w + i]) continue;
    across.fill(1, j * w + Math.max(0, i - r), j * w + Math.min(w, i + r + 1));
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!across[j * w + i]) continue;
    for (let q = Math.max(0, j - r); q <= Math.min(h - 1, j + r); q++) out[q * w + i] = 1;
  }
  return out;
}

/** The picture with the mark's outline drawn in magenta, `thick` pixels wide, just inside the mark. */
export function outlined(img: Raster, mask: Uint8Array, thick: number): Raster {
  const w = img.width, h = img.height, inner = shrinkMark(mask, w, h, thick);
  const data = new Uint8Array(img.data);
  for (let p = 0; p < w * h; p++) if (mask[p] && !inner[p]) data.set(MAGENTA, p * 4);
  return { width: w, height: h, data };
}

/**
 * How much of the guide outline the lined-up answer kept: the share of the band it was drawn in
 * (`thick` pixels inside the mark), grown by OUTLINE_SLACK_PX on both sides for a fit a pixel or two
 * off, that is near-magenta in `answer` where `sent` was not. The model may answer with the outlined
 * picture edited, and the outline lies inside the mark, where the alignment does not look.
 */
export function outlineShare(answer: Raster, sent: Raster, mask: Uint8Array, thick: number): number {
  const w = sent.width, h = sent.height;
  const outer = growMark(mask, w, h, OUTLINE_SLACK_PX), inner = shrinkMark(mask, w, h, thick + OUTLINE_SLACK_PX);
  let band = 0, left = 0;
  for (let p = 0; p < w * h; p++) {
    if (!outer[p] || inner[p]) continue;
    band++;
    if (nearMagenta(answer.data, p * 4) && !nearMagenta(sent.data, p * 4)) left++;
  }
  return band ? left / band : 0;
}

const pngUrl = (img: Raster) => `data:image/png;base64,${Buffer.from(encodePng({ width: img.width, height: img.height, data: img.data, channels: 4 })).toString('base64')}`;
const ratioOf = (aspect: string) => { const [w, h] = aspect.split(':').map(Number); return w / h; };
/** The image model's picture shape closest to `aspect` (width / height). */
const nearestAspect = (aspect: number) => ASPECTS.reduce((best, a) => (Math.abs(Math.log(ratioOf(a) / aspect)) < Math.abs(Math.log(ratioOf(best) / aspect)) ? a : best));

/** The picture padded with white to `ratio` (width / height), centred: the padded picture and where the picture sits in it. */
function padTo(img: Raster, ratio: number): { padded: Raster; x: number; y: number } {
  const W = Math.max(img.width, Math.round(img.height * ratio)), H = Math.max(img.height, Math.round(img.width / ratio));
  const x = (W - img.width) >> 1, y = (H - img.height) >> 1, data = new Uint8Array(W * H * 4).fill(255);
  for (let j = 0; j < img.height; j++) data.set(img.data.subarray(j * img.width * 4, (j + 1) * img.width * 4), ((j + y) * W + x) * 4);
  return { padded: { width: W, height: H, data }, x, y };
}

/**
 * The picture in the shape the image model is asked for (`ratio`, width / height): padded with
 * white when it is more than 1 % off (`bands`), else as it is (resizing the answer back covers the
 * rounding). With where the picture sits in what is sent.
 */
function fitShape(img: Raster, ratio: number): { padded: Raster; x: number; y: number; bands: boolean } {
  if (Math.abs(Math.log(img.width / img.height / ratio)) <= 0.01) return { padded: img, x: 0, y: 0, bands: false };
  return { ...padTo(img, ratio), bands: true };
}

/** A mask (one byte per pixel of a `w`-wide picture) placed at (x, y) in a larger picture `W` x `H`, 0 around it. */
function padMask(mask: Uint8Array, w: number, W: number, H: number, x: number, y: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let j = 0; j < mask.length / w; j++) out.set(mask.subarray(j * w, (j + 1) * w), (j + y) * W + x);
  return out;
}

/** A part of a picture. */
function cut(img: Raster, x: number, y: number, w: number, h: number): Raster {
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) data.set(img.data.subarray(((j + y) * img.width + x) * 4, ((j + y) * img.width + x + w) * 4), j * w * 4);
  return { width: w, height: h, data };
}

/** A colour's name in plain words (rough: enough to say which colour a design lacks). */
export function colourName(c: string): string {
  const [r, g, b] = rgb(c).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.15 || d < 0.08) return l < 0.2 ? 'black' : l > 0.85 ? 'white' : 'grey';
  const hue = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  if (hue < 15 || hue >= 340) return l < 0.3 ? 'dark red' : l > 0.75 ? 'pink' : 'red';
  if (hue < 45) return l < 0.45 ? 'brown' : s < 0.5 ? 'tan' : 'orange';
  if (hue < 70) return l < 0.35 ? 'olive' : 'yellow';
  if (hue < 160) return 'green';
  if (hue < 200) return 'teal';
  if (hue < 255) return 'blue';
  if (hue < 290) return 'purple';
  return 'pink';
}

/** The colour of `colours` nearest to `c` (RGB). */
function nearestColour(c: string, colours: string[]): string {
  const [r, g, b] = rgb(c);
  const dist = (h: string) => { const [R, G, B] = rgb(h); return (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2; };
  return colours.reduce((best, h) => (dist(h) < dist(best) ? h : best));
}

/** The off-palette part of the result, when it is more than OFF_PALETTE_SHARE of the mark, in plain words. */
function offPaletteNote(answer: Raster, mask: Uint8Array, colours: string[]): PictureEditResponse['offPalette'] {
  const off = offPalette(answer, mask, colours);
  if (!(off.share > OFF_PALETTE_SHARE) || !off.colour) return undefined;
  const name = colourName(off.colour), share = Math.round(off.share * 100);
  return {
    share: off.share, colour: off.colour,
    note: `The change wants ${name} (${off.colour}) on ${share} % of the marked area, a colour the design has no filament for: it prints in the nearest filament colour (${nearestColour(off.colour, colours)}). Add a ${name} filament to print it in ${name}.`,
  };
}

type Deps = { image: typeof requestImage; signal?: AbortSignal; onStatus?: (t: string) => void; id?: string };
/** A line-art edit's prompt: the piece the drawing is for and its width. */
type LineArtPiece = { style: LineArtStyle; width?: number };
/** The image model's answer to an edit, decoded, with the prompt it was asked with. */
type Asked = Awaited<ReturnType<typeof requestImage>> & { prompt: string; answer: Raster };
/** Asks the image model with the mode's prompt; `padded`: the picture sent has white bands added to give it the aspect asked for. */
type Ask = (aspect: string, references: string[], padded: boolean) => Promise<Asked>;
/** One line per edit in the server log with the numbers to tune the alignment by (no prompt, no picture). */
type Log = (fields: Record<string, unknown>) => void;

function asker(r: PictureEditRequest, deps: Deps, masked: boolean, colours?: string[], piece?: LineArtPiece): Ask {
  return async (aspect, references, padded) => {
    const prompt = pictureEditPrompt({ mode: r.mode, change: r.change, masked, colours, photos: (r.photos ?? []).length, padded, ...piece });
    deps.onStatus?.(`Changing "${r.picture}" with ${imageModel()}…`);
    const out = await deps.image(prompt, aspect, references, deps.signal, deps.onStatus, PICTURE_EDIT_SIZE);
    if (deps.signal?.aborted) throw new Error('Stopped');
    return { ...out, prompt, answer: decodeImage(Buffer.from(out.image.data, 'base64')) };
  };
}
const logger = (r: PictureEditRequest, deps: Deps, masked: boolean): Log =>
  (fields) => console.log('[picture-edit]', JSON.stringify({ id: deps.id, picture: r.picture, masked, ...fields }));
const size = (img: Raster) => `${img.width}x${img.height}`;
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * The marked area of `crop` changed by the image model: the crop (in the model's `aspect`; padded
 * to it and cut back when it is off it) sent with the same crop outlined where `inMark` is 1 (on the
 * crop's pixels), `whole` and the photos; the answer lined up with the crop outside the mark
 * (`tones`: its brightness and contrast matched too). Throws PictureEditError 502 when the answer
 * can't be pasted: it does not line up, or it kept the outline. Returns the answer lined up on the
 * crop's pixels, all of it (the caller pastes the mark).
 */
async function askInMark(crop: Raster, inMark: Uint8Array, aspect: string, whole: Raster, photos: string[], ask: Ask, log: Log, tones: boolean) {
  // A crop that fits no allowed aspect (a mark wider than 21:9) is padded to the one asked for, and cut back.
  const { padded, x, y, bands } = fitShape(crop, ratioOf(aspect));
  const sentMark = bands ? padMask(inMark, crop.width, padded.width, padded.height, x, y) : inMark;
  const asked = await ask(aspect, [pngUrl(padded), pngUrl(outlined(padded, sentMark, OUTLINE_PX)), pngUrl(whole), ...photos], bands);
  // Outside: the crop's own pixels outside the mark. The padding is neither (the model may redraw
  // it, and it must not count toward the outside a match needs).
  const outside = inMark.map((v) => 1 - v);
  const t0 = performance.now();
  const fit = alignTo(asked.answer, padded, bands ? padMask(outside, crop.width, padded.width, padded.height, x, y) : outside, { mark: sentMark, tones });
  const outline = fit.ok ? outlineShare(fit.image, padded, sentMark, OUTLINE_PX) : undefined;
  const failure: PasteFailure | undefined = !fit.ok ? fit.reason! : outline! > MAX_OUTLINE_SHARE ? 'outline left in' : undefined;
  const align = { error: round(fit.error, 2), shift: [round(fit.shift[0], 2), round(fit.shift[1], 2)] as [number, number], scale: [round(fit.scale[0], 5), round(fit.scale[1], 5)] as [number, number], answer: [asked.answer.width, asked.answer.height] as [number, number] };
  log({
    answer: size(asked.answer), sent: size(padded), error: align.error, shift: align.shift, scale: align.scale, offMark: fit.offMark,
    outline: outline === undefined ? undefined : round(outline, 4), reason: failure, ms: Math.round(performance.now() - t0),
  });
  if (failure) throw new PictureEditError(502, PASTE_MESSAGES[failure]);
  return { lined: bands ? cut(fit.image, x, y, crop.width, crop.height) : fit.image, asked, align };
}

/** The whole picture `pic` changed by the image model: sent padded to the nearest aspect it draws, the answer back at `pic`'s size. */
async function askWhole(pic: Raster, photos: string[], ask: Ask, log: Log) {
  const aspect = nearestAspect(pic.width / pic.height), { padded, x, y, bands } = fitShape(pic, ratioOf(aspect));
  const asked = await ask(aspect, [pngUrl(padded), ...photos], bands);
  log({ answer: size(asked.answer), sent: size(padded) });
  return { pasted: cut(resizeTo(asked.answer, padded.width, padded.height), x, y, pic.width, pic.height), asked };
}

/** The values' JSON object at `key` with `name` set to `value`, as JSON. */
const withEntry = (v: unknown, name: string, value: unknown) => JSON.stringify({ ...rawObject(v), [name]: value });

/** The picture's mark taken out of the values' marks (null: none left). */
function marksWithout(values: PictureEditRequest['values'], picture: string): string | null {
  const marks = rawObject(values[PICTURE_MARKS_KEY]);
  delete marks[picture];
  return Object.keys(marks).length ? JSON.stringify(marks) : null;
}

/**
 * Edits the picture: AI artwork or line art (the drawing named `picture` in the values' $drawings,
 * with its hand edits) or a LayerTone or lithophane photo (the picture named `picture` in $images).
 * With a mark, only the marked area changes: the answer that does not line up with what was sent
 * fails (PictureEditError 502) rather than paste a moved piece. Without one, the whole picture is
 * sent, padded to the nearest aspect the model draws, and replaced (line art: as generate_line_art's
 * edit does it, editLineArt). Returns the values to set: the drawing or picture under the same name,
 * for artwork the hand edits cut by the mark (dropped for a whole-picture edit) and re-keyed, for
 * LayerTone the swap layers kept (editPhoto), and the picture's mark removed.
 */
export async function editPicture(r: PictureEditRequest, deps: Deps): Promise<PictureEditResponse> {
  const problem = pictureEditProblem(r);
  if (problem) throw new PictureEditError(400, problem);
  return isPhoto(r.mode) ? editPhoto(r, deps) : r.mode === 'lineart' ? editLineArt(r, deps) : editArtwork(r, deps);
}

async function editArtwork(r: PictureEditRequest, deps: Deps): Promise<PictureEditResponse> {
  const d = parseDrawings(r.values[DRAWINGS_KEY])[r.picture];
  const colours = drawingColors(d);
  const photos = r.photos ?? [];
  const edits = parseArtworkEdits(r.values[ARTWORK_EDITS_KEY]);
  const own = Object.hasOwn(edits, r.picture) ? edits[r.picture] : undefined;
  const strokes = own && own.fp === drawingFingerprint(d) ? own.strokes : [];
  const mark = cleanMark(r.mark);
  const C = await crossSection();
  const ask = asker(r, deps, !!mark, colours);
  const log = logger(r, deps, !!mark);
  const background = (labels: Int16Array) => Uint8Array.from(labels, (l) => (l < 0 ? 1 : 0));

  let sent: string, shown: PictureWindow, pasted: Raster, fresh: SvgDrawing, area: PictureMark, note: PictureEditResponse['offPalette'];
  let asked: Asked;
  let align: PictureEditResponse['align'];
  if (mark) {
    const crop = cropAround(d, mark);
    const pic = renderDrawing(d, strokes, crop.win, crop.height), raster: Raster = { width: pic.width, height: pic.height, data: pic.data };
    const inMark = markMask(mark, { w: crop.width, h: crop.height, px: crop.win.h / crop.height, x0: crop.win.x0, y1: crop.win.y1 });
    const whole = renderDrawing(d, strokes, wholeWindow(d), Math.round(SENT_LONG_SIDE / Math.max(d.aspect, 1)));
    sent = pngUrl(raster);
    shown = crop.win;
    const res = await askInMark(raster, inMark, crop.aspect, whole, photos, ask, log, false);
    ({ asked, align } = res);
    const lined = res.lined;
    pasted = pasteMark(raster, lined, inMark, FEATHER_PX, crop.open);
    fresh = traceCrop(pasted, colours, crop.win, background(pic.labels), d.name, MAX_SVG_POINTS);
    area = mark;
    // The colour check: the answer's colours in the mark, where they do not trace as paper.
    const traced = renderDrawing(fresh, [], crop.win, crop.height).labels;
    note = offPaletteNote(lined, inMark.map((v, p) => (v && traced[p] >= 0 ? 1 : 0)), colours);
  } else {
    const heightPx = Math.round(SENT_LONG_SIDE / Math.max(d.aspect, 1));
    const pic = renderDrawing(d, strokes, wholeWindow(d), heightPx), raster: Raster = { width: pic.width, height: pic.height, data: pic.data };
    sent = pngUrl(raster);
    ({ pasted, asked } = await askWhole(raster, photos, ask, log));
    // Paper: where it was, and what touches the picture's edges (the whole subject may change).
    const paper = background(pic.labels);
    for (let i = 0; i < pic.width; i++) paper[i] = paper[(pic.height - 1) * pic.width + i] = 1;
    for (let j = 0; j < pic.height; j++) paper[j * pic.width] = paper[j * pic.width + pic.width - 1] = 1;
    const win = { ...wholeWindow(d), w: pic.width / heightPx };
    shown = win;
    fresh = traceCrop(pasted, colours, win, paper, d.name, MAX_SVG_POINTS);
    // The whole picture is the area replaced: a square past every side of it.
    area = { strokes: [{ width: 2 * Math.max(d.aspect, 1) + 1, points: [[0, 0]], shape: 'square' }] };
    const traced = renderDrawing(fresh, [], win, heightPx).labels;
    note = offPaletteNote(pasted, Uint8Array.from(traced, (l) => (l >= 0 ? 1 : 0)), colours);
  }

  let combined: ReturnType<typeof combineDrawing>;
  try {
    combined = combineDrawing(d, fresh, area, C);
  } catch (e) {
    throw new PictureEditError(400, (e as Error).message);
  }
  // As the app will read it back, so the hand edits' fingerprint matches.
  const drawing = cleanDrawing(combined.drawing);
  if (!drawing) throw new PictureEditError(400, 'The edited drawing is empty or too detailed to keep');

  const set: Record<string, string | null> = {};
  set[DRAWINGS_KEY] = withEntry(r.values[DRAWINGS_KEY], r.picture, drawing);
  if (strokes.length) {
    // The model saw the strokes drawn in: inside the mark the new picture already shows them.
    const edits = rawObject(r.values[ARTWORK_EDITS_KEY]);
    if (mark) edits[r.picture] = { fp: drawingFingerprint(drawing), strokes: cutStrokes(strokes, mark, C) };
    else delete edits[r.picture];
    set[ARTWORK_EDITS_KEY] = Object.keys(edits).length ? JSON.stringify(edits) : null;
  }
  set[PICTURE_MARKS_KEY] = marksWithout(r.values, r.picture);

  return {
    // A whole-picture edit has no outside: nothing to say about it.
    set, before: sent, after: pngUrl(pasted), window: shown, masked: !!mark, outsideSame: !!mark && combined.outsideSame,
    ...(combined.simplified ? { simplified: true } : {}),
    ...(note ? { offPalette: note } : {}),
    ...(align ? { align } : {}),
    prompt: asked.prompt, model: asked.model, cost: asked.cost,
  };
}

/**
 * A stored photo's edit (LayerTone's or a lithophane's, the same picture store). The stored picture (grey, at most 800 pixels a side) is cropped around
 * the mark on its own pixels and sent at about SENT_LONG_SIDE; the answer is lined up (tones too:
 * photos often come back re-toned), brought back to the stored pixels and pasted into the whole
 * stored picture inside the mark only, so every byte outside it stays as it was. The picture is
 * stored under the same name at the same size. A marked edit of a picture whose part was built with
 * automatic swap layers keeps them (swapsToKeep, set in the LayerTone setup), so the print outside
 * the mark keeps its heights too; nothing else in the setup changes. When the build prints another
 * LayerTone picture too (the swaps are shared), they are not kept, and the result says so.
 */
async function editPhoto(r: PictureEditRequest, deps: Deps): Promise<PictureEditResponse> {
  const img = parseLayerToneImages(r.values[LAYERTONE_IMAGES_KEY])[r.picture];
  const photos = r.photos ?? [], mark = cleanMark(r.mark);
  const ask = asker(r, deps, !!mark), log = logger(r, deps, !!mark);
  const W = img.width, H = img.height, aspect = W / H, full = greyRaster(img);
  // The whole picture as the model sees it: about SENT_LONG_SIDE on its long side.
  const wholeHeight = Math.round(SENT_LONG_SIDE / Math.max(aspect, 1));
  const whole = resizeTo(full, Math.max(1, Math.round(wholeHeight * aspect)), wholeHeight);

  let before: string, after: string, shown: PictureWindow, pasted: Raster, asked: Asked;
  let align: PictureEditResponse['align'], kept: number[] | null = null, notKept = false, fullMask: Uint8Array | null = null;
  if (mark) {
    // A lithophane maps each pixel to a thickness on its own: nothing to keep for the print outside the mark.
    if (r.mode === 'layertone') {
      const build = cleanBuild(r.layerTone)!;
      kept = swapsToKeep(img, build, r.values);
      // Swaps shared with another LayerTone picture would change its print: not kept, and said.
      if (kept && sharedSwaps(build)) { kept = null; notKept = true; }
    }
    fullMask = markMask(mark, { w: W, h: H, px: 1 / H, x0: -aspect / 2, y1: 0.5 });
    const b = markBounds(mark)!;
    const c = chooseCrop({ x: (b.min[0] + aspect / 2) * H, y: (0.5 - b.max[1]) * H, w: (b.max[0] - b.min[0]) * H, h: (b.max[1] - b.min[1]) * H }, { width: W, height: H }, ASPECTS, CONTEXT_MARGIN);
    const win = { x0: -aspect / 2 + c.x / H, y1: 0.5 - c.y / H, w: c.w / H, h: c.h / H };
    const crop = cut(full, c.x, c.y, c.w, c.h);
    // Sent larger than stored (the model sees detail better), the mark on the pixels sent.
    const k = SENT_LONG_SIDE / Math.max(c.w, c.h), sw = Math.max(1, Math.round(c.w * k)), sh = Math.max(1, Math.round(c.h * k));
    const sent = resizeTo(crop, sw, sh);
    const inMark = markMask(mark, { w: sw, h: sh, px: win.h / sh, x0: win.x0, y1: win.y1 });
    const res = await askInMark(sent, inMark, c.aspect, whole, photos, ask, log, true);
    ({ asked, align } = res);
    // Back on the stored pixels, in place in the whole picture, then pasted inside the mark only.
    const back = resizeTo(res.lined, c.w, c.h), edited = new Uint8Array(full.data);
    for (let j = 0; j < c.h; j++) edited.set(back.data.subarray(j * c.w * 4, (j + 1) * c.w * 4), ((c.y + j) * W + c.x) * 4);
    pasted = featherPaste(full, { width: W, height: H, data: edited }, fullMask, PHOTO_FEATHER_PX);
    before = pngUrl(crop);
    after = pngUrl(cut(pasted, c.x, c.y, c.w, c.h));
    shown = win;
  } else {
    const res = await askWhole(whole, photos, ask, log);
    asked = res.asked;
    pasted = resizeTo(res.pasted, W, H);
    before = pngUrl(full);
    after = pngUrl(pasted);
    shown = wholeWindow({ aspect });
  }

  // Greyscale at exactly the stored size (no resampling: outside the mark the bytes are the old ones).
  const next = toLayerToneImage(r.picture, W, H, pasted.data);
  let outsideSame = false;
  if (fullMask) {
    const was = layerToneLuma(img), now = layerToneLuma(next);
    outsideSame = was.every((v, p) => fullMask![p] === 1 || now[p] === v);
  }
  const set: Record<string, string | null> = {};
  set[LAYERTONE_IMAGES_KEY] = withEntry(r.values[LAYERTONE_IMAGES_KEY], r.picture, next);
  if (kept) set[LAYERTONE_KEY] = JSON.stringify({ ...rawObject(r.values[LAYERTONE_KEY]), swaps: kept });
  set[PICTURE_MARKS_KEY] = marksWithout(r.values, r.picture);
  return {
    set, before, after, window: shown, masked: !!mark, outsideSame,
    ...(align ? { align } : {}),
    ...(kept ? { swapsKept: { swaps: kept, note: swapsKeptNote(kept) } } : {}),
    ...(notKept ? { swapsNotKept: { note: SWAPS_NOT_KEPT_NOTE } } : {}),
    prompt: asked.prompt, model: asked.model, cost: asked.cost,
  };
}

/** The line-art hand edits of drawing `name` in the values, made on it as it is now (own keys only); none else. */
function handStrokes(values: PictureEditRequest['values'], name: string): LineArtStroke[] {
  const all = parseLineArtEdits(values[LINEART_EDITS_KEY]), d = parseDrawings(values[DRAWINGS_KEY]);
  const own = Object.hasOwn(all, name) && Object.hasOwn(d, name) ? all[name] : undefined;
  return own && own.fp === drawingFingerprint(d[name]) ? own.strokes : [];
}

/** Where the drawing sits in the piece, as the request says, checked: what is not a positive number is generate_line_art's default without a model. */
function lineArtPiece(f: PictureEditRequest['lineArt']): LineArtFrame & LineArtPiece {
  const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const k = pos(f?.k) ?? 80;
  return { k, k0: pos(f?.k0) ?? k, lineWidth: pos(f?.lineWidth) ?? 1, style: LINE_ART_STYLES.includes(f?.style as LineArtStyle) ? f!.style! : 'outline', width: pos(f?.width) };
}

/**
 * A line-art drawing's edit (one shape in one colour, H.lineart). Its hand edits are drawn in at
 * the size the piece is built (`lineArt` in the request). Without a mark: editWholeLineArt, the way
 * generate_line_art's edit goes (the answer traced at its own shape, the hand edits baked, their
 * colours kept). With one: the crop rendered at the size sent, the answer pasted inside the mark,
 * traced as line art and joined to the old drawing (combineDrawing: the lines crossing the mark's
 * edge meet, so it stays one piece where it was), and the mark appended to the hand edits as clears
 * ('restore'): inside it the model saw them drawn in, so the new drawing already has them.
 */
async function editLineArt(r: PictureEditRequest, deps: Deps): Promise<PictureEditResponse> {
  const d = parseDrawings(r.values[DRAWINGS_KEY])[r.picture];
  const ink = drawingColors(d)[0], photos = r.photos ?? [], mark = cleanMark(r.mark);
  const strokes = handStrokes(r.values, r.picture), piece = lineArtPiece(r.lineArt);
  const log = logger(r, deps, !!mark);
  const set: Record<string, string | null> = {};
  /** The drawing as the app will read it back (so the hand edits' fingerprint matches), or why it can't be kept. */
  const keepable = (drawing: SvgDrawing, status: number) => {
    const clean = cleanDrawing(drawing);
    if (!clean) throw new PictureEditError(status, `The edited drawing is empty or too detailed to keep (at most ${MAX_SVG_POINTS.toLocaleString('en')} points)`);
    return clean;
  };
  /** The hand edits on the new drawing: `next` (none: dropped), the other drawings' as they were. */
  const withEdits = (drawing: SvgDrawing, next: LineArtStroke[]) => {
    const edits = rawObject(r.values[LINEART_EDITS_KEY]);
    if (next.length) edits[r.picture] = { fp: drawingFingerprint(drawing), strokes: next }; else delete edits[r.picture];
    set[LINEART_EDITS_KEY] = Object.keys(edits).length ? JSON.stringify(edits) : null;
  };

  if (!mark) {
    deps.onStatus?.(`Changing "${r.picture}" with ${imageModel()}…`);
    const w = await editWholeLineArt({ drawing: d, name: r.picture, strokes, frame: piece, change: r.change, photos, width: piece.width, style: piece.style, aspect: nearestAspect(d.aspect) }, deps);
    if (deps.signal?.aborted) throw new Error('Stopped');
    log({ answer: size(w.answer), sent: size(w.sent) });
    const drawing = keepable(w.traced.drawing, 502);
    set[DRAWINGS_KEY] = withEntry(r.values[DRAWINGS_KEY], r.picture, drawing);
    if (strokes.length) withEdits(drawing, w.edits?.strokes ?? []);
    set[PICTURE_MARKS_KEY] = marksWithout(r.values, r.picture);
    // A whole-picture edit has no outside: nothing to say about it.
    return { set, before: pngUrl(w.sent), after: pngUrl(w.answer), window: wholeWindow(d), masked: false, outsideSame: false, prompt: w.prompt, model: w.model, cost: w.cost };
  }

  const C = await crossSection();
  const render = (heightPx: number, win?: PictureWindow): Raster => {
    const pic = drawingPicture(d, strokes, heightPx, piece.k, piece.lineWidth, piece.k0, win);
    return { width: pic.width, height: pic.height, data: pic.rgba };
  };
  const crop = cropAround(d, mark);
  const raster = render(crop.height, crop.win);
  const inMark = markMask(mark, { w: crop.width, h: crop.height, px: crop.win.h / crop.height, x0: crop.win.x0, y1: crop.win.y1 });
  const whole = render(Math.round(SENT_LONG_SIDE / Math.max(d.aspect, 1)));
  const { lined, asked, align } = await askInMark(raster, inMark, crop.aspect, whole, photos, asker(r, deps, true, undefined, piece), log, false);
  const pasted = pasteMark(raster, lined, inMark, FEATHER_PX, crop.open);
  let combined: ReturnType<typeof combineDrawing>;
  try {
    combined = combineDrawing(d, traceLineCrop(pasted, crop.win, d.name, ink), mark, C);
  } catch (e) {
    throw new PictureEditError(400, (e as Error).message);
  }
  const drawing = keepable(combined.drawing, 400);
  set[DRAWINGS_KEY] = withEntry(r.values[DRAWINGS_KEY], r.picture, drawing);
  // (No hand edits: nothing to take back.)
  if (strokes.length) withEdits(drawing, [...strokes, ...markClears(mark)]);
  set[PICTURE_MARKS_KEY] = marksWithout(r.values, r.picture);
  return {
    set, before: pngUrl(raster), after: pngUrl(pasted), window: crop.win, masked: true, outsideSame: combined.outsideSame,
    ...(combined.simplified ? { simplified: true } : {}),
    align, lineArtJoins: { note: LINE_ART_JOINS_NOTE },
    prompt: asked.prompt, model: asked.model, cost: asked.cost,
  };
}
