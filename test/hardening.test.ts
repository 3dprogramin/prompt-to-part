import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The API on a free port with its own data folder and a stand-in for the AI ideas call.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-hardening-test-'));
process.env.PTP_DATA = dataDir;
process.env.ANTHROPIC_API_KEY = 'sk-test';
process.env.NODE_ENV = 'test';
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const { createApp } = await import('../server/app');
const { AI_CALLS_AT_ONCE } = await import('../server/routes/store');
const { decodeImage } = await import('../server/artwork');

// Each ideas call waits here until the test releases it.
const held: Array<() => void> = [];
server.on('request', createApp({
  port,
  ideas: () => new Promise((resolve) => { held.push(() => resolve('')); }),
}));
after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const A = `http://127.0.0.1:${port}`;
const W = { 'Content-Type': 'application/json', 'X-PTP': '1' };

test('every response refuses to be framed and sniffed', async () => {
  for (const p of ['/api/health', '/api/capabilities', '/api/designs']) {
    const r = await fetch(`${A}${p}`);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
    assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'", p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
  }
});

test('AI side routes share one limit', async () => {
  const ask = () => fetch(`${A}/api/ideas`, { method: 'POST', headers: W, body: JSON.stringify({ modes: ['off'] }) });
  const first = Array.from({ length: AI_CALLS_AT_ONCE }, ask);
  while (held.length < AI_CALLS_AT_ONCE) await new Promise((r) => setTimeout(r, 10));
  const over = await ask();
  assert.equal(over.status, 429);
  assert.equal(over.headers.get('retry-after'), '10');
  // Another AI route is refused too: the limit is shared.
  const price = await fetch(`${A}/api/price`, { method: 'POST', headers: W, body: '{}' });
  assert.equal(price.status, 429);
  for (const release of held.splice(0)) release();
  await Promise.all(first.map((r) => r.then((x) => x.text())));
  const next = ask();
  while (held.length < 1) await new Promise((r) => setTimeout(r, 10));
  for (const release of held.splice(0)) release();
  assert.notEqual((await next).status, 429);
});

test('a PNG declaring more than MAX_PIXELS is refused before it is decoded', () => {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(20000, 16);
  png.writeUInt32BE(20000, 20);
  const t = Date.now();
  assert.throws(() => decodeImage(png), /too large/);
  assert.ok(Date.now() - t < 100);
});

test('blend export refuses parts that are not strings', async () => {
  const post = (body: unknown) => fetch(`${A}/api/export/blend`, { method: 'POST', headers: W, body: JSON.stringify(body) });
  const t = Date.now();
  const r = await post({ parts: [{ positions: { length: 4000000000 }, indices: '' }] });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'invalid parts' });
  assert.ok(Date.now() - t < 1000);
  assert.equal((await post({ parts: [{ positions: '', indices: '', name: 5 }] })).status, 400);
  assert.equal((await post({ parts: Array.from({ length: 501 }, () => ({ positions: '', indices: '' })) })).status, 400);
});
