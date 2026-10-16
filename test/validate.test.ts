import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import { validateResult } from '../src/geometry/validate';

const check = (code: string, opts = {}) => validateResult(evaluateScript(code, {}, 'normal'), opts).issues.map((i) => i.title);

test('a cube on the plate has no issues', () => {
  assert.deepEqual(check('function build() { return Manifold.cube([20, 20, 20]); }'), []);
});

test('thin walls, floating parts and overlaps are found', () => {
  assert.ok(check('function build() { return Manifold.cube([20, 20, 0.3]); }').includes('Walls too thin to print'));
  assert.ok(check('function build() { return Manifold.cube([20, 20, 20]).translate([0, 0, 5]); }').includes('Floating above the plate'));
  assert.ok(check('function build() { return [Manifold.cube([20, 20, 20]), Manifold.cube([20, 20, 20]).translate([10, 0, 0])]; }').some((t) => /overlap/.test(t)));
});

test('a sealed cavity is not "pieces in mid-air"', () => {
  const issues = check('function build() { return Manifold.cube([20, 20, 20]).subtract(Manifold.cube([10, 10, 10]).translate([5, 5, 5])); }');
  assert.ok(!issues.includes('Pieces in mid-air'), issues.join(', '));
  assert.ok(!issues.some((t) => /separate pieces/.test(t)));
});

test('only the exported parts are checked', () => {
  const code = 'function build() { return [{ name: "A", shape: Manifold.cube([200, 20, 20]) }, { name: "B", shape: Manifold.cube([200, 20, 20]).translate([210, 0, 0]) }]; }';
  assert.ok(check(code).some((t) => /Too big/.test(t)));
  assert.ok(!check(code, { parts: ['A'] }).some((t) => /Too big/.test(t)));
});

test('supports in the print settings turn the overhang warning into info', () => {
  const code = 'function build() { return [{ name: "T", shape: Manifold.union([Manifold.cube([10, 10, 30]), Manifold.cube([40, 10, 5]).translate([0, 0, 25])]) }]; }';
  const r = validateResult(evaluateScript(code, {}, 'normal'), { supportParts: ['T'] });
  assert.ok(r.issues.some((i) => i.title.includes('supports enabled') && i.severity === 'info'));
});
