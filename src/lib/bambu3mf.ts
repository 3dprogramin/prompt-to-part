// Bambu Studio project 3MF: A1 + PLA template from the user's Bambu Studio, per-object print-setting
// overrides, one filament per colour, the filament changes of LayerTone parts, and the colour
// painting of coloured meshes (each triangle's filament, as Bambu Studio's own painting tool stores
// it). Structure verified by loading and slicing with Bambu Studio 2.8.
import { zipSync, strToU8 } from 'fflate';
import { bambuOverrides, defaultsFromTemplate, effectiveSettings, type PrintProfile, type PrintSettings } from '../../shared/print';
import { bedShift, PRINTER } from '../../shared/printer';
import type { BambuTemplate } from '../../shared/api';
import type { PartMesh } from '../../shared/types';
import { CONTENT_TYPES, esc, num } from './threeMf';

/**
 * The prime tower's footprint, measured with Bambu Studio 2.8's slicer on the A1 (its rib-wall
 * tower, the same at any print height): a square from 3.2 mm before its wipe_tower_x/y, 31 mm
 * across for two filaments and 7.5 mm more for each further one.
 */
const towerSize = (filaments: number) => 31 + 7.5 * (filaments - 2);
const TOWER_LEAD = 3.2;
/** Space kept between the prime tower and the model (the model's brim fits in it), the smaller one only when the bigger doesn't fit. */
const TOWER_GAPS = [10, 5];

/**
 * Where the prime tower goes on a plate (its wipe_tower_x/y): beside the model, by one of its
 * corners (the back ones first), as the template's spot near the bed's edge collides with a big
 * model ("G-code conflicts"). `model` is the plate's parts' footprint; null when nothing fits.
 */
function towerSpot(model: { min: number[]; max: number[] }, filaments: number, bed: [number, number]): [number, number] | null {
  const s = towerSize(filaments) + 1;
  const [x0, y0] = model.min, [x1, y1] = model.max;
  for (const g of TOWER_GAPS) {
    // The tower's front-left corner: left or right of the model, level with its back, then its
    // front; then behind or in front of it, level with its left, then its right side.
    const tries: [number, number][] = [
      [x0 - g - s, y1 - s], [x1 + g, y1 - s], [x0 - g - s, y0], [x1 + g, y0],
      [x0, y1 + g], [x1 - s, y1 + g], [x0, y0 - g - s], [x1 - s, y0 - g - s],
    ];
    const spot = tries.find(([x, y]) => x >= 0 && y >= 0 && x + s <= bed[0] && y + s <= bed[1]);
    if (spot) return [+(spot[0] + TOWER_LEAD).toFixed(1), +(spot[1] + TOWER_LEAD).toFixed(1)];
  }
  return null;
}

/** Space kept between a model moved aside for the prime tower and the bed's edge. */
const EDGE = 5;

/**
 * The prime tower's spot on a plate (wipe_tower_x/y) and how far to move the plate's parts for it:
 * not at all when it fits beside the centred model, else to a side of the bed (right, left, back,
 * front) to make room. Null when it doesn't fit anywhere (a model about the size of the bed).
 */
function placeTower(model: { min: number[]; max: number[] }, filaments: number, bed: [number, number]): { spot: [number, number]; move: [number, number] } | null {
  const [x0, y0] = model.min, [x1, y1] = model.max;
  const moves: [number, number][] = [[0, 0], [bed[0] - EDGE - x1, 0], [EDGE - x0, 0], [0, bed[1] - EDGE - y1], [0, EDGE - y0]];
  for (const move of moves) {
    const spot = towerSpot({ min: [x0 + move[0], y0 + move[1]], max: [x1 + move[0], y1 + move[1]] }, filaments, bed);
    if (spot) return { spot, move };
  }
  return null;
}

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

/** The bed's width and depth (mm) from the template's printable area. */
function bedSize(tpl: BambuTemplate): [number, number] {
  const area = ((tpl.settings.printable_area as string[] | undefined) ?? []).map((p) => p.split('x').map(Number)).filter((p) => p.every(Number.isFinite));
  return area.length ? [Math.max(...area.map((p) => p[0])), Math.max(...area.map((p) => p[1]))] : [PRINTER.bed[0], PRINTER.bed[1]];
}

