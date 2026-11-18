import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-thumbs-'));
process.env.PTP_DATA = dataDir;
process.env.PTP_AUTH = 'subscription';
process.env.PTP_CLAUDE = '';
const { thumbKey, thumbStore } = await import('../server/thumbs');
const { createApp } = await import('../server/app');
const { geometry } = await import('../server/geometry');

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ptp-thumbstore-'));
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A store over a temp folder with designs held in memory and a render that counts its calls. */
function setup(opts: { busy?: () => boolean; render?: (code: string, values: unknown) => Promise<{ png?: string; size?: [number, number, number] }> } = {}) {
  const dir = tmp();
  const designs = new Map<string, { code: string; values: unknown }>();
  const state = { calls: 0, running: 0, maxRunning: 0 };
  const store = thumbStore({
    dir,
    busy: opts.busy ?? (() => false),
    readDesign: async (id) => designs.get(id) ?? null,
    render: async (code, values) => {
      state.calls++;
      state.running++;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      try {
        if (opts.render) return await opts.render(code, values);
        await wait(20);
        return { png: PNG, size: [40, 30, 20] };
      } finally { state.running--; }
    },
  });
  const add = (id: string, code: string, values: unknown = {}) => { designs.set(id, { code, values }); return thumbKey(code, values)!; };
  return { dir, designs, state, store, add };
}

test('thumbKey: null for no code, changes with code, values and nothing else', () => {
  assert.equal(thumbKey('', {}), null);
  const k = thumbKey('return box()', { w: 1 })!;
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(thumbKey('return box()', { w: 1 }), k);
  assert.notEqual(thumbKey('return box()', { w: 2 }), k);
  assert.notEqual(thumbKey('return box() ', { w: 1 }), k);
});

test('a picture is drawn once, then served from disk', async () => {
  const { dir, state, store, add } = setup();
  const key = add('design-0001', 'return box()');
  const a = await store.get('design-0001', key);
  const b = await store.get('design-0001', key);
  assert.equal(state.calls, 1);
  assert.deepEqual(a?.size, [40, 30, 20]);
  assert.deepEqual(b?.size, [40, 30, 20]);
  assert.equal(a?.file, path.join(dir, `design-0001-${key}.png`));
  assert.ok(existsSync(a!.file));
  assert.deepEqual(readdirSync(dir).sort(), [`design-0001-${key}.json`, `design-0001-${key}.png`]);
});

test('ten asked at once are drawn one at a time, and the same one only once', async () => {
  const { state, store, add } = setup();
  const asks: Promise<unknown>[] = [];
  for (let i = 0; i < 5; i++) {
    const id = `design-000${i}`;
    const key = add(id, `return box(${i})`);
    asks.push(store.get(id, key), store.get(id, key));
  }
  const results = await Promise.all(asks);
  assert.ok(results.every((r) => r !== null));
  assert.equal(state.maxRunning, 1);
  assert.equal(state.calls, 5);
});

test('nothing is drawn while a generation runs', async () => {
  let busy = true;
  const { state, store, add } = setup({ busy: () => busy });
  const key = add('design-0001', 'return box()');
  let done = false;
  const p = store.get('design-0001', key).then((r) => { done = true; return r; });
  await wait(1200);
  assert.equal(done, false);
  assert.equal(state.calls, 0);
  busy = false;
  const r = await p;
  assert.deepEqual(r?.size, [40, 30, 20]);
  assert.equal(state.calls, 1);
});

test('a design that does not build is remembered as failed and not tried again', async () => {
  let works = false;
  const { dir, state, store, add, designs } = setup({ render: async () => (works ? { png: PNG, size: [1, 2, 3] } : {}) });
  const key = add('design-0001', 'bad code');
  assert.equal(await store.get('design-0001', key), null);
  assert.equal(await store.get('design-0001', key), null);
  assert.equal(state.calls, 1);
  assert.deepEqual(readdirSync(dir), [`design-0001-${key}.json`]);
  works = true;
  designs.set('design-0001', { code: 'return box()', values: {} });
  const key2 = thumbKey('return box()', {})!;
  const r = await store.get('design-0001', key2);
  assert.deepEqual(r?.size, [1, 2, 3]);
  assert.equal(state.calls, 2);
});

