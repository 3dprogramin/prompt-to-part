import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The API on a free port with its own data folder, and a stand-in for Claude.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jig-api-test-'));
process.env.JIG_DATA = dataDir;
// The stand-in for Claude needs no credentials, but the API checks them first.
process.env.ANTHROPIC_API_KEY = 'sk-test';
// Listening first and attaching the app after: the app needs the port for its Host check.
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
let releaseGeneration = () => {};
// What the stand-in image model was last asked for.
let imageAsked: { prompt: string; aspect: string; references?: string[]; size?: string } | null = null;
const { createApp } = await import('../server/app');
const { UsageLimitError } = await import('../server/agent');
server.on('request', createApp({
  port,
  hosts: ['192.168.1.20'],
  suggest: async (r) => ({ price: Math.round(r.grams), low: 1, high: 99, reasoning: `for ${r.name}`, currency: 'RON' }),
  sceneWriter: async (id, _size, idea) => (idea ? `on a table: ${idea.idea}, for ${idea.product ?? 'it'} (${idea.suggested ?? 'none'})` : `on a ${id} written for this photo`),
  image: async (prompt, aspect, references, _signal, _onStatus, size) => {
    imageAsked = { prompt, aspect, references, size };
    return { image: { data: Buffer.from('89504e470d0a1a0a70686f746f', 'hex').toString('base64'), mediaType: 'image/png' }, model: 'test/image', cost: 0.04 };
  },
  generate: (req, send, abort) => new Promise((resolve, reject) => {
    // A reply refused because a Claude usage limit is reached.
    if (req.prompt === 'over the limit') {
      return reject(new UsageLimitError('Claude Code returned an error result: You\'ve hit your limit'));
    }
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
  // The names JIG_HOSTS adds (a phone on the network reaching this computer's address).
  assert.equal(await statusWithHost('/api/designs', `192.168.1.20:${port}`), 200);
  assert.equal((await fetch(`${A}/api/designs`, { headers: { Origin: `http://192.168.1.20:${port}` } })).status, 200);
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

test('tags: a saved design\'s tags are set, listed with it, added to or taken from several, and go when it is deleted', async () => {
  const T1 = 'test-tags-0000001', T2 = 'test-tags-0000002', T3 = 'test-tags-0000003';
  const setTags = (id: string, body: unknown) => fetch(`${A}/api/designs/${id}/tags`, { method: 'PUT', headers: W, body: JSON.stringify(body) });
  const bulk = (body: unknown) => fetch(`${A}/api/designs/tags`, { method: 'POST', headers: W, body: JSON.stringify(body) });
  const listed = async () => Object.fromEntries(((await (await fetch(`${A}/api/designs`)).json()) as { id: string; tags?: string[]; createdAt: number }[]).map((d) => [d.id, d]));
  // Not saved yet: the page keeps a new design's tags until its first save.
  assert.equal((await setTags(T1, { tags: ['Temp'] })).status, 404);
  assert.equal((await put(design({ id: T1, createdAt: 42 }))).status, 200);
  assert.equal((await put(design({ id: T2 }))).status, 200);
  for (const bad of [{}, { tags: 'Temp' }, { tags: [''] }, { tags: ['x'.repeat(40)] }, { tags: Array.from({ length: 13 }, (_, i) => `t${i}`) }]) assert.equal((await setTags(T1, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await setTags('bad!id-00000', { tags: ['Temp'] })).status, 400);
  const r = await setTags(T1, { tags: [' ornamente ', 'temp', 'Ornamente'] });
  assert.deepEqual(await r.json(), { tags: ['Temp', 'ornamente'] });
  let l = await listed();
  assert.deepEqual([l[T1].tags, l[T1].createdAt, l[T2].tags], [['Temp', 'ornamente'], 42, undefined]);

  // Several at once: designs that are gone are left out; the reply lists the changed ones.
  assert.deepEqual(await (await bulk({ ids: [T1, T2, T3], add: 'Temp' })).json(), { changed: [T2] });
  assert.deepEqual(await (await bulk({ ids: [T1, T2], remove: 'TEMP' })).json(), { changed: [T1, T2] });
  for (const bad of [{ ids: [T1] }, { ids: [T1], add: 'a', remove: 'b' }, { ids: [], add: 'a' }, { ids: ['../x'], add: 'a' }, { ids: [T1], add: 3 }]) assert.equal((await bulk(bad)).status, 400, JSON.stringify(bad));
  l = await listed();
  assert.deepEqual([l[T1].tags, l[T2].tags], [['ornamente'], undefined]);
  // A design with the most tags gets no more.
  assert.equal((await setTags(T2, { tags: Array.from({ length: 12 }, (_, i) => `t${i}`) })).status, 200);
  assert.deepEqual(await (await bulk({ ids: [T2], add: 'Product' })).json(), { changed: [] });

  assert.equal((await del(T1)).status, 200);
  assert.equal(JSON.parse(readFileSync(path.join(dataDir, 'tags.json'), 'utf8')).tags[T1], undefined);
  assert.equal((await del(T2)).status, 200);
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

test('a server that stops ends running replies with a note, and a reply in progress can be saved', async () => {
  const { endGenerations } = await import('../server/app');
  const r = await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: 'test-api-00000012', prompt: 'a cube' }) });
  assert.equal(r.status, 200);
  await endGenerations('The Jig server is restarting.');
  assert.match(await r.text(), /data: \{"type":"error","message":"The Jig server is restarting\."\}/);
  // A new one starts: the first has ended.
  const again = await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: 'test-api-00000012', prompt: 'a cube' }) });
  assert.equal(again.status, 200);
  releaseGeneration();
  await again.text();

  const reply = { id: 'm2', role: 'assistant', text: '', createdAt: 2, pending: true, steps: [{ kind: 'thinking', text: 'Planning' }], activity: [{ kind: 'thinking', text: 'Planning the cube', at: 1 }] };
  assert.equal((await put(design({ id: 'test-api-00000012', messages: [{ id: 'm1', role: 'user', text: 'a cube', createdAt: 1 }, reply] }))).status, 200);
  const saved = await (await fetch(`${A}/api/designs/test-api-00000012`)).json();
  assert.deepEqual(saved.messages[1], reply);
});

