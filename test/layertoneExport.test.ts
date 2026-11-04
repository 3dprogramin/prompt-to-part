import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import Module from 'manifold-3d';
import { filamentPlan, toBambuProject } from '../src/lib/bambu3mf';
import { A1_DEFAULTS, bambuOverrides, cleanProfile, cleanSettings, defaultsFromTemplate } from '../shared/print';
import { DATA_DIR } from '../server/config';
import { findBambuBinary } from '../server/bambu';
import { slicedProject, sliceProject } from '../server/slicer';
import { evaluateScript } from '../shared/runtime';
import { LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, toLayerToneImage, type LayerColor } from '../shared/layertone';
import type { BambuTemplate } from '../shared/api';
import type { PartMesh } from '../shared/types';

// LayerTone layers: 0.16 mm first layer, then 0.08 mm; layer i (≥ 1) starts at 0.16 + (i - 1) × 0.08.
const LAYERTONE_PRINT = { ai: { layerHeight: 0.08, firstLayerHeight: 0.16, parts: { Relief: { infill: 100 } } }, user: {} };
const lc = (layer: number, color: string, name: string): LayerColor => ({ z: layer ? +(0.16 + (layer - 1) * 0.08).toFixed(2) : 0, layer, color, td: 1, name });
const FOUR = [lc(0, '#161616', 'Black'), lc(5, '#808080', 'Grey'), lc(9, '#ff0000', 'Red'), lc(13, '#ffffff', 'White')];
const SIX = [lc(0, '#161616', 'Black'), lc(5, '#808080', 'Grey'), lc(7, '#ff0000', 'Red'), lc(9, '#ffffff', 'White'), lc(12, '#0000ff', 'Blue'), lc(15, '#ffff00', 'Yellow')];
const LAYERS = { layerHeight: 0.08, firstLayerHeight: 0.16 };

/** A part with only its box (enough for the plan). */
function box(name: string, x0: number, w: number, h: number, color: string, layerColors?: LayerColor[]): PartMesh {
  const v = [[0, 0, 0], [w, 0, 0], [w, 20, 0], [0, 20, 0], [0, 0, h], [w, 0, h], [w, 20, h], [0, 20, h]].map(([x, y, z]) => [x + x0, y, z]);
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { name, color, positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()), bbox: { min: [x0, 0, 0], max: [x0 + w, 20, h] }, volume: w * 20 * h, surfaceArea: 0, triCount: 12, genus: 0, components: 1, ...(layerColors ? { layerColors } : {}) };
}

test('first layer height: a model-wide setting read from and written to Bambu Studio', () => {
  assert.equal(A1_DEFAULTS.firstLayerHeight, 0.2);
  assert.deepEqual(cleanSettings({ firstLayerHeight: 0.17, layerHeight: 0.08 }), { firstLayerHeight: 0.16, layerHeight: 0.08 });
  assert.deepEqual(cleanProfile({ parts: { Relief: { firstLayerHeight: 0.16, infill: 100 } } }), { parts: { Relief: { infill: 100 } } });
  assert.equal(defaultsFromTemplate({ initial_layer_print_height: '0.24' }).firstLayerHeight, 0.24);
  assert.deepEqual(bambuOverrides({ ...A1_DEFAULTS, firstLayerHeight: 0.16, layerHeight: 0.08 }), { initial_layer_print_height: '0.16', layer_height: '0.08' });
});

