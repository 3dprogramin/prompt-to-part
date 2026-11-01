import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

// The API on a free port with its own data folder (as in api.test.ts).
const root = mkdtempSync(path.join(os.tmpdir(), 'jig-backup-test-'));
const dataDir = path.join(root, 'data');
process.env.JIG_DATA = dataDir;
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const { createApp } = await import('../server/app');
server.on('request', createApp({ port }));
after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

const A = `http://127.0.0.1:${port}`;
const W = { 'Content-Type': 'application/json', 'X-Jig': '1' };
const ID1 = 'test-bkp-00000001', ID2 = 'test-bkp-00000002';
const design = (extra: Record<string, unknown> = {}) => ({ id: ID1, name: 'Hook', createdAt: 1, updatedAt: 1000, messages: [], versions: [], currentVersion: -1, code: 'x', values: {}, ...extra });
const put = (d: { id: string; [k: string]: unknown }) => fetch(`${A}/api/designs/${d.id}`, { method: 'PUT', headers: W, body: JSON.stringify(d) });
const getDesign = async (id: string) => (await fetch(`${A}/api/designs/${id}`)).json();
const importZip = (zip: Uint8Array, headers: Record<string, string> = { 'X-Jig': '1' }) => fetch(`${A}/api/backup/import`, { method: 'POST', headers: { 'Content-Type': 'application/zip', ...headers }, body: Buffer.from(zip) });
const exportZip = async () => new Uint8Array(await (await fetch(`${A}/api/backup`)).arrayBuffer());
/** Status of a GET to /api/backup with these headers (fetch() won't send some of them). */
const statusWith = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
  request({ host: '127.0.0.1', port, path: '/api/backup', headers }, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject).end();
});
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const MESH_NAME = `${'ab'.repeat(16)}.bin`;
const MESH = new Uint8Array(300_000).map((_, i) => (i * 7919) % 251);
let imageUrl = '';

test('export: every design with its images and meshes, and the settings, as one zip', async () => {
  assert.equal((await put(design())).status, 200);
  assert.equal((await put(design({ id: ID2, name: 'Box', updatedAt: 2000 }))).status, 200);
  ({ url: imageUrl } = await (await fetch(`${A}/api/designs/${ID1}/images`, { method: 'POST', headers: W, body: JSON.stringify({ mediaType: 'image/png', data: PNG.toString('base64') }) })).json());
  // A stored mesh as server/meshes.ts keeps it (importing a real one needs the geometry worker).
  mkdirSync(path.join(dataDir, 'designs', ID1, 'meshes'), { recursive: true });
  writeFileSync(path.join(dataDir, 'designs', ID1, 'meshes', MESH_NAME), MESH);
  assert.equal((await fetch(`${A}/api/cost/settings`, { method: 'PUT', headers: W, body: JSON.stringify({ filamentPerKg: 110 }) })).status, 200);
  assert.equal((await fetch(`${A}/api/filaments/mine`, { method: 'PUT', headers: W, body: JSON.stringify({ filaments: [{ name: 'PLA Basic Black', brand: 'Bambu Lab', color: '#000000', td: 0.5 }] }) })).status, 200);
  // Not part of a backup: workspaces and caches.
  mkdirSync(path.join(dataDir, 'workspaces', ID1), { recursive: true });
  writeFileSync(path.join(dataDir, 'workspaces', ID1, 'model.js'), 'x');

  const r = await fetch(`${A}/api/backup`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename="jig-designs-\d{4}-\d\d-\d\d\.zip"$/);
  const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), [
    'cost.json', `designs/${ID1}.json`, `designs/${ID1}/${imageUrl.split('/').pop()}`, `designs/${ID1}/meshes/${MESH_NAME}`, `designs/${ID2}.json`, 'filaments.json',
  ].sort());
  assert.deepEqual(files[`designs/${ID1}/meshes/${MESH_NAME}`], MESH);
  assert.equal(JSON.parse(Buffer.from(files[`designs/${ID2}.json`]).toString()).name, 'Box');
});

