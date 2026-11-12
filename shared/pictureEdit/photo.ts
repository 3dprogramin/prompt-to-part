// A stored photo (LayerTone's pictures under $images) as the picture edits see it: its fingerprint,
// which a mark on it is saved with, so a mark made on an earlier picture is known as such, and how
// its part was built, which a marked edit needs.
import type { PictureEditRequest } from '../api';
import type { LayerColor, LayerToneImage, LayerToneSource } from '../layertone';

/** The picture's fingerprint: its size and a hash of its pixels (as stored). */
export function photoFingerprint(img: LayerToneImage): string {
  let h = 0;
  for (let i = 0; i < img.luma.length; i++) h = (h * 31 + img.luma.charCodeAt(i)) | 0;
  return `${img.width}x${img.height}:${h}`;
}

/**
 * How a LayerTone part was built, as a picture edit's request carries it (PictureEditRequest's
 * `layerTone`): its options, and from its stack the filaments and the layer each one after the
 * first starts at. Null for a part that is not a LayerTone print.
 */
export function layerToneBuild(part: { layerTone?: LayerToneSource; layerColors?: LayerColor[] }): PictureEditRequest['layerTone'] | null {
  const layers = part.layerColors;
  if (!part.layerTone || !layers?.length) return null;
  return {
    options: part.layerTone.options,
    filaments: layers.map((l) => ({ name: l.name ?? l.color, ...(l.brand ? { brand: l.brand } : {}), color: l.color, td: l.td })),
    swaps: layers.slice(1).map((l) => l.layer),
  };
}