test('filament plan: a change starts on the layer at its height; the same colour and name share a filament', () => {
  const plan = filamentPlan([box('Relief', 0, 40, 1.6, '#161616', FOUR)], LAYERS);
  assert.deepEqual(plan.filaments, [{ colour: '#161616', name: 'Black' }, { colour: '#808080', name: 'Grey' }, { colour: '#FF0000', name: 'Red' }, { colour: '#FFFFFF', name: 'White' }]);
  assert.deepEqual(plan.slot, [1]);
  assert.deepEqual(plan.changes[0], [
    { filament: 2, layer: 5, z: 0.48, topZ: 0.56 },
    { filament: 3, layer: 9, z: 0.8, topZ: 0.88 },
    { filament: 4, layer: 13, z: 1.12, topZ: 1.2 },
  ]);
  assert.deepEqual(plan.ams, [1, 2, 3, 4]);
  assert.equal(plan.problem, undefined);

  // Black again on top shares Black's filament; a black of another name gets its own.
  const again = filamentPlan([box('Relief', 0, 40, 1.6, '#161616', [lc(0, '#161616', 'Black'), lc(5, '#ffffff', 'White'), lc(9, '#161616', 'Black'), lc(13, '#161616', 'Other black')])], LAYERS);
  assert.equal(again.filaments.length, 3);
  assert.deepEqual(again.changes[0].map((c) => c.filament), [2, 1, 3]);
  // A part in a LayerTone filament's colour prints with it.
  assert.deepEqual(filamentPlan([box('Relief', 0, 40, 1.6, '#161616', FOUR), box('Frame', 50, 5, 2, '#ff0000')], LAYERS).slot, [1, 3]);
});

test('filament plan: a scaled part or other layer heights move a change to the nearest layer', () => {
  // $scale 1.5: the heights (and the relief) grow, the changes follow them, not the layer numbers.
  const scaled = FOUR.map((l) => ({ ...l, z: l.z * 1.5 }));
  assert.deepEqual(filamentPlan([box('Relief', 0, 40, 2.4, '#161616', scaled)], LAYERS).changes[0].map((c) => [c.layer, c.z]), [[8, 0.72], [14, 1.2], [20, 1.68]]);
  const plan = filamentPlan([box('Relief', 0, 40, 1.6, '#161616', FOUR)], { layerHeight: 0.2, firstLayerHeight: 0.2 });
  assert.deepEqual(plan.changes[0].map((c) => [c.layer, c.z, c.topZ]), [[2, 0.4, 0.6], [4, 0.8, 1], [6, 1.2, 1.4]]);
  // Changes on the same layer: the last wins; above the top: dropped.
  const at = (z: number, color: string, name: string): LayerColor => ({ z, layer: 0, color, td: 1, name });
  const crowded = filamentPlan([box('Relief', 0, 40, 1, '#161616', [at(0, '#161616', 'Black'), at(0.44, '#808080', 'Grey'), at(0.48, '#ff0000', 'Red'), at(1.12, '#ffffff', 'White')])], { layerHeight: 0.2, firstLayerHeight: 0.2 });
  assert.deepEqual(crowded.changes[0].map((c) => [c.filament, c.layer]), [[3, 2]]);
});

test('filament plan: beyond 4 filaments, a pause and the AMS slot of a filament that is done', () => {
  const plan = filamentPlan([box('Relief', 0, 40, 1.6, '#161616', SIX)], LAYERS);
  assert.deepEqual(plan.ams, [1, 2, 3, 4, 1, 2]);
  assert.deepEqual(plan.changes[0].map((c) => c.pause ?? null), [null, null, null, { slot: 1, replaces: 1 }, { slot: 2, replaces: 2 }]);
  // A normal part keeps its slot for the whole print, so the LayerTone filaments share the other three.
  const mixed = filamentPlan([box('Relief', 0, 40, 1.6, '#161616', SIX), box('Block', 50, 10, 5, '#00ff00')], LAYERS);
  assert.deepEqual(mixed.ams, [1, 3, 4, 1, 3, 4, 2]);
  // Four colours used all the way up leave no slot for the LayerTone print's changes.
  const full = filamentPlan([box('Relief', 0, 40, 1.6, '#161616', FOUR), ...['#00ff00', '#00ffff', '#ff00ff', '#ffaa00'].map((c, k) => box(`B${k}`, 50 + 15 * k, 10, 5, c))], LAYERS);
  assert.match(full.problem ?? '', /More than 4 filaments/);
});

