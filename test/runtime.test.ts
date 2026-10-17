import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript, normalizeParams, resolveValues, ScriptError } from '../shared/runtime';

const CUBE = 'const params = { w: { value: 20, min: 5, max: 60 }, n: { type: "int", value: 3 } };\nfunction build(p) { return Manifold.cube([p.w, 10, 5]); }';

test('a cube: size, volume, triangles, values', () => {
  const r = evaluateScript(CUBE, {}, 'draft');
  assert.deepEqual(r.bbox, { min: [0, 0, 0], max: [20, 10, 5] });
  assert.equal(Math.round(r.parts[0].volume), 1000);
  assert.equal(r.parts[0].triCount, 12);
  assert.equal(r.parts[0].components, 1);
  assert.deepEqual(r.values, { w: 20, n: 3 });
});

test('uniform scale ($scale) scales the model and its callouts', () => {
  const code = 'function build() { return { parts: [Manifold.cube([10, 10, 10])], dimensions: [{ label: "w", from: [0, 0, 0], to: [10, 0, 0] }] }; }';
  const r = evaluateScript(code, { $scale: 2 }, 'draft');
  assert.deepEqual(r.bbox!.max, [20, 20, 20]);
  assert.deepEqual(r.dimensions[0].to, [20, 0, 0]);
});

test('values: bad input falls back to the default, integers round', () => {
  const params = normalizeParams({ w: { value: 20 }, n: { type: 'int', value: 3 }, s: { type: 'select', options: ['a', 'b'], value: 'a' }, b: { value: true } });
  assert.deepEqual(resolveValues(params, { w: NaN, n: 2.6, s: 'zzz', b: 'yes' as never }), { w: 20, n: 3, s: 'a', b: true });
});

test('normalizeParams: types, aliases, ranges', () => {
  const p = normalizeParams([{ key: 'a', type: 'bool', value: false }, { name: 'f', type: 'font', value: 'std:roboto-700' }, { key: 'r', value: 5, min: 10, max: 2 }, { key: 'e', type: 'select', options: [] }]);
  assert.equal(p.a.type, 'boolean');
  assert.equal(p.f.type, 'text');
  assert.equal((p.f as { font?: boolean }).font, true);
  assert.deepEqual([(p.r as { min: number }).min, (p.r as { max: number }).max], [2, 10]);
  assert.equal(p.e, undefined);
  // a negative default gets a range around it, not a 1 mm slider at its edge
  const n = normalizeParams({ o: { value: -10 } }).o as { min: number; max: number };
  assert.deepEqual([n.min, n.max], [-20, 0]);
  // frozen params work (they are read, never written)
  assert.equal(normalizeParams(Object.freeze({ f: Object.freeze({ type: 'font', value: 'x' }) })).f.type, 'text');
  // a __proto__ key from JSON is just ignored
  normalizeParams(JSON.parse('{"__proto__": {"value": 1}}'));
  assert.equal(({} as Record<string, unknown>).value, undefined);
});

test('outputs: a Manifold, an array, or { parts }', () => {
  assert.equal(evaluateScript('function build() { return Manifold.cube([1, 1, 1]); }', {}, 'draft').parts.length, 1);
  assert.equal(evaluateScript('function build() { return [Manifold.cube([1, 1, 1]), Manifold.sphere(1)]; }', {}, 'draft').parts.length, 2);
  const r = evaluateScript('function build() { return { parts: [{ name: "A", shape: Manifold.cube([1, 1, 1]) }], print: { walls: 4, infill: null } }; }', {}, 'draft');
  assert.equal(r.parts[0].name, 'A');
  assert.deepEqual(r.print, { walls: 4 });
});

test('errors: stage, line, message', () => {
  const err = (code: string) => { try { evaluateScript(code, {}, 'draft'); } catch (e) { return (e as ScriptError).info; } assert.fail('no error'); };
  assert.equal(err('function build() { return CrossSection.square([1, 1]); }').stage, 'output');
  assert.match(err('function build() { return [Manifold.cube([1, 1, 1]), 5]; }').message, /Part 2 is not a Manifold/);
  assert.match(err('async function build() { return Manifold.cube([1, 1, 1]); }').message, /must be synchronous/);
  const thrown = err('function build() {\n  const x = 1;\n  throw new Error("boom");\n}');
  assert.deepEqual([thrown.stage, thrown.line, thrown.message], ['build', 3, 'boom']);
});

test('an empty part is a warning, not a part', () => {
  const r = evaluateScript('function build() { return [Manifold.cube([1, 1, 1]), Manifold.cube([0, 0, 0])]; }', {}, 'draft');
  assert.equal(r.parts.length, 1);
  assert.ok(r.warnings.some((w) => /is empty/.test(w)));
});

test('a sealed cavity is not a separate piece', () => {
  const r = evaluateScript('function build() { return Manifold.cube([20, 20, 20]).subtract(Manifold.cube([10, 10, 10]).translate([5, 5, 5])); }', {}, 'draft');
  assert.equal(r.parts[0].components, 1);
});

test('assembly steps naming unknown parts are dropped with a warning', () => {
  const r = evaluateScript('function build() { return { parts: [{ name: "A", shape: Manifold.cube([1, 1, 1]) }], assembly: [{ label: "x", parts: ["B"] }] }; }', {}, 'draft');
  assert.equal(r.assembly.length, 0);
  assert.ok(r.warnings.some((w) => /unknown part/.test(w)));
});

test('many builds free their wasm objects (no growth)', () => {
  const code = 'function build() { return Manifold.union(Array.from({ length: 20 }, (_, i) => Manifold.sphere(5, 24).translate([i * 3, 0, 0]))); }';
  for (let i = 0; i < 5; i++) evaluateScript(code, {}, 'draft');
  const before = process.memoryUsage().rss;
  for (let i = 0; i < 40; i++) evaluateScript(code, {}, 'draft');
  assert.ok(process.memoryUsage().rss - before < 100 * 2 ** 20, 'RSS grew by more than 100 MB');
});

test('callouts, warnings and parameter text are capped', () => {
  const code = `const params = { ['k'.repeat(5000)]: { value: 1 }, ok: { value: 1, label: 'L'.repeat(5000) } };
function build() {
  const dimensions = [];
  for (let i = 0; i < 2000; i++) dimensions.push({ label: i + 'x'.repeat(5000), from: [0, 0], to: [1, 0] });
  return { parts: [Manifold.cube([1, 1, 1])], dimensions };
}`;
  const r = evaluateScript(code, undefined, 'draft');
  assert.ok(r.warnings.length <= 26, `${r.warnings.length} warnings`);
  assert.match(r.warnings.at(-1)!, /more warnings/);
  assert.ok(r.warnings.every((w) => w.length < 400));
  assert.deepEqual(Object.keys(r.params), ['ok']);
  assert.equal(r.params.ok.label!.length, 120);
});
