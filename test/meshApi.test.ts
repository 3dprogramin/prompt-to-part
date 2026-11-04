import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, MeshUpload } from '../shared/api';
import type { MeshEntry } from '../shared/meshes';

// The API with its own data folder (the geometry process reads the mesh files from it).
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-mesh-test-'));
process.env.PTP_DATA = dataDir;
const { createApp } = await import('../server/app');
const { geometry, formatReport } = await import('../server/geometry');
const { cadTools } = await import('../server/cadTools');
const { createMeshyMock } = await import('../server/meshyMock');
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as AddressInfo).port;
server.on('request', createApp({ port }));
// The mock's clock moves only when the app waits between polls (50 ms a wait, at once): quick, and
// every status is seen however busy the machine is.
let clock = Date.now();
const sleep = async (ms: number) => { clock += Math.min(ms, 50); };
const mock = createMeshyMock({ pendingMs: 200, runMs: 800, now: () => clock });
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
after(() => { server.close(); mock.close(); geometry.stop(); rmSync(dataDir, { recursive: true, force: true }); });

const A = `http://127.0.0.1:${port}`;
const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', 'meshes', name));
const upload = (id: string, name: string, body: Uint8Array) => fetch(`${A}/api/designs/${id}/meshes?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-PTP': '1', 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(body) });
const ID = 'test-mesh-00000001';

test('a mesh file is imported, repaired and stored with the design', async () => {
  const r = await upload(ID, 'broken holes.stl', fixture('broken-holes.stl'));
  assert.equal(r.status, 200);
  const u = await r.json() as MeshUpload;
  assert.equal(u.name, 'broken-holes');
  assert.match(u.entry.file, /^\/api\/designs\/test-mesh-00000001\/meshes\/[0-9a-f]{32}\.bin$/);
  assert.equal(u.entry.source, 'upload');
  assert.equal(u.entry.original, 'broken holes.stl');
  assert.match(u.entry.repairs!.join(), /Closed 2 holes/);
  assert.equal(u.report.inputTriangles, 612);
  // The stored mesh, its picture and the original file.
  const bin = await fetch(A + u.entry.file);
  assert.equal(bin.status, 200);
  assert.match(bin.headers.get('cache-control') ?? '', /immutable/);
  assert.equal((await fetch(A + u.entry.preview!)).headers.get('content-type'), 'image/png');
  const files = readdirNames(ID);
  assert.ok(files.some((f) => f.endsWith('.stl')) && files.some((f) => f.endsWith('.png')) && files.some((f) => f.endsWith('.bin')), files.join());
  // The same file again: the same stored mesh.
  const again = await (await upload(ID, 'copy.stl', fixture('broken-holes.stl'))).json() as MeshUpload;
  assert.equal(again.entry.file, u.entry.file);

  // H.mesh in the locked-down geometry process: the server reads the file for it.
  const values = { $meshes: JSON.stringify({ pug: u.entry }) };
  const ev = await geometry.evaluate('const params = { h: { value: 30, min: 10, max: 80 } };\nfunction build(p) { return H.mesh("pug", { height: p.h }).add(Manifold.cylinder(2, 20, 20, 48)); }', values);
  assert.ok(ev.ok, JSON.stringify(ev));
  assert.match(formatReport(ev), /× 30\.00 mm/);
  const stress = await geometry.stress('const params = { h: { value: 30, min: 10, max: 80 } };\nfunction build(p) { return H.mesh("pug", { height: p.h }); }', values);
  assert.deepEqual(stress.failures, []);
  const render = await geometry.render('function build() { return H.mesh("pug"); }', values);
  assert.ok(render.ok && render.png);
  // A mesh whose file is gone is a clear error, not a hang.
  const gone = { $meshes: JSON.stringify({ pug: { ...u.entry, file: u.entry.file.replace(/[0-9a-f]{32}/, '0'.repeat(32)) } }) };
  const missing = await geometry.evaluate('function build() { return H.mesh("pug"); }', gone);
  assert.ok(!missing.ok && /couldn't be loaded: the file is missing/.test(missing.error.message), JSON.stringify(missing));
});

test('uploads are checked', async () => {
  assert.equal((await upload(ID, 'model.blend', Buffer.from('x'))).status, 400);
  assert.equal((await upload('bad', 'x.stl', Buffer.from('x'))).status, 400);
  assert.equal((await upload(ID, 'empty.stl', new Uint8Array(0))).status, 400);
  const sheet = await upload(ID, 'sheet.stl', fixture('open-sheet.stl'));
  assert.equal(sheet.status, 422);
  assert.match((await sheet.json()).error, /sheet\.stl: The mesh encloses no volume/);
  assert.equal((await upload(ID, 'junk.glb', Buffer.from('not a model'))).status, 422);
  // Writes need X-PTP, like every other write.
  assert.equal((await fetch(`${A}/api/designs/${ID}/meshes?name=a.stl`, { method: 'POST', body: fixture('pug.stl') })).status, 403);
  for (const name of ['../x.bin', 'abc.bin', `${'0'.repeat(32)}.exe`]) assert.notEqual((await fetch(`${A}/api/designs/${ID}/meshes/${encodeURIComponent(name)}`)).status, 200, name);
});

test('a design started from a version gets its own copies; deleting a design deletes its meshes', async () => {
  const u = await (await upload('test-mesh-00000002', 'fox.glb', fixture('fox.glb'))).json() as MeshUpload;
  const copy = await fetch(`${A}/api/designs/test-mesh-00000003/meshes/copy`, { method: 'POST', headers: { 'X-PTP': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'test-mesh-00000002' }) });
  assert.equal(copy.status, 200);
  assert.equal((await copy.json()).copied, 3);
  assert.equal((await fetch(A + u.entry.file.replace('00000002', '00000003'))).status, 200);
  const del = await fetch(`${A}/api/designs/test-mesh-00000002`, { method: 'DELETE', headers: { 'X-PTP': '1' } });
  assert.equal(del.status, 200);
  assert.equal((await fetch(A + u.entry.file)).status, 404);
  assert.equal((await fetch(A + u.entry.file.replace('00000002', '00000003'))).status, 200);
  assert.equal((await upload('test-mesh-00000002', 'fox.glb', fixture('fox.glb'))).status, 410);
  const bad = await fetch(`${A}/api/designs/test-mesh-00000003/meshes/copy`, { method: 'POST', headers: { 'X-PTP': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ from: '../etc' }) });
  assert.equal(bad.status, 400);
});

test('generate_3d: Meshy (the mock) makes a model, the app repairs and stores it, Claude gets a render', async () => {
  const events: AgentEvent[] = [];
  const base: Record<string, string> = {};
  const client = { key: 'msy_test', baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/openapi`, sleep };
  const { server: cad } = cadTools(path.join(dataDir, 'model.js'), (e) => events.push(e), new Set(), base, { meshy: { client, designId: 'test-mesh-00000004', references: [] } });
  // The tool as the Agent SDK calls it.
  const tools = (cad.instance as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra: unknown) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> }> })._registeredTools;
  const out = await tools.generate_3d.handler({ name: 'fox', prompt: 'a cute fox sitting' }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  assert.deepEqual(out.content.map((c) => c.type), ['image', 'text']);
  assert.match(out.content[1].text!, /Mesh "fox"[\s\S]*Use it with H\.mesh\("fox"/);
  const mesh = events.find((e) => e.type === 'mesh') as { name: string; entry: MeshEntry };
  assert.equal(mesh.entry.source, 'meshy');
  assert.match(mesh.entry.prompt!, /^a cute fox sitting, on a stable circular base/);
  assert.ok(existsSync(path.join(dataDir, 'designs', 'test-mesh-00000004', 'meshes', mesh.entry.file.split('/').pop()!)));
  assert.equal(JSON.parse(base.$meshes).fox.file, mesh.entry.file);
  const steps = events.flatMap((e) => (e.type === 'step' ? [e.step] : []));
  assert.ok(steps.some((s) => /^Meshy: \d+ %…$/.test(s.text)), steps.map((s) => s.text).join('\n'));
  const shown = steps.find((s) => s.kind === 'render')!;
  assert.match(shown.text, /3D model "fox" from Meshy · 25 credits/);
  assert.match(shown.detail!, /Prompt sent to Meshy \(text to 3D\):\n\na cute fox sitting/);
  assert.match(shown.image!, /^data:image\/png;base64,/);
  assert.ok(events.some((e) => e.type === 'live' && /^Meshy: \d+ %…$/.test(e.text)));
  // A figurine on a base, as Claude would build it.
  const r = await geometry.evaluate('function build() { const fox = H.mesh("fox", { height: 60 }).translate([0, 0, 3.5]); return Manifold.union([fox, Manifold.cylinder(4, 32, 32, 64)]); }', base);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(+r.bbox!.max[2].toFixed(1), 63.5);
  // The photo route needs a photo; a failed task is reported to Claude, not thrown.
  assert.ok((await tools.generate_3d.handler({ name: 'x', from_photo: true }, {})).isError);
  const failed = await tools.generate_3d.handler({ name: 'x', prompt: 'a dragon FAIL' }, {});
  assert.ok(failed.isError);
  assert.match(failed.content[0].text!, /too complex/);
});

