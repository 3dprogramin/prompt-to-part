// PNG and JPEG to RGBA pixels in plain JavaScript (fast-png, jpeg-js): for the textures of coloured
// meshes, decoded in the locked-down geometry worker.
import jpeg from 'jpeg-js';
import { decode as decodePng } from 'fast-png';
import type { Raster } from './meshFormats';

/** Largest texture decoded (pixels): Meshy's are 2048² (2k) to 8192² (8k). */
const MAX_PIXELS = 8192 * 8192;

export function decodeTexture(bytes: Uint8Array, mimeType = ''): Raster {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 1024 });
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const p = decodePng(bytes);
    if (p.width * p.height > MAX_PIXELS) throw new Error('texture too large');
    const n = p.width * p.height, ch = p.channels, data = new Uint8Array(n * 4);
    const src = p.data as ArrayLike<number>;
    const scale = p.depth === 16 ? 1 / 257 : 1;
    // Indexed (palette) PNGs come as indices with a palette.
    const pal = (p as { palette?: number[][] }).palette;
    for (let i = 0; i < n; i++) {
      if (pal) { const c = pal[src[i]] ?? [128, 128, 128]; data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; }
      else { const grey = ch < 3; for (let c = 0; c < 3; c++) data[i * 4 + c] = src[i * ch + (grey ? 0 : c)] * scale; }
      data[i * 4 + 3] = 255;
    }
    return { width: p.width, height: p.height, data };
  }
  throw new Error(`${mimeType || 'this picture format'} isn't supported (PNG or JPEG only)`);
}
