// Pieces both 3MF writers (plain 3MF in export.ts, Bambu project in bambu3mf.ts) share.
import { zipSync, strToU8 } from 'fflate';
import type { PartMesh } from '../../shared/types';
import { bedShift } from '../../shared/printer';

// Control characters other than tab, LF and CR are not allowed in XML at all (not even escaped):
// they are dropped, or Bambu Studio and OrcaSlicer refuse the whole file.
export const esc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
export const num = (n: number) => (Math.abs(n) < 1e-9 ? '0' : String(+n.toFixed(5)));

const FALLBACK_COLOUR = '#C9A26B';

/** One slot per distinct part colour: `colours` lists them (#RRGGBB), `slot[i]` is part i's index into it. */
export function colourSlots(parts: PartMesh[]): { colours: string[]; slot: number[] } {
  const colours: string[] = [];
  const slot = parts.map((p) => {
    const c = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color.toUpperCase() : FALLBACK_COLOUR;
    let i = colours.indexOf(c);
    if (i < 0) { colours.push(c); i = colours.length - 1; }
    return i;
  });
  return { colours, slot };
}

/** The index of `colour` in `colours` (#RRGGBB), added when it is new. */
export function colourIndex(colours: string[], colour: string): number {
  const c = /^#[0-9a-f]{6}$/i.test(colour) ? colour.toUpperCase() : FALLBACK_COLOUR;
  const i = colours.indexOf(c);
  return i < 0 ? colours.push(c) - 1 : i;
}

export const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/></Types>';

export type ThreeMfMeta = Partial<Record<'Designer' | 'LicenseTerms' | 'Copyright' | 'Description', string>>;

/** `<metadata>` lines for the given values (escaped), one per non-empty entry. */
export const metaXml = (meta: ThreeMfMeta, skip: string[] = []): string =>
  Object.entries(meta).filter(([k, v]) => v && !skip.includes(k)).map(([k, v]) => `<metadata name="${esc(k)}">${esc(v!)}</metadata>\n`).join('');

// ---------------------------------------------------------------------------
// 3MF. Colours use the Materials extension colour group per triangle - the encoding
// Bambu Studio reads from non-Bambu files (it offers colour mapping onto filaments). A coloured
// mesh's triangles each get their filament's colour.
// ---------------------------------------------------------------------------

/**
 * Exports exactly what the viewer shows: parts keep their positions relative to each other
 * (coloured pieces of one figurine stay attached); the whole model is only lifted onto the
 * plate and centred on the printer's bed. Each part is a named object with its colour.
 */
export function to3mf(parts: PartMesh[], title: string, oneColour: string | null = null, meta: ThreeMfMeta = {}): Blob {
  // In one colour ("Print in one colour"): one colour for every part, no painting.
  const { colours: palette, slot: colourIdx } = oneColour ? { colours: [oneColour.toUpperCase()], slot: parts.map(() => 0) } : colourSlots(parts);
  // One translation for the whole model: rest on the plate, centred on the bed.
  const shift = bedShift(parts.map((p) => p.bbox));

  const objects = parts.map((p, i) => {
    const [dx, dy, dz] = shift;
    const v: string[] = [];
    for (let k = 0; k < p.positions.length; k += 3) v.push(`<vertex x="${num(p.positions[k] + dx)}" y="${num(p.positions[k + 1] + dy)}" z="${num(p.positions[k + 2] + dz)}"/>`);
    const t: string[] = [];
    const ci = colourIdx[i];
    const pid = ` pid="1" p1="${ci}"`;
    // A painted part: each triangle its filament's colour.
    const painted = !oneColour && p.paint?.tri.length === p.indices.length / 3 ? p.paint : undefined;
    const paintIdx = painted?.filaments.map((f) => colourIndex(palette, f.color));
    for (let k = 0; k < p.indices.length; k += 3) t.push(`<triangle v1="${p.indices[k]}" v2="${p.indices[k + 1]}" v3="${p.indices[k + 2]}"${painted ? ` pid="1" p1="${paintIdx![painted.tri[k / 3]]}"` : pid}/>`);
    return `<object id="${i + 2}" name="${esc(p.name)}" type="model" pid="1" pindex="${ci}"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`;
  });
  const resources = objects.join('');
  const build = parts.map((_, i) => `<item objectid="${i + 2}"/>`).join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
<metadata name="Title">${esc(title)}</metadata>
<metadata name="Application">prompt-to-part</metadata>
${metaXml(meta)}<resources><m:colorgroup id="1">${palette.map((c) => `<m:color color="${c}FF"/>`).join('')}</m:colorgroup>${resources}</resources>
<build>${build}</build>
</model>`;
  const zip = zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  }, { level: 6 });
  return new Blob([zip], { type: 'model/3mf' });
}

