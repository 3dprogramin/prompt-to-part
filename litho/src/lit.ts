// The flat preview: the panel seen face on, lit from behind (Jig's simulateLithophane, the money
// shot) or with the light off (white PLA, where only the relief shows, lit from the room).
import { lithoThickness, resolveLithoOptions, simulateLithophane, type LithophaneOptions } from '../../shared/lithophane';
import { layerToneLuma, type LayerToneImage } from '../../shared/layertone';

export interface Pixels {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/** White PLA in daylight, sRGB. */
const PLA = [240, 236, 228];

/**
 * The panel unlit: white PLA shaded by its relief, as if lit from the upper left. Same size and
 * frame as simulateLithophane's picture, so the two swap in place.
 */
export function unlitLithophane(image: LayerToneImage, o: LithophaneOptions): Pixels {
  const r = resolveLithoOptions(o);
  const lum = layerToneLuma(image);
  const table = Float32Array.from({ length: 256 }, (_, b) => lithoThickness(b / 255, r));
  const bp = Math.round((r.border / r.width) * image.width);
  const bx = r.shape === 'cylinder' ? 0 : bp;
  const width = image.width + 2 * bx, height = image.height + 2 * bp;
  // Thickness per pixel, frame included.
  const t = new Float32Array(width * height).fill(r.maxThickness);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) t[(y + bp) * width + x + bx] = table[lum[y * image.width + x]];
  // Slope towards the light, in mm per mm: a pixel is r.width / image.width mm wide.
  const k = image.width / r.width;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (xx: number, yy: number) => t[Math.min(height - 1, Math.max(0, yy)) * width + Math.min(width - 1, Math.max(0, xx))];
      // Over two pixels each way, so the small steps of 8-bit tones don't show as lines.
      const slope = ((at(x - 2, y - 2) + at(x - 1, y - 2) + at(x - 2, y - 1) - at(x + 2, y + 2) - at(x + 1, y + 2) - at(x + 2, y + 1)) * k) / 3 / 5.7;
      // Thicker plastic is a touch denser white; slopes facing the light are brighter.
      const s = Math.min(1.05, Math.max(0.72, 0.93 + 1.3 * slope + 0.012 * (t[y * width + x] - r.minThickness)));
      const p = (y * width + x) * 4;
      rgba[p] = PLA[0] * s; rgba[p + 1] = PLA[1] * s; rgba[p + 2] = PLA[2] * s; rgba[p + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** The flat preview with the light on or off. */
export function flatPreview(image: LayerToneImage, o: LithophaneOptions, lightsOn: boolean): Pixels {
  return lightsOn ? simulateLithophane(image, o) : unlitLithophane(image, o);
}