test('the design list reads a design file again only when it changed', async () => {
  const id = 'test-api-00000031';
  const names = async () => ((await (await fetch(`${A}/api/designs`)).json()) as { id: string; name: string }[]).filter((d) => d.id === id).map((d) => d.name);
  assert.equal((await put(design({ id, name: 'Hook' }))).status, 200);
  assert.deepEqual(await names(), ['Hook']);
  // Saved through the API: the list follows at once.
  assert.equal((await put(design({ id, name: 'Hool', rev: 1 }))).status, 200);
  const file = path.join(dataDir, 'designs', `${id}.json`);
  const at = new Date(Date.now() - 60_000);
  utimesSync(file, at, at);
  assert.deepEqual(await names(), ['Hool']);
  // Changed on disk with the same size and time: still the summary read before (the file isn't read).
  writeFileSync(file, readFileSync(file, 'utf8').replace('"Hool"', '"Hoop"'));
  utimesSync(file, at, at);
  assert.deepEqual(await names(), ['Hool']);
  // A change of size (a restored backup, say) is read.
  writeFileSync(file, readFileSync(file, 'utf8').replace('"Hoop"', '"Hook2"'));
  assert.deepEqual(await names(), ['Hook2']);
  assert.equal((await del(id)).status, 200);
  assert.deepEqual(await names(), []);
});

