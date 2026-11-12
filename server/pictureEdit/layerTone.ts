// A picture edit of a LayerTone photo (its greyscale picture under $images): the picture as pixels
// for the image model, and how its part was built (sent by the app).
import type { PictureEditRequest } from '../../shared/api';
import { cleanFilaments, cleanLayerToneSource, layerToneLuma, type LayerToneImage } from '../../shared/layertone';
import type { Raster } from '../../shared/meshFormats';

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
