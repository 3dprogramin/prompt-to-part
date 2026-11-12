// The chat's picture edits in AI artwork, LayerTone, lithophane and line art mode: edit_picture
// changes part of a drawing or a stored photo (the user's saved mark, or a box the model picks) with
// the image model and keeps everything else exactly, under the same name; show_picture shows it with
// a grid to pick that box from.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { encode as encodePng } from 'fast-png';
import { z } from 'zod';
import { decodeImage } from '../artwork';
import { editPicture, outlined } from '../pictureEdit/index';
import { greyRaster } from '../pictureEdit/layerTone';
import { resizeTo } from '../pictureEdit/raster';
import type { PictureEditRequest } from '../../shared/api';
import { LAYERTONE_IMAGES_KEY, parseLayerToneImages } from '../../shared/layertone';
import { photoFingerprint } from '../../shared/pictureEdit/photo';
import type { Raster } from '../../shared/meshFormats';
import { ARTWORK_EDITS_KEY, parseArtworkEdits } from '../../shared/artworkEdits';
import { drawingFingerprint, drawingPicture, LINEART_EDITS_KEY, parseLineArtEdits, type LineArtStyle } from '../../shared/lineart';
import { boxMark, markMask, parsePictureMarks, PICTURE_MARKS_KEY, type PictureMark } from '../../shared/pictureEdit/mark';
import { renderDrawing, wholeWindow } from '../../shared/pictureEdit/render';
import { withSet } from '../../shared/pictureEdit/set';
import { formatCost } from '../../shared/duration';
import { DRAWINGS_KEY, parseDrawings, type SvgDrawing } from '../../shared/svgFeatures';
import type { AiImages, ToolContext } from './context';

/** The long side of the picture show_picture returns (pixels). */
const SHOW_LONG_SIDE = 1024;
/** The grid's colour, laid over the picture at GRID_ALPHA: light, but seen on black and on white. */
const GRID = [0, 150, 255], GRID_ALPHA = 0.55;
/** The most photos an edit takes (the picture edit's own limit). */
const MAX_PHOTOS = 4;
const PHOTO = /^data:image\/(png|jpeg|webp);base64,/;

const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const pngBase64 = (img: Raster) => Buffer.from(encodePng({ width: img.width, height: img.height, data: img.data, channels: 4 })).toString('base64');
const fromDataUrl = (url: string) => decodeImage(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));

/** The design's drawing `name` (own keys only), or null. */
function drawingOf(values: ToolContext['base'], name: string): SvgDrawing | null {
  const all = parseDrawings(values[DRAWINGS_KEY]);
  return Object.hasOwn(all, name) ? all[name] : null;
}

/** A picture as the tools see it: its shape (width / height), the fingerprint a mark on it is saved with, and how it prints, `heightPx` pixels high. */
interface Picture { aspect: number; fp: string; render: (heightPx: number) => Raster }

/**
 * The design's picture `name` (own keys only): AI artwork's drawing with its hand edits, a stored
 * photo, or a line-art drawing with its hand edits (drawn at `frame`'s size, or generate_line_art's
 * without one); null when there is none.
 */
function pictureOf(values: ToolContext['base'], name: string, mode: PictureTools['mode'], frame?: PictureEditRequest['lineArt'] | null): Picture | null {
  if (mode === 'lineart') {
    const d = drawingOf(values, name);
    if (!d) return null;
    const own = parseLineArtEdits(values[LINEART_EDITS_KEY]);
    const strokes = Object.hasOwn(own, name) && own[name].fp === drawingFingerprint(d) ? own[name].strokes : [];
    const k = frame?.k ?? 80;
    return { aspect: d.aspect, fp: drawingFingerprint(d), render: (h) => { const pic = drawingPicture(d, strokes, h, k, frame?.lineWidth ?? 1, frame?.k0 ?? k); return { width: pic.width, height: pic.height, data: pic.rgba }; } };
  }
  if (mode !== 'artwork') {
    const all = parseLayerToneImages(values[LAYERTONE_IMAGES_KEY]);
    if (!Object.hasOwn(all, name)) return null;
    const img = all[name], aspect = img.width / img.height;
    return { aspect, fp: photoFingerprint(img), render: (h) => resizeTo(greyRaster(img), Math.max(1, Math.round(h * aspect)), h) };
  }
  const d = drawingOf(values, name);
  if (!d) return null;
  const own = parseArtworkEdits(values[ARTWORK_EDITS_KEY]);
  const strokes = Object.hasOwn(own, name) && own[name].fp === drawingFingerprint(d) ? own[name].strokes : [];
  return { aspect: d.aspect, fp: drawingFingerprint(d), render: (h) => { const pic = renderDrawing(d, strokes, wholeWindow(d), h); return { width: pic.width, height: pic.height, data: pic.data }; } };
}