test('a reply goes on when the page\'s connection drops; the page catches up and can stop it', async () => {
  const id = 'test-api-00000013';
  const events = (text: string) => text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  const page = new AbortController();
  const r = await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: id, prompt: 'a cube' }), signal: page.signal });
  const reader = r.body!.getReader();
  let text = '';
  while (!text.includes('working')) text += new TextDecoder().decode((await reader.read()).value);
  const [{ runId }] = events(text);
  page.abort(); // the phone locks its screen
  await new Promise((res) => setTimeout(res, 50));
  assert.equal((await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: id, prompt: 'a cube' }) })).status, 409);
  assert.equal((await fetch(`${A}/api/generate/${id}/events?run=nope&from=0`)).status, 404);
  // Back: the events after the first one, then the rest as they come.
  const back = await fetch(`${A}/api/generate/${id}/events?run=${runId}&from=1`);
  assert.equal(back.status, 200);
  assert.equal((await fetch(`${A}/api/generate/${id}/stop`, { method: 'POST', headers: W })).status, 200);
  assert.deepEqual(events(await back.text()), [{ type: 'live', text: 'working' }, { type: 'error', message: 'Stopped.' }]);
  // Kept for a while after it ended.
  assert.equal(events(await (await fetch(`${A}/api/generate/${id}/events?run=${runId}&from=2`)).text()).length, 1);
});

test('finished replies kept for catching up fit a byte budget, the first finished forgotten first', async () => {
  const { setKeptRunsBudget } = await import('../server/routes/generate');
  const finish = async (designId: string) => {
    const text = await (await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId, prompt: 'over the limit' }) })).text();
    return { runId: JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6)).runId as string, bytes: text.length };
  };
  const first = await finish('test-api-00000021');
  const old = setKeptRunsBudget(Math.round(first.bytes * 1.5));
  try {
    const second = await finish('test-api-00000022');
    assert.equal((await fetch(`${A}/api/generate/test-api-00000021/events?run=${first.runId}&from=0`)).status, 404);
    const kept = await fetch(`${A}/api/generate/test-api-00000022/events?run=${second.runId}&from=0`);
    assert.equal(kept.status, 200);
    await kept.text();
  } finally {
    setKeptRunsBudget(old);
  }
});

test('a reply refused at the usage limit says so', async () => {
  const r = await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: 'test-api-00000011', prompt: 'over the limit' }) });
  const events = (await r.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type !== 'run');
  assert.deepEqual(events, [{ type: 'error', message: 'Claude usage limit reached for now. (Claude Code returned an error result: You\'ve hit your limit)' }]);
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
  // A random sub-scene for a photo, written by Claude (the stand-in).
  const scene = await fetch(`${A}/api/photo-scene`, { method: 'POST', headers: W, body: JSON.stringify({ scene: 'wall' }) });
  assert.deepEqual(await scene.json(), { scene: 'on a wall written for this photo' });
  assert.equal((await fetch(`${A}/api/photo-scene`, { method: 'POST', headers: W, body: JSON.stringify({ scene: 'moon' }) })).status, 400);
  // The user's idea written out: with the scene suggested for the product (a known one) and its name.
  const idea = await fetch(`${A}/api/photo-scene`, { method: 'POST', headers: W, body: JSON.stringify({ scene: 'idea', idea: 'cosy cabin', suggested: 'wall', product: 'Plaque' }) });
  assert.deepEqual(await idea.json(), { scene: 'on a table: cosy cabin, for Plaque (wall)' });
  assert.deepEqual(await (await fetch(`${A}/api/photo-scene`, { method: 'POST', headers: W, body: JSON.stringify({ scene: 'idea', idea: 'cosy cabin', suggested: 'moon' }) })).json(), { scene: 'on a table: cosy cabin, for it (none)' });
  for (const bad of [{ scene: 'idea' }, { scene: 'idea', idea: '  ' }, { scene: 'idea', idea: 'x'.repeat(601) }]) {
    assert.equal((await fetch(`${A}/api/photo-scene`, { method: 'POST', headers: W, body: JSON.stringify(bad) })).status, 400);
  }
});

