import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateScript, importMeshFile, ScriptError } from '../shared/runtime';
import { freeMeshName, MAX_CONCEPTS, MeshMissingError, MESHES_KEY, parseConcepts, parseMeshes, registerMesh, rehomeConcepts, rehomeMeshes, withConcept, withMeshes, type MeshEntry } from '../shared/meshes';

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, 'fixtures', 'meshes', name)));
const URL_A = '/api/designs/test-mesh-0000001/meshes/0123456789abcdef0123456789abcdef.bin';
const URL_B = '/api/designs/test-mesh-0000001/meshes/fedcba9876543210fedcba9876543210.bin';
const pug = importMeshFile(fixture('pug.stl'), 'pug.stl');
registerMesh(URL_A, pug.mesh);
const entry = (file: string): MeshEntry => ({ file, triangles: pug.report.triangles, size: pug.report.size, source: 'upload', original: 'pug.stl' });
const values = { [MESHES_KEY]: JSON.stringify({ pug: entry(URL_A), missing: entry(URL_B) }) };
const run = (build: string, extra = {}) => evaluateScript(`const params = {}; function build(p) { ${build} }`, { ...values, ...extra }, 'normal');
const size = (r: ReturnType<typeof run>) => [0, 1, 2].map((k) => +(r.bbox!.max[k] - r.bbox!.min[k]).toFixed(2));

test('H.mesh gives the stored solid, scaled and turned as asked', () => {
  const asIs = run('return H.mesh("pug");');
  assert.deepEqual(size(asIs), pug.report.size.map((x) => +x.toFixed(2)));
  assert.equal(asIs.parts[0].components, 1);
  assert.ok(Math.abs(asIs.bbox!.min[2]) < 1e-4);
  assert.equal(size(run('return H.mesh("pug", { height: 30 });'))[2], 30);
  assert.equal(size(run('return H.mesh("pug", { width: 10 });'))[0], 10);
  assert.equal(size(run('return H.mesh("pug", { size: 100 });'))[1], 100);
  assert.equal(size(run('return H.mesh("pug", { scale: 2 });'))[1], 120);
  // Laid on its side, then stood on the bed again (and centred).
  const turned = run('return H.mesh("pug", { rotate: [90, 0, 0] });');
  const t = size(turned);
  assert.ok(Math.abs(t[0] - 24.9) < 0.1 && Math.abs(t[1] - 45.5) < 0.1 && Math.abs(t[2] - 60) < 1e-3, `${t}`);
  assert.ok(Math.abs(turned.bbox!.min[2]) < 1e-4 && Math.abs(turned.bbox!.min[1] + turned.bbox!.max[1]) < 1e-3);
  const kept = run('return H.mesh("pug", { rotate: [90, 0, 0], center: false });');
  assert.ok(kept.bbox!.min[2] < -1);
});

test('remixing a mesh: a base, a hole and a cut', () => {
  const r = run(`
    const fig = H.mesh("pug", { height: 40 }).translate([0, 0, 2.5]);
    const base = Manifold.cylinder(3, 30, 30, 64);
    const hole = Manifold.cylinder(10, 3, 3, 24).translate([0, 0, -1]);
    return Manifold.union([fig, base]).subtract(hole).trimByPlane([0, 0, 1], 0.5);`);
  assert.equal(r.parts[0].components, 1);
  assert.equal(+r.bbox!.min[2].toFixed(3), 0.5);
  assert.equal(+r.bbox!.max[2].toFixed(2), 42.5);
});

