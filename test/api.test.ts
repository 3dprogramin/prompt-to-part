import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The API on a free port with its own data folder, and a stand-in for Claude.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jig-api-test-'));
process.env.JIG_DATA = dataDir;
const port = await new Promise<number>((resolve) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
let releaseGeneration = () => {};
const { createApp } = await import('../server/app');
const server: Server = createApp({
  port,
  generate: (_req, send, abort) => new Promise((resolve) => {
    send({ type: 'live', text: 'working' });
    releaseGeneration = () => resolve();
    abort.signal.addEventListener('abort', () => resolve());
  }),
}).listen(port, '127.0.0.1');
after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const A = `http://127.0.0.1:${port}`;
const W = { 'Content-Type': 'application/json', 'X-Jig': '1' };
const design = (extra = {}) => ({ id: 'test-api-00000001', name: 't', createdAt: 1, updatedAt: 1000, messages: [], versions: [], currentVersion: -1, code: 'x', values: {}, ...extra });
/** Status of a GET with a Host header of our choosing (fetch() always sends the real one). */
const statusWithHost = (urlPath: string, host: string) => new Promise<number>((resolve, reject) => {
  request({ host: '127.0.0.1', port, path: urlPath, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject).end();
});
const put = (d: object) => fetch(`${A}/api/designs/test-api-00000001`, { method: 'PUT', headers: W, body: JSON.stringify(d) });

test('only Jig\'s own pages get in', async () => {
  assert.equal(await statusWithHost('/api/designs', `evil.com:${port}`), 421);
  assert.equal((await fetch(`${A}/api/designs`, { headers: { Origin: 'https://evil.com' } })).status, 403);
  assert.equal((await fetch(`${A}/api/designs`, { headers: { Origin: 'http://localhost:3000' } })).status, 403);
  assert.equal((await put({ ...design() }).then(() => fetch(`${A}/api/designs/test-api-00000001`, { method: 'DELETE' }))).status, 403);
  assert.equal((await fetch(`${A}/api/bambu/template`)).status, 404); // a POST only
});

test('ids and bodies are checked', async () => {
  for (const id of ['short', '..%2Fx', 'a'.repeat(65)]) assert.equal((await fetch(`${A}/api/designs/${id}`)).status, 400, id);
  assert.equal((await put({ ...design(), id: 'test-api-00000002' })).status, 400);
  assert.equal((await put({ id: 'test-api-00000001', updatedAt: 5 })).status, 400);
  assert.equal((await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: 'test-api-00000001', prompt: 'x', model: 'gpt' }) })).status, 400);
});

test('save, load, stale save, delete', async () => {
  assert.equal((await put(design({ updatedAt: 2000 }))).status, 200);
  assert.equal((await (await fetch(`${A}/api/designs/test-api-00000001`)).json()).updatedAt, 2000);
  assert.equal((await put(design({ updatedAt: 1500 }))).status, 409);
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => put(design({ updatedAt: 3000, code: 'x'.repeat(i % 2 ? 200_000 : 5) }))));
  assert.deepEqual([...new Set(rs.map((r) => r.status))], [200]);
  JSON.parse(await (await fetch(`${A}/api/designs/test-api-00000001`)).text());
  assert.equal((await fetch(`${A}/api/designs/test-api-00000001`, { method: 'DELETE', headers: W })).status, 200);
  assert.equal((await fetch(`${A}/api/designs/test-api-00000001`)).status, 404);
});

test('images are stored by content', async () => {
  const data = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const r = await fetch(`${A}/api/designs/test-api-00000001/images`, { method: 'POST', headers: W, body: JSON.stringify({ mediaType: 'image/png', data }) });
  const { url } = await r.json();
  assert.match(url, /^\/api\/designs\/test-api-00000001\/images\/[0-9a-f]{32}\.png$/);
  assert.equal((await fetch(A + url)).status, 200);
  assert.equal((await fetch(`${A}/api/designs/test-api-00000001/images`, { method: 'POST', headers: W, body: JSON.stringify({ mediaType: 'text/html', data }) })).status, 400);
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
