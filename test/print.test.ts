import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A1_DEFAULTS, bambuOverrides, cleanProfile, cleanSettings, effectiveSettings, parseProfile } from '../shared/print';
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
