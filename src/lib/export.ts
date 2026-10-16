import { zipSync, strToU8 } from 'fflate';
import type { DimensionAnnotation, EvalResult, PartMesh } from '../../shared/types';
import { toBinaryStl } from './files';
import { toBambuProject, type BambuTemplate } from './bambu3mf';
import type { PrintProfile } from '../../shared/print';
import { WRITE_HEADERS } from './api';

export type ExportFormat = 'stl' | '3mf' | 'blend';

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const num = (n: number) => (Math.abs(n) < 1e-9 ? '0' : String(+n.toFixed(5)));

// ---------------------------------------------------------------------------
// 3MF. Colours use the Materials extension colour group per triangle – the encoding
// Bambu Studio reads from non-Bambu files (it offers colour mapping onto filaments).
// ---------------------------------------------------------------------------

const BED = { w: 256, d: 256 }; // Bambu Lab A1 – the model is centred on this plate

/**
 * Exports exactly what the viewer shows: parts keep their positions relative to each other
 * (coloured pieces of one figurine stay attached); the whole model is only lifted onto the
 * plate and centred on the A1 bed. Each part is a named object with its colour.
 */
export function to3mf(parts: PartMesh[], title: string, colours = true): Blob {
  const palette: string[] = [];
  const colourIdx = parts.map((p) => {
    const c = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color.toUpperCase() : '#C9A26B';
    let i = palette.indexOf(c);
    if (i < 0) { palette.push(c); i = palette.length - 1; }
    return i;
  });

  // One translation for the whole model: rest on the plate, centred on the bed.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.bbox.min[k]); hi[k] = Math.max(hi[k], p.bbox.max[k]); }
  const shift = [BED.w / 2 - (lo[0] + hi[0]) / 2, BED.d / 2 - (lo[1] + hi[1]) / 2, -lo[2]];

  const objects = parts.map((p, i) => {
    const [dx, dy, dz] = shift;
    const v: string[] = [];
    for (let k = 0; k < p.positions.length; k += 3) v.push(`<vertex x="${num(p.positions[k] + dx)}" y="${num(p.positions[k + 1] + dy)}" z="${num(p.positions[k + 2] + dz)}"/>`);
    const t: string[] = [];
    const ci = colourIdx[i];
    const pid = colours ? ` pid="1" p1="${ci}"` : '';
    for (let k = 0; k < p.indices.length; k += 3) t.push(`<triangle v1="${p.indices[k]}" v2="${p.indices[k + 1]}" v3="${p.indices[k + 2]}"${pid}/>`);
    return `<object id="${i + 2}" name="${esc(p.name)}" type="model"${colours ? ` pid="1" pindex="${ci}"` : ''}><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`;
  });
  const resources = objects.join('');
  const build = parts.map((_, i) => `<item objectid="${i + 2}"/>`).join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
<metadata name="Title">${esc(title)}</metadata>
<metadata name="Application">Jig</metadata>
<resources>${colours ? `<m:colorgroup id="1">${palette.map((c) => `<m:color color="${c}FF"/>`).join('')}</m:colorgroup>` : ''}${resources}</resources>
<build>${build}</build>
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
    headers: WRITE_HEADERS,
    body: JSON.stringify({
      name: title, code, params, size,
      parts: parts.map((p) => ({ name: p.name, color: p.color, positions: b64(p.positions), indices: b64(p.indices) })),
      dimensions: dims,
    }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.blob();
}

export interface ThreeMfOptions {
  colours: boolean;
  /** Print settings to embed (Bambu project format); null = plain 3MF. */
  print: { ai: PrintProfile; user: PrintProfile } | null;
}

export async function exportParts(format: ExportFormat, result: EvalResult, parts: PartMesh[], title: string, code: string, threeMf: ThreeMfOptions = { colours: true, print: null }): Promise<Blob> {
  if (format === '3mf') {
    if (!threeMf.print) return to3mf(parts, title, threeMf.colours);
    const res = await fetch('/api/bambu/template', { method: 'POST', headers: WRITE_HEADERS });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Bambu Studio profile unavailable');
    return toBambuProject(parts, title, (await res.json()) as BambuTemplate, { colours: threeMf.colours, print: threeMf.print });
  }
  if (format === 'blend') return toBlend(result, parts, title, code);
  return toBinaryStl(parts, title);
}