test('a mesh not loaded yet is asked for (not wrapped as a script error); a wrong name is', async () => {
  assert.throws(() => run('return H.mesh("missing");'), (e) => e instanceof MeshMissingError && e.url === URL_B);
  assert.throws(() => run('return H.mesh("nope");'), (e) => e instanceof ScriptError && /no mesh named "nope" \(meshes: "pug", "missing"\)/.test(e.message));
  assert.throws(() => run('return H.mesh("pug", { height: 10, width: 5 });'), /one of height, width/);
  assert.throws(() => run('return H.mesh("pug", { height: -1 });'), /height must be > 0/);
  // withMeshes loads what is missing and runs it again; a file that is gone is an error with a line.
  const loads: string[] = [];
  const r = await withMeshes(() => run('return [H.mesh("pug"), H.mesh("missing").translate([80, 0, 0])];'), async (url) => { loads.push(url); return pug.mesh; });
  assert.deepEqual(loads, [URL_B]);
  assert.equal(r.parts.length, 2);
  const gone = '/api/designs/test-mesh-0000001/meshes/00000000000000000000000000000000.bin';
  await assert.rejects(withMeshes(() => run('return H.mesh("x");', { [MESHES_KEY]: JSON.stringify({ x: entry(gone) }) }), async () => { throw new Error('the file is missing'); }), /couldn't be loaded: the file is missing/);
});

test('the kept mesh survives evaluations, and lite and draft evaluations work', () => {
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) assert.equal(run(`return H.mesh("pug", { height: ${20 + i} });`).parts.length, 1);
  assert.ok(performance.now() - t0 < 5000);
  const lite = evaluateScript('const params = {}; function build() { return H.mesh("pug"); }', values, 'draft', { lite: true });
  assert.equal(lite.parts[0].triCount, 0);
  assert.ok(lite.bbox!.max[2] > 45);
  // Scripts only get copies of the kept mesh: deleting or changing one doesn't touch it.
  assert.throws(() => run('const m = H.mesh("pug"); m.translate = () => 1; return m.translate();'));
  assert.throws(() => run('const m = H.mesh("pug"); m.delete(); return m;'));
  assert.equal(run('return H.mesh("pug");').parts.length, 1);
});

test('the mesh index is checked; names and fork copies', () => {
  const ok = entry(URL_A);
  const parsed = parseMeshes(JSON.stringify({ good: ok, 'bad name!': ok, evil: { ...ok, file: '/etc/passwd' }, other: { ...ok, file: '/api/designs/x/meshes/../../a.bin' } }));
  assert.deepEqual(Object.keys(parsed), ['good']);
  assert.equal(freeMeshName('My Dragon (final).stl', {}), 'My-Dragon-final');
  assert.equal(freeMeshName('fox.glb', { fox: 1, 'fox-2': 1 }), 'fox-3');
  const moved = parseMeshes(rehomeMeshes(JSON.stringify({ pug: { ...ok, preview: '/api/designs/test-mesh-0000001/meshes/0123456789abcdef0123456789abcdef.png' } }), 'new-design-00000002'));
  assert.equal(moved.pug.file, '/api/designs/new-design-00000002/meshes/0123456789abcdef0123456789abcdef.bin');
  assert.equal(moved.pug.preview, '/api/designs/new-design-00000002/meshes/0123456789abcdef0123456789abcdef.png');
  assert.equal(rehomeMeshes(undefined, 'new-design-00000002'), undefined);
});

test('the concept picture index: checked, newest last, at most MAX_CONCEPTS, fork copies', () => {
  const pic = (n: number) => ({ image: `/api/designs/test-mesh-0000001/meshes/${n.toString(16).padStart(32, '0')}.png`, subject: `figure ${n}`, createdAt: n });
  assert.deepEqual(Object.keys(parseConcepts(JSON.stringify({ a: pic(1), b: { ...pic(2), image: '/etc/passwd' }, c: { ...pic(3), image: pic(3).image.replace('.png', '.bin') } }))), ['a']);
  let raw = '';
  for (let i = 0; i < MAX_CONCEPTS + 2; i++) raw = withConcept(raw, `c${i}`, pic(i));
  raw = withConcept(raw, 'c5', pic(99));
  const names = Object.keys(parseConcepts(raw));
  assert.equal(names.length, MAX_CONCEPTS);
  assert.equal(names.at(-1), 'c5');
  assert.ok(!names.includes('c0') && !names.includes('c1'));
  assert.match(parseConcepts(rehomeConcepts(raw, 'new-design-00000002')).c5.image, /^\/api\/designs\/new-design-00000002\/meshes\/0{30}63\.png$/);
  // A coloured concept's painted picture: checked like the grey one, kept by withConcept, moved by a fork.
  const painted = pic(7).image.replace('.png', '.webp');
  raw = withConcept(raw, 'kid', { ...pic(5), painted, color: true });
  raw = withConcept(raw, 'bad', { ...pic(6), painted: '/etc/passwd' });
  assert.equal(parseConcepts(raw).kid.painted, painted);
  assert.equal(parseConcepts(raw).bad.painted, undefined);
  const forked = parseConcepts(rehomeConcepts(raw, 'new-design-00000002')).kid;
  assert.match(forked.image, /^\/api\/designs\/new-design-00000002\/meshes\/0{31}5\.png$/);
  assert.match(forked.painted!, /^\/api\/designs\/new-design-00000002\/meshes\/0{31}7\.webp$/);
  assert.equal(forked.color, true);
});
