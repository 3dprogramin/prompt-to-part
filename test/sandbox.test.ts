import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript, ScriptError } from '../shared/runtime';

const run = (code: string) => evaluateScript(code, {}, 'draft');
const fails = (code: string, pattern: RegExp, stage?: string) => {
  try {
    run(code);
  } catch (e) {
    assert.ok(e instanceof ScriptError, `expected a ScriptError, got ${e}`);
    assert.match(e.info.message, pattern);
    if (stage) assert.equal(e.info.stage, stage);
    return e.info;
  }
  assert.fail(`expected ${pattern} to be thrown`);
};

test('scripts see no host globals', () => {
  const r = run('function build() { console.log(typeof process, typeof require, typeof fetch, typeof setTimeout, typeof globalThis.process); return Manifold.cube([1, 1, 1]); }');
  assert.equal(r.logs[0], 'undefined undefined undefined undefined undefined');
});

test('constructor escapes are disarmed', () => {
  for (const escape of ['(() => {}).constructor("return process")()', 'Manifold.constructor("return 1")()', 'Manifold.cube.constructor("return 1")()', 'H.constructor.constructor("return 1")()']) {
    fails(`function build() { ${escape}; return Manifold.cube([1, 1, 1]); }`, /not a valid constructor/);
  }
});

test('shared intrinsics are frozen', () => {
  fails('function build() { Array.prototype.x = 1; return Manifold.cube([1, 1, 1]); }', /not extensible|read only/);
  fails('function build() { Object.prototype.y = 1; return Manifold.cube([1, 1, 1]); }', /not extensible|read only/);
});

test('import(), eval( and HTML comments are refused before the script runs', () => {
  for (const code of ['import("fs"); function build() {}', 'function build() { return eval("1"); }', '<!-- x\nfunction build() {}']) {
    assert.throws(() => run(code), (e: unknown) => e instanceof ScriptError && e.info.stage === 'compile');
  }
});

test('a script cannot change the classes later scripts use', () => {
  fails('function build() { Object.getPrototypeOf(Manifold.cube([1, 1, 1])).scale = function () { return this; }; return Manifold.cube([1, 1, 1]); }', /read only/);
  fails('function build() { Manifold.cube = () => null; return Manifold.sphere(1); }', /read only/);
  fails('function build() { Manifold.cube([1, 1, 1]).$$.ptrType.registeredClass.rawDestructor = () => {}; return Manifold.cube([1, 1, 1]); }', /read only/);
  // ...so a later script still gets correct geometry
  const r = run('function build() { return Manifold.cube([2, 2, 2]).scale(2); }');
  assert.equal(Math.round(r.parts[0].volume), 64);
});

test('an undeclared name is an error with its line, not undefined', () => {
  const info = fails('const params = { chamfer: { value: 1 } };\nfunction build(p) {\n  if (chamfr) return Manifold.cube([1, 1, 1]);\n  return Manifold.cube([2, 2, 2]);\n}', /"chamfr" is not defined/, 'compile');
  assert.equal(info.line, 3);
  // typeof, destructuring, hoisting, classes and labels are fine
  run('function build({ w = 2, ...rest }) { if (typeof foo !== "undefined") return null; const [a, , b = w] = [1, 2]; outer: for (const i of [1]) break outer; class A { #p = 1; get g() { return this.#p; } } return helper(a + b + new A().g); }\nfunction helper(s) { return Manifold.cube([s, 1, 1]); }');
});

test('syntax errors have a line number', () => {
  const info = fails('function build() {\n  return (\n}', /Syntax error/, 'compile');
  assert.equal(info.line, 3);
});

test('console output and error messages are capped', () => {
  const r = run('function build() { console.log(Array.from({ length: 50000 }, (_, i) => i)); return Manifold.cube([1, 1, 1]); }');
  assert.ok(r.logs[0].length < 600, `log line is ${r.logs[0].length} characters`);
});
