import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import Module from 'manifold-3d';
import { importMeshFile } from '../shared/runtime';
import { MeshFormatError, parseMeshFile } from '../shared/meshFormats';
import { decodeMesh, encodeMesh, type MeshData } from '../shared/meshes';
import { decodeTexture } from '../shared/imageDecode';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'meshes');
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

// A separate manifold-3d instance to check results with (the runtime's is locked down).
const wasm = await Module();
wasm.setup();
/** The mesh as a Manifold: throws unless it is a valid closed solid. */
function solid(m: MeshData) {
  const s = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices }));
  assert.equal(s.status(), 'NoError');
  return s;
}
function bounds(p: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) { min[i % 3] = Math.min(min[i % 3], p[i]); max[i % 3] = Math.max(max[i % 3], p[i]); }
  return { min, max, size: [0, 1, 2].map((k) => max[k] - min[k]) };
}

/** A unit-ish box as triangles (outward), for hand-made files. */
function boxTris(s = 10): number[][][] {
  const v = (x: number, y: number, z: number) => [x * s, y * s, z * s];
  const q = (a: number[], b: number[], c: number[], d: number[]) => [[a, b, c], [a, c, d]];
  return [
    ...q(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)), ...q(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)),
    ...q(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)), ...q(v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)),
    ...q(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)), ...q(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)),
  ];
}

