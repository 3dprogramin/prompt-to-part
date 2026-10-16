// Bambu Studio project 3MF: A1 + PLA template from the user's Bambu Studio, per-object print-setting
// overrides, and one filament per colour. Structure verified by loading and slicing with Bambu Studio 2.8.
import { zipSync, strToU8 } from 'fflate';
import { bambuOverrides, effectiveSettings, type PrintProfile } from '../../shared/print';
import type { PartMesh } from '../../shared/types';

export interface BambuTemplate {
  version: string;
  settings: Record<string, unknown>;
  perFilament: string[];
  perFilamentPlus2: string[];
}

const BED = { w: 256, d: 256 };
const APP = 'BambuStudio-02.08.04.57';
const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';
const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const num = (n: number) => (Math.abs(n) < 1e-9 ? '0' : String(+n.toFixed(5)));
const ID = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1';

/** Parts whose boxes touch are one printed object (e.g. coloured pieces of a figurine). */
function clusters(parts: PartMesh[]): number[][] {
  const n = parts.length, parent = parts.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const tol = 0.3;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = parts[i].bbox, b = parts[j].bbox;
    if ([0, 1, 2].every((k) => a.min[k] <= b.max[k] + tol && a.max[k] + tol >= b.min[k])) parent[find(i)] = find(j);
  }
  const groups = new Map<number, number[]>();
  parts.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  return [...groups.values()];
}

function meshXml(p: PartMesh, c: number[]): string {
  const v: string[] = [];
  for (let k = 0; k < p.positions.length; k += 3) v.push(`<vertex x="${num(p.positions[k] - c[0])}" y="${num(p.positions[k + 1] - c[1])}" z="${num(p.positions[k + 2] - c[2])}"/>`);
  const t: string[] = [];
  for (let k = 0; k < p.indices.length; k += 3) t.push(`<triangle v1="${p.indices[k]}" v2="${p.indices[k + 1]}" v3="${p.indices[k + 2]}"/>`);
  return `<mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh>`;
}

export function toBambuProject(
  parts: PartMesh[],
  title: string,
  tpl: BambuTemplate,
  opts: { colours: boolean; print: { ai: PrintProfile; user: PrintProfile } | null },
): Blob {
  // Filament slots: one per distinct colour (or a single filament).
  const colours: string[] = [];
  const slot = parts.map((p) => {
    if (!opts.colours) return 1;
    const c = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color.toUpperCase() : '#C9A26B';
    let i = colours.indexOf(c);
    if (i < 0) { colours.push(c); i = colours.length - 1; }
    return i + 1;
  });
  if (!colours.length) colours.push(opts.colours ? '#C9A26B' : String((tpl.settings.filament_colour as string[] | undefined)?.[0] ?? '#00AE42'));

  // Whole model moved as one onto the A1 plate (same placement as the viewer).
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.bbox.min[k]); hi[k] = Math.max(hi[k], p.bbox.max[k]); }
  const shift = [BED.w / 2 - (lo[0] + hi[0]) / 2, BED.d / 2 - (lo[1] + hi[1]) / 2, -lo[2]];

  const files: Record<string, Uint8Array> = {};
  const resources: string[] = [], items: string[] = [], rels: string[] = [], objectCfg: string[] = [], instances: string[] = [];
  const header = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n<metadata name="BambuStudio:3mfVersion">1</metadata>\n`;
  let nextId = 1;

  clusters(parts).forEach((group, gi) => {
    const gb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const i of group) for (let k = 0; k < 3; k++) { gb.min[k] = Math.min(gb.min[k], parts[i].bbox.min[k]); gb.max[k] = Math.max(gb.max[k], parts[i].bbox.max[k]); }
    const c = [0, 1, 2].map((k) => (gb.min[k] + gb.max[k]) / 2);
    // The biggest part names the object and decides its print settings.
    const main = group.reduce((a, b) => (parts[b].volume > parts[a].volume ? b : a));
    const file = `3D/Objects/object_${gi + 1}.model`;
    const meshIds = group.map(() => nextId++);
    const objId = nextId++;
    files[file] = strToU8(`${header}<resources>${group.map((i, k) => `<object id="${meshIds[k]}" type="model">${meshXml(parts[i], c)}</object>`).join('')}</resources>\n<build/>\n</model>`);
    rels.push(`<Relationship Target="/${file}" Id="rel-${gi + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`);
    resources.push(`<object id="${objId}" type="model"><components>${meshIds.map((m) => `<component p:path="/${file}" objectid="${m}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join('')}</components></object>`);
    items.push(`<item objectid="${objId}" transform="1 0 0 0 1 0 0 0 1 ${num(c[0] + shift[0])} ${num(c[1] + shift[1])} ${num(c[2] + shift[2])}" printable="1"/>`);
    const overrides = opts.print ? bambuOverrides(effectiveSettings(opts.print.ai, opts.print.user, parts[main].name)) : {};
    const name = group.length > 1 ? `${parts[main].name} (+${group.length - 1})` : parts[main].name;
    const partCfg = group.map((i, k) =>
      `<part id="${meshIds[k]}" subtype="normal_part"><metadata key="name" value="${esc(parts[i].name)}"/><metadata key="matrix" value="${ID}"/><metadata key="extruder" value="${slot[i]}"/></part>`).join('');
    objectCfg.push(`<object id="${objId}"><metadata key="name" value="${esc(name)}"/><metadata key="extruder" value="${slot[main]}"/>${Object.entries(overrides).map(([k, v]) => `<metadata key="${k}" value="${esc(v)}"/>`).join('')}${partCfg}</object>`);
    instances.push(`<model_instance><metadata key="object_id" value="${objId}"/><metadata key="instance_id" value="0"/></model_instance>`);
  });

  // Project settings: the user's A1 + PLA + 0.20 Standard, with one filament per colour.
  const settings: Record<string, unknown> = structuredClone(tpl.settings);
  const n = colours.length;
  for (const k of tpl.perFilament) {
    const v = settings[k];
    if (Array.isArray(v) && v.length) settings[k] = Array(n).fill(v[0]);
  }
  for (const k of tpl.perFilamentPlus2) settings[k] = Array(n + 2).fill('');
  settings.filament_colour = colours;
  settings.filament_self_index = colours.map((_, i) => String(i + 1));
  settings.filament_map = colours.map(() => '1');

  files['3D/3dmodel.model'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n<metadata name="Application">${APP}</metadata>\n<metadata name="BambuStudio:3mfVersion">1</metadata>\n<metadata name="Title">${esc(title)}</metadata>\n<metadata name="Designer">AI Designer</metadata>\n<resources>${resources.join('')}</resources>\n<build>${items.join('')}</build>\n</model>`);
  files['3D/_rels/3dmodel.model.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  files['Metadata/model_settings.config'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<config>${objectCfg.join('')}<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/>${instances.join('')}</plate><assemble></assemble></config>`);
  files['Metadata/project_settings.config'] = strToU8(JSON.stringify(settings, null, 4));
  files['[Content_Types].xml'] = strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/></Types>');
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  return new Blob([zipSync(files, { level: 6 })], { type: 'model/3mf' });
}
