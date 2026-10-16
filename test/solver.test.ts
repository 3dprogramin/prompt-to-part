import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveDimension } from '../shared/solver';

const CODE = 'const params = { w: { value: 20, min: 5, max: 60, drives: "x" }, h: { value: 5, min: 1, max: 30 }, n: { type: "int", value: 4, min: 1, max: 12 } };\nfunction build(p) { return { parts: [Manifold.cube([p.w * 2, 10 + p.n * 0, p.h])], dimensions: [{ label: "h", from: [0, 0, 0], to: [0, 0, p.h], param: "h" }] }; }';

test('bounding-box target is reached through the driving parameter', () => {
  const r = solveDimension(CODE, {}, { kind: 'bbox', axis: 0 }, 60, 'draft');
  assert.equal(r.ok, true);
  assert.equal(r.key, 'w');
  assert.ok(Math.abs(r.value! - 30) < 0.01);
});

test('callout target uses its linked parameter', () => {
  const r = solveDimension(CODE, {}, { kind: 'callout', index: 0 }, 12, 'draft');
  assert.equal(r.key, 'h');
  assert.ok(Math.abs(r.value! - 12) < 0.01);
});

test('scale is taken into account', () => {
  const r = solveDimension(CODE, { $scale: 2 }, { kind: 'bbox', axis: 0 }, 60, 'draft');
  assert.ok(Math.abs(r.value! - 15) < 0.01);
});

test('impossible targets explain themselves', () => {
  assert.equal(solveDimension(CODE, {}, { kind: 'bbox', axis: 0 }, -1, 'draft').message, 'Enter a positive size.');
  assert.equal(solveDimension(CODE, {}, { kind: 'bbox', axis: 1 }, 50, 'draft').message, 'No parameter changes the Y size.');
});
