import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { backTextPrintLayers, filamentPlan, toBambuProject } from '../src/lib/bambu3mf';
import type { LayerColor } from '../shared/layertone';
import type { BambuTemplate } from '../shared/api';
import type { BackTextMesh, PartMesh } from '../shared/types';

// The back text in the Bambu Studio project: its own filament, a modifier part from just below the
// bed to the top of print layer 2, and the swaps as height ranges (slider tool changes would print
// the text's region in the swapped filament too).

const LAYERS = { layerHeight: 0.08, firstLayerHeight: 0.16 };
const PRINT = { ai: { layerHeight: 0.08, firstLayerHeight: 0.16, parts: { Relief: { infill: 100 } } }, user: {} };
const lc = (layer: number, color: string, name: string, scale = 1): LayerColor => ({ z: +((layer ? 0.16 + (layer - 1) * 0.08 : 0) * scale).toFixed(5), layer, color, td: 1, name });
const STACK = (scale = 1) => [lc(0, '#161616', 'Black', scale), lc(5, '#1f4fd1', 'Blue', scale), lc(9, '#808080', 'Grey', scale), lc(13, '#ffffff', 'White', scale)];

/** A w x 20 x h box from z0 up. */
function boxMesh(x0: number, z0: number, w: number, d: number, h: number): { positions: Float32Array; indices: Uint32Array } {
  const v = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]].map(([x, y, z]) => [x + x0, y, z + z0]);
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()) };
}

/**
 * A LayerTone relief 40 x 20 x h from z0, its back text a small box from its bottom to topZ (the
 * part's own layers, scaled with it), in `text` (white by default, the stack's own White).
 */
function relief(opts: { h?: number; z0?: number; scale?: number; stack?: LayerColor[]; text?: { color: string; name: string } | null } = {}): PartMesh {
  const { h = 1.6, z0 = 0, scale = 1 } = opts;
  const m = boxMesh(0, z0, 40, 20, h);
  const text = opts.text === undefined ? { color: '#ffffff', name: 'White' } : opts.text;
  const topZ = +(0.24 * scale).toFixed(5);
  const backText: BackTextMesh | undefined = text ? { ...boxMesh(10, z0, 20, 4, topZ), text: 'shop.example', color: text.color, name: text.name, td: 1, layers: 2, topZ } : undefined;
  return {
    name: 'Relief', color: '#161616', ...m,
    bbox: { min: [0, 0, z0], max: [40, 20, z0 + h] }, volume: 40 * 20 * h, surfaceArea: 0, triCount: 12, genus: 0, components: 1,
    layerColors: opts.stack ?? STACK(scale), ...(backText ? { backText } : {}),
  };
}

