import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The API on a free port with its own data folder, and a stand-in for Claude.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jig-api-test-'));
process.env.JIG_DATA = dataDir;
// Listening first and attaching the app after: the app needs the port for its Host check.
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
let releaseGeneration = () => {};
const { createApp } = await import('../server/app');
server.on('request', createApp({
  port,
  suggest: async (r) => ({ price: Math.round(r.grams), low: 1, high: 99, reasoning: `for ${r.name}`, currency: 'RON' }),
  generate: (_req, send, abort) => new Promise((resolve) => {
    send({ type: 'live', text: 'working' });
    releaseGeneration = () => resolve();
    abort.signal.addEventListener('abort', () => resolve());
  }),
}));
after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const A = `http://127.0.0.1:${port}`;
const W = { 'Content-Type': 'application/json', 'X-Jig': '1' };
const design = (extra = {}) => ({ id: 'test-api-00000001', name: 't', createdAt: 1, updatedAt: 1000, messages: [], versions: [], currentVersion: -1, code: 'x', values: {}, ...extra });
/** Status of a GET with a Host header of our choosing (fetch() always sends the real one). */
const statusWithHost = (urlPath: string, host: string) => new Promise<number>((resolve, reject) => {
  request({ host: '127.0.0.1', port, path: urlPath, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject).end();
});
const put = (d: { id?: string; [k: string]: unknown }) => fetch(`${A}/api/designs/${d.id ?? 'test-api-00000001'}`, { method: 'PUT', headers: W, body: JSON.stringify(d) });
const del = (id: string) => fetch(`${A}/api/designs/${id}`, { method: 'DELETE', headers: W });
const postImage = (id: string, data: string) => fetch(`${A}/api/designs/${id}/images`, { method: 'POST', headers: W, body: JSON.stringify({ mediaType: 'image/png', data }) });
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

test('only Jig\'s own pages get in', async () => {
  assert.equal(await statusWithHost('/api/designs', `evil.com:${port}`), 421);
  assert.equal((await fetch(`${A}/api/designs`, { headers: { Origin: 'https://evil.com' } })).status, 403);
  assert.equal((await fetch(`${A}/api/designs`, { headers: { Origin: 'http://localhost:3000' } })).status, 403);
  const saved = await put(design({ id: 'test-api-00000009' }));
  assert.equal(saved.status, 200);
  assert.equal((await fetch(`${A}/api/designs/test-api-00000009`, { method: 'DELETE' })).status, 403);
  assert.equal((await del('test-api-00000009')).status, 200);
  assert.equal((await fetch(`${A}/api/bambu/template`)).status, 404); // a POST only
});

test('ids and bodies are checked', async () => {
  for (const id of ['short', '..%2Fx', 'a'.repeat(65)]) assert.equal((await fetch(`${A}/api/designs/${id}`)).status, 400, id);
  const mismatch = await fetch(`${A}/api/designs/test-api-00000001`, { method: 'PUT', headers: W, body: JSON.stringify(design({ id: 'test-api-00000002' })) });
  assert.equal(mismatch.status, 400);
  assert.equal((await put({ id: 'test-api-00000001', updatedAt: 5 })).status, 400);
  assert.equal((await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: 'test-api-00000001', prompt: 'x', model: 'gpt' }) })).status, 400);
});

test('saves build on the last revision; a stale copy is refused', async () => {
  const first = await put(design());
  assert.equal(first.status, 200);
  assert.equal((await first.json()).rev, 1);
  assert.equal((await (await fetch(`${A}/api/designs/test-api-00000001`)).json()).rev, 1);
  // A copy that missed revision 1 (another tab saved it), even with a newer timestamp.
  const stale = await put(design({ rev: 0, updatedAt: 9999 }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).rev, 1);
  assert.equal((await put(design({ rev: 1, name: 'second' }))).status, 200);
  // Of overlapping saves based on the same revision, exactly one wins; the file stays whole.
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => put(design({ rev: 2, code: 'x'.repeat(i % 2 ? 200_000 : 5) }))));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, ...Array(19).fill(409)]);
  assert.equal(JSON.parse(await (await fetch(`${A}/api/designs/test-api-00000001`)).text()).rev, 3);
});

