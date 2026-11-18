import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The data folder under a dot folder (~/.local/share/...), where res.sendFile refuses files by default.
const root = mkdtempSync(path.join(os.tmpdir(), 'ptp-thumbs-'));
const dataDir = path.join(root, '.local', 'share', 'ptp');
process.env.PTP_DATA = dataDir;
process.env.PTP_AUTH = 'subscription';
process.env.PTP_CLAUDE = '';
const { THUMB_VERSION, thumbKey, thumbStore } = await import('../server/thumbs');
const { createApp } = await import('../server/app');
const { geometry } = await import('../server/geometry');

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ptp-thumbstore-'));
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Render = (code: string, values: unknown) => Promise<{ png?: string; size?: [number, number, number] }>;
type Designs = Map<string, { code: string; values: unknown; v: number }>;
let saves = 0;
/** What a store reads a design with: `reads` counts the reads of the design (the file's time and size are free). */
function readers(designs: Designs, state: { reads: number }, onRead = () => {}) {
  return {
    readDesign: async (id: string) => { state.reads++; onRead(); const d = designs.get(id); return d ? { code: d.code, values: d.values } : null; },
    statDesign: async (id: string) => { const d = designs.get(id); return d ? { mtimeMs: d.v, size: d.code.length } : null; },
  };
}

