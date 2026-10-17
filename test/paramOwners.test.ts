import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import { nudge, probeParamOwners } from '../shared/paramOwners';

const CODE = `const params = {
  lidT: { value: 3, min: 1, max: 6 },
  width: { value: 40, min: 20, max: 80 },
  label: { type: 'text', value: 'AB' },
  unused: { value: 5, min: 0, max: 10 },
};
function build(p) { return [
  { name: 'Box', shape: Manifold.cube([p.width, 30, 20]) },
  { name: 'Lid', shape: Manifold.cube([p.width, 30, p.lidT]).translate([0, 40, 0]) },
]; }`;

test('each parameter is matched with the parts it really changes', () => {
  const base = evaluateScript(CODE, {}, 'draft');
  const owners = probeParamOwners(base, {}, (v) => evaluateScript(CODE, v, 'draft'));
  assert.deepEqual(owners.lidT, ['Lid']);
  assert.deepEqual(owners.width, ['Box', 'Lid']);
  assert.equal(owners.unused, undefined);
  assert.equal(owners.label, undefined);
});

test('nudged values stay in range and keep text length', () => {
  assert.equal(nudge({ type: 'number', min: 0, max: 10, value: 10 }, 10), 9);
  assert.equal(nudge({ type: 'integer', min: 0, max: 3, value: 1 }, 1), 2);
  assert.equal(nudge({ type: 'text', value: 'DREAM' }, 'DREAM'), 'DREAA');
  assert.equal(nudge({ type: 'text', value: 'Roboto', font: true }, 'Roboto'), null);
  assert.equal(nudge({ type: 'boolean', value: true }, true), false);
});