test('a deleted design is not brought back by a late save or upload', async () => {
  assert.equal((await del('test-api-00000001')).status, 200);
  assert.equal((await fetch(`${A}/api/designs/test-api-00000001`)).status, 404);
  assert.equal((await put(design({ rev: 3 }))).status, 410);
  assert.equal((await put(design())).status, 410);
  assert.equal((await postImage('test-api-00000001', PNG)).status, 410);
  assert.equal((await fetch(`${A}/api/designs/test-api-00000001`)).status, 404);
});

test('images are stored by content', async () => {
  const r = await postImage('test-api-00000004', PNG);
  assert.equal(r.status, 200);
  const { url } = await r.json();
  assert.match(url, /^\/api\/designs\/test-api-00000004\/images\/[0-9a-f]{32}\.png$/);
  const got = await fetch(A + url);
  assert.equal(got.status, 200);
  assert.match(got.headers.get('cache-control') ?? '', /immutable/);
  // A missing image may still be uploaded: its 404 must not be cached.
  const missing = await fetch(A + url.replace(/[0-9a-f]{32}/, '0'.repeat(32)));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${A}/api/designs/test-api-00000004/images`, { method: 'POST', headers: W, body: JSON.stringify({ mediaType: 'text/html', data: PNG }) })).status, 400);
});

test('one generation per design; a running design can\'t be deleted', async () => {
  const body = JSON.stringify({ designId: 'test-api-00000003', prompt: 'a cube' });
  const first = await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body });
  assert.equal(first.status, 200);
  assert.equal((await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body })).status, 409);
  assert.equal((await fetch(`${A}/api/designs/test-api-00000003`, { method: 'DELETE', headers: W })).status, 409);
  releaseGeneration();
  await first.text();
  assert.equal((await fetch(`${A}/api/designs/test-api-00000003`, { method: 'DELETE', headers: W })).status, 200);
});

test('dictation tokens need the ElevenLabs key, and only Jig may ask', { skip: !!process.env.ELEVENLABS_API_KEY && 'ELEVENLABS_API_KEY is set' }, async () => {
  assert.equal((await (await fetch(`${A}/api/capabilities`)).json()).speech, false);
  const r = await fetch(`${A}/api/speech/token`, { method: 'POST', headers: W });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /ELEVENLABS_API_KEY/);
  assert.equal((await fetch(`${A}/api/speech/token`, { method: 'POST' })).status, 403);
});

test('cost settings are stored, slicing needs a project, price suggestions go through', async () => {
  const put = await fetch(`${A}/api/cost/settings`, { method: 'PUT', headers: W, body: JSON.stringify({ filamentPerKg: 110, averageWatts: -5 }) });
  assert.deepEqual(await put.json(), { filamentPerKg: 110 });
  assert.deepEqual(await (await fetch(`${A}/api/cost/settings`)).json(), { filamentPerKg: 110 });
  assert.equal((await fetch(`${A}/api/slice`, { method: 'POST', headers: { ...W, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(0) })).status, 400);
  const price = await fetch(`${A}/api/price`, { method: 'POST', headers: W, body: JSON.stringify({ name: 'Hook', size: '10 × 10 × 10 mm', parts: 1, colours: 1, grams: 42, seconds: 600, filamentCost: 4.6, electricityCost: null }) });
  assert.deepEqual(await price.json(), { price: 42, low: 1, high: 99, reasoning: 'for Hook', currency: 'RON' });
  assert.equal((await fetch(`${A}/api/price`, { method: 'POST', headers: W, body: '{}' })).status, 400);
});

