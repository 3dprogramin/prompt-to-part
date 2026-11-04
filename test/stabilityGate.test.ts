import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cadTools } from '../server/cadTools';
import { geometry } from '../server/geometry';
import type { AgentEvent } from '../shared/api';

// submit_model's tipping check, driven as the Agent SDK calls the tools.
const dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-stability-gate-'));
after(() => { geometry.stop(); rmSync(dir, { recursive: true, force: true }); });

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
type Tools = Record<string, { handler: (a: unknown, extra: unknown) => Promise<Result> }>;

/** Writes `code` as model.js, renders it, then submits with `input`; returns the result and the events. */
async function submit(name: string, code: string, input: Record<string, unknown> = {}, options: Parameters<typeof cadTools>[4] = {}) {
  const file = path.join(dir, name, 'model.js');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, code);
  const events: AgentEvent[] = [];
  const { server } = cadTools(file, (e) => events.push(e), new Set(), {}, options);
  const tools = (server.instance as unknown as { _registeredTools: Tools })._registeredTools;
  const shown = await tools.render_model.handler({}, {});
  assert.ok(!shown.isError, JSON.stringify(shown));
  const result = await tools.submit_model.handler({ summary: 'test', sources: [], ...input }, {});
  const text = result.content.map((c) => c.text ?? '').join('\n');
  const steps = events.flatMap((e) => (e.type === 'step' ? [e.step] : []));
  const model = events.find((e) => e.type === 'model') as Extract<AgentEvent, { type: 'model' }> | undefined;
  return { result, text, steps, model };
}

// The narrow post from the geometry worker's test: a 200 g load high up and off to the side.
const tower = (base: number) => `function build() {
  const b = Manifold.cube([${base}, 20, 10]);
  const post = Manifold.cube([10, 20, 60]).translate([0, 0, 10]);
  return { parts: [b.add(post)], loads: [{ name: 'phone', mass: 200, at: [25, 10, 60] }] };
}`;

test('a flat box passes quietly: no chat step, no strip', async () => {
  const { result, steps, model } = await submit('box', 'function build() { return Manifold.cube([40, 30, 5]); }');
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(!steps.some((s) => /Tipping check/.test(s.text) && !s.verbose), steps.map((s) => s.text).join('\n'));
  assert.ok(model);
  assert.equal(model.stability, undefined);
});

test('a ball with nothing on it passes: no flat base is not a failure', async () => {
  const { result, steps, model } = await submit('ball', 'function build() { return Manifold.sphere(15, 12); }');
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(steps.some((s) => s.verbose && /no flat base to check: rests on a point or a line/.test(s.detail ?? '')), JSON.stringify(steps));
  assert.equal(model?.stability, undefined);
});

test('a ball holding a load is rejected with advice to flatten it', async () => {
  const code = "function build() { return { parts: [Manifold.sphere(15, 12)], loads: [{ name: 'egg', mass: 60, at: [0, 0, 30] }] }; }";
  const { result, text } = await submit('ball-load', code);
  assert.ok(result.isError, JSON.stringify(result));
  assert.match(text, /flatten the underside/);
});

// A 100 mm slab with a 30 g load 50 mm past its edge: a printed slab of normal infill outweighs it,
// one of 1 wall and no infill does not.
const slab = `function build() {
  return { parts: [Manifold.cube([100, 100, 20])], loads: [{ name: 'weight', mass: 30, at: [150, 50, 20] }] };
}`;

test("the user's print settings weigh the parts", async () => {
  const normal = await submit('slab', slab);
  assert.ok(!normal.result.isError, normal.text);
  const light = await submit('slab-light', slab, {}, { printProfile: JSON.stringify({ walls: 1, infill: 0 }) });
  assert.ok(light.result.isError, light.text);
  assert.match(light.text, /tips over/);
});

test('a top-heavy stand is rejected', async () => {
  const { result, text, steps, model } = await submit('tower', tower(10));
  assert.ok(result.isError);
  assert.match(text, /tips over/);
  assert.match(text, /outside the base/);
  // Which way: the centre of mass and the base's extent, and what it carries.
  assert.match(text, /centre of mass at x [\d.]+, y [\d.]+; base spans x 0\.\.10, y 0\.\.20/);
  assert.match(text, /Loads: phone \(200 g\)/);
  assert.equal(model, undefined);
  const failed = steps.find((s) => s.ok === false && /tip/i.test(s.text));
  assert.ok(failed?.detail?.includes('default'), JSON.stringify(steps));
});

test('an explanation lets it through', async () => {
  const { result, steps, model } = await submit('wall', tower(10), { stability: { explanation: 'screwed to the wall' } });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(model?.stability?.explanation, 'screwed to the wall');
  assert.ok(steps.some((s) => /Tipping check: explained - screwed to the wall/.test(s.text)), steps.map((s) => s.text).join('\n'));
});

test('each pose is checked', async () => {
  // Stands at the default tilt; at tilt 60 the load swings far past the 20 mm base.
  const code = `const params = { tilt: { value: 10, min: 0, max: 90 } };
function build(p) {
  const b = Manifold.cube([20, 20, 5]);
  return { parts: [b], loads: [{ name: 'tablet', mass: 300, at: [p.tilt > 50 ? 60 : 10, 10, 40] }] };
}`;
  const { result, text } = await submit('tilt', code, { stability: { poses: [{ label: 'tilt 60', values: { tilt: 60 } }] } });
  assert.ok(result.isError, JSON.stringify(result));
  assert.match(text, /tilt 60/);
  assert.doesNotMatch(text, /default:/);
});

test('a pose that cannot be evaluated is reported as failing, not tipping', async () => {
  const code = `const params = { tiltAngle: { value: 10, min: 0, max: 90 } };
function build(p) { return Manifold.cube([40, 40, 5]); }`;
  const { result, text } = await submit('typo', code, { stability: { poses: [{ label: 'tilt 60', values: { tilt: 60 } }] } });
  assert.ok(result.isError, JSON.stringify(result));
  assert.match(text, /Rejected - the design fails in these poses:/);
  assert.match(text, /unknown parameter "tilt" \(parameters: tiltAngle\)/);
  assert.doesNotMatch(text, /tips over/);
});

test('an explanation covers tipping, not a pose that could not be evaluated', async () => {
  // The default pose tips (explained away); the misnamed pose never ran, so it must still be refused.
  const code = `const params = { tiltAngle: { value: 10, min: 0, max: 90 } };
function build(p) {
  return { parts: [Manifold.cube([10, 10, 5])], loads: [{ name: 'phone', mass: 200, at: [40, 5, 40] }] };
}`;
  const { result, text } = await submit('typo-explained', code, { stability: { poses: [{ label: 'tilt 60', values: { tilt: 60 } }], explanation: 'screwed to the wall' } });
  assert.ok(result.isError, JSON.stringify(result));
  assert.match(text, /Rejected - the design fails in these poses:/);
  assert.match(text, /unknown parameter "tilt" \(parameters: tiltAngle\)/);
  assert.doesNotMatch(text, /tips over/);
});

test('a check that cannot run warns but does not block the design', async () => {
  const real = geometry.stability;
  geometry.stability = async () => { throw new Error('timed out'); };
  try {
    const { result, steps, model } = await submit('broken', tower(10));
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(steps.some((s) => s.text === "Tipping check couldn't run: timed out"), steps.map((s) => s.text).join('\n'));
    assert.ok(model && model.stability === undefined);
  } finally {
    geometry.stability = real;
  }
});
