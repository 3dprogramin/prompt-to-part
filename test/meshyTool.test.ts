// generate_3d against the Meshy mock: a paid model survives a failed import (a later call fetches it
// without a new task).
import './wasm';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ParamValues } from '../shared/types';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-meshy-tool-'));
process.env.PTP_DATA = dataDir;
const { cadTools } = await import('../server/cadTools');
const { geometry } = await import('../server/geometry');
const { createMeshyMock } = await import('../server/meshyMock');
const { MESHES_KEY } = await import('../shared/meshes');
let clock = Date.now();
const sleep = async (ms: number) => { clock += Math.min(ms, 50); };
const mock = createMeshyMock({ pendingMs: 200, runMs: 800, now: () => clock });
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
const realImport = geometry.importMesh;
after(() => { geometry.importMesh = realImport; mock.close(); geometry.stop(); rmSync(dataDir, { recursive: true, force: true }); });
const client = { key: 'msy_test', baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/openapi`, sleep };

type Handler = (a: unknown, extra: unknown) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
const handlers = (cad: unknown) => (cad as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance._registeredTools;

test('a model whose import failed is fetched again by the next generate_3d, without a new Meshy task', async () => {
  const base: ParamValues = {};
  const { server } = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), base, { meshy: { client, designId: 'meshy-tool-1', references: [] } });
  const make = () => handlers(server).generate_3d.handler({ name: 'fox', prompt: 'a red fox sitting' }, {});
  let importFails = 1;
  geometry.importMesh = (async (...args: Parameters<typeof realImport>) => {
    if (importFails-- > 0) throw new Error('Geometry worker exited (SIGKILL)');
    return realImport(...args);
  }) as typeof realImport;
  const created = mock.created.length;
  const failed = await make();
  assert.ok(failed.isError);
  assert.match(failed.content[0].text!, /kept.*same arguments.*no new credits/s);
  assert.equal(mock.created.length, created + 1);
  // The same request again: the kept task, not a new one (and no slot of the reply's allowance).
  const again = await make();
  assert.ok(!again.isError, JSON.stringify(again));
  assert.equal(mock.created.length, created + 1);
  assert.ok(JSON.parse(String(base[MESHES_KEY])).fox);
  // Once stored, the same request makes a new model (another variation), within the allowance.
  const third = await make();
  assert.ok(!third.isError, JSON.stringify(third));
  assert.equal(mock.created.length, created + 2);
});

test('Stop during the import stops the import: nothing is stored and the tool ends at once', async () => {
  const base: ParamValues = {};
  const stop = new AbortController();
  // Stop pressed as the import starts.
  const emit = (e: { type: string; text?: string }) => { if (e.type === 'live' && /importing/.test(e.text ?? '')) stop.abort(); };
  const { server } = cadTools(path.join(dataDir, 'model.js'), emit as never, new Set(), base, { meshy: { client, designId: 'meshy-tool-2', references: [], signal: stop.signal } });
  await assert.rejects(handlers(server).generate_3d.handler({ name: 'owl', prompt: 'an owl on a branch' }, {}), (e: Error) => e.name === 'AbortError');
  assert.equal(base[MESHES_KEY], undefined);
});

test('a kept model is fetched again once: when that fails too it is dropped, and the next call makes a new one', async (t) => {
  const base: ParamValues = {};
  const { server } = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), base, { meshy: { client, designId: 'meshy-tool-3', references: [] } });
  const make = () => handlers(server).generate_3d.handler({ name: 'bear', prompt: 'a bear holding a fish' }, {});
  // This model never imports (a file the import can't take).
  geometry.importMesh = (async () => { throw new Error('Not a mesh the import can read'); }) as typeof realImport;
  t.after(() => { geometry.importMesh = realImport; });
  const created = mock.created.length;
  const first = await make();
  assert.match(first.content[0].text!, /kept/);
  assert.equal(mock.created.length, created + 1);
  // The free try: the kept task, no new one; it fails again, so it is dropped and the agent is told.
  const again = await make();
  assert.ok(again.isError);
  assert.equal(mock.created.length, created + 1);
  assert.doesNotMatch(again.content[0].text!, /kept/);
  assert.match(again.content[0].text!, /failed again.*new model/s);
  // The next one is a new (paid) model, within the reply's allowance of 2; after that the allowance stops the loop.
  const third = await make();
  assert.match(third.content[0].text!, /kept/);
  assert.equal(mock.created.length, created + 2);
  const fourth = await make();
  assert.match(fourth.content[0].text!, /^Refused/);
  assert.equal(mock.created.length, created + 2);
});
