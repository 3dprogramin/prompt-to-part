import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cadTools } from '../server/cadTools';
import { geometry } from '../server/geometry';
import type { AgentEvent } from '../shared/api';

// submit_model's tipping check, driven as the Agent SDK calls the tools.
const dir = mkdtempSync(path.join(os.tmpdir(), 'jig-stability-gate-'));
after(() => { geometry.stop(); rmSync(dir, { recursive: true, force: true }); });

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
type Tools = Record<string, { handler: (a: unknown, extra: unknown) => Promise<Result> }>;

/** Writes `code` as model.js, renders it, then submits with `input`; returns the result and the events. */
async function submit(name: string, code: string, input: Record<string, unknown> = {}) {
  const file = path.join(dir, name, 'model.js');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, code);
  const events: AgentEvent[] = [];
  const { server } = cadTools(file, (e) => events.push(e));
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

test('a flat box passes without stability input', async () => {
  const { result, steps, model } = await submit('box', 'function build() { return Manifold.cube([40, 30, 5]); }');
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(steps.some((s) => /Tipping check passed/.test(s.text)), steps.map((s) => s.text).join('\n'));
  assert.equal(model?.stability?.poses.length, 1);
});

test('a top-heavy stand is rejected', async () => {
  const { result, text, steps, model } = await submit('tower', tower(10));
  assert.ok(result.isError);
  assert.match(text, /tips over/);
  assert.match(text, /outside the base/);
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
