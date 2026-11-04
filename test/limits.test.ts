import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type ClientRequest, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The API with a password and room for one reply at a time (as in api.test.ts: a free port, its
// own data folder and a stand-in for Claude).
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-limits-test-'));
process.env.PTP_DATA = dataDir;
process.env.ANTHROPIC_API_KEY = 'sk-test';
// Quiet: Express logs the uploads this test cuts off unless NODE_ENV is test.
process.env.NODE_ENV = 'test';
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const { createApp } = await import('../server/app');
const { passwordMatches, isLoopback } = await import('../server/auth');
server.on('request', createApp({
  port,
  password: 's3cret',
  maxGenerations: 1,
  generate: (_req, send, abort) => new Promise((resolve) => {
    send({ type: 'live', text: 'working' });
    abort.signal.addEventListener('abort', () => resolve());
  }),
}));
after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const A = `http://127.0.0.1:${port}`;
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const AUTH = { Authorization: basic('anyone', 's3cret') };
const W = { ...AUTH, 'Content-Type': 'application/json', 'X-PTP': '1' };

test('the password: checked in constant time, any user name', () => {
  assert.equal(passwordMatches(basic('', 's3cret'), 's3cret'), true);
  assert.equal(passwordMatches(basic('me', 's3cret:with:colons'), 's3cret:with:colons'), true);
  assert.equal(passwordMatches(basic('s3cret', ''), 's3cret'), false);
  assert.equal(passwordMatches(Buffer.from('s3cret').toString('base64'), 's3cret'), false);
  assert.equal(passwordMatches('Basic czNjcmV0', 's3cret'), false); // no colon: not user:password
  assert.equal(passwordMatches(undefined, 's3cret'), false);
  assert.equal(passwordMatches('Bearer s3cret', 's3cret'), false);
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3']) assert.equal(isLoopback(h), true, h);
  for (const h of ['0.0.0.0', '192.168.1.20', '::', 'ptp.lan']) assert.equal(isLoopback(h), false, h);
});

test('with PTP_PASSWORD every page and API call needs it, but the healthcheck does not', async () => {
  for (const p of ['/api/designs', '/api/capabilities', '/api/backup', '/', '/assets/x.js']) {
    const r = await fetch(`${A}${p}`);
    assert.equal(r.status, 401, p);
    assert.match(r.headers.get('www-authenticate') ?? '', /^Basic realm="prompt-to-part"/);
  }
  assert.equal((await fetch(`${A}/api/designs`, { headers: { Authorization: basic('anyone', 'wrong') } })).status, 401);
  assert.equal((await fetch(`${A}/api/designs/test-lim-00000001`, { method: 'DELETE', headers: { 'X-PTP': '1' } })).status, 401);
  assert.equal((await fetch(`${A}/api/designs`, { headers: AUTH })).status, 200);
  assert.deepEqual(await (await fetch(`${A}/api/health`)).json(), { ok: true });
});

test('one reply too many is refused with a plain message', async () => {
  const start = (designId: string, signal?: AbortSignal) => fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId, prompt: 'a hook' }), signal });
  const first = await start('test-lim-00000001');
  assert.equal(first.status, 200);
  const second = await start('test-lim-00000002');
  assert.equal(second.status, 429);
  assert.match((await second.json()).error, /A reply is already under way, the most that can run at once/);
  // Once the first one stops, another can start.
  await fetch(`${A}/api/generate/test-lim-00000001/stop`, { method: 'POST', headers: W });
  await first.text();
  const third = await start('test-lim-00000002');
  assert.equal(third.status, 200);
  await fetch(`${A}/api/generate/test-lim-00000002/stop`, { method: 'POST', headers: W });
  await third.text();
});

test('a slice or .blend export: one running and one waiting, the next is told to try again', async () => {
  for (const [route, type, busy] of [['/api/slice', 'application/octet-stream', /Busy slicing/], ['/api/export/blend', 'application/json', /Busy with another \.blend/]] as const) {
    // Two uploads still under way (their bodies never finish) hold both places.
    const open: ClientRequest[] = [];
    for (let i = 0; i < 2; i++) {
      const r = request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { ...AUTH, 'X-PTP': '1', 'Content-Type': type, 'Content-Length': 100_000_000 } });
      r.on('error', () => {});
      r.write(Buffer.alloc(1000));
      open.push(r);
    }
    await new Promise((r) => setTimeout(r, 100));
    const third = await fetch(`${A}${route}`, { method: 'POST', headers: { ...AUTH, 'X-PTP': '1', 'Content-Type': type }, body: 'x' });
    assert.equal(third.status, 429, route);
    assert.match((await third.json()).error, busy);
    // When they go, there is room again (an empty body is then refused as such).
    for (const r of open) r.destroy();
    let status = 429;
    for (let i = 0; i < 50 && status === 429; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = (await fetch(`${A}${route}`, { method: 'POST', headers: { ...AUTH, 'X-PTP': '1', 'Content-Type': type }, body: type === 'application/json' ? '{}' : '' })).status;
    }
    assert.equal(status, 400, route);
  }
});