/**
 * The build plates: parts without a plate of their own all on plate 1 (moved as one block onto it,
 * as the viewer places them), parts with one (PartMesh.plate: the pieces of a split model) each on
 * theirs. Bambu Studio lays plates out in a grid (as many columns as the square root of their
 * number, rounded up) a fifth of a bed apart; a part goes at its plate's place.
 */
function platesOf(parts: PartMesh[], tpl: BambuTemplate): { parts: number[]; shift: [number, number, number]; name: string; footprint: { min: number[]; max: number[] } }[] {
  const ids = [...new Set(parts.map((p) => p.plate ?? 1))].sort((a, b) => a - b);
  const [bedW, bedD] = bedSize(tpl);
  const cols = Math.ceil(Math.sqrt(ids.length) - 1e-9);
  return ids.map((id, k) => {
    const mine = parts.flatMap((p, i) => ((p.plate ?? 1) === id ? [i] : []));
    const [x, y, z] = bedShift(mine.map((i) => parts[i].bbox));
    const own = parts[mine[0]].plate != null && ids.length > 1;
    // Where its parts are on the plate itself (x, y), for the prime tower.
    const footprint = { min: [0, 1].map((a) => Math.min(...mine.map((i) => parts[i].bbox.min[a])) + [x, y][a]), max: [0, 1].map((a) => Math.max(...mine.map((i) => parts[i].bbox.max[a])) + [x, y][a]) };
    return { parts: mine, shift: [x + (k % cols) * bedW * 1.2, y - Math.floor(k / cols) * bedD * 1.2, z], name: own ? mine.map((i) => parts[i].name).join(', ') : '', footprint };
  });
}

/** Parts whose boxes touch are one printed object (e.g. coloured pieces of a figurine); a LayerTone part is always its own. */
function clusters(parts: PartMesh[]): number[][] {
  const n = parts.length, parent = parts.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const tol = 0.3;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = parts[i].bbox, b = parts[j].bbox;
    if (parts[i].layerColors?.length || parts[j].layerColors?.length) continue;
    if ([0, 1, 2].every((k) => a.min[k] <= b.max[k] + tol && a.max[k] + tol >= b.min[k])) parent[find(i)] = find(j);
  }
  const groups = new Map<number, number[]>();
  parts.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  return [...groups.values()];
}

const FALLBACK_COLOUR = '#C9A26B';
const hex = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : FALLBACK_COLOUR);

/** Filament slots in the A1's AMS lite. */
export const AMS_SLOTS = 4;

/** Where a LayerTone part changes to another filament. */
export interface FilamentChange {
  /** The project filament it changes to (1-based). */
  filament: number;
  /** The first layer printed with it (0-based) and that layer's bottom and top, mm above the part's bottom. */
  layer: number;
  z: number;
  topZ: number;
  /**
   * The print pauses first (the filaments don't all fit in the AMS): put this filament in AMS slot
   * `slot`, in place of filament `replaces`, which is done by then.
   */
  pause?: { slot: number; replaces: number };
}

export interface FilamentPlan {
  /** The project's filaments: one per distinct part colour, per LayerTone filament and per painted filament (the same colour and name share one). */
  filaments: { colour: string; name?: string }[];
  /** Each part's filament (1-based); a LayerTone part's is its first (bottom) one, a painted part's the one most of it prints with. */
  slot: number[];
  /** A painted part's filament (1-based) for each of its paint filaments (PartMesh.paint), else empty. */
  paint: number[][];
  /** Each part's filament changes, bottom → top (none for a normal part). */
  changes: FilamentChange[][];
  /** The AMS slot (1–4) each filament goes in; 0 for a filament nothing prints with. */
  ams: number[];
  /** Why the filaments don't fit the AMS even with pauses (more than 4 needed at the same layer). */
  problem?: string;
}

/**
 * The project's filaments and the LayerTone filament changes, on the print's layers. A change at
 * height z starts with the layer whose bottom is nearest to z: z rather than LayerColor.layer, as z
 * follows the part (scaled with $scale, like the relief and the viewer's colours) and the layer
 * index only fits the heights the part was made with. At the part's own layer heights the two
 * agree. Filaments beyond the AMS's four reuse the slot of one that is done, with a pause before
 * they start.
 */