// The engine's own output: a gradient picture with four filaments swapped at layers 6, 9 and 13.
const gradient = toLayerToneImage('gradient.png', 200, 100, Uint8Array.from({ length: 200 * 100 * 4 }, (_, i) => (i % 4 === 3 ? 255 : Math.round(((i >> 2) % 200) / 199 * 255))));
const ENGINE_VALUES = {
  [LAYERTONE_IMAGES_KEY]: JSON.stringify({ 'gradient.png': gradient }),
  [LAYERTONE_KEY]: JSON.stringify({ filaments: [['Black', '#161616', 0.6], ['Blue', '#1f4fd1', 1.2], ['Red', '#d12f1f', 1.5], ['White', '#ffffff', 3]].map(([name, color, td]) => ({ name, color, td })), swaps: [6, 9, 13] }),
};
const ENGINE_SCRIPT = "function build() { return { name: 'Picture', ...H.layertone('gradient.png', { width: 100 }) }; }";

test("filament plan: the engine's layers and print settings", () => {
  const r = evaluateScript(ENGINE_SCRIPT, ENGINE_VALUES, 'draft');
  assert.deepEqual(r.print, { layerHeight: 0.08, firstLayerHeight: 0.16, infill: 100, infillPattern: 'zig-zag' });
  const plan = filamentPlan(r.parts, { layerHeight: r.print.layerHeight!, firstLayerHeight: r.print.firstLayerHeight! });
  assert.deepEqual(plan.changes[0].map((c) => c.layer), r.parts[0].layerColors!.slice(1).map((l) => l.layer));
  assert.deepEqual(plan.changes[0].map((c) => c.topZ), [0.64, 0.88, 1.2]);
  // At $scale 1.5 the changes stay with the relief's heights (0.84 → 0.88, 1.2, 1.68), not at layers 6, 9 and 13.
  const scaled = evaluateScript(ENGINE_SCRIPT, { ...ENGINE_VALUES, $scale: 1.5 }, 'draft');
  assert.deepEqual(filamentPlan(scaled.parts, LAYERS).changes[0].map((c) => c.z), [0.88, 1.2, 1.68]);
});