test('a key that is not the current one draws nothing and writes nothing', async () => {
  const { dir, state, store, add } = setup();
  add('design-0001', 'return box()');
  assert.equal(await store.get('design-0001', 'deadbeefdeadbeef'), null);
  assert.equal(await store.get('missing-0001', 'deadbeefdeadbeef'), null);
  assert.equal(state.calls, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('a new picture replaces the old key\'s files; drop removes them all', async () => {
  const { dir, store, add, designs } = setup();
  const k1 = add('design-0001', 'return box(1)');
  add('design-00010', 'return box(9)');
  await store.get('design-0001', k1);
  const other = thumbKey('return box(9)', {})!;
  await store.get('design-00010', other);
  const k2 = add('design-0001', 'return box(2)');
  assert.ok(await store.get('design-0001', k2));
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, [`design-0001-${k2}.json`, `design-0001-${k2}.png`, `design-00010-${other}.json`, `design-00010-${other}.png`].sort());
  await store.drop('design-0001');
  assert.deepEqual(readdirSync(dir).sort(), [`design-00010-${other}.json`, `design-00010-${other}.png`].sort());
  assert.ok(designs.has('design-0001'));
});

test('a render that throws does not stop the queue', async () => {
  let first = true;
  const { store, add } = setup({ render: async () => { if (first) { first = false; throw new Error('boom'); } return { png: PNG, size: [4, 5, 6] }; } });
  const k1 = add('design-0001', 'return box(1)');
  const k2 = add('design-0002', 'return box(2)');
  const [a, b] = await Promise.all([store.get('design-0001', k1), store.get('design-0002', k2)]);
  assert.equal(a, null);
  assert.deepEqual(b?.size, [4, 5, 6]);
});

test('a render that crashed leaves nothing on disk, is not retried in this store, and is tried again by a new one', async () => {
  let crash = true;
  const { dir, state, store, add, designs } = setup({ render: async () => { if (crash) throw new Error('worker died'); return { png: PNG, size: [7, 8, 9] }; } });
  const key = add('design-0001', 'return box()');
  assert.equal(await store.get('design-0001', key), null);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(await store.get('design-0001', key), null);
  assert.equal(state.calls, 1);
  crash = false;
  let calls = 0;
  const again = thumbStore({ dir, busy: () => false, readDesign: async (id) => designs.get(id) ?? null, render: async () => { calls++; return { png: PNG, size: [7, 8, 9] }; } });
  const r = await again.get('design-0001', key);
  assert.equal(calls, 1);
  assert.deepEqual(r?.size, [7, 8, 9]);
  assert.ok(existsSync(r!.file));
});

test('a design changed while it was drawn writes nothing for the old key', async () => {
  const gate: { open: () => void } = { open: () => {} };
  const { dir, store, add, designs } = setup({ render: () => new Promise((r) => { gate.open = () => r({ png: PNG, size: [1, 1, 1] }); }) });
  const key = add('design-0001', 'return box(1)');
  const p = store.get('design-0001', key);
  await wait(50);
  designs.delete('design-0001');
  gate.open();
  assert.equal(await p, null);
  assert.deepEqual(readdirSync(dir), []);
});

// ---- the routes ----
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
server.on('request', createApp({ port }));
after(() => { geometry.stop(); server.closeAllConnections(); server.close(); rmSync(dataDir, { recursive: true, force: true }); });
const A = `http://127.0.0.1:${port}`;
const W = { 'Content-Type': 'application/json', 'X-PTP': '1' };
const BOX = 'function build() { return Manifold.cube([40, 30, 20]); }';
const mk = (id: string, code: string) => ({ id, name: 't', createdAt: 1, updatedAt: 1, messages: [], versions: [], currentVersion: -1, code, values: {} });

test('routes: the list has the key, the picture and its size are served, delete removes them', async () => {
  const ID = 'thumb-test-00000001', EMPTY = 'thumb-test-00000002';
  for (const d of [mk(ID, BOX), mk(EMPTY, '')]) assert.equal((await fetch(`${A}/api/designs/${d.id}`, { method: 'PUT', headers: W, body: JSON.stringify(d) })).status, 200);
  const list = (await (await fetch(`${A}/api/designs`)).json()) as { id: string; thumb?: string }[];
  const key = list.find((d) => d.id === ID)?.thumb;
  assert.match(key ?? '', /^[0-9a-f]{16}$/);
  assert.equal(list.find((d) => d.id === EMPTY)?.thumb, undefined);

  const img = await fetch(`${A}/api/designs/${ID}/thumb?k=${key}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const png = Buffer.from(await img.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 520);
  assert.equal(png.readUInt32BE(20), 520);

  const info = await fetch(`${A}/api/designs/${ID}/thumb.json?k=${key}`);
  assert.equal(info.status, 200);
  assert.equal(info.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const { size } = (await info.json()) as { size: number[] };
  assert.equal(size.length, 3);
  assert.ok(Math.abs(size[0] - 40) < 0.5 && Math.abs(size[1] - 30) < 0.5 && Math.abs(size[2] - 20) < 0.5);

  const wrong = await fetch(`${A}/api/designs/${ID}/thumb?k=deadbeefdeadbeef`);
  assert.equal(wrong.status, 404);
  assert.equal(wrong.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${A}/api/designs/${ID}/thumb?k=XYZ`)).status, 400);
  assert.equal((await fetch(`${A}/api/designs/${ID}/thumb.json?k=${key}0`)).status, 400);
  assert.equal((await fetch(`${A}/api/designs/bad%20id/thumb?k=${key}`)).status, 400);

  const folder = path.join(dataDir, 'thumbs');
  assert.ok(readdirSync(folder).some((f) => f.startsWith(ID)));
  assert.equal((await fetch(`${A}/api/designs/${ID}`, { method: 'DELETE', headers: W })).status, 200);
  assert.ok(!readdirSync(folder).some((f) => f.startsWith(ID)));
});