type Tools = Record<string, { handler: (a: unknown, extra: unknown) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> }>;
const toolsOf = (cad: { instance: unknown }) => (cad.instance as { _registeredTools: Tools })._registeredTools;
const mockBase = () => `http://127.0.0.1:${(mock.address() as AddressInfo).port}/openapi`;
/** A Meshy client on the mock that records what the app creates (and fails a request as if offline). */
function recordingClient() {
  const created: { path: string; body: Record<string, unknown> }[] = [];
  const client = {
    key: 'msy_test', baseUrl: mockBase(), sleep,
    fetch: (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (String(body.prompt ?? '').includes('OFFLINE')) throw new TypeError('fetch failed');
        created.push({ path: new URL(url).pathname, body });
      }
      return fetch(url, init);
    }) as typeof fetch,
  };
  return { client, created };
}

test('3D figure: a concept picture first, then image to 3D from exactly that picture once the user approves', async () => {
  const events: AgentEvent[] = [];
  const base: Record<string, string> = {};
  const { client, created } = recordingClient();
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('a grey clay figure')]);
  const asked: { prompt: string; aspect: string }[] = [];
  const image = async (prompt: string, aspect: string) => { asked.push({ prompt, aspect }); return { image: { data: png.toString('base64'), mediaType: 'image/png' }, model: 'test/image-model', cost: 0.04 }; };
  const { server: cad, newUserMessage } = cadTools(path.join(dataDir, 'model.js'), (e) => events.push(e), new Set(), base, { meshy: { client, designId: 'test-mesh-00000005', references: [], concepts: true }, image });
  const tools = toolsOf(cad);
  const out = await tools.generate_concept.handler({ name: 'hero', subject: 'a superhero crouching, one hand on the ground' }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  assert.match(asked[0].prompt, /Subject: a superhero crouching/);
  assert.match(asked[0].prompt, /grey clay[\s\S]*plain pure white/);
  assert.equal(asked[0].aspect, '3:4');
  assert.match(out.content[1].text!, /end your reply[\s\S]*Don't call generate_3d now/);
  const concept = events.find((e) => e.type === 'concept') as Extract<AgentEvent, { type: 'concept' }>;
  assert.match(concept.entry.image, /^\/api\/designs\/test-mesh-00000005\/meshes\/[0-9a-f]{32}\.png$/);
  assert.deepEqual(new Uint8Array(await (await fetch(A + concept.entry.image)).arrayBuffer()), new Uint8Array(png));
  assert.equal(JSON.parse(base.$concepts).hero.image, concept.entry.image);
  assert.ok(events.some((e) => e.type === 'step' && e.step.kind === 'render' && e.step.image === `data:image/png;base64,${png.toString('base64')}`));
  // Not in the reply that drew it: the user approves first.
  const early = await tools.generate_3d.handler({ name: 'hero', from_concept: 'hero' }, {});
  assert.ok(early.isError);
  assert.match(early.content[0].text!, /hasn't approved/);
  assert.ok((await tools.generate_3d.handler({ name: 'hero', from_concept: 'nope' }, {})).isError);
  assert.equal(created.length, 0);
  // The user's next message approves it: Meshy gets exactly that picture (image to 3D).
  newUserMessage();
  const built = await tools.generate_3d.handler({ name: 'hero', from_concept: 'hero' }, {});
  assert.ok(!built.isError, JSON.stringify(built));
  assert.equal(created.length, 1);
  assert.equal(created[0].path, '/openapi/v1/image-to-3d');
  assert.equal(created[0].body.image_url, `data:image/png;base64,${png.toString('base64')}`);
  const mesh = events.find((e) => e.type === 'mesh') as Extract<AgentEvent, { type: 'mesh' }>;
  assert.match(mesh.entry.prompt!, /^From concept picture "hero": a superhero crouching/);
});

test('3D figure in colour: a colour concept, a textured model (35 credits), its colours kept as 4 filaments through the script', async () => {
  const events: AgentEvent[] = [];
  const base: Record<string, string> = {};
  const { client, created } = recordingClient();
  const grey = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('a grey clay figure')]);
  const painted = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('the same figure painted')]);
  const asked: { prompt: string; references?: string[] }[] = [];
  const image = async (prompt: string, _aspect: string, references?: string[]) => {
    asked.push({ prompt, references });
    return { image: { data: (references ? painted : grey).toString('base64'), mediaType: 'image/png' }, model: 'test/image-model', cost: 0.04 };
  };
  const { server: cad, newUserMessage } = cadTools(path.join(dataDir, 'model.js'), (e) => events.push(e), new Set(), base, { meshy: { client, designId: 'test-mesh-00000007', references: [], concepts: true, color: true }, image });
  const tools = toolsOf(cad);
  // In colour it needs the palette to paint in.
  assert.match((await tools.generate_concept.handler({ name: 'kid', subject: 'a boy in a red shirt and blue trousers' }, {})).content[0].text!, /give palette/);
  const palette = [
    { color: '#E0B090', name: 'light skin', parts: 'face, arms and hands' },
    { color: '#1a1a1a', name: 'black', parts: 'the hair' },
    { color: '#c62a30', name: 'red', parts: 'the shirt' },
    { color: '#2040a0', name: 'blue', parts: 'the trousers and shoes' },
  ];
  const out = await tools.generate_concept.handler({ name: 'kid', subject: 'a boy in a red shirt and blue trousers', palette }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  // The shape: the same grey clay picture as without colour; then that picture painted (image to image).
  assert.equal(asked.length, 2);
  assert.match(asked[0].prompt, /grey clay[\s\S]*plain pure white/);
  assert.equal(asked[0].references, undefined);
  assert.match(asked[1].prompt, /Paint the attached picture[\s\S]*collectible figurine[\s\S]*exactly these 4 colours[\s\S]*3\. red \(#c62a30\): the shirt[\s\S]*not a drawing[\s\S]*light tent/);
  assert.deepEqual(asked[1].references, [`data:image/png;base64,${grey.toString('base64')}`]);
  assert.deepEqual(out.content.map((c) => c.type), ['image', 'image', 'text']);
  assert.match(out.content[2].text!, /keeps to the palette[\s\S]*red \(the shirt\) → PLA Basic Red[\s\S]*approve the pair[\s\S]*35 Meshy credits, in colour/);
  const kid = JSON.parse(base.$concepts).kid;
  assert.equal(kid.color, true);
  assert.deepEqual(kid.palette.map((c: { color: string }) => c.color), ['#e0b090', '#1a1a1a', '#c62a30', '#2040a0']);
  assert.notEqual(kid.painted, kid.image);
  assert.deepEqual(new Uint8Array(await (await fetch(A + kid.painted)).arrayBuffer()), new Uint8Array(painted));
  const shown = events.flatMap((e) => (e.type === 'step' && e.step.kind === 'render' ? [e.step.text] : []));
  assert.deepEqual(shown.map((t) => t.replace(/ from .*/, '')), ['Concept "kid" – shape', 'Concept "kid" – colours']);
  // Not in the reply that drew the pair.
  assert.match((await tools.generate_3d.handler({ name: 'kid', from_concept: 'kid' }, {})).content[0].text!, /hasn't approved/);
  assert.equal(created.length, 0);
  newUserMessage();
  const built = await tools.generate_3d.handler({ name: 'kid', from_concept: 'kid' }, {});
  assert.ok(!built.isError, JSON.stringify(built));
  assert.equal(created[0].path, '/openapi/v1/image-to-3d');
  // The shape from the grey picture, the texture from the painted one.
  assert.equal(created[0].body.image_url, `data:image/png;base64,${grey.toString('base64')}`);
  assert.equal(created[0].body.texture_image_url, `data:image/png;base64,${painted.toString('base64')}`);
  assert.equal(created[0].body.remove_lighting, true);
  assert.equal(created[0].body.should_texture, true);
  assert.equal(created[0].body.texture_resolution, '2k');
  assert.equal(created[0].body.enable_pbr, false);
  const steps = events.flatMap((e) => (e.type === 'step' ? [e.step.text] : []));
  assert.ok(steps.some((t) => /in colour \(35 credits\)/.test(t)), steps.join('\n'));
  assert.ok(steps.some((t) => /^Coloured 3D model "kid" from Meshy · 35 credits$/.test(t)), steps.join('\n'));
  const mesh = (events.find((e) => e.type === 'mesh') as Extract<AgentEvent, { type: 'mesh' }>).entry;
  assert.equal(mesh.palette?.length, 4, JSON.stringify(mesh.palette));
  assert.match(built.content[1].text!, /In colour: its texture reduced to 4 colours/);
  // The script's base in the figure's black: the report says 4 filaments, painted.
  const code = `function build() { const f = H.mesh('kid', { height: 50 }).translate([0, 0, 2]); return [{ name: 'Kid', shape: f.add(Manifold.cylinder(2.5, 18, 18, 40)), color: '${mesh.palette!.find((c) => c.filament.name === 'PLA Basic Black')!.filament.color}' }]; }`;
  const report = formatReport(await geometry.evaluate(code, base, 'draft'));
  assert.match(report, /Coloured \(.*\): (PLA Basic \w+ \(Bambu Lab\) #[0-9a-f]{6} \d+ %; ){3}PLA Basic \w+ \(Bambu Lab\) #[0-9a-f]{6} \d+ %/);
  assert.doesNotMatch(report, /needs \d filaments/);
  // The limit message says what a coloured model costs.
  await tools.generate_3d.handler({ name: 'two', prompt: 'a cat' }, {});
  const third = await tools.generate_3d.handler({ name: 'three', prompt: 'a dog' }, {});
  assert.match(third.content[0].text!, /35 Meshy credits \(in colour\)/);
  assert.deepEqual(created.slice(1).map((c) => [c.path, c.body.mode]), [['/openapi/v2/text-to-3d', 'preview'], ['/openapi/v2/text-to-3d', 'refine']]);
});

test('3D figure in colour: when painting the concept fails, the grey picture alone, and Meshy paints the model itself', async () => {
  const events: AgentEvent[] = [];
  const base: Record<string, string> = {};
  const { client, created } = recordingClient();
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('a grey clay cat')]);
  const image = async (_prompt: string, _aspect: string, references?: string[]) => {
    if (references) throw new Error('The image model is busy');
    return { image: { data: png.toString('base64'), mediaType: 'image/png' }, model: 'test/image-model', cost: 0.04 };
  };
  const { server: cad, newUserMessage } = cadTools(path.join(dataDir, 'model.js'), (e) => events.push(e), new Set(), base, { meshy: { client, designId: 'test-mesh-00000008', references: [], concepts: true, color: true }, image });
  const tools = toolsOf(cad);
  const out = await tools.generate_concept.handler({ name: 'cat', subject: 'a ginger cat sitting upright', palette: [{ color: '#d07a30', name: 'ginger', parts: 'the whole cat' }] }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  assert.deepEqual(out.content.map((c) => c.type), ['image', 'text']);
  assert.match(out.content[1].text!, /Painting it in colour failed \(The image model is busy\)[\s\S]*colours will come from Meshy/);
  const cat = JSON.parse(base.$concepts).cat;
  assert.equal(cat.color, true);
  assert.equal(cat.painted, undefined);
  assert.ok(events.some((e) => e.type === 'step' && e.step.ok === false && /^Concept colours: The image model is busy – Meshy will paint the model itself$/.test(e.step.text)));
  newUserMessage();
  assert.ok(!(await tools.generate_3d.handler({ name: 'cat', from_concept: 'cat' }, {})).isError);
  assert.equal(created[0].body.should_texture, true);
  assert.equal(created[0].body.texture_image_url, undefined);
});

test('at most 2 generate_3d calls per reply; a call that never reached Meshy does not count; the next message gets a fresh allowance', async () => {
  const events: AgentEvent[] = [];
  const { client, created } = recordingClient();
  const { server: cad, newUserMessage } = cadTools(path.join(dataDir, 'model.js'), (e) => events.push(e), new Set(), {}, { meshy: { client, designId: 'test-mesh-00000006', references: [] } });
  const tools = toolsOf(cad);
  assert.ok((await tools.generate_3d.handler({ name: 'x', prompt: 'a cat OFFLINE' }, {})).isError);
  assert.ok(!(await tools.generate_3d.handler({ name: 'cat', prompt: 'a cat' }, {})).isError);
  assert.ok(!(await tools.generate_3d.handler({ name: 'dog', prompt: 'a dog' }, {})).isError);
  const third = await tools.generate_3d.handler({ name: 'gargoyle', prompt: 'a gargoyle' }, {});
  assert.ok(third.isError);
  assert.match(third.content[0].text!, /already had Meshy make 2 models in this reply[\s\S]*ask the user[\s\S]*25 Meshy credits/);
  assert.equal(created.length, 2);
  assert.ok(events.some((e) => e.type === 'step' && /at most 2 models per reply/.test(e.step.text)));
  newUserMessage();
  assert.ok(!(await tools.generate_3d.handler({ name: 'fox', prompt: 'a fox' }, {})).isError);
  assert.equal(created.length, 3);
});

test('GET /api/meshy/balance: Meshy\'s balance, cached for a minute, asked again after a model; 404 without a key', async () => {
  const { forgetBalance } = await import('../server/meshy');
  delete process.env.MESHY_API_KEY;
  assert.equal((await fetch(`${A}/api/meshy/balance`)).status, 404);
  Object.assign(process.env, { MESHY_API_KEY: 'msy_test', MESHY_BASE_URL: mockBase() });
  try {
    const get = async () => (await (await fetch(`${A}/api/meshy/balance`)).json()) as { balance: number; monthly_credits: number; permanent_credits: number; monthly_resets_at: number };
    const first = await get();
    assert.ok(Number.isFinite(first.balance) && Number.isFinite(first.monthly_credits) && Number.isFinite(first.permanent_credits) && first.monthly_resets_at > Date.now(), JSON.stringify(first));
    // Spent elsewhere: the cached answer stays for a minute, unless the app spent it (forgetBalance).
    await fetch(`${mockBase()}/v2/text-to-3d`, { method: 'POST', headers: { Authorization: 'Bearer msy_x', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'preview', prompt: 'a cat' }) });
    assert.equal((await get()).balance, first.balance);
    forgetBalance();
    assert.equal((await get()).balance, first.balance - 20);
    process.env.MESHY_API_KEY = 'sk-wrong';
    const bad = await fetch(`${A}/api/meshy/balance`);
    assert.equal(bad.status, 502);
    assert.match((await bad.json()).error, /refused the API key/);
  } finally {
    delete process.env.MESHY_API_KEY;
    delete process.env.MESHY_BASE_URL;
    forgetBalance();
  }
});

function readdirNames(id: string) {
  return readdirSync(path.join(dataDir, 'designs', id, 'meshes'));
}
