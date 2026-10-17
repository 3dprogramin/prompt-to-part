import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A1_DEFAULTS, bambuOverrides, cleanProfile, cleanSettings, defaultsFromTemplate, effectiveSettings, parseProfile } from '../shared/print';
import { bedShift, fitProblem, PRINTER } from '../shared/printer';

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

test('fitProblem and bedShift follow PRINTER', () => {
  const [w, d] = PRINTER.bed;
  assert.equal(fitProblem({ min: [0, 0, 0], max: [w, d, PRINTER.height] }), null);
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

