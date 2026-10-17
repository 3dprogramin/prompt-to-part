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