test('STL: binary and ASCII', () => {
  const pug = parseMeshFile(fixture('pug.stl'), 'pug.stl');
  assert.equal(pug.indices.length / 3, 644);
  assert.equal(pug.up, 'z');
  const ascii = `solid box\n${boxTris().map((t) => `facet normal 0 0 0\nouter loop\n${t.map((p) => `vertex ${p.join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid box\n`;
  const box = parseMeshFile(strToU8(ascii), 'box.STL');
  assert.equal(box.indices.length / 3, 12);
  const r = importMeshFile(strToU8(ascii), 'box.stl');
  assert.deepEqual(r.report.size.map((x) => +x.toFixed(3)), [10, 10, 10]);
  assert.equal(+r.report.volume.toFixed(3), 1000);
  assert.deepEqual(r.report.repairs, []);
});

test('OBJ: polygons, negative and slashed indices', () => {
  const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nf 1/1/1 2/1/1 3/1/1 4/1/1\nf -4 -2 -1\n';
  const m = parseMeshFile(strToU8(obj), 'quad.obj');
  assert.deepEqual([...m.indices], [0, 1, 2, 0, 2, 3, 0, 2, 3]);
  const fox = parseMeshFile(fixture('fox.obj'), 'fox.obj');
  assert.equal(fox.indices.length / 3, 568);
  assert.equal(fox.up, 'y');
});

test('glTF: GLB and a .gltf with an embedded buffer, node transforms applied', () => {
  const glb = parseMeshFile(fixture('figurine.glb'), 'figurine.glb');
  assert.equal(glb.indices.length / 3, 876);
  assert.equal(glb.mmPerUnit, 1000);
  // A .gltf: one triangle, its node moved 5 along X and mirrored (det < 0 flips the winding back).
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const b64 = Buffer.from(pos.buffer).toString('base64');
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ translation: [5, 0, 0], children: [1] }, { mesh: 0, scale: [-1, 1, 1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${b64}` }],
  };
  const m = parseMeshFile(strToU8(JSON.stringify(gltf)), 'tri.gltf');
  assert.deepEqual([...m.positions], [5, 0, 0, 4, 0, 0, 5, 1, 0]);
  assert.deepEqual([...m.indices], [0, 2, 1]);
  assert.throws(() => parseMeshFile(strToU8(JSON.stringify({ ...gltf, extensionsRequired: ['KHR_draco_mesh_compression'] })), 'd.gltf'), /compression/);
});

test('3MF: units, components and build transforms', () => {
  const r = parseMeshFile(fixture('broken-shells.3mf'), 'shells.3mf');
  assert.equal(r.mmPerUnit, 10);
  assert.equal(r.indices.length / 3, 568 + 8);
  // The ball (object 3 → component 2 lifted 2 cm) is placed 0.5 cm along X by its build item.
  const ballZ = r.positions.slice(-8 * 9).filter((_, i) => i % 3 === 2);
  assert.equal(Math.max(...ballZ), 4);
  const tri = (verts: string) => zipSync({ '3D/3dmodel.model': strToU8(`<model unit="inch"><resources><object id="1"><mesh><vertices>${verts}</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`) });
  assert.equal(parseMeshFile(tri('<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>'), 't.3mf').mmPerUnit, 25.4);
  assert.throws(() => parseMeshFile(strToU8('not a zip'), 'x.3mf'), MeshFormatError);
  assert.throws(() => parseMeshFile(strToU8('solid'), 'x.dae'), MeshFormatError);
});

// ---- crafted files: tiny inputs that claim huge sizes or loop, refused quickly without big allocations
const triGltf = (over: Record<string, unknown> = {}) => {
  const b64 = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64');
  return {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${b64}` }],
    ...over,
  };
};
const gltfFile = (j: unknown) => strToU8(JSON.stringify(j));

test('glTF: accessor counts and offsets are checked before anything is allocated', () => {
  const acc = (a: Record<string, unknown>) => gltfFile(triGltf({ accessors: [{ componentType: 5126, type: 'VEC3', ...a }] }));
  // 500 million vertices of zeros (no buffer view) or claimed from a 36-byte buffer.
  assert.throws(() => parseMeshFile(acc({ count: 500_000_000 }), 'z.gltf'), (e) => e instanceof MeshFormatError && /more than/.test(e.message));
  assert.throws(() => parseMeshFile(acc({ count: 500_000_000, bufferView: 0 }), 'b.gltf'), MeshFormatError);
  for (const count of [-1, 2.5, '3', null]) assert.throws(() => parseMeshFile(acc({ count, bufferView: 0 }), 'c.gltf'), /bad count/);
  assert.throws(() => parseMeshFile(acc({ count: 3, bufferView: 0, byteOffset: -12 }), 'o.gltf'), /bad buffer offsets/);
  assert.throws(() => parseMeshFile(acc({ count: 4, bufferView: 0 }), 'p.gltf'), /runs past/);
  // The view's own length bounds it too, not just the buffer's.
  assert.throws(() => parseMeshFile(gltfFile(triGltf({ bufferViews: [{ buffer: 0, byteLength: 24 }] })), 'v.gltf'), /runs past/);
  assert.equal(parseMeshFile(gltfFile(triGltf()), 'ok.gltf').indices.length, 3);
});

test('glTF: broken GLB JSON, node cycles and fan-out are refused or skipped', () => {
  const json = strToU8('{"asset": nope');
  const glb = new Uint8Array(12 + 8 + json.length);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, glb.length, true);
  dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4e4f534a, true); glb.set(json, 20);
  assert.throws(() => parseMeshFile(glb, 'x.glb'), (e) => e instanceof MeshFormatError && /GLB/.test(e.message));
  assert.throws(() => parseMeshFile(strToU8('null'), 'n.gltf'), MeshFormatError);
  // A node that is its own child (twice): placed once.
  const loop = parseMeshFile(gltfFile(triGltf({ nodes: [{ mesh: 0, children: [0, 0] }] })), 'loop.gltf');
  assert.equal(loop.indices.length, 3);
  // Each node lists the next one twice: 2^40 paths without a cap.
  const nodes = Array.from({ length: 40 }, (_, i) => (i < 39 ? { children: [i + 1, i + 1] } : { mesh: 0 }));
  assert.throws(() => parseMeshFile(gltfFile(triGltf({ nodes })), 'fan.gltf'), /placed parts/);
});

const model3mf = (body: string) => zipSync({ '3D/3dmodel.model': strToU8(body) });
const triObj = (id: number, extra = '') => `<object id="${id}"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/>${extra}</triangles></mesh></object>`;

