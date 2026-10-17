// A script that rewrites a Manifold object's embind record ($$) must not reach other objects'
// memory; the worker is retired instead (own file: it leaves the runtime marked as trapped).
import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript, runtimeTrapped } from '../shared/runtime';

const CUBE = 'function build() { return Manifold.cube([2, 3, 4]); }';

test('a rewritten heap pointer is refused and retires the worker', () => {
  assert.equal(runtimeTrapped(), false);
  const evil = 'function build() { const a = Manifold.cube([1, 1, 1]); const b = Manifold.cube([2, 2, 2]); a.$$.ptr = b.$$.ptr; return a.translate([0, 0, 0]); }';
  assert.throws(() => evaluateScript(evil, undefined, 'draft'), /internals of a Manifold/);
  assert.equal(runtimeTrapped(), true);
  // Nothing was freed twice: later designs still build correctly.
  for (let i = 0; i < 3; i++) assert.equal(Math.round(evaluateScript(CUBE, undefined, 'draft').parts[0].volume), 24);
});

test('a tampered handle the script catches still retires the worker', () => {
  const evil = 'function build() { const a = Manifold.cube([1, 1, 1]); try { a.$$.count.value = 0; a.volume(); } catch (e) {} return Manifold.cube([1, 1, 1]); }';
  evaluateScript(evil, undefined, 'draft');
  assert.equal(runtimeTrapped(), true);
});

test('clone() is refused', () => {
  assert.throws(() => evaluateScript('function build() { return Manifold.cube([1, 1, 1]).clone(); }', undefined, 'draft'), /clone\(\) is not available/);
});