const tpl: BambuTemplate = {
  version: '02.08.04.57',
  settings: { filament_colour: ['#00AE42'], filament_type: ['PLA'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0'], flush_volumes_vector: ['140', '140'], machine_pause_gcode: 'M400 U1', layer_height: '0.2', initial_layer_print_height: '0.2' },
  perFilament: ['filament_colour', 'filament_type'],
  perFilamentPlus2: [],
};
const unzip = async (b: Blob) => unzipSync(new Uint8Array(await b.arrayBuffer()));

test('Bambu project: a LayerTone print alone gets "change filament" marks on the layer slider', async () => {
  const files = await unzip(toBambuProject([box('Relief', 0, 40, 1.6, '#161616', SIX)], 't', tpl, { print: LAYERTONE_PRINT }));
  const xml = strFromU8(files['Metadata/custom_gcode_per_layer.xml']);
  const marks = [...xml.matchAll(/<layer top_z="([^"]+)" type="(\d)" extruder="(\d+)" color="([^"]*)" extra="([^"]*)"/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), m[4], m[5]]);
  assert.deepEqual(marks, [
    [0.56, 2, 2, '#808080', ''],
    [0.72, 2, 3, '#FF0000', ''],
    [0.88, 2, 4, '#FFFFFF', ''],
    [1.12, 1, 4, '', 'Put Blue in AMS slot 1 (instead of Black)'],
    [1.12, 2, 5, '#0000FF', ''],
    [1.36, 1, 5, '', 'Put Yellow in AMS slot 2 (instead of Grey)'],
    [1.36, 2, 6, '#FFFF00', ''],
  ]);
  assert.match(xml, /<plate>\n<plate_info id="1"\/>\n/);
  assert.match(xml, /<mode value="MultiAsSingle"\/>/);
  assert.ok(!files['Metadata/layer_config_ranges.xml']);
  const settings = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
  assert.deepEqual(settings.filament_colour, ['#161616', '#808080', '#FF0000', '#FFFFFF', '#0000FF', '#FFFF00']);
  assert.equal(settings.layer_height, '0.08');
  assert.equal(settings.initial_layer_print_height, '0.16');
  assert.equal(settings.enable_prime_tower, '0', 'no prime tower: it collides with a big picture');
  const cfg = strFromU8(files['Metadata/model_settings.config']);
  assert.match(cfg, /value="Relief"\/><metadata key="extruder" value="1"\/><metadata key="sparse_infill_density" value="100%"\/>/);

  // Ordinary multi-colour parts keep the prime tower.
  const normal = await unzip(toBambuProject([box('Block', -10, 10, 5, '#00ff00'), box('Lid', 20, 40, 5, '#ff0000')], 't', tpl, { print: LAYERTONE_PRINT }));
  assert.notEqual(JSON.parse(strFromU8(normal['Metadata/project_settings.config'])).enable_prime_tower, '0');

  // Without colours: one filament, no changes.
  const plain = await unzip(toBambuProject([box('Relief', 0, 40, 1.6, '#161616', FOUR)], 't', tpl, { oneColour: '#00AE42', print: LAYERTONE_PRINT }));
  assert.ok(!plain['Metadata/custom_gcode_per_layer.xml'] && !plain['Metadata/layer_config_ranges.xml']);
});

test('Bambu project: next to other objects, a LayerTone print gets height ranges in its filaments', async () => {
  // The block touches the relief but stays its own object, after it.
  const files = await unzip(toBambuProject([box('Block', -10, 10, 5, '#00ff00'), box('Relief', 0, 40, 1.6, '#161616', FOUR)], 't', tpl, { print: LAYERTONE_PRINT }));
  const ranges = strFromU8(files['Metadata/layer_config_ranges.xml']);
  assert.match(ranges, /^<\?xml[^]*<objects>\n <object id="2">\n {2}<range min_z="0.48" max_z="0.8">\n {3}<option opt_key="extruder">3<\/option>\n {3}<option opt_key="layer_height">0.08<\/option>\n {2}<\/range>/);
  assert.deepEqual([...ranges.matchAll(/min_z="([^"]+)" max_z="([^"]+)">\n {3}<option opt_key="extruder">(\d)/g)].map((m) => m.slice(1).map(Number)), [[0.48, 0.8, 3], [0.8, 1.12, 4], [1.12, 1.6, 5]]);
  // Five filaments: White takes Black's AMS slot after a pause, the only slider mark.
  const marks = strFromU8(files['Metadata/custom_gcode_per_layer.xml']);
  assert.deepEqual([...marks.matchAll(/<layer top_z="([^"]+)" type="(\d)"/g)].map((m) => [Number(m[1]), Number(m[2])]), [[1.2, 1]]);
  assert.match(marks, /extra="Put White in AMS slot 2 \(instead of Black\)"[^]*<mode value="MultiExtruder"\/>/);
  assert.equal((strFromU8(files['Metadata/model_settings.config']).match(/<object id=/g) ?? []).length, 2);
});

// ---------------------------------------------------------------------------
// Slicing with the user's Bambu Studio (skipped without it, or before the app has built its template).
// ---------------------------------------------------------------------------

const TEMPLATE = path.join(DATA_DIR, 'bambu', 'template.json');
const canSlice = !!(await findBambuBinary()) && existsSync(TEMPLATE);

/** A stepped relief: 10 mm steps of these heights, 20 mm deep. */
async function steps(heights: number[]): Promise<PartMesh> {
  const wasm = await Module();
  wasm.setup();
  let m = wasm.Manifold.cube([10 * heights.length, 20, heights[0]]);
  heights.forEach((h, k) => { m = m.add(wasm.Manifold.cube([10, 20, h]).translate([10 * k, 0, 0])); });
  const g = m.getMesh(), b = m.boundingBox();
  const positions = new Float32Array(g.vertProperties.length / g.numProp * 3);
  for (let i = 0; i < positions.length / 3; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = g.vertProperties[i * g.numProp + k];
  return { name: 'Relief', color: '#161616', positions, indices: new Uint32Array(g.triVerts), bbox: { min: [...b.min] as [number, number, number], max: [...b.max] as [number, number, number] }, volume: m.volume(), surfaceArea: m.surfaceArea(), triCount: g.triVerts.length / 3, genus: 0, components: 1 };
}

/** Each tool change in the G-code (T0…), with the layer it happens on ("; Z_HEIGHT"), and the pauses. */
function filamentCommands(gcode: string): { tool: string[]; pause: number[] } {
  let z = 0;
  const tool: string[] = [], pause: number[] = [];
  for (const line of gcode.split('\n')) {
    const zh = /^; Z_HEIGHT: (.+)/.exec(line);
    if (zh) z = Number(zh[1]);
    const t = /^T(\d+)\s*$/.exec(line);
    if (t && t[1] !== '255') tool.push(`${z}:T${t[1]}`);
    if (line.startsWith('M400 U1')) pause.push(z);
  }
  return { tool, pause };
}

test('Bambu Studio slices the filament changes on the intended layers', { skip: !canSlice && 'needs Bambu Studio and its prompt-to-part template' }, async () => {
  const realTpl = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as BambuTemplate;
  // The engine's relief, with its own print settings.
  const r = evaluateScript(ENGINE_SCRIPT, ENGINE_VALUES, 'draft');
  const picture = await slicedProject(new Uint8Array(await toBambuProject(r.parts, 'Picture', realTpl, { print: { ai: r.print, user: {} } }).arrayBuffer()));
  assert.deepEqual(filamentCommands(strFromU8(picture['Metadata/plate_1.gcode'])).tool, ['0.64:T1', '0.88:T2', '1.2:T3']);
  assert.match(strFromU8(picture['Metadata/slice_info.config']), /<filament id="4"[^>]*color="#FFFFFF"/);

  const relief = { ...(await steps([0.48, 0.8, 1.12, 1.6])), layerColors: SIX };
  const project = async (parts: PartMesh[]) => new Uint8Array(await toBambuProject(parts, 'LayerTone test', realTpl, { print: LAYERTONE_PRINT }).arrayBuffer());

  // Alone: slider marks. Each change happens at the start of the layer whose top is topZ; the pauses just before.
  const alone = await slicedProject(await project([relief]));
  const { tool, pause } = filamentCommands(strFromU8(alone['Metadata/plate_1.gcode']));
  assert.deepEqual(tool, ['0.56:T1', '0.72:T2', '0.88:T3', '1.12:T4', '1.36:T5']);
  assert.deepEqual(pause.filter((z) => z > 0.2), [1.12, 1.36]);
  // Every filament prints its own share.
  const stats = await sliceProject(await project([relief]));
  assert.deepEqual(stats.filaments.map((f) => f.color), ['#161616', '#808080', '#FF0000', '#FFFFFF', '#0000FF', '#FFFF00']);
  assert.ok(stats.filaments.every((f) => f.grams > 0));

  // Next to a block in another colour: height ranges (the block's own changes interleave).
  const mixed = await slicedProject(await project([relief, { ...box('Block', 60, 10, 3, '#00ff00'), name: 'Block' }]));
  const m = filamentCommands(strFromU8(mixed['Metadata/plate_1.gcode']));
  const firstOf = (t: string) => m.tool.find((x) => x.endsWith(`:${t}`));
  assert.deepEqual(['T1', 'T2', 'T3', 'T4', 'T5'].map(firstOf), ['0.56:T1', '0.72:T2', '0.88:T3', '1.12:T4', '1.36:T5']);
  assert.deepEqual(m.pause.filter((z) => z > 0.2), [0.88, 1.12, 1.36]);
  const info = strFromU8(mixed['Metadata/slice_info.config']);
  assert.equal((info.match(/<filament id=/g) ?? []).length, 7);
});