test('without an API key Claude is never started', async () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN, openrouter: process.env.OPENROUTER_API_KEY };
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN; delete process.env.OPENROUTER_API_KEY;
  try {
    assert.match((await (await fetch(`${A}/api/capabilities`)).json()).claude, /ANTHROPIC_API_KEY/);
    const r = await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: 'test-api-00000007', prompt: 'a cube' }) });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    assert.equal((await (await fetch(`${A}/api/capabilities`)).json()).claude, null);
  } finally {
    for (const [k, v] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_AUTH_TOKEN', saved.token], ['OPENROUTER_API_KEY', saved.openrouter]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});


test('product photos: checked, need the OpenRouter key, stored with the design', async () => {
  const id = 'test-api-00000010';
  const photo = (extra: Record<string, unknown> = {}) => ({ render: { mediaType: 'image/png', data: PNG }, scene: 'table', aspect: '4:5', product: { name: 'Coaster', size: [100, 100, 5] }, ...extra });
  const post = (body: unknown, designId = id) => fetch(`${A}/api/designs/${designId}/photos`, { method: 'POST', headers: W, body: JSON.stringify(body) });
  const saved = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    const noKey = await post(photo());
    assert.equal(noKey.status, 503);
    assert.match((await noKey.json()).error, /OPENROUTER_API_KEY/);
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    for (const bad of [
      photo({ scene: 'moon' }), photo({ aspect: '3:1' }), photo({ scene: 'custom' }), photo({ notes: 'x'.repeat(5000) }),
      photo({ render: { mediaType: 'image/gif', data: PNG } }), photo({ render: { mediaType: 'image/jpeg', data: PNG } }), photo({ render: { mediaType: 'image/png', data: '' } }),
      photo({ product: { name: 'Coaster', size: [100, 100] } }), photo({ product: { name: 'Coaster', size: [100, -1, 5] } }), photo({ product: { size: [1, 1, 1] } }), {},
    ]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 120));
    assert.equal((await post(photo(), 'bad')).status, 400);
    imageAsked = null;
    assert.equal((await post(photo({ scene: 'moon' }))).status, 400);
    assert.equal(imageAsked, null, 'nothing is drawn for a bad request');

    const r = await post(photo({ scene: 'custom', notes: 'on a bedside table' }));
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.match(out.photo, /^\/api\/designs\/test-api-00000010\/images\/[0-9a-f]{32}\.png$/);
    assert.match(out.render, /^\/api\/designs\/test-api-00000010\/images\/[0-9a-f]{32}\.png$/);
    assert.notEqual(out.photo, out.render);
    assert.equal(out.model, 'test/image');
    assert.equal(out.cost, 0.04);
    assert.equal(out.prompt, imageAsked!.prompt);
    assert.match(out.prompt, /on a bedside table/);
    assert.equal(imageAsked!.aspect, '4:5');
    assert.equal(imageAsked!.size, undefined, 'a photo at the model\'s default size');
    assert.deepEqual(imageAsked!.references, [`data:image/png;base64,${PNG}`]);
    assert.equal((await fetch(A + out.photo)).status, 200);

    // A shop set's photo: square at 2K, in the grey studio, saying what the shot shows.
    assert.equal((await post(photo({ shop: 'hero' }))).status, 400);
    const shop = await post(photo({ scene: 'grey-studio', aspect: '1:1', shop: 'main', product: { name: 'Coaster', size: [100, 100, 5], faceOn: true } }));
    assert.equal(shop.status, 200);
    assert.equal(imageAsked!.size, '2K');
    assert.equal(imageAsked!.aspect, '1:1');
    assert.match(imageAsked!.prompt, /light grey \(#F3F3F3\) studio sweep/);
    assert.match(imageAsked!.prompt, /THE MAIN LISTING PHOTO/);
    assert.match((await shop.json()).photo, /^\/api\/designs\/test-api-00000010\/images\/[0-9a-f]{32}\.png$/);

    // Listed in the design, which keeps them.
    const entry = { url: out.photo, render: out.render, scene: 'custom', notes: 'on a bedside table', aspect: '4:5', prompt: out.prompt, model: out.model, cost: out.cost, createdAt: 5 };
    const { notes: _notes, ...plain } = entry;
    const shopEntry = { ...plain, scene: 'grey-studio', shop: 'main', aspect: '1:1', createdAt: 6 };
    assert.equal((await put(design({ id, photos: [entry, shopEntry] }))).status, 200);
    assert.deepEqual((await (await fetch(`${A}/api/designs/${id}`)).json()).photos, [entry, shopEntry]);
    assert.equal((await put(design({ id, rev: 1, photos: 'nope' }))).status, 400);

    assert.equal((await del(id)).status, 200);
    assert.equal((await post(photo())).status, 410);
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = saved;
  }
});

test('sale sizes: stored with the design; a photo for another size keeps an earlier photo\'s scene', async () => {
  const id = 'test-api-00000021';
  const sizes = [{ id: 's1', label: 'S', axis: 0, mm: 100, resolved: { key: 'k', values: { $faceScale: 0.667 }, size: [100, 66.7, 6], how: 'face' } }, { id: 's2', label: 'M', axis: 0, mm: 150 }];
  assert.equal((await put(design({ id, sizes }))).status, 200);
  assert.deepEqual((await (await fetch(`${A}/api/designs/${id}`)).json()).sizes, sizes);
  assert.equal((await put(design({ id, rev: 1, sizes: { s: 1 } }))).status, 400);
  // An old design without sizes still loads as it was.
  assert.equal((await put(design({ id: 'test-api-00000022' }))).status, 200);
  assert.equal((await (await fetch(`${A}/api/designs/test-api-00000022`)).json()).sizes, undefined);

  const post = (body: unknown) => fetch(`${A}/api/designs/${id}/photos`, { method: 'POST', headers: W, body: JSON.stringify(body) });
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    const product = (size: number[]) => ({ name: 'Plaque', size, faceOn: true });
    const base = await (await post({ render: { mediaType: 'image/png', data: PNG }, scene: 'wall', aspect: '1:1', shop: 'size', saleSize: { id: 's2', label: 'M' }, product: product([150, 100, 6]) })).json();
    const sized = Buffer.from('89504e470d0a1a0a73697a6564', 'hex').toString('base64');
    const resize = { render: { mediaType: 'image/png', data: sized }, from: { photo: base.photo }, scene: 'wall', aspect: '1:1', shop: 'size', saleSize: { id: 's1', label: 'S' }, resize: { base: { label: 'M', size: [150, 100, 6] } }, product: product([100, 66.7, 6]) };
    for (const bad of [{ ...resize, from: undefined }, { ...resize, render: undefined }, { ...resize, resize: { base: { size: [1, 2] } } }, { ...resize, saleSize: { id: '', label: 'S' } }, { ...resize, change: '' }]) {
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 160));
    }
    imageAsked = null;
    const r = await post(resize);
    assert.equal(r.status, 200);
    const out = await r.json();
    // The size's own render first, then the earlier photo as the scene; at 2K like any shop photo.
    assert.equal(imageAsked!.references![0], `data:image/png;base64,${sized}`);
    assert.match(imageAsked!.references![1], /^data:image\/png;base64,/);
    assert.equal(imageAsked!.size, '2K');
    assert.match(out.prompt, /THIS PHOTO SHOWS THE S SIZE/);
    assert.match(out.prompt, /THE SCENE TO KEEP EXACTLY/);
    assert.match(out.prompt, /0\.67x as wide and as tall as in the earlier photo \(just as thick as before\)/);
    assert.notEqual(out.render, base.render, 'its own render is stored with it');
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = saved;
  }
});