export function filamentPlan(parts: PartMesh[], layers: { layerHeight: number; firstLayerHeight: number }): FilamentPlan {
  const filaments: FilamentPlan['filaments'] = [];
  const add = (colour: string, name?: string) => {
    let i = filaments.findIndex((f) => f.colour === colour && (name === undefined || (f.name ?? '') === name));
    if (i < 0) i = filaments.push(name ? { colour, name } : { colour }) - 1;
    return i + 1;
  };
  const h = layers.layerHeight, first = layers.firstLayerHeight, eps = 1e-6;
  const bottom = (i: number) => (i === 0 ? 0 : first + (i - 1) * h);
  /** The layer whose bottom is nearest to z (the end of a part: the first layer above it). */
  const layerAt = (z: number) => (z < first / 2 ? 0 : Math.max(1, Math.round((z - first) / h + eps) + 1));
  const used: [number, number][][] = []; // per filament: [first, last] layer ranges
  const use = (f: number, from: number, to: number) => { if (to >= from) (used[f - 1] ??= []).push([from, to]); };
  const floor = Math.min(...parts.map((p) => p.bbox.min[2]));

  const slot: number[] = [], changes: FilamentChange[][] = [], paint: number[][] = [];
  for (const p of parts) {
    const top = layerAt(p.bbox.max[2] - p.bbox.min[2]) - 1;
    if (p.paint?.filaments.length && !p.layerColors?.length) {
      // Painted: every filament of it counts for its whole height; the part's own is its most used.
      const fs = p.paint.filaments.map((f) => add(hex(f.color), f.name));
      const count = fs.map(() => 0);
      for (const t of p.paint.tri) count[t]++;
      slot.push(fs[count.indexOf(Math.max(...count))]); changes.push([]); paint.push(fs);
      for (const f of new Set(fs)) use(f, layerAt(p.bbox.min[2] - floor), layerAt(p.bbox.max[2] - floor) - 1);
      continue;
    }
    paint.push([]);
    if (!p.layerColors?.length) {
      const f = add(hex(p.color));
      slot.push(f); changes.push([]);
      use(f, layerAt(p.bbox.min[2] - floor), layerAt(p.bbox.max[2] - floor) - 1);
      continue;
    }
    const stack = [...p.layerColors].sort((a, b) => a.z - b.z).map((l) => ({ f: add(hex(l.color), l.name ?? ''), layer: layerAt(l.z) }));
    // A filament that would print no layer (the next one starts on the same layer, or it starts above the top) is left out.
    const kept = stack.filter((s, k) => s.layer <= top && (k + 1 === stack.length || stack[k + 1].layer > s.layer));
    if (!kept.length || kept[0].layer > 0) kept.unshift({ ...stack[0], layer: 0 });
    kept.forEach((s, k) => use(s.f, s.layer, k + 1 < kept.length ? kept[k + 1].layer - 1 : top));
    slot.push(kept[0].f);
    changes.push(kept.slice(1).filter((s, k) => s.f !== kept[k].f)
      .map((s) => ({ filament: s.f, layer: s.layer, z: +bottom(s.layer).toFixed(5), topZ: +(first + s.layer * h).toFixed(5) })));
  }

  // AMS slots, in the order the filaments are first needed: a free slot, else one whose filament is done.
  const ams = filaments.map(() => 0);
  const span = used.map((r) => (r ? [Math.min(...r.map((x) => x[0])), Math.max(...r.map((x) => x[1]))] : null));
  const holder: number[] = []; // per AMS slot: the filament (1-based) in it
  let problem: string | undefined;
  for (const f of filaments.map((_, i) => i + 1).filter((f) => span[f - 1]).sort((a, b) => span[a - 1]![0] - span[b - 1]![0] || a - b)) {
    const start = span[f - 1]![0];
    if (holder.length < AMS_SLOTS) { holder.push(f); ams[f - 1] = holder.length; continue; }
    const free = holder.map((g, s) => ({ g, s })).filter(({ g }) => span[g - 1]![1] < start).sort((a, b) => span[a.g - 1]![1] - span[b.g - 1]![1])[0];
    if (!free) { problem ??= `More than ${AMS_SLOTS} filaments are needed at the same height (layer ${start + 1}): they can't all be in the AMS`; continue; }
    holder[free.s] = f;
    ams[f - 1] = free.s + 1;
    for (const list of changes) for (const c of list) if (c.filament === f && c.layer === start) c.pause = { slot: free.s + 1, replaces: free.g };
  }
  return { filaments, slot, paint, changes, ams, ...(problem ? { problem } : {}) };
}

