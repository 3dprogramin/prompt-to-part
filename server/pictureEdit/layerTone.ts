// A picture edit of a LayerTone photo (its greyscale picture under $images): the picture as pixels
// for the image model, how its part was built (sent by the app), and the automatic swap layers kept
// as they were, so that a marked edit leaves the print outside the mark exactly as it was (the
// automatic swaps are chosen from the whole picture's tones, which the edit changes).
import type { PictureEditRequest } from '../../shared/api';
import { autoSwaps, checkSwaps, cleanFilaments, cleanLayerToneSource, LAYERTONE_KEY, layerToneLuma, parseLayerToneSetup, type LayerToneImage } from '../../shared/layertone';
import type { Raster } from '../../shared/meshFormats';
import { SCALE_KEY } from '../../shared/params';
import type { ParamValues } from '../../shared/types';

export type LayerToneBuild = NonNullable<PictureEditRequest['layerTone']>;

/** The picture as RGBA pixels, grey (each of red, green and blue its luminance). */
export function greyRaster(img: LayerToneImage): Raster {
  const luma = layerToneLuma(img), data = new Uint8Array(img.width * img.height * 4);
  for (let p = 0; p < luma.length; p++) { const v = luma[p]; data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = v; data[p * 4 + 3] = 255; }
  return { width: img.width, height: img.height, data };
}

/** How the part was built, as the request has it, checked: options a part can have, usable filaments, whole swap layers; or null. */
export function cleanBuild(raw: unknown): LayerToneBuild | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<LayerToneBuild>;
  const source = cleanLayerToneSource({ image: '', options: o.options });
  const filaments = cleanFilaments(o.filaments);
  if (!source || !filaments) return null;
  if (o.swaps !== undefined && !(Array.isArray(o.swaps) && o.swaps.length < filaments.length && o.swaps.every((n) => Number.isInteger(n) && n >= 0))) return null;
  return { options: source.options, filaments, ...(o.swaps ? { swaps: o.swaps } : {}) };
}

/**
 * The swap layers to keep for a marked edit of `img` (the picture as the part was built from it),
 * or null when there are none to keep: the user's own swaps in the setup (they stay), a single
 * filament, or swaps the part was built with that are not the automatic ones (the script's own,
 * which do not depend on the picture). Else the automatic swaps of the picture as it was, worked out
 * as the build does (its options are scaled with the part: taken back to the script's sizes first).
 */
export function swapsToKeep(img: LayerToneImage, build: LayerToneBuild, values: ParamValues): number[] | null {
  const count = build.filaments.length;
  if (count < 2 || checkSwaps(parseLayerToneSetup(values[LAYERTONE_KEY]).swaps, count)) return null;
  const raw = Number(values[SCALE_KEY]), scale = Number.isFinite(raw) && raw > 0 ? raw : 1;
  const o = build.options;
  const options = { ...o, width: o.width / scale, layerHeight: o.layerHeight / scale, firstLayerHeight: o.firstLayerHeight / scale, baseHeight: o.baseHeight / scale, maxHeight: o.maxHeight / scale, border: o.border / scale, resolution: o.resolution / scale };
  const auto = autoSwaps(img, build.filaments, options);
  if (build.swaps && (build.swaps.length !== auto.length || build.swaps.some((s, i) => s !== auto[i]))) return null;
  return auto;
}

/** What the user is told when the swap layers were kept. */
export const swapsKeptNote = (swaps: number[]) =>
  `Swap layers kept as they were (layer${swaps.length > 1 ? 's' : ''} ${swaps.join(', ')}), so the print outside the mark stays the same: set them back to automatic in the Print tab if you like.`;
