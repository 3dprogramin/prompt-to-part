// Photos in the browser: a file → a downscaled canvas (the photo the widget works from and attaches
// to the order), and a crop of it → Jig's LayerToneImage (8-bit brightness) for the lithophane.
import { toLayerToneImage, type LayerToneImage } from '../../shared/layertone';
import type { Rect } from './crop';

export interface Photo {
  /** The photo, upright (EXIF orientation applied), at most the configured longest side. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** The file's name without its extension. */
  name: string;
  /** Pixels on the original's longer side (before downscaling). */
  originalLong: number;
}

/** Decodes a picture file upright: createImageBitmap where it can, an <img> otherwise (older Safari). */
async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** A picture file as a Photo, scaled down to `maxSide` pixels on its longer side. */
export async function loadPhoto(file: Blob, maxSide: number): Promise<Photo> {
  const d = await decode(file);
  try {
    if (!(d.width > 0 && d.height > 0)) throw new Error('empty picture');
    const s = Math.min(1, maxSide / Math.max(d.width, d.height));
    const w = Math.max(1, Math.round(d.width * s)), h = Math.max(1, Math.round(d.height * s));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    // Transparent areas count as white, like paper.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(d.source, 0, 0, w, h);
    const name = ((file as File).name ?? 'photo').replace(/\.[^.]*$/, '').slice(0, 60) || 'photo';
    return { canvas, width: w, height: h, name, originalLong: Math.max(d.width, d.height) };
  } finally {
    d.close();
  }
}

/** The photo as a JPEG file, for the order. */
export function photoFile(photo: Photo, quality = 0.9): Promise<File> {
  return new Promise((resolve, reject) => {
    photo.canvas.toBlob((b) => (b ? resolve(new File([b], `${photo.name}.jpg`, { type: 'image/jpeg' })) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', quality);
  });
}

/**
 * The part `rect` (photo pixels) of the photo as a LayerToneImage of at most `longSide` pixels on
 * its longer side (never more than the photo has: enlarging adds nothing).
 */
export function cropImage(photo: Photo, rect: Rect, longSide: number): LayerToneImage {
  const s = Math.min(1, longSide / Math.max(rect.w, rect.h));
  const w = Math.max(2, Math.round(rect.w * s)), h = Math.max(2, Math.round(rect.h * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  return toLayerToneImage(photo.name, w, h, ctx.getImageData(0, 0, w, h).data, Math.max(w, h));
}

/** RGBA pixels drawn onto a canvas (resized to them). */
export function putPixels(canvas: HTMLCanvasElement, p: { width: number; height: number; rgba: Uint8ClampedArray }) {
  canvas.width = p.width;
  canvas.height = p.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
}
