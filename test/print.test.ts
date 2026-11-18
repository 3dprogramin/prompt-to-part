import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A1_DEFAULTS, bambuOverrides, cleanProfile, cleanSettings, defaultsFromTemplate, effectiveSettings, parseProfile, SETTING_GROUPS, SETTING_LABELS, describeSetting, supportStylesFor } from '../shared/print';
import { bedShift, fitProblem, printer } from '../shared/printer';

test('cleanSettings: clamps, rounds and maps values', () => {
  assert.deepEqual(cleanSettings({ walls: 3.6, infill: 150, infillPattern: 'Gyroid', supports: true, brim: 50, layerHeight: 0.22 }),
    { walls: 4, infill: 100, infillPattern: 'gyroid', supports: 'tree', brim: 20, layerHeight: 0.2 });
  assert.deepEqual(cleanSettings({ supports: false, brim: 0 }), { supports: 'off', brim: 'none' });
  assert.deepEqual(cleanSettings({ brim: 'auto', walls: '3' }), { brim: 'auto', walls: 3 });
});

test('cleanSettings: null, empty and false mean "not set", not 0', () => {
  assert.deepEqual(cleanSettings({ walls: null, infill: '', layerHeight: null, topLayers: false, bottomLayers: undefined, brim: null }), {});
});

test('cleanProfile drops unknown parts and per-part layer height', () => {
  assert.deepEqual(cleanProfile({ walls: 3, parts: { Hook: { walls: 4, layerHeight: 0.12 }, Ghost: { walls: 5 } } }, ['Hook']), { walls: 3, parts: { Hook: { walls: 4 } } });
  assert.deepEqual(parseProfile('garbage'), {});
});

test('effectiveSettings: A1 ← AI ← AI part ← user ← user part', () => {
  const ai = { walls: 3, infill: 20, parts: { Hook: { walls: 4 } } };
  const user = { infill: 30, parts: { Hook: { infill: 50 } } };
  assert.deepEqual(effectiveSettings(ai, user), { ...A1_DEFAULTS, walls: 3, infill: 30 });
  assert.deepEqual(effectiveSettings(ai, user, 'Hook'), { ...A1_DEFAULTS, walls: 4, infill: 50 });
});

test('bambuOverrides lists only what differs', () => {
  assert.deepEqual(bambuOverrides(A1_DEFAULTS), {});
  assert.deepEqual(bambuOverrides({ ...A1_DEFAULTS, brim: 3 }), { brim_type: 'outer_only', brim_width: '3' });
  const s = bambuOverrides({ ...A1_DEFAULTS, supports: 'normal' });
  assert.equal(s.enable_support, '1');
  assert.equal(s.support_type, 'normal(auto)');
});

test('fitProblem and bedShift follow the printer', () => {
  const [w, d] = printer().bed;
  assert.equal(fitProblem({ min: [0, 0, 0], max: [w, d, printer().height] }), null);
  assert.match(fitProblem({ min: [0, 0, 0], max: [w + 0.5, 10, 10] })!, /X/);
  assert.deepEqual(bedShift([{ min: [-10, -10, 2], max: [10, 10, 12] }]), [w / 2, d / 2, -2]);
});

test('the new settings: cleaned, written as Bambu values, compared with the baseline', () => {
  assert.deepEqual(cleanSettings({ ironing: 'top', seam: 'back', supportsOnPlate: true, wallOrder: 'outer-inner', fuzzySkin: 'external' }),
    { ironing: 'top', seam: 'back', supportsOnPlate: true, wallOrder: 'outer-inner', fuzzySkin: 'external' });
  assert.deepEqual(cleanSettings({ ironing: 'everywhere', seam: 'left', supportsOnPlate: 'yes', wallOrder: 'x', fuzzySkin: true }), { fuzzySkin: 'external' });
  assert.deepEqual(bambuOverrides({ ...A1_DEFAULTS, ironing: 'topmost', wallOrder: 'inner-outer-inner', supportsOnPlate: true }),
    { ironing_type: 'topmost', wall_sequence: 'inner-outer-inner wall', support_on_build_plate_only: '1' });
});

test('the baseline comes from the Bambu template', () => {
  const tpl = {
    layer_height: '0.2', wall_loops: '3', top_shell_layers: '5', bottom_shell_layers: '3', sparse_infill_density: '20%', sparse_infill_pattern: 'gyroid',
    enable_support: '0', support_type: 'tree(auto)', brim_type: 'auto_brim', brim_width: '5', ironing_type: 'no ironing', seam_position: 'aligned',
    support_on_build_plate_only: '0', wall_sequence: 'inner wall/outer wall', fuzzy_skin: 'none',
  };
  const base = defaultsFromTemplate(tpl);
  assert.deepEqual(base, { ...A1_DEFAULTS, walls: 3, infill: 20, infillPattern: 'gyroid' });
  // A setting equal to the template's is not a change, even if it differs from the fallback.
  assert.deepEqual(bambuOverrides(effectiveSettings({ walls: 3 }, {}, undefined, base), base), {});
  assert.deepEqual(bambuOverrides(effectiveSettings({ walls: 2 }, {}, undefined, base), base), { wall_loops: '2' });
  // Missing or unknown values fall back.
  assert.deepEqual(defaultsFromTemplate({}), A1_DEFAULTS);
  assert.equal(defaultsFromTemplate({ ...tpl, brim_type: 'outer_only', brim_width: '7', enable_support: '1', support_type: 'normal(auto)' }).brim, 7);
});


