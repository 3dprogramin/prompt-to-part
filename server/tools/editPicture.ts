// The chat's picture edits in AI artwork mode: edit_picture changes part of a drawing (the user's
// saved mark, or a box the model picks) with the image model and keeps everything else exactly,
// under the same name; show_picture shows a drawing with a grid to pick that box from.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { encode as encodePng } from 'fast-png';
import { z } from 'zod';
import { decodeImage } from '../artwork';
import { editPicture, outlined } from '../pictureEdit/index';
import type { Raster } from '../../shared/meshFormats';
import { ARTWORK_EDITS_KEY, parseArtworkEdits } from '../../shared/artworkEdits';
import { drawingFingerprint } from '../../shared/lineart/strokes';
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

/** The user's saved mark on drawing `d` (named `name`), or null when there is none or it was made on another version of the picture. */
export function savedMark(values: ToolContext['base'], name: string, d: SvgDrawing): PictureMark | null {
  const marks = parsePictureMarks(values[PICTURE_MARKS_KEY]);
  const m = Object.hasOwn(marks, name) ? marks[name] : undefined;
  return m && m.fp === drawingFingerprint(d) ? m.mark : null;
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

/** edit_picture and show_picture, in AI artwork mode; `edit` is the picture edit (replaceable in tests). */
export function editPictureTools({ base, emit, drawImage }: ToolContext, artwork: AiImages, edit: typeof editPicture = editPicture) {
  return [
    tool('show_picture', 'Show one of the design\'s drawings as it prints (the user\'s hand edits in), with a light grid to pick a region for edit_picture: lines every 0.1 of its width and height from the top-left corner, thicker at 0.5. The user\'s saved mark, if there is one, is outlined in magenta.', {
      picture: z.string().max(120).describe('The drawing\'s name, as used with H.svg'),
    }, async (a) => {
      const d = drawingOf(base, a.picture);
      if (!d) return fail(`There is no drawing "${a.picture}" in this design.`);
      const own = parseArtworkEdits(base[ARTWORK_EDITS_KEY]);
      const strokes = Object.hasOwn(own, a.picture) && own[a.picture].fp === drawingFingerprint(d) ? own[a.picture].strokes : [];
      const heightPx = Math.round(SHOW_LONG_SIDE / Math.max(d.aspect, 1)), win = wholeWindow(d);
      const pic = renderDrawing(d, strokes, win, heightPx);
      let img: Raster = withGrid({ width: pic.width, height: pic.height, data: pic.data });
      const mark = savedMark(base, a.picture, d);
      if (mark) img = outlined(img, markMask(mark, { w: pic.width, h: pic.height, px: 1 / heightPx, x0: win.x0, y1: win.y1 }), 3);
      const png = pngBase64(img);
      emit({ type: 'step', step: { kind: 'render', ok: true, verbose: true, text: `Picture "${a.picture}" with a grid`, image: `data:image/png;base64,${png}` } });
      return {
        content: [
          { type: 'image', data: png, mimeType: 'image/png' },
          { type: 'text', text: `Drawing "${a.picture}" (${pic.width}×${pic.height} pixels, ${d.aspect.toFixed(3)} times as wide as high). The grid lines are every 0.1 of the width and height from the top-left corner (0, 0) to the bottom-right (1, 1), thicker at 0.5. A region for edit_picture is a box [x0, y0, x1, y1] in these fractions from the top-left; give it a little room around what changes (the whole head for a face). ${mark ? 'The user\'s saved mark is outlined in magenta: region "mark" uses it.' : 'The user has no saved mark on it.'}` },
        ],
      };
    }),
    tool('edit_picture', 'Change part of one of the design\'s drawings with the image model and keep everything else exactly as it is: swap a person or a face, change an object, fix a detail. The new drawing replaces the old one under the same name (in the drawing\'s own colours), so the script stays unchanged. The region is the user\'s saved mark ("mark"), or a box you pick from show_picture\'s grid; without one the whole picture is redrawn. Costs a few cents and takes ~20-60 s.', {
      picture: z.string().max(120).describe('The drawing\'s name, as used with H.svg'),
      change: z.string().min(3).max(2000).describe('What to change, in plain words: who or what goes there, how it looks (e.g. "replace the man on the left with the woman in the attached photo, smiling")'),
      region: z.union([z.literal('mark'), z.tuple([z.number(), z.number(), z.number(), z.number()])]).optional()
        .describe('"mark" = the area the user selected in the brush editor; or [x0, y0, x1, y1], fractions 0..1 of the picture\'s width and height from its top-left corner (see show_picture); omit to change the whole picture'),
      use_attached_photos: z.boolean().optional().describe('Show the image model the photos the user attached to this message (the real person or thing for the part that changes)'),
    }, async (a) => {
      const d = drawingOf(base, a.picture);
      if (!d) return fail(`There is no drawing "${a.picture}" in this design.`);
      let mark: PictureMark | undefined;
      if (a.region === 'mark') {
        const saved = savedMark(base, a.picture, d);
        if (!saved) return fail(`There is no saved mark on "${a.picture}": ask the user to select the area with Select (C) in the brush editor, or give the region as a box from show_picture's grid.`);
        mark = saved;
      } else if (a.region) {
        const box = boxMark(a.region, d.aspect);
        if (!box.strokes.length) return fail(`The region [${a.region.join(', ')}] is an empty box: give [x0, y0, x1, y1] with x0 < x1 and y0 < y1, fractions 0..1 of the picture's width and height from its top-left corner (show_picture shows the grid).`);
        mark = box;
      }
      let photos: string[] = [];
      if (a.use_attached_photos) {
        photos = artwork.references.filter((p) => PHOTO.test(p)).slice(0, MAX_PHOTOS);
        if (!photos.length) return fail(artwork.references.length ? 'The photos attached to this message are not PNG, JPEG or WebP pictures.' : 'The user attached no photos to this message.');
      }
      emit({ type: 'step', step: { kind: 'status', text: `Changing "${a.picture}"…` } });
      try {
        const r = await edit({ mode: 'artwork', picture: a.picture, values: base, ...(mark ? { mark } : {}), change: a.change, photos }, {
          image: drawImage, signal: artwork.signal, onStatus: (text) => emit({ type: 'step', step: { kind: 'status', text } }),
        });
        // From now on every check and render uses the new drawing; the app keeps the same values.
        // (Changed in place: every tool of the generation holds this same `base`.)
        const next = withSet(base, r.set);
        for (const k of Object.keys(base)) if (!Object.hasOwn(next, k)) delete base[k];
        Object.assign(base, next);
        emit({ type: 'pictureEdited', set: r.set, info: { picture: a.picture, change: a.change, masked: r.masked, outsideSame: r.outsideSame, cost: r.cost } });
        const cost = r.cost != null ? ` · ${formatCost(r.cost)}` : '';
        const notes = [
          r.masked ? (r.outsideSame ? 'Outside the region the drawing is unchanged.' : 'Outside the region the drawing changed too.') : 'The whole picture was redrawn.',
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
            { type: 'text', text: `${r.masked ? 'The region' : 'The picture'} of "${a.picture}" after the edit (above). ${notes.join(' ')}${r.cost != null ? ` It cost ${formatCost(r.cost)}.` : ''}\nThe drawing is updated under the same name: keep the script unchanged, check it with render_model and submit. If the change itself is wrong, call edit_picture again with a clearer change.` },
          ],
        };
      } catch (e) {
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Picture edit: ${(e as Error).message}` } });
        return fail((e as Error).message);
      }
    }),
  ];
}
