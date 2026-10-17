// Bambu Studio project 3MF: A1 + PLA template from the user's Bambu Studio, per-object print-setting
// overrides, and one filament per colour. Structure verified by loading and slicing with Bambu Studio 2.8.
import { zipSync, strToU8 } from 'fflate';
import { bambuOverrides, defaultsFromTemplate, effectiveSettings, type PrintProfile, type PrintSettings } from '../../shared/print';
import { bedShift } from '../../shared/printer';
import type { BambuTemplate } from '../../shared/api';
import type { PartMesh } from '../../shared/types';
import { CONTENT_TYPES, colourSlots, esc, num } from './threeMf';

/** Rough prime-tower depth per filament (mm), measured with Bambu Studio's slicer on the A1. */
const TOWER_DEPTH_PER_FILAMENT = 12;

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';
const ID = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1';

/** "02.08.04.57" from the installed Bambu Studio the template was built with (the project's Application). */
function bambuAppVersion(v: string): string {
  return /^\d+(\.\d+)+$/.test(v) ? v.split('.').map((x) => x.padStart(2, '0')).join('.') : '02.08.04.57';
}

/** Settings Bambu Studio keeps per object only: a part (volume) can't have its own. */
const OBJECT_ONLY = new Set(['layer_height', 'enable_support', 'support_type', 'support_on_build_plate_only', 'brim_type', 'brim_width']);

/**
 * Settings of an object made of several parts: the main part's, with supports on if any part needs
 * them and the widest explicit brim (those can only be set for the whole object).
 */
function objectSettings(main: Required<PrintSettings>, all: Required<PrintSettings>[]): Required<PrintSettings> {
  const out = { ...main };
  if (out.supports === 'off') out.supports = all.find((s) => s.supports !== 'off')?.supports ?? 'off';
  const widths = all.map((s) => s.brim).filter((b): b is number => typeof b === 'number');
  if (widths.length) out.brim = Math.max(...widths);
  return out;
}

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
  // Filament slots (1-based): one per distinct colour, or a single filament.
  const slots = colourSlots(parts);
  const colours = opts.colours ? slots.colours : [String((tpl.settings.filament_colour as string[] | undefined)?.[0] ?? '#00AE42')];
  const slot = parts.map((_, i) => (opts.colours ? slots.slot[i] + 1 : 1));

  // Model-wide settings go into the project itself, so Bambu shows them in the main Process panel.
  // The template's own profile is the baseline: only real changes from it are written.
  const base = defaultsFromTemplate(tpl.settings);
  const globalSettings = opts.print ? effectiveSettings(opts.print.ai, opts.print.user, undefined, base) : base;
  const globalChanges = bambuOverrides(globalSettings, base);

  // Whole model moved as one onto the plate (same placement as the viewer).
  const shift = bedShift(parts.map((p) => p.bbox));

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
    // Objects only carry what differs from the model-wide settings (which live in the project), and
    // each part what differs from its object.
    const own = group.map((i) => (opts.print ? effectiveSettings(opts.print.ai, opts.print.user, parts[i].name, base) : globalSettings));
    const objSettings = objectSettings(own[group.indexOf(main)], own);
    const overrides = opts.print ? bambuOverrides(objSettings, globalSettings) : {};
    const name = group.length > 1 ? `${parts[main].name} (+${group.length - 1})` : parts[main].name;
    const partCfg = group.map((i, k) => {
      const partOverrides = Object.entries(bambuOverrides(own[k], objSettings)).filter(([key]) => !OBJECT_ONLY.has(key));
      return `<part id="${meshIds[k]}" subtype="normal_part"><metadata key="name" value="${esc(parts[i].name)}"/><metadata key="matrix" value="${ID}"/><metadata key="extruder" value="${slot[i]}"/>${partOverrides.map(([key, v]) => `<metadata key="${key}" value="${esc(v)}"/>`).join('')}</part>`;
    }).join('');
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
  // The prime tower gets deeper with every filament; the template's spot near the back edge only
  // fits three (y = 220 on the 256 mm bed fails to slice with four). Move it forward so its
  // estimated depth stays on the bed.
  const bedY = Math.max(0, ...((tpl.settings.printable_area as string[] | undefined) ?? []).map((p) => Number(p.split('x')[1])).filter(Number.isFinite));
  const towerY = Number((settings.wipe_tower_y as string[] | undefined)?.[0]);
  const maxTowerY = bedY - 5 - TOWER_DEPTH_PER_FILAMENT * n;
  if (n > 1 && bedY > 0 && Number.isFinite(towerY) && towerY > maxTowerY) settings.wipe_tower_y = [String(Math.max(0, Math.floor(maxTowerY)))];
  // Purge volumes between filaments: an n × n matrix (nothing on the diagonal) and two values per
  // filament; the slicer refuses a project whose matrix has a different size.
  const purge = (tpl.settings.flush_volumes_matrix as string[] | undefined)?.find((v) => v !== '0') ?? '280';
  const vector = (tpl.settings.flush_volumes_vector as string[] | undefined)?.[0] ?? '140';
  settings.flush_volumes_matrix = colours.flatMap((_, i) => colours.map((_, j) => (i === j ? '0' : purge)));
  settings.flush_volumes_vector = colours.flatMap(() => [vector, vector]);
  // Changed process values, recorded the way Bambu Studio does so they show as modified.
  Object.assign(settings, globalChanges);
  const diff = settings.different_settings_to_system as string[];
  diff[0] = Object.keys(globalChanges).sort().join(';');

  files['3D/3dmodel.model'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n<metadata name="Application">BambuStudio-${bambuAppVersion(tpl.version)}</metadata>\n<metadata name="BambuStudio:3mfVersion">1</metadata>\n<metadata name="Title">${esc(title)}</metadata>\n<metadata name="Designer">Jig</metadata>\n<resources>${resources.join('')}</resources>\n<build>${items.join('')}</build>\n</model>`);
  files['3D/_rels/3dmodel.model.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  files['Metadata/model_settings.config'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<config>${objectCfg.join('')}<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/>${instances.join('')}</plate><assemble></assemble></config>`);
  files['Metadata/project_settings.config'] = strToU8(JSON.stringify(settings, null, 4));
  files['[Content_Types].xml'] = strToU8(CONTENT_TYPES);
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  return new Blob([zipSync(files, { level: 6 })], { type: 'model/3mf' });
}