test('export: only from Jig\'s own page', async () => {
  assert.equal(await statusWith({ Host: `evil.com:${port}` }), 421);
  assert.equal(await statusWith({ Origin: 'https://evil.com' }), 403);
  assert.equal(await statusWith({ 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.equal(await statusWith({ 'Sec-Fetch-Site': 'same-site' }), 403);
  assert.equal(await statusWith({ 'Sec-Fetch-Site': 'same-origin' }), 200);
  assert.equal((await importZip(zipSync({}), {})).status, 403); // no X-Jig
});

test('import into an empty data folder brings everything back; ids already here are kept', async () => {
  const zip = await exportZip();
  const before = { d1: await getDesign(ID1), d2: await getDesign(ID2) };
  for (const f of ['designs', 'cost.json', 'filaments.json']) rmSync(path.join(dataDir, f), { recursive: true, force: true });
  assert.deepEqual(await (await fetch(`${A}/api/designs`)).json(), []);

  const r = await importZip(zip);
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual(out.imported.map((d: { name: string }) => d.name).sort(), ['Box', 'Hook']);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.settings.sort(), ['My filaments', 'cost settings']);
  assert.deepEqual(await getDesign(ID1), before.d1);
  assert.deepEqual(await getDesign(ID2), before.d2);
  assert.deepEqual(Buffer.from(await (await fetch(A + imageUrl)).arrayBuffer()), PNG);
  assert.deepEqual(new Uint8Array(await (await fetch(`${A}/api/designs/${ID1}/meshes/${MESH_NAME}`)).arrayBuffer()), MESH);
  assert.deepEqual(await (await fetch(`${A}/api/cost/settings`)).json(), { filamentPerKg: 110 });
  assert.equal((await (await fetch(`${A}/api/filaments/mine`)).json()).filaments[0].name, 'PLA Basic Black');
  assert.equal(existsSync(path.join(dataDir, 'workspaces', ID1, 'model.js')), true); // untouched
  assert.deepEqual(readdirSync(dataDir).filter((f) => f.startsWith('.backup-import-')), []);

  // Again, after changing one here: nothing is overwritten (not even by a newer copy), and the settings stay.
  assert.equal((await put(design({ rev: before.d1.rev, name: 'Hook (edited)', updatedAt: 1 }))).status, 200);
  await fetch(`${A}/api/cost/settings`, { method: 'PUT', headers: W, body: JSON.stringify({ filamentPerKg: 90 }) });
  const again = await (await importZip(zip)).json();
  assert.deepEqual(again.imported, []);
  assert.deepEqual(again.skipped.map((s: { id: string; reason: string }) => [s.id, s.reason]).sort(), [[ID1, 'already here (kept as it is)'], [ID2, 'already here (kept as it is)']]);
  assert.deepEqual(again.settings, []);
  assert.equal((await getDesign(ID1)).name, 'Hook (edited)');
  assert.deepEqual(await (await fetch(`${A}/api/cost/settings`)).json(), { filamentPerKg: 90 });

  // A design deleted here can be brought back, and takes uploads again.
  assert.equal((await fetch(`${A}/api/designs/${ID2}`, { method: 'DELETE', headers: W })).status, 200);
  assert.deepEqual((await (await importZip(zip)).json()).imported, [{ id: ID2, name: 'Box' }]);
  assert.equal((await fetch(`${A}/api/designs/${ID2}/images`, { method: 'POST', headers: W, body: JSON.stringify({ mediaType: 'image/png', data: PNG.toString('base64') }) })).status, 200);
});

test('import: paths outside the backup\'s layout refuse the whole zip', async () => {
  const id = 'test-bkp-00000003';
  const good: Zippable = { [`designs/${id}.json`]: strToU8(JSON.stringify(design({ id }))) };
  for (const bad of [
    '../evil.json', `designs/../../evil.json`, `designs/${id}/../../../evil.json`, '/evil.json', `designs\\..\\..\\evil.json`,
    `designs/${id}/meshes/../../../../evil.json`, `designs/${id}/evil.png`, `designs/${id}/meshes/model.stl`, `workspaces/${id}/model.js`,
    'bambu/template.json', 'designs/short.json', `designs/${id}/meshes/sub/${MESH_NAME}`,
  ]) {
    const r = await importZip(zipSync({ ...good, [bad]: strToU8('{}') }));
    assert.equal(r.status, 400, bad);
    assert.match((await r.json()).error, /Not a Jig backup/, bad);
  }
  assert.equal(existsSync(path.join(root, 'evil.json')), false);
  assert.equal(existsSync(path.join(dataDir, 'evil.json')), false);
  assert.equal((await fetch(`${A}/api/designs/${id}`)).status, 404, 'nothing of a refused zip is imported');
  // Folder entries are fine.
  const ok = await (await importZip(zipSync({ designs: {}, ...good }))).json();
  assert.deepEqual(ok.imported, [{ id, name: 'Hook' }]);
});

test('import: damaged zips and designs', async () => {
  assert.equal((await importZip(strToU8('not a zip'))).status, 400);
  const id = 'test-bkp-00000004';
  // A design whose id doesn't match its file, and one that isn't a design.
  const mismatched = await (await importZip(zipSync({ [`designs/${id}.json`]: strToU8(JSON.stringify(design({ id: 'test-bkp-00000099' }))), 'designs/test-bkp-00000005.json': strToU8('{"id":1') }))).json();
  assert.deepEqual(mismatched.imported, []);
  assert.deepEqual(mismatched.skipped.map((s: { reason: string }) => s.reason).sort(), ['not a complete design', 'not a design']);
  // A mesh file damaged in the zip (stored, so its bytes can be changed): the design is not imported.
  const zip = zipSync({ [`designs/${id}.json`]: strToU8(JSON.stringify(design({ id }))), [`designs/${id}/meshes/${MESH_NAME}`]: [MESH, { level: 0 }] });
  const at = Buffer.from(zip).indexOf(Buffer.from(MESH.subarray(1000, 1032)));
  zip[at] ^= 0xff;
  const damaged = await (await importZip(zip)).json();
  assert.deepEqual(damaged.skipped.map((s: { id: string; reason: string }) => [s.id, s.reason]), [[id, `designs/${id}/meshes/${MESH_NAME} is damaged`]]);
  assert.equal((await fetch(`${A}/api/designs/${id}`)).status, 404);
  assert.equal(existsSync(path.join(dataDir, 'designs', id, 'meshes', MESH_NAME)), false);
});

test('a zipped project ("Export project…") brings back its design, pictures and meshes; nothing else in it is written', async () => {
  const id = 'test-bkp-00000007', other = 'test-bkp-00000008';
  const IMG = `${'cd'.repeat(16)}.png`;
  const project = (dir: string, extra: Zippable = {}): Uint8Array => zipSync({
    [`${dir}design.jig.json`]: strToU8(JSON.stringify(design({ id, name: 'Project hook' }))),
    [`${dir}images/${IMG}`]: PNG,
    [`${dir}images/picture-photo.png`]: PNG,
    [`${dir}meshes/${MESH_NAME}`]: MESH,
    [`${dir}model.js`]: strToU8('x'),
    [`${dir}project-hook.stl`]: strToU8('solid'),
    [`${dir}README.md`]: strToU8('# Project hook'),
    [`${dir}images/../../evil.json`]: strToU8('{}'),
    [`${dir}meshes/sub/${MESH_NAME}`]: MESH,
    [`${dir}designs/${other}.json`]: strToU8(JSON.stringify(design({ id: other }))),
    'evil.json': strToU8('{}'),
    ...extra,
  });
  const r = await importZip(project('Project hook/'));
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).imported, [{ id, name: 'Project hook' }]);
  assert.equal((await getDesign(id)).name, 'Project hook');
  assert.deepEqual(await (await fetch(`${A}/api/designs/${id}/files`)).json(), { images: [IMG], meshes: [MESH_NAME] });
  assert.equal((await fetch(`${A}/api/designs/${id}/images/${IMG}`)).status, 200);
  assert.equal((await fetch(`${A}/api/designs/${other}`)).status, 404, 'a project is one design');
  for (const f of [path.join(root, 'evil.json'), path.join(dataDir, 'evil.json'), path.join(dataDir, 'designs', 'evil.json')]) assert.equal(existsSync(f), false, f);

  // Zipped without its folder too; a design already here is kept.
  const again = await (await importZip(project(''))).json();
  assert.deepEqual(again.skipped.map((s: { id: string }) => s.id), [id]);
  // Two projects in one zip are neither a project nor a backup.
  assert.equal((await importZip(project('a/', { 'b/design.jig.json': strToU8('{}') }))).status, 400);
  // The design's own id must be a valid one.
  const bad = await (await importZip(zipSync({ 'x/design.jig.json': strToU8(JSON.stringify(design({ id: '../../evil' }))) }))).json();
  assert.deepEqual(bad.imported, []);
  assert.equal(bad.skipped[0].reason, 'not a complete design');
  assert.equal((await fetch(`${A}/api/designs/bad!id/files`)).status, 400);
});

