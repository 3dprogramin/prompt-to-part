// Stop before Claude starts: the steps runGeneration takes first (a render of the current model,
// OpenSCAD for attached files) end at once and the query never runs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, GenerateRequest } from '../shared/api';
import { DEFAULT_PRINTER, setPrinter } from '../shared/printer';

const dataDir = mkdtempSync(path.join(tmpdir(), 'jig-stop-'));
// server/config.ts reads these when it is first imported.
process.env.JIG_DATA = dataDir;
process.env.ANTHROPIC_API_KEY = 'test';
setPrinter(DEFAULT_PRINTER);
const { runGeneration } = await import('../server/agent');
const { geometry } = await import('../server/geometry');
after(() => { geometry.stop(); rmSync(dataDir, { recursive: true, force: true }); });

/** Runs a generation that is stopped when it emits the live line `at`; whether the query ran. */
async function stoppedAt(req: GenerateRequest, at: RegExp): Promise<{ queried: boolean; events: AgentEvent[] }> {
  const abort = new AbortController();
  const events: AgentEvent[] = [];
  let queried = false;
  const fake = (() => { queried = true; return (async function* () {})(); }) as unknown as typeof query;
  await runGeneration(req, (e) => { events.push(e); if (e.type === 'live' && at.test(e.text)) abort.abort(); }, abort, fake);
  return { queried, events };
}

test('Stop while the app renders the current model: no query', async () => {
  const req: GenerateRequest = { designId: 'stop-test-0001', prompt: 'taller', code: 'function build() { return Manifold.cube([1, 1, 1]); }', renderValues: {} };
  const { queried, events } = await stoppedAt(req, /Capturing the current model/);
  assert.equal(queried, false);
  assert.ok(!events.some((e) => e.type === 'step' && e.step.kind === 'render'), 'no render after the stop');
});

test('Stop while OpenSCAD renders an attached file: no query, no further files', async () => {
  const req: GenerateRequest = { designId: 'stop-test-0002', prompt: 'rebuild it', scad: [{ name: 'a.scad', source: 'cube(1);' }, { name: 'b.scad', source: 'cube(2);' }] };
  const { queried, events } = await stoppedAt(req, /Rendering a\.scad/);
  assert.equal(queried, false);
  assert.ok(!events.some((e) => e.type === 'live' && /b\.scad/.test(e.text)), 'b.scad was not rendered');
  assert.ok(!events.some((e) => e.type === 'step' && e.step.kind === 'tool' && e.step.ok === false), 'the stop is not reported as an OpenSCAD failure');
});

test('Stop right at the start: no query', async () => {
  const { queried } = await stoppedAt({ designId: 'stop-test-0003', prompt: 'a box' }, /Starting/);
  assert.equal(queried, false);
});