/** The design's filaments, as the Bambu project gets them (the same colour and name share one). */
export function printFilaments(parts: PartMesh[]): FilamentPlan['filaments'] {
  return parts.length ? filamentPlan(parts, { layerHeight: 0.2, firstLayerHeight: 0.2 }).filaments : [];
}

/**
 * The one filament of a print in one colour ("Print in one colour", parseOneColour): the picked
 * colour when the design still has a filament in it, else the main filament, the one the biggest
 * part prints with (a painted part's most used, a LayerTone part's first).
 */
export function oneColourFilament(parts: PartMesh[], choice: 'main' | string): { colour: string; name?: string } {
  if (!parts.length) return { colour: FALLBACK_COLOUR };
  const plan = filamentPlan(parts, { layerHeight: 0.2, firstLayerHeight: 0.2 });
  const picked = plan.filaments.find((f) => f.colour === choice.toUpperCase());
  if (picked) return picked;
  const main = parts.reduce((a, _, b) => (parts[b].volume > parts[a].volume ? b : a), 0);
  return plan.filaments[plan.slot[main] - 1];
}

/**
 * Bambu Studio's colour painting of a whole (unsplit) triangle with a filament (1-based), its
 * paint_color attribute: the triangle's TriangleSelector state, written as hex digits last first.
 * The state is the filament; states below 3 are one digit (state << 2), the others "C" (0b1100,
 * "more bits follow") then the state − 3: 1 → "4", 2 → "8", 3 → "0C", 4 → "1C", 5 → "2C".
 */
export function paintColor(filament: number): string {
  return filament < 3 ? (filament << 2).toString(16).toUpperCase() : `${(filament - 3).toString(16).toUpperCase()}C`;
}

/** A part's mesh; `paint` gives each triangle's filament (a painted part), `own` the part's (left unpainted). */
function meshXml(p: PartMesh, c: number[], paint?: { filament: number[]; own: number }): string {
  const v: string[] = [];
  for (let k = 0; k < p.positions.length; k += 3) v.push(`<vertex x="${num(p.positions[k] - c[0])}" y="${num(p.positions[k + 1] - c[1])}" z="${num(p.positions[k + 2] - c[2])}"/>`);
  const t: string[] = [];
  const tri = paint && p.paint?.tri.length === p.indices.length / 3 ? p.paint.tri : undefined;
  for (let k = 0; k < p.indices.length; k += 3) {
    const f = tri ? paint!.filament[tri[k / 3]] : 0;
    t.push(`<triangle v1="${p.indices[k]}" v2="${p.indices[k + 1]}" v3="${p.indices[k + 2]}"${f && f !== paint!.own ? ` paint_color="${paintColor(f)}"` : ''}/>`);
  }
  return `<mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh>`;
}

