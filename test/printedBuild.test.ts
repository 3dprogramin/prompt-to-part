import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The printed route stamps a mark with the server's own build; a repeat mark keeps the first one.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-printedbuild-test-'));
process.env.PTP_DATA = dataDir;
process.env.PTP_AUTH = 'subscription';
process.env.PTP_CLAUDE = ''; // the mode set here, whatever PTP_CLAUDE the shell or .env names
process.env.PTP_COMMIT = 'abc1234';
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const { createApp } = await import('../server/app');
const { APP_BUILD } = await import('../server/config');
const { PRINTED_JSON, readPrinted, versionFingerprint } = await import('../server/printed');
const { writeFile } = await import('node:fs/promises');
server.on('request', createApp({ port }));
after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const A = `http://127.0.0.1:${port}`;
const W = { 'Content-Type': 'application/json', 'X-PTP': '1' };
const code = 'function build() { return Manifold.cube([10, 10, 10]); }';
const values = { w: 1 };
const put = async (id: string) => {
  const r = await fetch(`${A}/api/designs/${id}`, { method: 'PUT', headers: W, body: JSON.stringify({ id, name: 'P', createdAt: 1, updatedAt: 1, code, values, messages: [], currentVersion: 0,
    versions: [{ code, summary: 'A cube', createdAt: 1, source: 'manual', values }] }) });
  assert.equal(r.status, 200, await r.text());
};
const mark = async (id: string) => (await fetch(`${A}/api/designs/${id}/printed/0`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PTP': '1' }, body: new Uint8Array(0) })).json() as Promise<{ at: number; app?: unknown }>;

test('a new printed mark carries the server build', async () => {
  const id = 'test-pb-00000001';
  await put(id);
  const m = await mark(id);
  assert.deepEqual(m.app, APP_BUILD);
  assert.equal(APP_BUILD.commit, 'abc1234');
  assert.deepEqual((await readPrinted())[id][0].app, APP_BUILD);
});

test('marking the same unchanged version again keeps its first date and build', async () => {
  const id = 'test-pb-00000002';
  await put(id);
  await writeFile(PRINTED_JSON, JSON.stringify({ printed: { [id]: [{ v: 0, at: 5, fp: versionFingerprint({ code, values }), file: false, settings: false, app: { version: '0.1.0' } }] } }));
  const m = await mark(id);
  assert.equal(m.at, 5);
  assert.deepEqual(m.app, { version: '0.1.0' });
});

test('an old mark with no app keeps none', async () => {
  const id = 'test-pb-00000003';
  await put(id);
  await writeFile(PRINTED_JSON, JSON.stringify({ printed: { [id]: [{ v: 0, at: 7, fp: versionFingerprint({ code, values }), file: false, settings: false }] } }));
  const m = await mark(id);
  assert.equal(m.at, 7);
  assert.equal('app' in m, false);
});
