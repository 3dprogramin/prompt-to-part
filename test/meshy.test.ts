import './wasm';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createMeshyMock } from '../server/meshyMock';
import { createImageTo3d, createTextTo3d, download, generateMeshyModel, getTask, MAX_DOWNLOAD, MeshyError, waitForTask, type MeshyClient, type MeshyTask } from '../server/meshy';
import { importMeshFile } from '../shared/runtime';
import { decodeTexture } from '../shared/imageDecode';
import { MESHY_CREDITS_PER_COLOR_MODEL, MESHY_CREDITS_PER_MODEL } from '../shared/meshes';

// The mocks' clock moves only when the client waits between polls (40 ms a wait, at once), so the
// polls see every status however busy the machine is; a test that doesn't poll holds it still.
let clock = Date.now();
const now = () => clock;
const fastSleep = async (ms: number) => { clock += Math.min(ms, 40); };
// The mock with quick tasks: 0.4 s waiting, 1.5 s running.
async function startMock(balance?: number) {
  const mock = createMeshyMock({ pendingMs: 400, runMs: 1500, balance, now });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  after(() => mock.close());
  return `http://127.0.0.1:${(mock.address() as AddressInfo).port}/openapi`;
}
const base = await startMock();
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
  const flaky = await createTextTo3d(client, 'a cat FLAKY RESCHEDULE');
  const seen: MeshyTask[] = [];
  const done = await waitForTask(client, 'text-to-3d', flaky, { onProgress: (t) => seen.push(t) });
  assert.equal(done.status, 'SUCCEEDED');
  // Back to PENDING once, half way through, as Meshy may do.
  assert.deepEqual(statuses(seen), ['PENDING', 'IN_PROGRESS', 'PENDING', 'IN_PROGRESS', 'SUCCEEDED']);
  const slow = await createTextTo3d(client, 'a slow cat');
  // Real waits that leave the clock still: the task stays PENDING, only the time limit ends it.
  const stuck = { ...client, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 10))) };
  await assert.rejects(waitForTask(stuck, 'text-to-3d', slow, { timeoutMs: 50 }), (e) => e instanceof MeshyError && e.code === 'timeout');
  await assert.rejects(getTask(client, 'text-to-3d', 'no-such-task'), (e) => e instanceof MeshyError && e.status === 404);
});

test('stopping while a task waits deletes it (refunded)', async () => {
  const before = await balance();
  const abort = new AbortController();
  const p = generateMeshyModel({ ...client, sleep: (ms, signal) => new Promise((resolve, reject) => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }); }) }, { prompt: 'a dog' }, { signal: abort.signal, onStarted: () => setTimeout(() => abort.abort(), 20) });
  await assert.rejects(p);
  // The delete is fire and forget: the refund comes soon after.
  for (const end = Date.now() + 5000; (await balance()) !== before && Date.now() < end;) await new Promise((r) => setTimeout(r, 10));
  assert.equal(await balance(), before);
});

test('in colour: image to 3D textured, text to 3D refined after its preview, 35 credits either way', async () => {
  const mock = createMeshyMock({ pendingMs: 200, runMs: 600, now });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  after(() => mock.close());
  const c: MeshyClient = { ...client, baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/openapi` };
  const photo = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`;
  const started: string[] = [];
  const img = await generateMeshyModel(c, { image: photo }, { color: true, onStarted: (id) => started.push(id) });
  assert.equal(mock.created.at(-1)?.type, 'image-to-3d');
  const sent = mock.created.at(-1)!.body;
  assert.equal(sent.should_texture, true);
  assert.equal(sent.texture_resolution, '2k');
  assert.equal(sent.remove_lighting, true);
  assert.equal(sent.enable_pbr, false);
  assert.equal(sent.geometry_resolution, '2k');
  assert.equal(img.credits, MESHY_CREDITS_PER_COLOR_MODEL);
  assert.equal(started.length, 1);
  assert.equal(sent.texture_image_url, undefined);
  // Painted from a picture of its own (a concept's coloured version): texture_image_url, still 35.
  const painted = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a7061696e746564', 'hex').toString('base64')}`;
  const tex = await generateMeshyModel(c, { image: photo, texture: painted }, { color: true });
  assert.equal(mock.created.at(-1)!.body.image_url, photo);
  assert.equal(mock.created.at(-1)!.body.texture_image_url, painted);
  assert.equal(tex.credits, MESHY_CREDITS_PER_COLOR_MODEL);
  await assert.rejects(createImageTo3d(c, photo, undefined, true, 'data:image/gif;base64,R0lGOD'), (e) => e instanceof MeshyError && e.status === 400);

  const stages = new Set<string>();
  const text = await generateMeshyModel(c, { prompt: 'a knight' }, { color: true, onStarted: (id) => started.push(id), onProgress: (_, s) => stages.add(s) });
  assert.deepEqual(mock.created.slice(-2).map((t) => t.type), ['text-to-3d-preview', 'text-to-3d-refine']);
  const refine = mock.created.at(-1)!.body;
  assert.equal(refine.mode, 'refine');
  assert.equal(refine.preview_task_id, started[1]);
  assert.equal(refine.enable_pbr, false);
  assert.equal(text.task.type, 'text-to-3d-refine');
  assert.equal(text.credits, MESHY_CREDITS_PER_COLOR_MODEL);
  assert.deepEqual([...stages], ['model', 'texture']);
  // The textured model comes with its colours.
  const imported = importMeshFile(text.model.bytes, text.model.filename, { colors: true }, decodeTexture);
  assert.ok(imported.report.colored);
  // Without colour: untextured, 25.
  const grey = await generateMeshyModel(c, { image: photo, texture: painted });
  assert.equal(mock.created.at(-1)!.body.should_texture, false);
  assert.equal(mock.created.at(-1)!.body.texture_image_url, undefined);
  assert.equal(grey.credits, MESHY_CREDITS_PER_MODEL);
});

test('a download is read as it comes and refused once it is larger than the limit', async () => {
  const MB = new Uint8Array(1024 * 1024);
  let pulled = 0;
  // No length given, and more than the limit: the reading stops at it.
  const endless = () => new ReadableStream<Uint8Array>({ pull(ctl) { pulled++; ctl.enqueue(MB); } });
  const client = (body: () => BodyInit, headers: Record<string, string> = {}): MeshyClient => ({ key: 'x', baseUrl: 'http://meshy.test', fetch: async () => new Response(body(), { headers }) });
  await assert.rejects(download(client(endless), 'https://assets.meshy.test/model.glb'), (e) => e instanceof MeshyError && /too big/.test(e.message));
  assert.ok(pulled <= MAX_DOWNLOAD / MB.length + 3, `read ${pulled} MB`);
  // Said up front: refused before reading.
  pulled = 0;
  await assert.rejects(download(client(endless, { 'content-length': String(MAX_DOWNLOAD + 1) }), 'https://assets.meshy.test/model.glb'), /too big/);
  assert.ok(pulled <= 2, `read ${pulled} MB`);
  // A small one comes whole.
  const r = await download(client(() => new Uint8Array([1, 2, 3]), { 'content-type': 'model/gltf-binary' }), 'https://assets.meshy.test/model.glb');
  assert.deepEqual([...r.bytes], [1, 2, 3]);
  assert.equal(r.type, 'model/gltf-binary');
});

