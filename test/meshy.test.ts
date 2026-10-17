import './wasm';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createMeshyMock } from '../server/meshyMock';
import { createImageTo3d, createTextTo3d, generateMeshyModel, getTask, MeshyError, waitForTask, type MeshyClient, type MeshyTask } from '../server/meshy';
import { importMeshFile } from '../shared/runtime';

// The mock with quick tasks: 0.4 s waiting, 1.5 s running (the client's waits are cut short).
async function startMock(balance?: number, pendingMs = 400) {
  const mock = createMeshyMock({ pendingMs, runMs: 1500, balance });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  after(() => mock.close());
  return `http://127.0.0.1:${(mock.address() as AddressInfo).port}/openapi`;
}
const base = await startMock();
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 40)));
const client: MeshyClient = { key: 'msy_test', baseUrl: base, sleep: fastSleep };
const balance = async (url = base) => (await (await fetch(`${url}/v1/balance`, { headers: { Authorization: 'Bearer msy_x' } })).json()).balance as number;
const statuses = (seen: MeshyTask[]) => seen.map((t) => t.status).filter((s, i, a) => s !== a[i - 1]);

test('a model from a description: PENDING → IN_PROGRESS with rising progress → SUCCEEDED, then the files', async () => {
  const seen: MeshyTask[] = [];
  const r = await generateMeshyModel(client, { prompt: 'a red fox sitting' }, { onProgress: (t) => seen.push(t) });
  assert.deepEqual(statuses(seen), ['PENDING', 'IN_PROGRESS', 'SUCCEEDED']);
  const progress = seen.filter((t) => t.status === 'IN_PROGRESS').map((t) => t.progress);
  assert.ok(progress.length >= 1 && progress.every((p, i) => p < 100 && (i === 0 || p >= progress[i - 1])), `${progress}`);
  assert.equal(seen.at(-1)!.progress, 100);
  assert.match(r.prompt, /^a red fox sitting, on a stable circular base, solid, printable/);
  assert.equal(r.task.consumed_credits, 25); // the mesh, 2k geometry
  assert.match(r.model.filename, /\.glb$/);
  assert.equal(r.picture?.ext, 'png');
  // The fox sample, unit-less and Y-up like Meshy's models, imports as a solid.
  const imported = importMeshFile(r.model.bytes, r.model.filename);
  assert.equal(Math.round(Math.max(...imported.report.size)), 80);
});

test('a model from a photo (image to 3D)', async () => {
  const photo = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`;
  const r = await generateMeshyModel(client, { image: photo });
  assert.equal(r.task.type, 'image-to-3d');
  assert.equal(r.prompt, 'From the attached photo');
  await assert.rejects(createImageTo3d(client, 'data:image/gif;base64,R0lGOD'), (e) => e instanceof MeshyError && e.status === 400);
});

test('errors: a bad key, a bad request, a failed task, credits', async () => {
  await assert.rejects(createTextTo3d({ ...client, key: 'sk-wrong' }, 'a cat'), (e) => e instanceof MeshyError && e.status === 401 && /refused the API key/.test(e.message));
  const long = await fetch(`${base}/v2/text-to-3d`, { method: 'POST', headers: { Authorization: 'Bearer msy_x', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'preview', prompt: 'x'.repeat(801) }) });
  assert.equal(long.status, 400);
  assert.match((await long.json()).message, /800/);
  const before = await balance();
  await assert.rejects(generateMeshyModel(client, { prompt: 'a dragon FAIL' }), (e) => e instanceof MeshyError && e.code === 'image_too_complex' && /couldn't make the model: The uploaded image is too complex/.test(e.message));
  assert.equal(await balance(), before - 25); // charged when created (the real API refunds failures later)
  const poor = { ...client, baseUrl: await startMock(40) };
  await createTextTo3d(poor, 'one');
  await assert.rejects(createTextTo3d(poor, 'two'), (e) => e instanceof MeshyError && e.status === 402 && /Not enough Meshy credits/.test(e.message));
});

test('a full queue is a 429 without Retry-After, and no task is created', async () => {
  const busy = { ...client, baseUrl: await startMock() };
  for (let i = 0; i < 10; i++) await createTextTo3d(busy, `cat ${i}`);
  const r = await fetch(`${busy.baseUrl}/v2/text-to-3d`, { method: 'POST', headers: { Authorization: 'Bearer msy_x', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'preview', prompt: 'one more' }) });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), null);
  assert.match((await r.json()).message, /^NoMorePendingTasks/);
  await assert.rejects(createTextTo3d(busy, 'one more'), (e) => e instanceof MeshyError && e.status === 429 && /Meshy is busy/.test(e.message));
  const list = await (await fetch(`${busy.baseUrl}/v2/text-to-3d?page_size=100`, { headers: { Authorization: 'Bearer msy_x' } })).json();
  assert.equal(list.length, 10);
});

test('polling rides out a server error, follows a reschedule, and gives up after the time limit', async () => {
  // Long waits, so the polls see each of them.
  const slowQueue = { ...client, baseUrl: await startMock(undefined, 1200) };
  const flaky = await createTextTo3d(slowQueue, 'a cat FLAKY RESCHEDULE');
  const seen: MeshyTask[] = [];
  const done = await waitForTask(slowQueue, 'text-to-3d', flaky, { onProgress: (t) => seen.push(t) });
  assert.equal(done.status, 'SUCCEEDED');
  // Back to PENDING once, half way through, as Meshy may do.
  assert.deepEqual(statuses(seen), ['PENDING', 'IN_PROGRESS', 'PENDING', 'IN_PROGRESS', 'SUCCEEDED']);
  const slow = await createTextTo3d(client, 'a slow cat');
  await assert.rejects(waitForTask(client, 'text-to-3d', slow, { timeoutMs: 50 }), (e) => e instanceof MeshyError && e.code === 'timeout');
  await assert.rejects(getTask(client, 'text-to-3d', 'no-such-task'), (e) => e instanceof MeshyError && e.status === 404);
});

test('stopping while a task waits deletes it (refunded)', async () => {
  const before = await balance();
  const abort = new AbortController();
  const p = generateMeshyModel({ ...client, sleep: (ms, signal) => new Promise((resolve, reject) => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }); }) }, { prompt: 'a dog' }, { signal: abort.signal, onStarted: () => setTimeout(() => abort.abort(), 20) });
  await assert.rejects(p);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await balance(), before);
});

