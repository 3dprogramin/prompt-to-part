// The strip as a picture: the colours a filament stack prints, from its lowest layer (left) to its
// highest (right), sent to the image model with a LayerTone picture to draw, repaint or edit.
import { encode as encodePng } from 'fast-png';
import { stripColors, type LayerToneOptions, type LayerToneStack } from '../shared/layertone';

export const STRIP_WIDTH = 512;
export const STRIP_HEIGHT = 64;

/** The strip of `stack` as a PNG data URL, STRIP_WIDTH × STRIP_HEIGHT. */
export function stripPng(stack: LayerToneStack, o: LayerToneOptions): { dataUrl: string; width: typeof STRIP_WIDTH; height: typeof STRIP_HEIGHT } {
  const strip = stripColors(stack, o);
  const data = new Uint8Array(STRIP_WIDTH * STRIP_HEIGHT * 3);
  for (let x = 0; x < STRIP_WIDTH; x++) {
    const c = strip[Math.round((x / (STRIP_WIDTH - 1)) * 255)];
    for (let y = 0; y < STRIP_HEIGHT; y++) data.set(c, (y * STRIP_WIDTH + x) * 3);
  }
  const png = encodePng({ width: STRIP_WIDTH, height: STRIP_HEIGHT, data, channels: 3 });
  return { dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, width: STRIP_WIDTH, height: STRIP_HEIGHT };
}