/** The user's saved mark on picture `name` (fingerprint `fp`), or null when there is none or it was made on another version of the picture. */
export function savedMark(values: ToolContext['base'], name: string, fp: string): PictureMark | null {
  const marks = parsePictureMarks(values[PICTURE_MARKS_KEY]);
  const m = Object.hasOwn(marks, name) ? marks[name] : undefined;
  return m && m.fp === fp ? m.mark : null;
}

/** The picture with a grid every 0.1 of its width and height, thicker at 0.5 (lines blended over the picture). */
export function withGrid(img: Raster): Raster {
  const { width: w, height: h } = img, data = new Uint8Array(img.data);
  const blend = (i: number, j: number) => {
    const o = (j * w + i) * 4;
    for (let c = 0; c < 3; c++) data[o + c] = Math.round(data[o + c] * (1 - GRID_ALPHA) + GRID[c] * GRID_ALPHA);
  };
  // Each line once, `thick` pixels wide, centred on its tenth.
  const lines = (n: number) => Array.from({ length: 9 }, (_, k) => {
    const at = Math.round(((k + 1) / 10) * n), thick = k === 4 ? 3 : 1;
    return Array.from({ length: thick }, (_, t) => at - (thick >> 1) + t).filter((p) => p >= 0 && p < n);
  }).flat();
  const xs = new Set(lines(w)), ys = new Set(lines(h));
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (xs.has(i) || ys.has(j)) blend(i, j);
  return { width: w, height: h, data };
}

/** Two pictures of the same height side by side on white, a small gap between them. */
function sideBySide(a: Raster, b: Raster): Raster {
  const h = Math.max(a.height, b.height), gap = Math.max(4, Math.round(h / 40)), w = a.width + gap + b.width;
  const data = new Uint8Array(w * h * 4).fill(255);
  for (const [img, x] of [[a, 0], [b, a.width + gap]] as const) {
    for (let j = 0; j < img.height; j++) data.set(img.data.subarray(j * img.width * 4, (j + 1) * img.width * 4), (j * w + x) * 4);
  }
  return { width: w, height: h, data };
}

/**
 * What edit_picture and show_picture edit: AI artwork's drawings, LayerTone's photos (`built`:
 * how a photo's part is built now, which a marked edit needs; null when no part is built from it)
 * or a lithophane's photo (nothing to pin: each pixel is its own thickness), or line art's drawings
 * (`frame`: where a drawing sits in the piece now, to draw its hand edits at their width; null when
 * the model does not use it; `style`: the menu's line-art style, which the edit draws for then).
 */
export type PictureTools = { mode: 'artwork' } | { mode: 'lithophane' } | { mode: 'layertone'; built: (picture: string) => Promise<PictureEditRequest['layerTone'] | null> }
  | { mode: 'lineart'; frame: (picture: string) => Promise<PictureEditRequest['lineArt'] | null>; style?: LineArtStyle };

/** The tools' words for each kind of picture (artwork's as they always were). */
const WORDS = {
  artwork: {
    noun: 'drawing',
    editor: 'brush editor',
    name: 'The drawing\'s name, as used with H.svg',
    show: 'Show one of the design\'s drawings as it prints (the user\'s hand edits in), with a light grid to pick a region for edit_picture: lines every 0.1 of its width and height from the top-left corner, thicker at 0.5. The user\'s saved mark, if there is one, is outlined in magenta.',
    edit: 'Change part of one of the design\'s drawings with the image model and keep everything else exactly as it is: swap a person or a face, change an object, fix a detail. The new drawing replaces the old one under the same name (in the drawing\'s own colours), so the script stays unchanged. The region is the user\'s saved mark ("mark"), or a box you pick from show_picture\'s grid; without one the whole picture is redrawn. Costs a few cents and takes ~20-60 s.',
  },
  layertone: {
    noun: 'picture',
    editor: 'picture editor',
    name: 'The picture\'s name, as used with H.layertone',
    show: 'Show one of the design\'s LayerTone pictures as stored (greyscale), with a light grid to pick a region for edit_picture: lines every 0.1 of its width and height from the top-left corner, thicker at 0.5. The user\'s saved mark, if there is one, is outlined in magenta.',
    edit: 'Change part of one of the design\'s LayerTone pictures with the image model and keep everything else exactly as it is: swap a person or a face, take something out, fix a detail. The new picture replaces the old one under the same name, so the script stays unchanged; with a region, automatic swap layers are kept as they were, so the print outside the region stays the same. The region is the user\'s saved mark ("mark"), or a box you pick from show_picture\'s grid; without one the whole picture is redone. Costs a few cents and takes ~20-60 s.',
  },
  lithophane: {
    noun: 'picture',
    editor: 'picture editor',
    name: 'The picture\'s name, as used with H.lithophane',
    show: 'Show one of the design\'s lithophane pictures as stored (greyscale), with a light grid to pick a region for edit_picture: lines every 0.1 of its width and height from the top-left corner, thicker at 0.5. The user\'s saved mark, if there is one, is outlined in magenta.',
    edit: 'Change part of one of the design\'s lithophane pictures with the image model and keep everything else exactly as it is: swap a person or a face, take something out, fix a detail. The new picture replaces the old one under the same name, so the script stays unchanged; with a region, the panel outside it stays exactly as it was. The region is the user\'s saved mark ("mark"), or a box you pick from show_picture\'s grid; without one the whole picture is redone. Costs a few cents and takes ~20-60 s.',
  },
  lineart: {
    noun: 'drawing',
    editor: 'Edit drawing brush',
    name: 'The drawing\'s name, as used with H.lineart',
    show: 'Show one of the design\'s line-art drawings as it prints (black on white, the user\'s hand edits in), with a light grid to pick a region for edit_picture: lines every 0.1 of its width and height from the top-left corner, thicker at 0.5. The user\'s saved mark, if there is one, is outlined in magenta.',
    edit: 'Change part of one of the design\'s line-art drawings with the image model and keep everything else exactly as it is: swap a face or a rider, change an object, fix a detail. The new lines are traced and joined to the drawing under the same name, so the script stays unchanged; with a region, the drawing and the user\'s hand edits outside it stay exactly as they were (the hand edits inside it are part of the new lines). The region is the user\'s saved mark ("mark"), or a box you pick from show_picture\'s grid; without one the whole drawing is redrawn, as generate_line_art with edit does. Costs a few cents and takes ~20-60 s.',
  },
};

