import { zipSync, strToU8 } from 'fflate';
import type { DimensionAnnotation, EvalResult, PartMesh } from '../../shared/types';
import { toBinaryStl } from './files';

export type ExportFormat = 'stl' | '3mf' | 'blend';

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const num = (n: number) => (Math.abs(n) < 1e-9 ? '0' : String(+n.toFixed(5)));

/** 3MF with one named, coloured object per part (Bambu Studio / PrusaSlicer / Cura). */
export function to3mf(parts: PartMesh[], title: string): Blob {
  const colors = parts.map((p) => `<base name="${esc(p.name)}" displaycolor="${/^#[0-9a-f]{6}$/i.test(p.color) ? p.color.toUpperCase() : '#C9A26B'}FF"/>`).join('');
  const objects: string[] = [];
  parts.forEach((p, i) => {
    const v: string[] = [];
    for (let k = 0; k < p.positions.length; k += 3) v.push(`<vertex x="${num(p.positions[k])}" y="${num(p.positions[k + 1])}" z="${num(p.positions[k + 2])}"/>`);
    const t: string[] = [];
    for (let k = 0; k < p.indices.length; k += 3) t.push(`<triangle v1="${p.indices[k]}" v2="${p.indices[k + 1]}" v3="${p.indices[k + 2]}"/>`);
    objects.push(`<object id="${i + 2}" name="${esc(p.name)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`);
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${esc(title)}</metadata>
<metadata name="Application">AI Designer</metadata>
<resources><basematerials id="1">${colors}</basematerials>${objects.join('')}</resources>
<build>${parts.map((_, i) => `<item objectid="${i + 2}"/>`).join('')}</build>
</model>`;
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  }, { level: 6 });
  return new Blob([zip], { type: 'model/3mf' });
}

const b64 = (arr: Float32Array | Uint32Array) => {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** .blend via the server's headless Blender: one object per part + a Dimensions collection. */
export async function toBlend(result: EvalResult, parts: PartMesh[], title: string, code: string): Promise<Blob> {
  const b = result.bbox!;
  const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const off = size * 0.12;
  const fmt = (n: number) => `${n.toFixed(2)} mm`;
  const dims: { label: string; from: number[]; to: number[]; offset?: number[]; color?: string }[] = [
    { label: `X ${fmt(b.max[0] - b.min[0])}`, from: [b.min[0], b.min[1], b.min[2]], to: [b.max[0], b.min[1], b.min[2]], offset: [0, -off, 0], color: '#e46a6a' },
    { label: `Y ${fmt(b.max[1] - b.min[1])}`, from: [b.max[0], b.min[1], b.min[2]], to: [b.max[0], b.max[1], b.min[2]], offset: [off, 0, 0], color: '#6ac46a' },
    { label: `Z ${fmt(b.max[2] - b.min[2])}`, from: [b.max[0], b.min[1], b.min[2]], to: [b.max[0], b.min[1], b.max[2]], offset: [off * 0.7, -off * 0.7, 0], color: '#6a9ae4' },
    ...result.dimensions.map((d: DimensionAnnotation) => ({
      label: `${d.label ? d.label + ': ' : ''}${fmt(Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]))}`,
      from: d.from, to: d.to, offset: d.offset,
    })),
  ];
  const params = Object.fromEntries(Object.entries(result.values).filter(([k]) => !k.startsWith('$')));
  const res = await fetch('/api/export/blend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: title, code, params, size,
      parts: parts.map((p) => ({ name: p.name, color: p.color, positions: b64(p.positions), indices: b64(p.indices) })),
      dimensions: dims,
    }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.blob();
}

export async function exportParts(format: ExportFormat, result: EvalResult, parts: PartMesh[], title: string, code: string): Promise<Blob> {
  if (format === '3mf') return to3mf(parts, title);
  if (format === 'blend') return toBlend(result, parts, title, code);
  return toBinaryStl(parts, title);
}