const tpl: BambuTemplate = {
  version: '02.08.04.57',
  settings: { filament_colour: ['#00AE42'], filament_type: ['PLA'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0'], flush_volumes_vector: ['140', '140'], machine_pause_gcode: 'M400 U1', layer_height: '0.2', initial_layer_print_height: '0.2' },
  perFilament: ['filament_colour', 'filament_type'],
  perFilamentPlus2: [],
};
const unzip = async (b: Blob) => unzipSync(new Uint8Array(await b.arrayBuffer()));
const RED = { color: '#ff0000', name: 'Red' };

test('filament plan: a white text shares the stack\'s White', () => {
  const plan = filamentPlan([relief()], LAYERS);
  assert.equal(plan.filaments.length, 4);
  assert.deepEqual(plan.backText, [4]);
  assert.deepEqual(plan.backTextLayers, [2]);
  assert.equal(plan.problem, undefined);
  // No text: 0.
  const none = filamentPlan([relief({ text: null })], LAYERS);
  assert.deepEqual([none.backText, none.backTextLayers], [[0], [0]]);
});

test('filament plan: a text filament outside the stack prints layers 0 to 1, its slot reused with a pause', () => {
  const plan = filamentPlan([relief({ text: RED })], LAYERS);
  assert.equal(plan.filaments.length, 5);
  assert.deepEqual(plan.filaments[4], { colour: '#FF0000', name: 'Red' });
  assert.deepEqual(plan.backText, [5]);
  assert.equal(plan.problem, undefined);
  // Red is done after layer 1: White, the last to start, takes its AMS slot after a pause.
  assert.equal(plan.ams[4], 2);
  assert.deepEqual(plan.changes[0].map((c) => c.pause ?? null), [null, null, { slot: 2, replaces: 5 }]);
});

/** The text object's z values on the bed (its vertices after the item transform), rounded. */
function textZ(files: Record<string, Uint8Array>): number[] {
  const obj = strFromU8(files['3D/Objects/object_1.model']);
  const objects = [...obj.matchAll(/<object id="(\d+)" type="model">([^]*?)<\/object>/g)];
  assert.equal(objects.length, 2, 'the relief and its text');
  const item = /<item objectid="\d+" transform="([^"]+)"/.exec(strFromU8(files['3D/3dmodel.model']))!;
  const dz = Number(item[1].split(' ')[11]);
  return [...new Set([...objects[1][2].matchAll(/<vertex [^>]*z="([^"]+)"/g)].map((m) => +(Number(m[1]) + dz).toFixed(4)))].sort((a, b) => a - b);
}

test('Bambu project: the text is a modifier part in its filament, the swaps height ranges', async () => {
  const files = await unzip(toBambuProject([relief({ text: RED })], 't', tpl, { print: PRINT }));
  const model = strFromU8(files['3D/3dmodel.model']);
  assert.equal((model.match(/<component /g) ?? []).length, 2);
  const cfg = strFromU8(files['Metadata/model_settings.config']);
  assert.match(cfg, /<part id="\d+" subtype="modifier_part"><metadata key="name" value="Back text"\/><metadata key="matrix" value="[^"]+"\/><metadata key="extruder" value="5"\/><\/part>/);
  assert.equal((cfg.match(/subtype="normal_part"/g) ?? []).length, 1);
  const ranges = strFromU8(files['Metadata/layer_config_ranges.xml']);
  assert.deepEqual([...ranges.matchAll(/min_z="([^"]+)" max_z="([^"]+)">\n {3}<option opt_key="extruder">(\d)/g)].map((m) => m.slice(1).map(Number)), [[0.48, 0.8, 2], [0.8, 1.12, 3], [1.12, 1.6, 4]]);
  assert.match(ranges, /<object id="1">/);
  // The pause for White stays on the slider; no tool changes there.
  const marks = strFromU8(files['Metadata/custom_gcode_per_layer.xml']);
  assert.doesNotMatch(marks, /type="2"/);
  assert.deepEqual([...marks.matchAll(/<layer top_z="([^"]+)" type="(\d)"/g)].map((m) => [Number(m[1]), Number(m[2])]), [[1.2, 1]]);
  assert.match(marks, /<mode value="MultiExtruder"\/>/);
  const settings = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
  assert.deepEqual(settings.filament_colour, ['#161616', '#1F4FD1', '#808080', '#FFFFFF', '#FF0000']);

  // A white text in the stack's White: no pause, so no slider file at all.
  const white = await unzip(toBambuProject([relief()], 't', tpl, { print: PRINT }));
  assert.ok(!white['Metadata/custom_gcode_per_layer.xml']);
  assert.match(strFromU8(white['Metadata/model_settings.config']), /value="Back text"\/><metadata key="matrix" value="[^"]+"\/><metadata key="extruder" value="4"\/>/);
  assert.equal((strFromU8(white['Metadata/layer_config_ranges.xml']).match(/<range /g) ?? []).length, 3);
});

test('Bambu project: the text covers exactly the first 2 print layers, from just below the bed', async () => {
  const project = async (part: PartMesh, user: object = {}) => textZ(await unzip(toBambuProject([part], 't', tpl, { print: { ...PRINT, user } })));
  assert.deepEqual(await project(relief()), [-0.1, 0.24]);
  // The part away from z 0 (it is still placed on the bed).
  assert.deepEqual(await project(relief({ z0: 3 })), [-0.1, 0.24]);
  // Other print layers set on the Print tab: first + (2 - 1) x layer height.
  assert.deepEqual(await project(relief(), { layerHeight: 0.12, firstLayerHeight: 0.12 }), [-0.1, 0.24]);
  assert.deepEqual(await project(relief(), { layerHeight: 0.12, firstLayerHeight: 0.24 }), [-0.1, 0.36]);
  // Built at $scale 0.5 (first swap at part layer 13, z 0.56): the part's text is 0.12 mm high, the print's layers still decide.
  const half = [lc(0, '#161616', 'Black', 0.5), lc(13, '#1f4fd1', 'Blue', 0.5), lc(15, '#ffffff', 'White', 0.5)];
  assert.deepEqual(await project(relief({ h: 0.8, scale: 0.5, stack: half })), [-0.1, 0.24]);
  assert.deepEqual(await project(relief({ h: 0.8, scale: 0.5, stack: half }), { layerHeight: 0.12, firstLayerHeight: 0.24 }), [-0.1, 0.36]);
});

test('Bambu project: the first filament keeps a print layer above the text', async () => {
  // $scale 0.5 with the first swap at part layer 5 (z 0.24): Blue starts on print layer 2, so the text gets 1 layer.
  const one = relief({ h: 0.8, scale: 0.5 });
  const plan = filamentPlan([one], LAYERS);
  assert.equal(plan.changes[0][0].layer, 2);
  assert.deepEqual([plan.backText, plan.backTextLayers], [[4], [1]]);
  assert.deepEqual(textZ(await unzip(toBambuProject([one], 't', tpl, { print: PRINT }))), [-0.1, 0.16]);
  // The same part on coarse print layers (0.24 first, 0.12): Blue starts on layer 1, no room for a
  // text in red: no text filament, no modifier, the swaps back on the slider.
  const coarse = relief({ h: 0.8, scale: 0.5, text: RED });
  const plan2 = filamentPlan([coarse], { layerHeight: 0.12, firstLayerHeight: 0.24 });
  assert.equal(plan2.changes[0][0].layer, 1);
  assert.deepEqual([plan2.backText, plan2.backTextLayers, plan2.filaments.length], [[0], [0], 4]);
  // The reviewer's case: $scale 0.5, first swap at part layer 3 (z 0.16) printed at 0.08/0.16: print layer 1, no text.
  const early = relief({ h: 0.8, scale: 0.5, text: RED, stack: [lc(0, '#161616', 'Black', 0.5), lc(3, '#1f4fd1', 'Blue', 0.5), lc(9, '#ffffff', 'White', 0.5)] });
  const plan3 = filamentPlan([early], LAYERS);
  assert.deepEqual([plan3.changes[0][0].layer, plan3.backText, plan3.backTextLayers, plan3.filaments.length], [1, [0], [0], 3]);
  const files = await unzip(toBambuProject([early], 't', tpl, { print: PRINT }));
  assert.doesNotMatch(strFromU8(files['Metadata/model_settings.config']), /modifier_part/);
  assert.equal((strFromU8(files['3D/Objects/object_1.model']).match(/<object /g) ?? []).length, 1);
  assert.ok(!files['Metadata/layer_config_ranges.xml']);
  assert.match(strFromU8(files['Metadata/custom_gcode_per_layer.xml']), /type="2"[^]*<mode value="MultiAsSingle"\/>/);
});

test('Bambu project: in one colour, or without a text, no modifier and slider marks as before', async () => {
  const one = await unzip(toBambuProject([relief({ text: RED })], 't', tpl, { oneColour: '#00AE42', print: PRINT }));
  assert.doesNotMatch(strFromU8(one['Metadata/model_settings.config']), /modifier_part/);
  assert.equal((strFromU8(one['3D/Objects/object_1.model']).match(/<object /g) ?? []).length, 1);
  assert.ok(!one['Metadata/custom_gcode_per_layer.xml'] && !one['Metadata/layer_config_ranges.xml']);

  const none = await unzip(toBambuProject([relief({ text: null })], 't', tpl, { print: PRINT }));
  assert.doesNotMatch(strFromU8(none['Metadata/model_settings.config']), /modifier_part/);
  assert.ok(!none['Metadata/layer_config_ranges.xml']);
  const marks = strFromU8(none['Metadata/custom_gcode_per_layer.xml']);
  assert.equal((marks.match(/type="2"/g) ?? []).length, 3);
  assert.match(marks, /<mode value="MultiAsSingle"\/>/);
});

test('the Print tab counts the back text layers as the 3MF prints them', () => {
  // The cases above: 2 layers at full size, 1 at $scale 0.5, none on coarse layers or with an early swap.
  const cases: [PartMesh, { layerHeight: number; firstLayerHeight: number }][] = [
    [relief(), LAYERS],
    [relief({ h: 0.8, scale: 0.5 }), LAYERS],
    [relief({ h: 0.8, scale: 0.5, text: RED }), { layerHeight: 0.12, firstLayerHeight: 0.24 }],
    [relief({ h: 0.8, scale: 0.5, text: RED, stack: [lc(0, '#161616', 'Black', 0.5), lc(3, '#1f4fd1', 'Blue', 0.5), lc(9, '#ffffff', 'White', 0.5)] }), LAYERS],
  ];
  const counts = cases.map(([p, r]) => backTextPrintLayers(2, p.layerColors!, p.bbox.max[2] - p.bbox.min[2], r));
  assert.deepEqual(counts, [2, 1, 0, 0]);
  assert.deepEqual(counts, cases.map(([p, r]) => filamentPlan([p], r).backTextLayers[0]));
});