/** edit_picture and show_picture, in AI artwork mode or (`kind`) LayerTone, lithophane or line art mode; `edit` is the picture edit (replaceable in tests). */
export function editPictureTools({ base, emit, drawImage }: ToolContext, images: AiImages, edit: typeof editPicture = editPicture, kind: PictureTools = { mode: 'artwork' }) {
  const mode = kind.mode, words = WORDS[mode], noun = words.noun;
  return [
    tool('show_picture', words.show, {
      picture: z.string().max(120).describe(words.name),
    }, async (a) => {
      const pic = pictureOf(base, a.picture, mode, kind.mode === 'lineart' && drawingOf(base, a.picture) ? await kind.frame(a.picture) : null);
      if (!pic) return fail(`There is no ${noun} "${a.picture}" in this design.`);
      const heightPx = Math.round(SHOW_LONG_SIDE / Math.max(pic.aspect, 1)), win = wholeWindow(pic);
      const shown = pic.render(heightPx);
      let img: Raster = withGrid(shown);
      const mark = savedMark(base, a.picture, pic.fp);
      if (mark) img = outlined(img, markMask(mark, { w: shown.width, h: shown.height, px: 1 / heightPx, x0: win.x0, y1: win.y1 }), 3);
      const png = pngBase64(img);
      emit({ type: 'step', step: { kind: 'render', ok: true, verbose: true, text: `Picture "${a.picture}" with a grid`, image: `data:image/png;base64,${png}` } });
      return {
        content: [
          { type: 'image', data: png, mimeType: 'image/png' },
          { type: 'text', text: `${noun === 'drawing' ? 'Drawing' : 'Picture'} "${a.picture}" (${shown.width}×${shown.height} pixels, ${pic.aspect.toFixed(3)} times as wide as high). The grid lines are every 0.1 of the width and height from the top-left corner (0, 0) to the bottom-right (1, 1), thicker at 0.5. A region for edit_picture is a box [x0, y0, x1, y1] in these fractions from the top-left; give it a little room around what changes (the whole head for a face). ${mark ? 'The user\'s saved mark is outlined in magenta: region "mark" uses it.' : 'The user has no saved mark on it.'}` },
        ],
      };
    }),
    tool('edit_picture', words.edit, {
      picture: z.string().max(120).describe(words.name),
      change: z.string().min(3).max(2000).describe('What to change, in plain words: who or what goes there, how it looks (e.g. "replace the man on the left with the woman in the attached photo, smiling")'),
      region: z.union([z.literal('mark'), z.tuple([z.number(), z.number(), z.number(), z.number()])]).optional()
        .describe('"mark" = the area the user selected in the brush editor; or [x0, y0, x1, y1], fractions 0..1 of the picture\'s width and height from its top-left corner (see show_picture); omit to change the whole picture'),
      use_attached_photos: z.boolean().optional().describe('Show the image model the photos the user attached to this message (the real person or thing for the part that changes)'),
    }, async (a) => {
      // A line-art drawing's hand edits are drawn in at the size the piece is built (the model run only for a drawing there is).
      const frame = kind.mode === 'lineart' && drawingOf(base, a.picture) ? await kind.frame(a.picture) : null;
      const pic = pictureOf(base, a.picture, mode, frame);
      if (!pic) return fail(`There is no ${noun} "${a.picture}" in this design.`);
      let mark: PictureMark | undefined;
      if (a.region === 'mark') {
        const saved = savedMark(base, a.picture, pic.fp);
        if (!saved) return fail(`There is no saved mark on "${a.picture}": ask the user to select the area with Select (C) in the ${words.editor}, or give the region as a box from show_picture's grid.`);
        mark = saved;
      } else if (a.region) {
        const box = boxMark(a.region, pic.aspect);
        if (!box.strokes.length) return fail(`The region [${a.region.join(', ')}] is an empty box: give [x0, y0, x1, y1] with x0 < x1 and y0 < y1, fractions 0..1 of the picture's width and height from its top-left corner (show_picture shows the grid).`);
        mark = box;
      }
      let photos: string[] = [];
      if (a.use_attached_photos) {
        photos = images.references.filter((p) => PHOTO.test(p)).slice(0, MAX_PHOTOS);
        if (!photos.length) return fail(images.references.length ? 'The photos attached to this message are not PNG, JPEG or WebP pictures.' : 'The user attached no photos to this message.');
      }
      // A marked LayerTone edit keeps the swap layers the part is built with now.
      let layerTone: PictureEditRequest['layerTone'] | null = null;
      if (kind.mode === 'layertone' && mark) {
        layerTone = await kind.built(a.picture);
        if (!layerTone) return fail(`No part of the model is built from "${a.picture}" yet: build it with H.layertone("${a.picture}", …) first, or edit the whole picture (no region).`);
      }
      emit({ type: 'step', step: { kind: 'status', text: `Changing "${a.picture}"…` } });
      try {
        const r = await edit({ mode, picture: a.picture, values: base, ...(mark ? { mark } : {}), change: a.change, photos, ...(layerTone ? { layerTone } : {}), ...(frame ? { lineArt: frame } : kind.mode === 'lineart' && kind.style ? { lineArt: { k: 0, lineWidth: 0, style: kind.style } } : {}) }, {
          image: drawImage, signal: images.signal, onStatus: (text) => emit({ type: 'step', step: { kind: 'status', text } }),
        });
        // From now on every check and render uses the new picture; the app keeps the same values.
        // (Changed in place: every tool of the generation holds this same `base`.)
        const next = withSet(base, r.set);
        for (const k of Object.keys(base)) if (!Object.hasOwn(next, k)) delete base[k];
        Object.assign(base, next);
        // (Swaps not kept: the print outside may change, so the version does not line up.)
        emit({ type: 'pictureEdited', set: r.set, info: { picture: a.picture, change: a.change, masked: r.masked, outsideSame: r.outsideSame && !r.swapsNotKept, cost: r.cost } });
        const cost = r.cost != null ? ` · ${formatCost(r.cost)}` : '';
        const notes = [
          r.masked ? (r.outsideSame ? (r.swapsNotKept ? `The ${noun} is unchanged outside the region; the print there may change (swap layers not kept).` : `Outside the region the ${noun} is unchanged.`) : `Outside the region the ${noun} changed too.`) : 'The whole picture was redrawn.',
          ...(r.swapsKept ? [r.swapsKept.note] : []),
          ...(r.swapsNotKept ? [r.swapsNotKept.note] : []),
          ...(r.lineArtJoins ? [r.lineArtJoins.note] : []),
          ...(r.offPalette ? [r.offPalette.note] : []),
          ...(r.simplified ? ['The new shapes were simplified harder to stay within the drawing\'s point limit.'] : []),
        ];
        emit({ type: 'step', step: {
          kind: 'render', ok: true, image: `data:image/png;base64,${pngBase64(sideBySide(fromDataUrl(r.before), fromDataUrl(r.after)))}`, detailOpen: true,
          text: `Picture "${a.picture}" edited, before / after, by ${r.model}${cost}`,
          detail: `${notes.join('\n')}\n\nPrompt sent to ${r.model}:\n\n${r.prompt}`,
        } });
        return {
          content: [
            { type: 'image', data: r.after.slice(r.after.indexOf(',') + 1), mimeType: 'image/png' },
            { type: 'text', text: `${r.masked ? 'The region' : 'The picture'} of "${a.picture}" after the edit (above). ${notes.join(' ')}${r.cost != null ? ` It cost ${formatCost(r.cost)}.` : ''}\nThe ${noun} is updated under the same name: keep the script unchanged, check it with render_model and submit. If the change itself is wrong, call edit_picture again with a clearer change.` },
          ],
        };
      } catch (e) {
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Picture edit: ${(e as Error).message}` } });
        return fail((e as Error).message);
      }
    }),
  ];
}
