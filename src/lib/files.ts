import type { PartMesh } from '../../shared/types';

/** Binary STL of one or more parts (merged into one file). */
export function toBinaryStl(parts: PartMesh[], name = 'model'): Blob {
  const triCount = parts.reduce((s, p) => s + p.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buf);
  const header = `Jig - ${name}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i) & 0x7f);
  view.setUint32(80, triCount, true);
  let o = 84;
  for (const p of parts) {
    const P = p.positions, I = p.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
      o += 12;
      for (const idx of [a, b, c]) {
        view.setFloat32(o, P[idx], true); view.setFloat32(o + 4, P[idx + 1], true); view.setFloat32(o + 8, P[idx + 2], true);
        o += 12;
      }
      view.setUint16(o, 0, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'model/stl' });
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

export function dataUrlToImage(url: string): { mediaType: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (!m) throw new Error('bad data url');
  return { mediaType: m[1], data: m[2] };
}

export const uid = () => crypto.randomUUID();