/** A store over a temp folder with designs held in memory and a render that counts its calls. */
function setup(opts: { render?: Render; build?: string; dir?: string; onRead?: () => void } = {}) {
  const dir = opts.dir ?? tmp();
  const designs: Designs = new Map();
  const state = { calls: 0, running: 0, maxRunning: 0, reads: 0 };
  const store = thumbStore({
    dir,
    build: opts.build ?? 'v1',
    ...readers(designs, state, opts.onRead),
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
  /** Saves a design (its time changes with every save) and gives its picture's key. */
  const add = (id: string, code: string, values: unknown = {}) => { designs.set(id, { code, values, v: ++saves }); return thumbKey(code, values)!; };
  return { dir, designs, state, store, add };
}

test('thumbKey: null for no code, changes with code and the values that build, nothing else', () => {
  assert.equal(THUMB_VERSION, 2);
  assert.equal(thumbKey('', {}), null);
  assert.equal(thumbKey('  \n\t ', {}), null);
  const k = thumbKey('return box()', { w: 1 })!;
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(thumbKey('return box()', { w: 1 }), k);
  assert.notEqual(thumbKey('return box()', { w: 2 }), k);
  assert.notEqual(thumbKey('return box() ', { w: 1 }), k);
  // The picture marks and the edit history build nothing.
  assert.equal(thumbKey('return box()', { w: 1, $pictureMarks: '{"a":1}', $editHistory: '{"lineart":[]}' }), k);
  assert.notEqual(thumbKey('return box()', { w: 1, $text: '[]' }), k);
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

test('a design that does not build is remembered as failed and not tried again', async () => {
  let works = false;
  const { dir, state, store, add } = setup({ render: async () => (works ? { png: PNG, size: [1, 2, 3] } : {}) });
  const key = add('design-0001', 'bad code');
  assert.equal(await store.get('design-0001', key), null);
  assert.equal(await store.get('design-0001', key), null);
  assert.equal(state.calls, 1);
  assert.deepEqual(readdirSync(dir), [`design-0001-${key}.json`]);
  works = true;
  const key2 = add('design-0001', 'return box()');
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

test('a stale key: after its first answer it is "not there" at once, with no read and no render', async () => {
  const { dir, state, store, add } = setup();
  const stale = add('design-0001', 'return box(1)');
  add('design-0001', 'return box(2)');
  assert.equal(await store.get('design-0001', stale), null);
  assert.equal(state.reads, 1);
  for (let i = 0; i < 5; i++) {
    assert.equal(await store.peek('design-0001', stale, 0), null);
    assert.equal(await store.peek('design-0001', stale, 1500), null);
    assert.equal(await store.get('design-0001', stale), null);
  }
  assert.equal(state.reads, 1);
  assert.equal(state.calls, 0);
  assert.deepEqual(readdirSync(dir), []);
  // Saved so that the once-stale key is the current one again: its time changed, so it is drawn.
  assert.equal(add('design-0001', 'return box(1)'), stale);
  assert.deepEqual((await store.peek('design-0001', stale, 1500) as { size: number[] }).size, [40, 30, 20]);
  assert.equal(state.reads, 2);
  assert.equal(state.calls, 1);
});

test('a deleted design\'s key: "not there" without reads after its first answer, drawn again if the design comes back', async () => {
  const { state, store, add, designs } = setup();
  const key = add('design-0001', 'return box()');
  designs.delete('design-0001');
  assert.equal(await store.peek('design-0001', key, 1500), null);
  const reads = state.reads;
  for (let i = 0; i < 5; i++) { assert.equal(await store.peek('design-0001', key, 0), null); assert.equal(await store.get('design-0001', key), null); }
  assert.equal(state.reads, reads);
  assert.equal(state.calls, 0);
  add('design-0001', 'return box()');
  assert.deepEqual((await store.get('design-0001', key))?.size, [40, 30, 20]);
  assert.equal(state.calls, 1);
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

test('previous: the newest older picture of exactly that design, nothing for its own key, a failure or a bad id', async () => {
  const { dir, store, add } = setup();
  const k1 = add('design-0001', 'return box(1)');
  assert.equal(await store.previous('design-0001', k1), null, 'nothing on disk yet');
  await store.get('design-0001', k1);
  assert.equal(await store.previous('design-0001', k1), null, 'its own key is not an older picture');
  // Another design whose id starts with this one's: never given for it.
  const k9 = add('design-0001-copy', 'return box(9)');
  await store.get('design-0001-copy', k9);
  const k2 = add('design-0001', 'return box(2)');
  assert.equal(await store.previous('design-0001', k2), path.join(dir, `design-0001-${k1}.png`));
  assert.equal(await store.previous('design-0001-copy', k2), path.join(dir, `design-0001-copy-${k9}.png`));
  assert.equal(await store.previous('design-0002', k2), null);
  assert.equal(await store.previous('../design-0001', k2), null);
  assert.equal(await store.previous('design-0001', 'XYZ'), null);
  // A failure marker is not a picture.
  writeFileSync(path.join(dir, `design-0003-${k2}.json`), JSON.stringify({ failed: true, build: 'v1' }));
  assert.equal(await store.previous('design-0003', k1), null);
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
  const again = thumbStore({ dir, build: 'v1', ...readers(designs, { reads: 0 }), render: async () => { calls++; return { png: PNG, size: [7, 8, 9] }; } });
  const r = await again.get('design-0001', key);
  assert.equal(calls, 1);
  assert.deepEqual(r?.size, [7, 8, 9]);
  assert.ok(existsSync(r!.file));
});

test('a design deleted while it was drawn writes nothing for the old key', async () => {
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

test('a design saved while it was drawn writes nothing, even with the same code and values (its time changed)', async () => {
  const gate: { open: () => void } = { open: () => {} };
  const { dir, state, store, add } = setup({ render: () => new Promise((r) => { gate.open = () => r({ png: PNG, size: [1, 1, 1] }); }) });
  const key = add('design-0001', 'return box(1)');
  const p = store.get('design-0001', key);
  await wait(50);
  add('design-0001', 'return box(1)');
  gate.open();
  assert.equal(await p, null);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(state.reads, 1, 'the check after the render compares the time and size, it does not read the design again');
});

test('the design is read once per picture drawn; asks for one queued or drawn add no read', async () => {
  const { state, store, add } = setup({ render: async () => { await wait(200); return { png: PNG, size: [1, 2, 3] }; } });
  const key = add('design-0001', 'return box()');
  const asks: Promise<unknown>[] = [];
  for (let i = 0; i < 5; i++) asks.push(store.get('design-0001', key), store.peek('design-0001', key, 0), store.peek('design-0001', key, 1500));
  await wait(50);
  assert.equal(state.reads, 1);
  await Promise.all(asks);
  for (let i = 0; i < 5; i++) { await store.get('design-0001', key); await store.peek('design-0001', key, 0); }
  assert.equal(state.reads, 1);
  assert.equal(state.calls, 1);
});

test('a failure is tried again by another build, and a marker without a build once', async () => {
  let works = false;
  const render: Render = async () => (works ? { png: PNG, size: [1, 2, 3] } : {});
  const a = setup({ render, build: 'v1' });
  const key = a.add('design-0001', 'bad code');
  assert.equal(await a.store.get('design-0001', key), null);
  assert.deepEqual(JSON.parse(readFileSync(path.join(a.dir, `design-0001-${key}.json`), 'utf8')), { failed: true, build: 'v1' });
  // The same build: known to fail, not drawn again (also by a new store, after a restart).
  const same = setup({ render, build: 'v1', dir: a.dir });
  same.designs.set('design-0001', a.designs.get('design-0001')!);
  assert.equal(await same.store.get('design-0001', key), null);
  assert.equal(same.state.calls, 0);
  // Another build: drawn again (and it works now).
  works = true;
  const next = setup({ render, build: 'v2', dir: a.dir });
  next.designs.set('design-0001', a.designs.get('design-0001')!);
  assert.deepEqual((await next.store.get('design-0001', key))?.size, [1, 2, 3]);
  assert.equal(next.state.calls, 1);
  // A marker from before builds were noted: tried once, then known.
  works = false;
  const old = setup({ render, build: 'v2' });
  const k2 = old.add('design-0002', 'bad code 2');
  writeFileSync(path.join(old.dir, `design-0002-${k2}.json`), JSON.stringify({ failed: true }));
  assert.equal(await old.store.get('design-0002', k2), null);
  assert.equal(await old.store.peek('design-0002', k2, 0), null);
  assert.equal(old.state.calls, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(old.dir, `design-0002-${k2}.json`), 'utf8')), { failed: true, build: 'v2' });
});

test('peek: a render slower than waitMs answers pending, then the picture is there; one render in all', async () => {
  const { state, store, add } = setup({ render: async () => { await wait(300); return { png: PNG, size: [1, 2, 3] }; } });
  const key = add('design-0001', 'return box()');
  assert.equal(await store.peek('design-0001', key, 50), 'pending');
  await wait(600);
  const r = await store.peek('design-0001', key, 50);
  assert.deepEqual((r as { size: number[] }).size, [1, 2, 3]);
  assert.equal(state.calls, 1);
});

test('peek: ten designs at once, only the first waits, the others answer pending at once; all end up on disk', async () => {
  const { dir, state, store, add } = setup({ render: async () => { await wait(150); return { png: PNG, size: [1, 1, 1] }; } });
  const keys: [string, string][] = [];
  for (let i = 0; i < 10; i++) { const id = `design-100${i}`; keys.push([id, add(id, `return box(${i})`)]); }
  const t0 = Date.now();
  const first = await Promise.all(keys.map(async ([id, k]) => { const r = await store.peek(id, k, 1500); return { r, ms: Date.now() - t0 }; }));
  const drawn = first.filter((a) => a.r !== 'pending');
  assert.equal(drawn.length, 1, 'only the first in line waited for its picture');
  assert.deepEqual((drawn[0].r as { size: number[] }).size, [1, 1, 1]);
  for (const a of first.filter((x) => x.r === 'pending')) assert.ok(a.ms < 100, `pending after ${a.ms} ms`);
  for (let i = 0; i < 40 && readdirSync(dir).filter((f) => f.endsWith('.png')).length < 10; i++) await wait(100);
  assert.equal(state.maxRunning, 1);
  assert.equal(state.calls, 10);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.png')).length, 10);
  for (const [id, k] of keys) assert.ok(await store.peek(id, k, 0) !== 'pending');
});

test('a failure to write the files is remembered and not tried again', async () => {
  const dir = path.join(tmp(), 'blocked');
  writeFileSync(dir, 'a file, so the folder cannot be made');
  const designs: Designs = new Map([['design-0001', { code: 'return box()', values: {}, v: 1 }]]);
  let calls = 0;
  const store = thumbStore({ dir, build: 'v1', ...readers(designs, { reads: 0 }), render: async () => { calls++; return { png: PNG, size: [1, 2, 3] }; } });
  const key = thumbKey('return box()', {})!;
  assert.equal(await store.get('design-0001', key), null);
  assert.equal(await store.get('design-0001', key), null);
  assert.equal(calls, 1);
});

// ---- the routes ----
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
let release = () => {};
server.on('request', createApp({
  port,
  generate: (_req, _send, abort) => new Promise((resolve) => { release = () => resolve(); abort.signal.addEventListener('abort', () => resolve()); }),
}));
after(() => { release(); geometry.stop(); server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); });
const A = `http://127.0.0.1:${port}`;
const W = { 'Content-Type': 'application/json', 'X-PTP': '1' };
const BOX = 'function build() { return Manifold.cube([40, 30, 20]); }';
const mk = (id: string, code: string) => ({ id, name: 't', createdAt: 1, updatedAt: 1, messages: [], versions: [], currentVersion: -1, code, values: {} });

test('routes: the list has the key, the picture and its size are served (from a data folder under a dot folder), delete removes them', async () => {
  const ID = 'thumb-test-00000001', EMPTY = 'thumb-test-00000002';
  for (const d of [mk(ID, BOX), mk(EMPTY, '')]) assert.equal((await fetch(`${A}/api/designs/${d.id}`, { method: 'PUT', headers: W, body: JSON.stringify(d) })).status, 200);
  const list = (await (await fetch(`${A}/api/designs`)).json()) as { id: string; thumb?: string }[];
  const key = list.find((d) => d.id === ID)?.thumb;
  assert.match(key ?? '', /^[0-9a-f]{16}$/);
  assert.equal(list.find((d) => d.id === EMPTY)?.thumb, undefined);

  const img = await fetch(`${A}/api/designs/${ID}/thumb?k=${key}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  const png = Buffer.from(await img.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 520);
  assert.equal(png.readUInt32BE(20), 520);

  const info = await fetch(`${A}/api/designs/${ID}/thumb.json?k=${key}`);
  assert.equal(info.status, 200);
  assert.equal(info.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  const { size } = (await info.json()) as { size: number[] };
  assert.equal(size.length, 3);
  assert.ok(Math.abs(size[0] - 40) < 0.5 && Math.abs(size[1] - 30) < 0.5 && Math.abs(size[2] - 20) < 0.5);

  const wrong = await fetch(`${A}/api/designs/${ID}/thumb?k=deadbeefdeadbeef`);
  assert.equal(wrong.status, 404);
  assert.equal(wrong.headers.get('cache-control'), 'no-store');
  // The info of a key that is not current says "not there" too (not "not yet"), also when asked again.
  for (let i = 0; i < 2; i++) {
    const info = await fetch(`${A}/api/designs/${ID}/thumb.json?k=deadbeefdeadbeef`);
    assert.equal(info.status, 404);
    assert.equal(info.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(`${A}/api/designs/${ID}/thumb?k=XYZ`)).status, 400);
  assert.equal((await fetch(`${A}/api/designs/${ID}/thumb.json?k=${key}0`)).status, 400);
  assert.equal((await fetch(`${A}/api/designs/bad%20id/thumb?k=${key}`)).status, 400);

  const folder = path.join(dataDir, 'thumbs');
  assert.ok(readdirSync(folder).some((f) => f.startsWith(ID)));
  assert.equal((await fetch(`${A}/api/designs/${ID}`, { method: 'DELETE', headers: W })).status, 200);
  assert.ok(!readdirSync(folder).some((f) => f.startsWith(ID)));
});

/** Asks `url` until it answers something other than 503 (the picture not drawn yet), at most ~10 s. */
async function settled(url: string): Promise<Response> {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.status !== 503 || i >= 40) return r;
    await r.arrayBuffer();
    await wait(250);
  }
}

test('routes: while a generation runs, a render under way goes on and a picture is drawn and served 200; one behind it answers 503 no-store with Retry-After', async () => {
  const ID = 'thumb-test-00000003', OTHER = 'thumb-test-00000004', DRAWING = 'thumb-test-00000007';
  // About a second and a half of work in the worker before the cube (the sandbox has no clock).
  const SLOW = 'function build() { let x = 0; for (let i = 0; i < 1e9; i++) x += i; return Manifold.cube([12, 12, 12 + (x % 1)]); }';
  for (const d of [mk(ID, BOX), mk(OTHER, BOX), mk(DRAWING, SLOW)]) assert.equal((await fetch(`${A}/api/designs/${d.id}`, { method: 'PUT', headers: W, body: JSON.stringify(d) })).status, 200);
  const list = (await (await fetch(`${A}/api/designs`)).json()) as { id: string; thumb?: string }[];
  const key = list.find((d) => d.id === ID)!.thumb, slowKey = list.find((d) => d.id === DRAWING)!.thumb;
  const slowPng = fetch(`${A}/api/designs/${DRAWING}/thumb?k=${slowKey}`);
  await wait(100);
  const gen = await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: OTHER, prompt: 'a cube' }) });
  assert.equal(gen.status, 200);
  try {
    // Behind the render under way: "not yet", asked again in 3 s.
    const behind = await fetch(`${A}/api/designs/${ID}/thumb?k=${key}`);
    assert.equal(behind.status, 503);
    assert.equal(behind.headers.get('cache-control'), 'no-store');
    assert.equal(behind.headers.get('retry-after'), '3');
    await (await slowPng).arrayBuffer();
    // The render under way was not stopped by the generation, and the next one is drawn while it runs.
    assert.equal((await settled(`${A}/api/designs/${DRAWING}/thumb.json?k=${slowKey}`)).status, 200);
    const img = await settled(`${A}/api/designs/${ID}/thumb?k=${key}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal((await fetch(`${A}/api/designs/${ID}/thumb.json?k=${key}`)).status, 200);
  } finally {
    release();
    await gen.arrayBuffer();
  }
});

test('routes: a design whose code does not build answers 404 no-store, twice, with one render', async () => {
  const ID = 'thumb-test-00000005';
  const real = geometry.thumb;
  let renders = 0;
  geometry.thumb = (...a: Parameters<typeof real>) => { renders++; return real(...a); };
  try {
    assert.equal((await fetch(`${A}/api/designs/${ID}`, { method: 'PUT', headers: W, body: JSON.stringify(mk(ID, 'this is not a script (')) })).status, 200);
    const key = ((await (await fetch(`${A}/api/designs`)).json()) as { id: string; thumb?: string }[]).find((d) => d.id === ID)!.thumb;
    const first = await settled(`${A}/api/designs/${ID}/thumb?k=${key}`);
    assert.equal(first.status, 404);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const second = await fetch(`${A}/api/designs/${ID}/thumb?k=${key}`);
    assert.equal(second.status, 404);
    assert.equal(second.headers.get('cache-control'), 'no-store');
    assert.equal(renders, 1);
    assert.ok(JSON.parse(readFileSync(path.join(dataDir, 'thumbs', `${ID}-${key}.json`), 'utf8')).failed, 'remembered as failed');
  } finally { geometry.thumb = real; }
});

test('routes: while a render is slow, thumb.json answers 503 at once', async () => {
  const ID = 'thumb-test-00000006';
  // About a second and a half of work in the worker before the cube (the sandbox has no clock).
  const SLOW = 'function build() { let x = 0; for (let i = 0; i < 1e9; i++) x += i; return Manifold.cube([10, 10, 10 + (x % 1)]); }';
  assert.equal((await fetch(`${A}/api/designs/${ID}`, { method: 'PUT', headers: W, body: JSON.stringify(mk(ID, SLOW)) })).status, 200);
  const key = ((await (await fetch(`${A}/api/designs`)).json()) as { id: string; thumb?: string }[]).find((d) => d.id === ID)!.thumb;
  const png = fetch(`${A}/api/designs/${ID}/thumb?k=${key}`);
  await wait(100);
  const t0 = Date.now();
  const info = await fetch(`${A}/api/designs/${ID}/thumb.json?k=${key}`);
  assert.ok(Date.now() - t0 < 300, `answered after ${Date.now() - t0} ms`);
  assert.equal(info.status, 503);
  assert.equal(info.headers.get('cache-control'), 'no-store');
  assert.equal(info.headers.get('retry-after'), '3');
  await (await png).arrayBuffer();
  // Drawn in the end (and nothing is left running for the next test).
  assert.equal((await settled(`${A}/api/designs/${ID}/thumb.json?k=${key}`)).status, 200);
});

/** Asks `url` until it answers the picture of its own key (not "not yet", not an older one), at most ~10 s. */
async function current(url: string): Promise<Response> {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if ((r.status !== 503 && !r.headers.get('x-thumb-stale')) || i >= 40) return r;
    await r.arrayBuffer();
    await wait(250);
  }
}
const put = (d: object) => fetch(`${A}/api/designs/${(d as { id: string }).id}`, { method: 'PUT', headers: W, body: JSON.stringify(d) });
const keyOf = async (id: string) => ((await (await fetch(`${A}/api/designs`)).json()) as { id: string; thumb?: string }[]).find((d) => d.id === id)!.thumb!;

test('routes: a changed design shows its old picture (no-store, X-Thumb-Stale) until the new one is drawn', async () => {
  const ID = 'thumb-test-00000008';
  assert.equal((await put(mk(ID, BOX))).status, 200);
  const k1 = await keyOf(ID);
  const first = await current(`${A}/api/designs/${ID}/thumb?k=${k1}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-thumb-stale'), null);
  const old = Buffer.from(await first.arrayBuffer());
  assert.equal((await put({ ...mk(ID, 'function build() { return Manifold.cube([10, 10, 10]); }'), rev: 1 })).status, 200);
  const k2 = await keyOf(ID);
  assert.notEqual(k2, k1);
  // The new picture's render is held until the old one has been checked.
  const real = geometry.thumb;
  let open = () => {};
  const gate = new Promise<void>((r) => { open = r; });
  geometry.thumb = (...a: Parameters<typeof real>) => gate.then(() => real(...a));
  try {
    const stale = await fetch(`${A}/api/designs/${ID}/thumb?k=${k2}`);
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('content-type'), 'image/png');
    assert.equal(stale.headers.get('cache-control'), 'no-store');
    assert.equal(stale.headers.get('x-thumb-stale'), '1');
    assert.deepEqual(Buffer.from(await stale.arrayBuffer()), old);
    // The size is the new key's only: not there yet.
    assert.equal((await fetch(`${A}/api/designs/${ID}/thumb.json?k=${k2}`)).status, 503);
  } finally { open(); geometry.thumb = real; }
  const fresh = await current(`${A}/api/designs/${ID}/thumb?k=${k2}`);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(fresh.headers.get('x-thumb-stale'), null);
  assert.notDeepEqual(Buffer.from(await fresh.arrayBuffer()), old);
  assert.deepEqual(readdirSync(path.join(dataDir, 'thumbs')).filter((f) => f.startsWith(`${ID}-`)).sort(), [`${ID}-${k2}.json`, `${ID}-${k2}.png`]);
});

test('routes: no old picture for a key that failed or is not current: 404', async () => {
  const ID = 'thumb-test-00000009';
  assert.equal((await put(mk(ID, BOX))).status, 200);
  const k1 = await keyOf(ID);
  assert.equal((await current(`${A}/api/designs/${ID}/thumb?k=${k1}`)).status, 200);
  // A key that is not the design's: "not there", also when asked again, though a picture of the design is on disk.
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${A}/api/designs/${ID}/thumb?k=deadbeefdeadbeef`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('x-thumb-stale'), null);
  }
  assert.equal((await put({ ...mk(ID, 'this is not a script ('), rev: 1 })).status, 200);
  const bad = await keyOf(ID);
  for (let i = 0; i < 2; i++) {
    const r = await current(`${A}/api/designs/${ID}/thumb?k=${bad}`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
});
