import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, geometry } from '../server/geometry';

// The locked-down geometry process the agent's tools use (server/geometry.ts).
after(() => geometry.stop()); // the worker process would keep the event loop alive

test('evaluate reports sizes to Claude', async () => {
  const r = await geometry.evaluate('function build() { return Manifold.cube([20, 10, 5]); }');
  assert.ok(r.ok);
  assert.match(formatReport(r), /20\.00 × 10\.00 × 5\.00 mm/);
});

test('script errors come back with their line', async () => {
  const r = await geometry.evaluate('function build() {\n  return nope;\n}');
  assert.ok(!r.ok);
  assert.equal(r.error.line, 2);
});

test('the stress test finds the slider value that breaks the model', async () => {
  const s = await geometry.stress('const params = { w: { value: 20, min: 5, max: 50 } };\nfunction build(p) { if (p.w > 40) throw new Error("too wide"); return Manifold.cube([p.w, 1, 1]); }');
  assert.ok(s.failures.some((f) => f.case === 'w=50'), JSON.stringify(s.failures));
});
