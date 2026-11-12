import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { linesUp, versionNote } from '../src/lib/pictureEdit';
import type { Box3, DesignVersion } from '../shared/types';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-picver-test-'));
process.env.PTP_DATA = dataDir;
process.env.PTP_AUTH = 'subscription';
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const { createApp } = await import('../server/app');
server.on('request', createApp({ port }));
after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const box = (d = 0): Box3 => ({ min: [0, 0, 0], max: [40 + d, 30, 5] });
const ok = { masked: true, outsideSame: true };

test('linesUp: identical boxes line up, 0.02 mm apart does not', () => {
  assert.equal(linesUp(ok, box(), box()), true);
  assert.equal(linesUp(ok, box(), box(0.005)), true);
  assert.equal(linesUp(ok, box(), box(0.02)), false);
});

test('linesUp: needs a mask, an unchanged outside and two boxes', () => {
  assert.equal(linesUp({ masked: false, outsideSame: true }, box(), box()), false);
  assert.equal(linesUp({ masked: true, outsideSame: false }, box(), box()), false);
  assert.equal(linesUp(ok, null, box()), false);
  assert.equal(linesUp(ok, box(), null), false);
});

const v = (extra: Partial<DesignVersion> = {}): DesignVersion => ({ code: 'x', summary: 's', createdAt: 1, source: 'ai', ...extra });
const edit = { picture: 'p', change: 'c', masked: true, parent: 2, linesUp: true, cost: null };

test('versionNote: versions without a picture edit keep today\'s words', () => {
  assert.equal(versionNote(v({ source: 'manual' })), 'your code edit');
  assert.equal(versionNote(v({ source: 'settings' })), 'your saved settings');
  assert.equal(versionNote(v({ source: 'ai' })), 'from the chat');
});

test('versionNote: a picture edit says whether it lines up, 1-based', () => {
  assert.equal(versionNote(v({ pictureEdit: edit })), 'your picture edit, lines up with v3');
  assert.equal(versionNote(v({ pictureEdit: { ...edit, linesUp: false } })), 'your picture edit');
  assert.equal(versionNote(v({ pictureEdit: { ...edit, masked: false } })), 'your picture edit');
});

test('versionNote: a missing, malformed or stale parent is not named', () => {
  const note = (pe: unknown, count?: number) => versionNote(v({ pictureEdit: pe as DesignVersion['pictureEdit'] }), count);
  assert.equal(note({}), 'your picture edit');
  assert.equal(note({ masked: true, linesUp: true }), 'your picture edit');
  assert.equal(note({ ...edit, parent: -1 }), 'your picture edit');
  assert.equal(note({ ...edit, parent: '2' }), 'your picture edit');
  assert.equal(note({ ...edit, parent: null }), 'your picture edit');
  assert.equal(note({ ...edit, parent: 1.5 }), 'your picture edit');
  assert.equal(note(edit, 3), 'your picture edit, lines up with v3');
  assert.equal(note(edit, 2), 'your picture edit');
});

test('linesUp: a box missing min or max is false, not a throw', () => {
  const bad = { min: [0, 0, 0] } as unknown as Box3;
  assert.equal(linesUp(ok, bad, box()), false);
  assert.equal(linesUp(ok, box(), bad), false);
  assert.equal(linesUp(ok, box(), {} as Box3), false);
});

test('a design with and without pictureEdit round-trips through save and load unchanged', async () => {
  const W = { 'Content-Type': 'application/json', 'X-PTP': '1' };
  const id = 'test-picver-0001';
  const d = { id, name: 't', createdAt: 1, updatedAt: 1000, messages: [], currentVersion: 1, code: 'x', values: {},
    versions: [v(), v({ pictureEdit: edit })] };
  const A = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${A}/api/designs/${id}`, { method: 'PUT', headers: W, body: JSON.stringify(d) })).status, 200);
  const got = await (await fetch(`${A}/api/designs/${id}`, { headers: W })).json();
  assert.deepEqual(got.versions, d.versions);
  assert.equal('pictureEdit' in got.versions[0], false);
});