test('top surface pattern: cleaned by id or name, written as Bambu\'s key, read from the template', () => {
  assert.deepEqual(cleanSettings({ topPattern: 'Concentric' }), { topPattern: 'concentric' });
  assert.deepEqual(cleanSettings({ topPattern: 'Monotonic line' }), { topPattern: 'monotonicline' });
  assert.deepEqual(cleanSettings({ topPattern: 'gyroid' }), {});
  assert.deepEqual(cleanProfile({ parts: { Lid: { topPattern: 'concentric' } } }), { parts: { Lid: { topPattern: 'concentric' } } });
  assert.deepEqual(bambuOverrides({ ...A1_DEFAULTS, topPattern: 'concentric' }), { top_surface_pattern: 'concentric' });
  const base = defaultsFromTemplate({ top_surface_pattern: 'monotonic' });
  assert.equal(base.topPattern, 'monotonic');
  assert.deepEqual(bambuOverrides(effectiveSettings({ topPattern: 'monotonic' }, {}, undefined, base), base), {});
});

test('the 2026-11-18 settings: cleaned, clamped, odd values dropped', () => {
  assert.deepEqual(cleanSettings({ supportAngle: '45.4', supportGap: 0.123, supportInterfaceLayers: 9, supportStyle: 'tree_organic', topOneWall: true, infillDirection: 200,
    wallGenerator: 'arachne', scarfSeam: true, ironingSpeed: 5, ironingFlow: '15', ironingSpacing: 0.5, holeCompensation: -2, contourCompensation: '0.05', elephantFoot: 0.1234, spiralVase: true }),
  { supportAngle: 45, supportGap: 0.12, supportInterfaceLayers: 5, supportStyle: 'tree_organic', topOneWall: 'all', infillDirection: 180,
    wallGenerator: 'arachne', scarfSeam: 'external', ironingSpeed: 10, ironingFlow: 15, ironingSpacing: 0.3, holeCompensation: -0.5, contourCompensation: 0.05, elephantFoot: 0.123, spiralVase: true });
  assert.deepEqual(cleanSettings({ supportAngle: null, supportGap: '', supportStyle: 'organic', topOneWall: 'yes', wallGenerator: true, scarfSeam: 'outer', ironingFlow: 'x', spiralVase: 'on', holeCompensation: NaN }), {});
  // Ironing flow as Bambu writes it, a percent string.
  assert.deepEqual(cleanSettings({ ironingFlow: '15%' }), { ironingFlow: 15 });
  assert.deepEqual(cleanSettings({ ironingFlow: '40 %' }), { ironingFlow: 30 });
});

test('scarf seam is model-wide: a value on a part is dropped', () => {
  assert.deepEqual(cleanProfile({ scarfSeam: 'external', parts: { Vase: { scarfSeam: 'all', walls: 3 } } }), { scarfSeam: 'external', parts: { Vase: { walls: 3 } } });
  assert.deepEqual(cleanSettings({ scarfSeam: 'all' }, false), {});
});

test('spiral vase is model-wide and forces what it needs', () => {
  assert.deepEqual(cleanProfile({ spiralVase: true, parts: { Vase: { spiralVase: true, walls: 3 } } }), { spiralVase: true, parts: { Vase: { walls: 3 } } });
  assert.deepEqual(bambuOverrides({ ...A1_DEFAULTS, spiralVase: true, walls: 4, infill: 40, supports: 'tree' }),
    { spiral_mode: '1', wall_loops: '1', top_shell_layers: '0', sparse_infill_density: '0%', skeleton_infill_density: '0%', skin_infill_density: '0%' });
});

test('a support style that does not fit the support type is written as default', () => {
  assert.equal(bambuOverrides({ ...A1_DEFAULTS, supports: 'normal', supportStyle: 'tree_organic' }).support_style, undefined);
  assert.equal(bambuOverrides({ ...A1_DEFAULTS, supports: 'tree', supportStyle: 'tree_organic' }).support_style, 'tree_organic');
  assert.equal(bambuOverrides({ ...A1_DEFAULTS, supports: 'tree', supportStyle: 'snug' }).support_style, undefined);
  assert.deepEqual(supportStylesFor('normal'), ['default', 'grid', 'snug']);
});

test('the new settings as Bambu values, and nothing written for an old design or a template without the keys', () => {
  assert.deepEqual(bambuOverrides({ ...A1_DEFAULTS, topOneWall: 'off', infillDirection: 0, wallGenerator: 'arachne', scarfSeam: 'all', ironingFlow: 15, holeCompensation: 0.1, elephantFoot: 0.15, supportGap: 0.25 }),
    { top_one_wall_type: 'not apply', infill_direction: '0', wall_generator: 'arachne', seam_slope_type: 'all', ironing_flow: '15%', xy_hole_compensation: '0.1', elefant_foot_compensation: '0.15', support_top_z_distance: '0.25' });
  assert.deepEqual(bambuOverrides(effectiveSettings({}, {})), {});
  const base = defaultsFromTemplate({ ironing_flow: '12%', top_one_wall_type: 'topmost', elefant_foot_compensation: '0.15', wall_generator: 'arachne', spiral_mode: '0' });
  assert.deepEqual([base.ironingFlow, base.topOneWall, base.elephantFoot, base.wallGenerator, base.spiralVase, base.supportAngle], [12, 'topmost', 0.15, 'arachne', false, 30]);
  assert.deepEqual(bambuOverrides(base, base), {});
});

test('every setting has a label, a group or a main row, and a description', () => {
  const grouped = SETTING_GROUPS.flatMap((g) => g.keys);
  assert.equal(new Set(grouped).size, 15);
  for (const k of Object.keys(A1_DEFAULTS) as (keyof typeof A1_DEFAULTS)[]) {
    assert.ok(SETTING_LABELS[k], k);
    assert.ok(describeSetting(k, A1_DEFAULTS[k]) !== 'undefined', k);
  }
});