export function toBambuProject(
  parts: PartMesh[],
  title: string,
  tpl: BambuTemplate,
  opts: {
    /** Print everything in this one filament colour (#RRGGBB): no painting, no LayerTone filament changes. */
    oneColour?: string | null;
    print: { ai: PrintProfile; user: PrintProfile } | null;
  },
): Blob {
  // Model-wide settings go into the project itself, so Bambu shows them in the main Process panel.
  // The template's own profile is the baseline: only real changes from it are written.
  const base = defaultsFromTemplate(tpl.settings);
  const globalSettings = opts.print ? effectiveSettings(opts.print.ai, opts.print.user, undefined, base) : base;
  const globalChanges = bambuOverrides(globalSettings, base);
  // A LayerTone print changes filament once per layer, for the whole layer: no prime tower is needed,
  // and on the A1's bed it collides with a big picture ("G-code conflicts"). Purging goes to the chute.
  if (parts.some((p) => p.layerColors?.length)) globalChanges.enable_prime_tower = '0';

  // Filament slots (1-based): one per distinct colour and LayerTone filament, or a single filament.
  const plan = filamentPlan(parts, globalSettings);
  const multi = !opts.oneColour;
  const colours = multi ? plan.filaments.map((f) => f.colour) : [hex(opts.oneColour!)];
  const slot = parts.map((_, i) => (multi ? plan.slot[i] : 1));

  // Whole model moved as one onto the plate (same placement as the viewer); parts with plates of
  // their own (a big piece split into pieces) each onto theirs, centred there.
  const plates = platesOf(parts, tpl);
  // The prime tower (bigger with every filament) beside the model on each plate, the model moved
  // aside if it doesn't fit beside it centred. Without room for it anywhere there is none: the A1
  // purges into its chute.
  const n = colours.length, tower = !globalChanges.enable_prime_tower && n > 1;
  const bed = bedSize(tpl);
  const towers = tower ? plates.map((pl) => placeTower(pl.footprint, n, bed)) : [];
  if (towers.some((t) => !t)) globalChanges.enable_prime_tower = '0';
  else towers.forEach((t, k) => { plates[k].shift[0] += t!.move[0]; plates[k].shift[1] += t!.move[1]; });

  const files: Record<string, Uint8Array> = {};
  const resources: string[] = [], items: string[] = [], rels: string[] = [], objectCfg: string[] = [], instances: string[] = [];
  const header = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n<metadata name="BambuStudio:3mfVersion">1</metadata>\n`;
  let nextId = 1;

  const groups = plates.flatMap((pl) => clusters(pl.parts.map((i) => parts[i])).map((g) => g.map((k) => pl.parts[k])));
  const plateOfGroup = groups.map((g) => plates.findIndex((pl) => pl.parts.includes(g[0])));
  groups.forEach((group, gi) => {
    const shift = plates[plateOfGroup[gi]].shift;
    const gb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const i of group) for (let k = 0; k < 3; k++) { gb.min[k] = Math.min(gb.min[k], parts[i].bbox.min[k]); gb.max[k] = Math.max(gb.max[k], parts[i].bbox.max[k]); }
    const c = [0, 1, 2].map((k) => (gb.min[k] + gb.max[k]) / 2);
    // The biggest part names the object and decides its print settings.
    const main = group.reduce((a, b) => (parts[b].volume > parts[a].volume ? b : a));
    const file = `3D/Objects/object_${gi + 1}.model`;
    const meshIds = group.map(() => nextId++);
    const objId = nextId++;
    // A painted part (a coloured mesh): its triangles painted with their filaments, unless it prints in one colour.
    const painting = (i: number) => (multi && plan.paint[i].length ? { filament: plan.paint[i], own: plan.slot[i] } : undefined);
    files[file] = strToU8(`${header}<resources>${group.map((i, k) => `<object id="${meshIds[k]}" type="model">${meshXml(parts[i], c, painting(i))}</object>`).join('')}</resources>\n<build/>\n</model>`);
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
    instances[plateOfGroup[gi]] = (instances[plateOfGroup[gi]] ?? '') + `<model_instance><metadata key="object_id" value="${objId}"/><metadata key="instance_id" value="0"/></model_instance>`;
  });

  if (multi) Object.assign(files, filamentChangeFiles(parts, groups, plan, globalSettings.layerHeight, String(tpl.settings.machine_pause_gcode ?? 'M400 U1')));

  // Project settings: the user's A1 + PLA + 0.20 Standard, with one filament per colour.
  const settings: Record<string, unknown> = structuredClone(tpl.settings);
  for (const k of tpl.perFilament) {
    const v = settings[k];
    if (Array.isArray(v) && v.length) settings[k] = Array(n).fill(v[0]);
  }
  for (const k of tpl.perFilamentPlus2) settings[k] = Array(n + 2).fill('');
  settings.filament_colour = colours;
  settings.filament_self_index = colours.map((_, i) => String(i + 1));
  settings.filament_map = colours.map(() => '1');
  if (tower && towers.every(Boolean)) {
    settings.wipe_tower_x = towers.map((t) => String(t!.spot[0]));
    settings.wipe_tower_y = towers.map((t) => String(t!.spot[1]));
  }
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
  files['Metadata/model_settings.config'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<config>${objectCfg.join('')}${plates.map((pl, k) => `<plate><metadata key="plater_id" value="${k + 1}"/><metadata key="plater_name" value="${esc(pl.name)}"/><metadata key="locked" value="false"/>${instances[k] ?? ''}</plate>`).join('')}<assemble></assemble></config>`);
  files['Metadata/project_settings.config'] = strToU8(JSON.stringify(settings, null, 4));
  files['[Content_Types].xml'] = strToU8(CONTENT_TYPES);
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  return new Blob([zipSync(files, { level: 6 })], { type: 'model/3mf' });
}

