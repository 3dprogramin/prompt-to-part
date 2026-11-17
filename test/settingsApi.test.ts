// The settings API: read masked, saved and reset, with the provider address only behind a password.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { SettingsView } from '../shared/api';
import { SETTINGS } from '../shared/settings';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-settings-api-'));
const shellData = process.env.PTP_DATA;
process.env.PTP_DATA = dataDir;
const { createApp } = await import('../server/app');
const { checkConnection } = await import('../server/connection');
const { resetSettings } = await import('../server/settings');

// The store remembers the environment's own value of a setting once per process, so the environment
// these tests rely on is fixed here, after config.ts has read any .env and before any save, whatever
// the shell sets (put back after).
const FIXED: Record<string, string | undefined> = { OPENROUTER_API_KEY: undefined, PTP_COUNTRY: undefined, PTP_CURRENCY: 'USD', ANTHROPIC_BASE_URL: undefined, PTP_EFFORT: undefined };
const shellEnv = Object.fromEntries(Object.keys(FIXED).map((k) => [k, process.env[k]]));
const setEnv = (values: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
setEnv(FIXED);

const listen = () => new Promise<Server>((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const portOf = (s: Server) => (s.address() as { port: number }).port;

// The connection check counts its runs, under the real one-minute cache of server/connection.ts.
let checks = 0;
const server = await listen();
server.on('request', createApp({
  port: portOf(server),
  password: '',
  connection: (fresh) => checkConnection(fresh, async () => { checks++; return { via: 'anthropic', ok: true, detail: 'stand-in' }; }),
}));
const serverPw = await listen();
serverPw.on('request', createApp({ port: portOf(serverPw), password: 'pw', connection: async () => ({ via: 'none', ok: false, detail: 'stand-in' }) }));

after(async () => {
  await resetSettings();
  server.close();
  serverPw.close();
  setEnv(shellEnv);
  if (shellData === undefined) delete process.env.PTP_DATA;
  else process.env.PTP_DATA = shellData;
  rmSync(dataDir, { recursive: true, force: true });
});
afterEach(() => resetSettings());

const base = `http://127.0.0.1:${portOf(server)}`;
const basePw = `http://127.0.0.1:${portOf(serverPw)}`;
const W = { 'Content-Type': 'application/json', 'X-PTP': '1' };
const AUTH = { Authorization: `Basic ${Buffer.from('user:pw').toString('base64')}` };
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

const get = async (p: string) => (await fetch(`${base}${p}`)).json() as Promise<SettingsView>;
const put = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'PUT', headers: W, body: JSON.stringify(body) });
const post = (p: string) => fetch(`${base}${p}`, { method: 'POST', headers: W });
const getPw = async (p: string) => (await fetch(`${basePw}${p}`, { headers: AUTH })).json() as Promise<SettingsView>;
const putPw = (p: string, body: unknown) => fetch(`${basePw}${p}`, { method: 'PUT', headers: { ...W, ...AUTH }, body: JSON.stringify(body) });
const rowOf = (v: SettingsView, env: string) => v.rows.find((r) => r.env === env)!;

test('GET /api/settings lists every row and no secret in full', async () => {
  const v = await get('/api/settings');
  assert.deepEqual(v.rows.map((r) => r.env), SETTINGS.map((d) => d.env));
  assert.equal(v.running, 0);
  assert.ok('via' in v);
});

test('PUT saves, the next GET shows it masked, and the body never comes back', async () => {
  const res = await put('/api/settings', { change: { OPENROUTER_API_KEY: KEY, PTP_COUNTRY: 'Romania' } });
  assert.equal(res.status, 200);
  const text = JSON.stringify(await res.json());
  assert.ok(!text.includes(KEY));
  const v = await get('/api/settings');
  assert.equal(rowOf(v, 'PTP_COUNTRY').value, 'Romania');
  assert.equal(rowOf(v, 'OPENROUTER_API_KEY').source, 'here');
  assert.ok(!JSON.stringify(v).includes(KEY));
});

test('without a password the provider address is locked: shown read-only, and a PUT of it answers 400', async () => {
  assert.equal(rowOf(await get('/api/settings'), 'ANTHROPIC_BASE_URL').editable, false);
  assert.equal((await put('/api/settings', { change: { ANTHROPIC_BASE_URL: 'https://x.example' } })).status, 400);
  assert.equal(rowOf(await get('/api/settings'), 'ANTHROPIC_BASE_URL').source, 'unset');
});

test('with a password the provider address can be saved', async () => {
  assert.equal(rowOf(await getPw('/api/settings'), 'ANTHROPIC_BASE_URL').editable, true);
  assert.equal((await putPw('/api/settings', { change: { ANTHROPIC_BASE_URL: 'https://x.example' } })).status, 200);
  assert.equal(rowOf(await getPw('/api/settings'), 'ANTHROPIC_BASE_URL').value, 'https://x.example');
  // And without the password the settings are not even read.
  assert.equal((await fetch(`${basePw}/api/settings`)).status, 401);
});

test('a write without X-PTP is refused, as every other write', async () => {
  assert.equal((await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"change":{}}' })).status, 403);
  assert.equal((await fetch(`${base}/api/settings/reset`, { method: 'POST' })).status, 403);
});

test('a save forgets the cached connection check', async () => {
  checks = 0;
  await fetch(`${base}/api/connection`);
  await fetch(`${base}/api/connection`); // within the minute: the cached one
  assert.equal(checks, 1);
  assert.equal((await put('/api/settings', { change: { PTP_COUNTRY: 'X' } })).status, 200);
  await fetch(`${base}/api/connection`);
  assert.equal(checks, 2);
  assert.equal((await post('/api/settings/reset')).status, 200);
  await fetch(`${base}/api/connection`);
  assert.equal(checks, 3);
});

test('a refused save keeps the cached connection check', async () => {
  checks = 0;
  await fetch(`${base}/api/connection?fresh=1`);
  assert.equal((await put('/api/settings', { change: { PTP_EFFORT: 'gigantic' } })).status, 400);
  await fetch(`${base}/api/connection`);
  assert.equal(checks, 1);
});

test('two saves at once both land', async () => {
  const [a, b] = await Promise.all([put('/api/settings', { change: { PTP_COUNTRY: 'A' } }), put('/api/settings', { change: { PTP_CURRENCY: 'EUR' } })]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const v = await get('/api/settings');
  assert.equal(rowOf(v, 'PTP_COUNTRY').value, 'A');
  assert.equal(rowOf(v, 'PTP_CURRENCY').value, 'EUR');
});

test('reset with nothing set answers 200 and changes nothing; reset after a save gives the environment back', async () => {
  const before = await get('/api/settings');
  const empty = await post('/api/settings/reset');
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json() as SettingsView).rows, before.rows);

  assert.equal((await put('/api/settings', { change: { PTP_COUNTRY: 'Romania', PTP_CURRENCY: 'USD' } })).status, 200);
  const saved = await get('/api/settings');
  assert.equal(rowOf(saved, 'PTP_COUNTRY').source, 'here');
  // The same value the environment has, but saved here: it says so.
  assert.equal(rowOf(saved, 'PTP_CURRENCY').source, 'here');
  const reset = await post('/api/settings/reset');
  assert.equal(reset.status, 200);
  const v = await reset.json() as SettingsView;
  assert.equal(rowOf(v, 'PTP_COUNTRY').source, 'unset');
  assert.equal(rowOf(v, 'PTP_CURRENCY').source, 'env');
  assert.equal(rowOf(v, 'PTP_CURRENCY').value, 'USD');
});

test('a bad value answers 400 with a message that does not repeat it', async () => {
  const r = await put('/api/settings', { change: { PTP_EFFORT: 'gigantic' } });
  assert.equal(r.status, 400);
  const text = await r.text();
  assert.ok(!text.includes('gigantic'));
  assert.equal(typeof JSON.parse(text).error, 'string');
  // A bad key is refused the same way, and nothing of it comes back.
  const k = await put('/api/settings', { change: { OPENROUTER_API_KEY: `${KEY} with spaces` } });
  assert.equal(k.status, 400);
  assert.ok(!(await k.text()).includes(KEY));
  // Nothing was saved by either.
  const v = await get('/api/settings');
  assert.equal(rowOf(v, 'PTP_EFFORT').source, 'unset');
  assert.equal(rowOf(v, 'OPENROUTER_API_KEY').source, 'unset');
});

test('a body with no changes or an oversized one is refused', async () => {
  assert.equal((await put('/api/settings', {})).status, 400);
  assert.equal((await put('/api/settings', { change: { PTP_COUNTRY: 'x'.repeat(9000) } })).status, 413);
});

test('a body that is not JSON is refused, and nothing of it is logged or sent back', async () => {
  const logged: unknown[] = [];
  const { error, warn, log } = console;
  console.error = console.warn = console.log = (...a: unknown[]) => void logged.push(...a);
  try {
    // A key pasted without its quotes: JSON.parse's message quotes the text around the mistake.
    const r = await fetch(`${base}/api/settings`, { method: 'PUT', headers: W, body: `{"change":{"OPENROUTER_API_KEY":${KEY}}}` });
    assert.equal(r.status, 400);
    const text = await r.text();
    assert.ok(!text.includes(KEY.slice(0, 8)));
    assert.equal(typeof JSON.parse(text).error, 'string');
  } finally {
    Object.assign(console, { error, warn, log });
  }
  assert.ok(!logged.map((x) => String((x as Error)?.stack ?? x)).join('\n').includes(KEY.slice(0, 8)));
});