test('3MF: self-referencing and doubling components, bad triangle indices, single quotes', () => {
  // An object that is its own component, twice: placed once.
  const self = `<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh><components><component objectid="1"/><component objectid="1"/></components></object></resources><build><item objectid="1"/></build></model>`;
  assert.equal(parseMeshFile(model3mf(self), 's.3mf').indices.length, 3);
  // Each object holds the next one twice (2^30 copies without a cap).
  const objs = Array.from({ length: 30 }, (_, i) => `<object id="${i + 1}"><components><component objectid="${i + 2}"/><component objectid="${i + 2}"/></components></object>`).join('') + triObj(31);
  assert.throws(() => parseMeshFile(model3mf(`<model><resources>${objs}</resources><build><item objectid="1"/></build></model>`), 'fan.3mf'), /placed parts/);
  // Negative, fractional and missing indices are skipped (a -1 would reach into another object's vertices).
  const bad = triObj(1, '<triangle v1="-1" v2="1" v3="2"/><triangle v1="0.5" v2="1" v3="2"/><triangle v1="0" v2="1"/>');
  const m = parseMeshFile(model3mf(`<model><resources>${triObj(9)}${bad}</resources><build><item objectid="9"/><item objectid="1"/></build></model>`), 'b.3mf');
  assert.deepEqual([...m.indices], [0, 1, 2, 3, 4, 5]);
  // Single-quoted attributes are read like double-quoted ones.
  const q = parseMeshFile(model3mf(`<model unit='inch'><resources><object id='1'><mesh><vertices><vertex x='0' y='0' z='0'/><vertex x='2' y='0' z='0'/><vertex x='0' y='1' z='0'/></vertices><triangles><triangle v1='0' v2='1' v3='2'/></triangles></mesh></object></resources><build><item objectid='1'/></build></model>`), 'q.3mf');
  assert.equal(q.mmPerUnit, 25.4);
  assert.deepEqual([...q.positions], [0, 0, 0, 2, 0, 0, 0, 1, 0]);
});

test('3MF: zip entries claiming huge sizes, or too many entries, are refused before unpacking', () => {
  const zip = zipSync({ '3D/3dmodel.model': strToU8(`<model><resources>${triObj(1)}</resources><build><item objectid="1"/></build></model>`) }, { level: 0 });
  const find = (sig: number) => { const dv = new DataView(zip.buffer); for (let i = zip.length - 4; i >= 0; i--) if (dv.getUint32(i, true) === sig) return i; return -1; };
  // The central directory says the model unpacks to 300 MB.
  const big = zip.slice();
  new DataView(big.buffer).setUint32(find(0x02014b50) + 24, 300 * 1024 * 1024, true);
  assert.throws(() => parseMeshFile(big, 'big.3mf'), (e) => e instanceof MeshFormatError && /too large/.test(e.message));
  // The end record claims 65,535 entries (only one is there).
  const many = zip.slice();
  const eocd = find(0x06054b50), dv = new DataView(many.buffer);
  dv.setUint16(eocd + 8, 0xffff, true); dv.setUint16(eocd + 10, 0xffff, true);
  assert.throws(() => parseMeshFile(many, 'many.3mf'), (e) => e instanceof MeshFormatError && /files in the archive/.test(e.message));
});

test('PNG textures claiming huge sizes are refused from the header, before decoding', () => {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(png.buffer);
  dv.setUint32(8, 13); dv.setUint32(12, 0x49484452); dv.setUint32(16, 100_000); dv.setUint32(20, 100_000);
  png.set([8, 6, 0, 0, 0], 24);
  assert.throws(() => decodeTexture(png), /too large/);
  assert.throws(() => decodeTexture(png.subarray(0, 20)), /not a valid PNG/);
});

test('every sample becomes a watertight solid, standing on the bed, centred', () => {
  for (const name of ['pug.stl', 'fox.obj', 'figurine.glb', 'fox.glb', 'dog.glb', 'cat.glb', 'fish.glb', 'broken-holes.glb', 'broken-holes.stl', 'broken-flipped.obj', 'broken-soup.stl', 'broken-nonmanifold.obj', 'broken-shells.3mf']) {
    const r = importMeshFile(fixture(name), name);
    const s = solid(r.mesh);
    assert.ok(s.volume() > 0, name);
    assert.ok(Math.abs(s.volume() - r.report.volume) < r.report.volume * 1e-3, name); // float32 positions
    const b = bounds(r.mesh.positions);
    assert.ok(Math.abs(b.min[2]) < 1e-3, `${name} on the bed`);
    assert.ok(Math.abs(b.min[0] + b.max[0]) < 1e-3 && Math.abs(b.min[1] + b.max[1]) < 1e-3, `${name} centred`);
    // A round trip through the stored format keeps it exactly.
    const back = decodeMesh(encodeMesh(r.mesh, { name }));
    assert.deepEqual([...back.indices], [...r.mesh.indices]);
    assert.equal(back.header.name, name);
  }
});

