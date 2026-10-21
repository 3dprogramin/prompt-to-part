import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import { solveDimension } from '../shared/solver';
import { boxSize, cleanSizes, hashText, mainAxis, nextSize, printableMax, resolveSize, sizeKey, sizePlan, suggestSizes, type SizeTools } from '../shared/sizes';
import type { ParamValues } from '../shared/types';

// Stand-ins for the geometry worker: the same runtime and solver, in this process.
const tools: SizeTools = {
  evaluate: async (v: ParamValues) => { try { return evaluateScript(code, v, 'normal'); } catch (e) { return { error: (e as Error).message }; } },
  solve: async (v, target, goal) => solveDimension(code, v, target, goal, 'normal'),
};
let code = '';
const at = (c: string) => { code = c; return tools; };

// A plaque with a raised border and lettering: no parameters, so a size scales it.
const PLAQUE = 'function build() { return [Manifold.cube([150, 100, 5]), Manifold.cube([150, 6, 2]).translate([0, 0, 5]), Manifold.cube([60, 20, 1.5]).translate([45, 40, 5])]; }';
// A 3D box with no parameters.
const BOX = 'function build() { return Manifold.cube([40, 30, 60]); }';
// A sign whose width and height are driving parameters (and a border width that isn't).
const SIGN = 'const params = { width: { value: 200, min: 80, max: 300, drives: "x" }, height: { value: 120, min: 50, max: 250, drives: "y" }, thick: { value: 4, min: 2, max: 8 } };\nfunction build(p) { return Manifold.cube([p.width, p.height, p.thick]).add(Manifold.cube([p.width - 20, p.height - 20, 1]).translate([10, 10, p.thick])); }';
// A mug-like solid with only its height driven.
const TALL = 'const params = { h: { value: 90, min: 40, max: 200, drives: "z" } };\nfunction build(p) { return Manifold.cylinder(p.h, 40, 40, 64); }';

const size = (r: { size: number[] } | { error: string }) => { assert.ok(!('error' in r), JSON.stringify(r)); return (r as { size: number[] }).size; };

test('a flat piece without parameters: only its face scales, its thickness and reliefs stay', async () => {
  const r = await resolveSize(at(PLAQUE), {}, 0, 225, 'k');
  assert.ok(!('error' in r));
  assert.equal(r.how, 'face');
  assert.deepEqual(r.size, [225, 150, 7]);
  assert.ok(Math.abs(Number(r.values.$faceScale) - 1.5) < 1e-6);
  assert.equal(r.values.$scale, undefined);
  // Built for real: the same values give the same model.
  const built = evaluateScript(PLAQUE, r.values, 'normal');
  assert.deepEqual(boxSize(built)!.map((v) => +v.toFixed(2)), [225, 150, 7]);
});

test('a solid without parameters scales uniformly, on top of the user\'s Scale %', async () => {
  const r = await resolveSize(at(BOX), { $scale: 0.5 }, 2, 45, 'k');
  assert.ok(!('error' in r));
  assert.equal(r.how, 'scale');
  assert.deepEqual(r.size, [30, 22.5, 45]);
  assert.ok(Math.abs(Number(r.values.$scale) - 0.75) < 1e-6, 'as if the user had typed 75 %');
});

test('driving parameters make the size: the face in proportion, thickness and borders as designed', async () => {
  const r = await resolveSize(at(SIGN), {}, 0, 300, 'k');
  assert.ok(!('error' in r));
  assert.equal(r.how, 'params');
  assert.ok(Math.abs(Number(r.values.width) - 300) < 0.01);
  assert.ok(Math.abs(Number(r.values.height) - 180) < 0.01);
  assert.equal(r.values.thick, undefined, 'thickness is not a driver of the face');
  assert.deepEqual(size(r), [300, 180, 5]);
  assert.equal(r.note, undefined);
  // The same as editing W and D in Overall size.
  const w = solveDimension(SIGN, {}, { kind: 'bbox', axis: 0 }, 300, 'normal');
  assert.equal(w.key, 'width');
});

