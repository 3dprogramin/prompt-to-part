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
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jig-mesh-test-'));
process.env.JIG_DATA = dataDir;
const { createApp } = await import('../server/app');
const { geometry, formatReport } = await import('../server/geometry');
const { cadTools } = await import('../server/cadTools');
const { createMeshyMock } = await import('../server/meshyMock');
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as AddressInfo).port;
server.on('request', createApp({ port }));
const mock = createMeshyMock({ pendingMs: 200, runMs: 800 });
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
after(() => { server.close(); mock.close(); geometry.stop(); rmSync(dataDir, { recursive: true, force: true }); });

const A = `http://127.0.0.1:${port}`;
const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', 'meshes', name));
const upload = (id: string, name: string, body: Uint8Array) => fetch(`${A}/api/designs/${id}/meshes?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-Jig': '1', 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(body) });
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
  // Writes need X-Jig, like every other write.
  assert.equal((await fetch(`${A}/api/designs/${ID}/meshes?name=a.stl`, { method: 'POST', body: fixture('pug.stl') })).status, 403);
  for (const name of ['../x.bin', 'abc.bin', `${'0'.repeat(32)}.exe`]) assert.notEqual((await fetch(`${A}/api/designs/${ID}/meshes/${encodeURIComponent(name)}`)).status, 200, name);
});

test('a design started from a version gets its own copies; deleting a design deletes its meshes', async () => {
  const u = await (await upload('test-mesh-00000002', 'fox.glb', fixture('fox.glb'))).json() as MeshUpload;
  const copy = await fetch(`${A}/api/designs/test-mesh-00000003/meshes/copy`, { method: 'POST', headers: { 'X-Jig': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'test-mesh-00000002' }) });
  assert.equal(copy.status, 200);
  assert.equal((await copy.json()).copied, 3);
  assert.equal((await fetch(A + u.entry.file.replace('00000002', '00000003'))).status, 200);
  const del = await fetch(`${A}/api/designs/test-mesh-00000002`, { method: 'DELETE', headers: { 'X-Jig': '1' } });
  assert.equal(del.status, 200);
  assert.equal((await fetch(A + u.entry.file)).status, 404);
  assert.equal((await fetch(A + u.entry.file.replace('00000002', '00000003'))).status, 200);
  assert.equal((await upload('test-mesh-00000002', 'fox.glb', fixture('fox.glb'))).status, 410);
  const bad = await fetch(`${A}/api/designs/test-mesh-00000003/meshes/copy`, { method: 'POST', headers: { 'X-Jig': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ from: '../etc' }) });
  assert.equal(bad.status, 400);
});

test('generate_3d: Meshy (the mock) makes a model, Jig repairs and stores it, Claude gets a render', async () => {
  const events: AgentEvent[] = [];
  const base: Record<string, string> = {};
  const client = { key: 'msy_test', baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/openapi`, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50))) };
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

function readdirNames(id: string) {
  return readdirSync(path.join(dataDir, 'designs', id, 'meshes'));
}
