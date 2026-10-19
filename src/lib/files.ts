import type { PartMesh } from '../../shared/types';
import { binaryStl } from '../../shared/stl';

/** Binary STL of one or more parts (merged into one file). */
export function toBinaryStl(parts: PartMesh[], name = 'model'): Blob {
  return new Blob([binaryStl(parts, `Jig - ${name}`)], { type: 'model/stl' });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';

/** Downscale to Claude's sweet spot (≤1568 px long side) and re-encode as JPEG. */
export async function prepareImage(file: Blob): Promise<string> {
  if (isSvg(file)) return svgPicture(await file.text());
  const bmp = await createImageBitmap(file);
  const max = 1568;
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.88);
}

export const isSvg = (f: Blob) => f.type === 'image/svg+xml' || /\.svg$/i.test((f as File).name ?? '');

/** An SVG drawn by the browser on white, as a JPEG about 1024 px on its long side. */
async function svgPicture(source: string): Promise<string> {
  // An SVG without width/height draws at an arbitrary size: give it one from its viewBox.
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg') throw new Error('not an SVG');
  const vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const aspect = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb[2] / vb[3] : (parseFloat(root.getAttribute('width') ?? '') || 1) / (parseFloat(root.getAttribute('height') ?? '') || 1);
  const w = Math.round(aspect >= 1 ? 1024 : 1024 * aspect), h = Math.round(aspect >= 1 ? 1024 / aspect : 1024);
  root.setAttribute('width', String(w));
  root.setAttribute('height', String(h));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function dataUrlToImage(url: string): { mediaType: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (!m) throw new Error('bad data url');
  return { mediaType: m[1], data: m[2] };
}

/**
 * A random id (a version 4 UUID). crypto.randomUUID exists on secure pages only (https, localhost):
 * Jig opened at this computer's network address, e.g. from a phone, is plain http.
 */
export function uid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