/**
 * The LayerTone filament changes, as Bambu Studio stores them. One LayerTone print on its own (or
 * several with the same changes) gets Bambu Studio's "change filament" marks on the layer slider
 * (Metadata/custom_gcode_per_layer.xml: a tool change at the top of the first layer in the new
 * filament). Those only apply when every object prints with a single filament, so next to other
 * objects each LayerTone object gets height ranges printed in its filaments instead
 * (Metadata/layer_config_ranges.xml; objects by their 1-based order, and the slicer crashes on a
 * range without a layer height). Pauses for AMS slot swaps are slider marks either way; on the
 * same layer as a tool change the pause comes first.
 */
function filamentChangeFiles(parts: PartMesh[], groups: number[][], plan: FilamentPlan, layerHeight: number, pauseGcode: string): Record<string, Uint8Array> {
  const changing = groups.map((g) => (g.length === 1 && plan.changes[g[0]].length ? g[0] : -1));
  if (changing.every((i) => i < 0)) return {};
  const key = (i: number) => JSON.stringify([plan.slot[i], plan.changes[i]]);
  const onSlider = changing.every((i) => i >= 0) && new Set(changing.map(key)).size === 1;
  const label = (f: number) => plan.filaments[f - 1].name || plan.filaments[f - 1].colour;
  // Slider marks by top_z (one pause and one tool change at most per layer).
  const pauses = new Map<number, string>(), toolChanges = new Map<number, string>();
  const ranges: string[] = [];
  changing.forEach((i, gi) => {
    if (i < 0 || (onSlider && gi > 0)) return; // on the slider, the first object's changes are everyone's
    const list = plan.changes[i];
    list.forEach((c, k) => {
      const before = k ? list[k - 1].filament : plan.slot[i];
      if (c.pause) pauses.set(c.topZ, `<layer top_z="${num(c.topZ)}" type="1" extruder="${before}" color="" extra="${esc(`Put ${label(c.filament)} in AMS slot ${c.pause.slot} (instead of ${label(c.pause.replaces)})`)}" gcode="${esc(pauseGcode)}"/>\n`);
      if (onSlider) toolChanges.set(c.topZ, `<layer top_z="${num(c.topZ)}" type="2" extruder="${c.filament}" color="${plan.filaments[c.filament - 1].colour}" extra="" gcode="tool_change"/>\n`);
    });
    if (!onSlider) {
      const height = parts[i].bbox.max[2] - parts[i].bbox.min[2];
      ranges.push(` <object id="${gi + 1}">\n${list.map((c, k) => `  <range min_z="${num(c.z)}" max_z="${num(k + 1 < list.length ? list[k + 1].z : height)}">\n   <option opt_key="extruder">${c.filament}</option>\n   <option opt_key="layer_height">${num(layerHeight)}</option>\n  </range>\n`).join('')} </object>\n`);
    }
  });
  const files: Record<string, Uint8Array> = {};
  if (ranges.length) files['Metadata/layer_config_ranges.xml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>\n<objects>\n${ranges.join('')}</objects>\n`);
  if (pauses.size || toolChanges.size) {
    const layers = [...new Set([...pauses.keys(), ...toolChanges.keys()])].sort((a, b) => a - b).map((z) => (pauses.get(z) ?? '') + (toolChanges.get(z) ?? '')).join('');
    files['Metadata/custom_gcode_per_layer.xml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n<plate>\n<plate_info id="1"/>\n${layers}<mode value="${onSlider ? 'MultiAsSingle' : 'MultiExtruder'}"/>\n</plate>\n</custom_gcodes_per_layer>\n`);
  }
  return files;
}
