// A stored photo (LayerTone's pictures under $images) as the picture edits see it: its fingerprint,
// which a mark on it is saved with, so a mark made on an earlier picture is known as such.
import type { LayerToneImage } from '../layertone';

/** The picture's fingerprint: its size and a hash of its pixels (as stored). */
export function photoFingerprint(img: LayerToneImage): string {
  let h = 0;
  for (let i = 0; i < img.luma.length; i++) h = (h * 31 + img.luma.charCodeAt(i)) | 0;
  return `${img.width}x${img.height}:${h}`;
}