test('design tags go into a backup and come back for designs that have none here', async () => {
  const ID3 = 'test-bkp-00000003', ID4 = 'test-bkp-00000004';
  const tag = (id: string, tags: string[]) => fetch(`${A}/api/designs/${id}/tags`, { method: 'PUT', headers: W, body: JSON.stringify({ tags }) });
  const tagsOf = async () => Object.fromEntries(((await (await fetch(`${A}/api/designs`)).json()) as { id: string; tags?: string[] }[]).map((d) => [d.id, d.tags]));
  assert.equal((await put(design({ id: ID3 }))).status, 200);
  assert.equal((await put(design({ id: ID4 }))).status, 200);
  assert.equal((await tag(ID3, ['Product'])).status, 200);
  assert.equal((await tag(ID4, ['temp', 'Ornamente'])).status, 200);
  const zip = await exportZip();
  assert.deepEqual(JSON.parse(Buffer.from(unzipSync(zip)['tags.json']).toString()).tags[ID4], ['Temp', 'Ornamente']);
  // ID4 is deleted (its tags go with it) and ID3 retagged here: the import brings ID4 back with its tags, ID3 keeps its own.
  assert.equal((await fetch(`${A}/api/designs/${ID4}`, { method: 'DELETE', headers: W })).status, 200);
  assert.equal((await tagsOf())[ID4], undefined);
  assert.equal((await tag(ID3, ['Ornamente'])).status, 200);
  const out = await (await importZip(zip)).json();
  assert.deepEqual(out.imported.map((x: { id: string }) => x.id), [ID4]);
  assert.ok(out.settings.includes('design tags'));
  const tags = await tagsOf();
  assert.deepEqual([tags[ID3], tags[ID4]], [['Ornamente'], ['Temp', 'Ornamente']]);
});

test('a backup restores the printer choice where none is saved, and the server follows it', async () => {
  const file = path.join(dataDir, 'printer.json');
  rmSync(file, { force: true });
  // A damaged one is left out.
  await importZip(zipSync({ 'printer.json': strToU8(JSON.stringify({ filaments: [] })) }));
  assert.equal(existsSync(file), false);
  const r = await (await importZip(zipSync({ 'printer.json': strToU8(JSON.stringify({ printerId: 'Bambu Lab P1S 0.4 nozzle', filaments: 40 })) }))).json();
  assert.ok(r.settings.includes('printer'), JSON.stringify(r));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { printerId: 'Bambu Lab P1S 0.4 nozzle', filaments: 16 });
  const info = await (await fetch(`${A}/api/printer`)).json();
  assert.equal(info.printer.name, 'Bambu Lab P1S');
});
