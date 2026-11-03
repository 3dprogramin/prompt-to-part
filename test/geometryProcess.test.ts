import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { diedOfOom, formatReport, geometry } from '../server/geometry';

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

test('attached drawings reach the geometry process', async () => {
  const drawing = { name: 'sq.svg', aspect: 1, shapes: [{ rule: 'NonZero', contours: [[[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]] }] };
  const r = await geometry.evaluate("function build() { return H.svg('sq.svg', { height: 10 }).extrude(2); }", { $drawings: JSON.stringify({ 'sq.svg': drawing }) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(formatReport(r), /10\.00 × 10\.00 × 2\.00 mm/);
});


// The tipping check: a narrow post with a heavy load high up falls over, a wide base holds it.
const BASE = { layerHeight: 0.2, walls: 2, topLayers: 4, bottomLayers: 4, infill: 15 } as never;
const tower = (base: number) => `function build() {
  const b = Manifold.cube([${base}, 20, 10]);
  const post = Manifold.cube([10, 20, 60]).translate([0, 0, 10]);
  return { parts: [b.add(post)], loads: [{ name: 'phone', mass: 200, at: [25, 10, 60] }] };
}`;

test('a tall load on a narrow post tips', async () => {
  const r = await geometry.stability({ code: tower(10), extra: {}, poses: [{ label: 'default', values: {} }], printBase: BASE, nozzle: 0.4 });
  assert.equal(r.poses[0].ok, false, JSON.stringify(r));
  assert.deepEqual(r.loads, ['phone (200 g)']);
});

test('a wide base holds it', async () => {
  const r = await geometry.stability({ code: tower(80), extra: {}, poses: [{ label: 'default', values: {} }], printBase: BASE, nozzle: 0.4 });
  assert.equal(r.poses[0].ok, true, JSON.stringify(r));
});

test('a pose that fails reports its error', async () => {
  const code = 'const params = { tilt: { value: 10, min: 0, max: 90 } };\nfunction build(p) { if (p.tilt > 50) throw new Error("too steep"); return Manifold.cube([20, 20, 5]); }';
  const r = await geometry.stability({ code, extra: {}, poses: [{ label: 'flat', values: {} }, { label: 'steep', values: { tilt: 60 } }], printBase: BASE, nozzle: 0.4 });
  assert.equal(r.poses[1].ok, false);
  assert.match(r.poses[1].error ?? '', /too steep/);
  assert.equal(r.poses[0].error, undefined);
});

test('a pose with a misnamed or mistyped parameter is an error, not the defaults', async () => {
  const code = `const params = { tiltAngle: { value: 10, min: 0, max: 90 }, swivel: { value: 0, min: -45, max: 45 }, foot: { type: 'select', value: 'round', options: [{ value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }] } };
function build(p) { return Manifold.cube([20, 20, 5]); }`;
  const r = await geometry.stability({ code, extra: {}, poses: [
    { label: 'tilt 60', values: { tilt: 60 } },
    { label: 'steep', values: { tiltAngle: '60' } },
    { label: 'square foot', values: { foot: 'hexagon' } },
  ], printBase: BASE, nozzle: 0.4 });
  assert.equal(r.poses[0].ok, false);
  assert.match(r.poses[0].error ?? '', /unknown parameter "tilt" \(parameters: tiltAngle, swivel, foot\)/);
  assert.match(r.poses[1].error ?? '', /parameter "tiltAngle" needs a number/);
  assert.match(r.poses[2].error ?? '', /"foot" has no option "hexagon" \(options: round, square\)/);
});

test('upright turns a part printed on its side', async () => {
  const code = 'function build() { return Manifold.cube([60, 10, 10]); }';
  const flat = await geometry.stability({ code, extra: {}, poses: [{ label: 'p', values: {} }], printBase: BASE, nozzle: 0.4 });
  const up = await geometry.stability({ code, extra: {}, poses: [{ label: 'p', values: {} }], printBase: BASE, nozzle: 0.4, upright: [0, -90, 0] });
  // Standing on the 10 mm end the centre of mass is 30 mm up: edge distance 5 mm; lying down it is 5 mm too, but 5 mm high.
  assert.ok(up.poses[0].com[2] > 25 && up.poses[0].com[2] < 35, JSON.stringify(up));
  assert.ok(flat.poses[0].com[2] < 10, JSON.stringify(flat));
  assert.ok(up.poses[0].edgeMm < 6, JSON.stringify(up));
});

// Stop: a generation's jobs are dropped while they wait and the worker is killed while one runs.
const SLOW = 'function build() { let x = 0; for (let i = 0; i < 1e11; i++) x += i; return Manifold.cube([1, 1, x > 0 ? 1 : 2]); }';

test('a stopped generation\'s geometry jobs end at once, and the next job still runs', async () => {
  const a = new AbortController();
  const b = new AbortController();
  const running = geometry.evaluate(SLOW, undefined, undefined, a.signal);
  const waiting = geometry.evaluate('function build() { return Manifold.cube([1, 1, 1]); }', undefined, undefined, b.signal);
  // Another design's job (no signal), queued behind both.
  const other = geometry.evaluate('function build() { return Manifold.cube([3, 3, 3]); }');
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  b.abort();
  await assert.rejects(waiting, /Stopped/);
  a.abort();
  await assert.rejects(running, /Stopped/);
  assert.ok(Date.now() - t0 < 2000, 'took too long');
  const r = await other;
  assert.ok(r.ok);
  assert.match(formatReport(r), /3\.00 × 3\.00 × 3\.00 mm/);
  // Already stopped: never queued.
  await assert.rejects(geometry.render(SLOW, undefined, a.signal), /Stopped/);
});

test('a worker killed by running out of JavaScript heap counts as out of memory (not retried)', () => {
  assert.equal(diedOfOom(null, 'SIGABRT'), true);
  assert.equal(diedOfOom(134, null), true);
  assert.equal(diedOfOom(null, 'SIGTERM'), false);
  assert.equal(diedOfOom(1, null), false);
  assert.equal(diedOfOom(0, null), false);
});
