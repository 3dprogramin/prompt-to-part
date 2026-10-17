import { MAX_HF_IMAGE_SIDE, toHfImage, type HfImage } from '../../shared/hueforge';

// LayerTone pictures in the browser: a file or data URL → HfImage (via a canvas), and back to
// pictures the side panel can show.

/** A picture file or data URL as an HfImage, at most MAX_HF_IMAGE_SIDE pixels on its long side. */
export async function loadHfImage(src: Blob | string, name: string): Promise<HfImage> {
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, MAX_HF_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  // Transparent areas count as white, like paper.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return toHfImage(name, w, h, ctx.getImageData(0, 0, w, h).data);
}

/** RGBA pixels as a PNG data URL. */
export function rgbaToDataUrl(width: number, height: number, rgba: Uint8ClampedArray): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas.toDataURL('image/png');
}

/** The stored picture (brightness only) as a grey PNG data URL. */
export function hfImageToDataUrl(img: HfImage): string {
  const luma = Uint8Array.from(atob(img.luma), (c) => c.charCodeAt(0));
  const rgba = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    const v = luma[i] ?? 0;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return rgbaToDataUrl(img.width, img.height, rgba);
}