test('repairs are reported in words', () => {
  const holes = importMeshFile(fixture('broken-holes.stl'), 'h.stl').report;
  assert.match(holes.repairs.join('\n'), /Closed 2 holes/);
  const flipped = importMeshFile(fixture('broken-flipped.obj'), 'f.obj').report;
  assert.match(flipped.repairs.join('\n'), /Flipped \d+ inside-out triangles/);
  const soup = importMeshFile(fixture('broken-soup.stl'), 's.stl').report;
  assert.match(soup.repairs.join('\n'), /invalid coordinates[\s\S]*degenerate[\s\S]*duplicate[\s\S]*double-sided/);
  const nm = importMeshFile(fixture('broken-nonmanifold.obj'), 'n.obj').report;
  assert.match(nm.repairs.join('\n'), /non-manifold edge/);
  // The cubes that only touched stay separate solids; the fin is gone.
  assert.equal(nm.components, 3);
  assert.equal(+nm.volume.toFixed(0), 3 * 8000);
  const shells = importMeshFile(fixture('broken-shells.3mf'), 's.3mf').report;
  assert.match(shells.repairs.join('\n'), /Converted to millimetres \(×10\)/);
  assert.equal(shells.components, 1);
});

test('a single open sheet is refused with a clear message', () => {
  assert.throws(() => importMeshFile(fixture('open-sheet.stl'), 'sheet.stl', { resolution: 60 }), /encloses no volume/);
});

test('units and up axis: Y-up files stand up, unit-less ones get a sensible size', () => {
  const fig = importMeshFile(fixture('figurine.glb'), 'figurine.glb').report;
  // The figurine (arms out) is 1.1 units wide: its longest side becomes 80 mm, and it stands in Z.
  assert.equal(Math.round(fig.size[0]), 80);
  assert.ok(fig.size[2] > 50 && fig.size[1] < 40, `${fig.size}`);
  assert.match(fig.repairs.join('\n'), /Y-up to Z-up[\s\S]*No usable units/);
  const sized = importMeshFile(fixture('fox.glb'), 'fox.glb', { defaultHeight: 40 }).report;
  assert.equal(Math.round(Math.max(...sized.size)), 40);
  // An STL in millimetres keeps its size.
  const pug = importMeshFile(fixture('pug.stl'), 'pug.stl').report.size;
  assert.ok(Math.abs(pug[1] - 60) < 1e-3 && Math.abs(pug[0] - 24.9) < 0.1 && Math.abs(pug[2] - 45.5) < 0.1, `${pug}`);
});

test('heavy meshes are simplified to the budget; the grid rebuild makes anything solid', () => {
  const r = importMeshFile(fixture('cat.glb'), 'cat.glb', { maxTriangles: 1000 });
  assert.ok(r.report.triangles <= 1000, `${r.report.triangles}`);
  assert.match(r.report.repairs.join('\n'), /Simplified from 1,400 triangles/);
  solid(r.mesh);
  const g = importMeshFile(fixture('broken-holes.glb'), 'b.glb', { rebuild: true, resolution: 60 });
  assert.ok(g.report.rebuilt);
  assert.match(g.report.repairs.join('\n'), /Rebuilt as a watertight solid on a 1\.\d+ mm grid/);
  const s = solid(g.mesh);
  // About the same volume as the repaired cat (within the grid's resolution).
  const cat = importMeshFile(fixture('cat.glb'), 'cat.glb').report.volume;
  assert.ok(Math.abs(s.volume() - cat) / cat < 0.1, `${s.volume()} vs ${cat}`);
});