test('a size past a driving parameter\'s range is still built, with a note', async () => {
  const r = await resolveSize(at(SIGN), {}, 0, 400, 'k');
  assert.ok(!('error' in r));
  assert.deepEqual(size(r), [400, 240, 5]);
  assert.match(r.note ?? '', /Width is 400, outside its slider's range \(80 to 300\)/i);
});

test('a solid with one driven axis follows it alone (as Overall size does)', async () => {
  const r = await resolveSize(at(TALL), {}, 2, 135, 'k');
  assert.ok(!('error' in r));
  assert.equal(r.how, 'params');
  assert.deepEqual(r.values, { h: 135 });
  assert.equal(size(r)[2], 135);
});

test('the plan picks the main axis and the way a size is made', () => {
  assert.equal(mainAxis([150, 100, 5]), 0);
  assert.equal(mainAxis([80, 120, 5]), 1, 'a flat piece by its longer side');
  assert.equal(mainAxis([40, 30, 60]), 2);
  const plaque = evaluateScript(PLAQUE, {}, 'draft');
  assert.equal(sizePlan(plaque, {}, 0, 300)!.how, 'face');
  const sign = evaluateScript(SIGN, {}, 'draft');
  assert.deepEqual(sizePlan(sign, {}, 0, 300)!.goals.map((g) => g.axis), [0, 1]);
  assert.equal(sizePlan(sign, {}, 0, -1), null);
});

test('suggested sizes sit around the current one, within the limits, rounded', () => {
  assert.deepEqual(suggestSizes(150, [10, 256]), [{ label: 'S', mm: 105 }, { label: 'M', mm: 150 }, { label: 'L', mm: 210 }]);
  assert.deepEqual(suggestSizes(200, [80, 250]), [{ label: 'S', mm: 140 }, { label: 'M', mm: 200 }, { label: 'L', mm: 250 }]);
  assert.deepEqual(suggestSizes(30, [28, 32]).map((s) => s.mm), [28, 30, 32]);
  assert.equal(suggestSizes(100, [100, 100]).length, 1, 'no room: one size');
  assert.equal(Math.round(printableMax([150, 100, 5], 0)), 256);
  assert.equal(Math.round(printableMax([40, 30, 120], 2)), 256);
  assert.equal(Math.round(printableMax([200, 100, 50], 0)), 256);
  assert.deepEqual(nextSize([{ label: 'S', mm: 100 }, { label: 'M', mm: 150 }, { label: 'L', mm: 200 }], 150, 256), { label: 'XL', mm: 250 });
  assert.deepEqual(nextSize([], 147, 256), { label: 'M', mm: 145 });
  assert.deepEqual(nextSize([{ label: 'A4', mm: 297 }], 200, 256), { label: 'Size 1', mm: 370 });
});

test('sizes stored with a design are checked; an old design has none; keys change with the design', () => {
  assert.deepEqual(cleanSizes(undefined), []);
  assert.deepEqual(cleanSizes('nope'), []);
  const ok = { id: 's1', label: 'M', axis: 0, mm: 150, resolved: { key: 'a', values: { width: 150 }, size: [150, 90, 4], how: 'params' }, slice: { key: 'b', stats: { seconds: 3600, grams: 40, filaments: [] } } };
  assert.deepEqual(cleanSizes([ok, { id: 's2', label: 'L', axis: 5, mm: 1 }, null, { id: '', label: 'x', axis: 0, mm: 1 }]), [ok]);
  assert.equal(cleanSizes([{ ...ok, resolved: { key: 'a', size: [1, 2] } }])[0].resolved, undefined);
  assert.equal(cleanSizes([{ ...ok, label: 'x'.repeat(100) }])[0].label.length, 24);
  assert.equal(cleanSizes(Array.from({ length: 20 }, (_, i) => ({ ...ok, id: `s${i}` }))).length, 8);
  assert.notEqual(sizeKey(SIGN, {}, 0, 150), sizeKey(SIGN, { thick: 5 }, 0, 150));
  assert.notEqual(sizeKey(SIGN, {}, 0, 150), sizeKey(SIGN, {}, 0, 151));
  assert.equal(sizeKey(SIGN, {}, 0, 150), sizeKey(SIGN, {}, 0, 150));
  assert.match(hashText('x'), /^[0-9a-z]+$/);
});
