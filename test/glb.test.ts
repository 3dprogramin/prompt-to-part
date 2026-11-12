import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGlb, isFlat } from '../src/lib/glb';
import type { PartMesh } from '../shared/types';

function box(name: string, [x0, y0, z0]: [number, number, number], [sx, sy, sz]: [number, number, number], color: string): PartMesh {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(([x, y, z]) => [x0 + x * sx, y0 + y * sy, z0 + z * sz]);
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { name, color, positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()), bbox: { min: [x0, y0, z0], max: [x0 + sx, y0 + sy, z0 + sz] }, volume: sx * sy * sz, surfaceArea: 0, triCount: 12, genus: 0, components: 1 };
}

interface Gltf {
  asset: { version: string };
  meshes: { name: string; primitives: { attributes: Record<string, number>; material: number; indices?: number }[] }[];
  materials: { pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number } }[];
  accessors: { min?: number[]; max?: number[]; count: number }[];
  nodes: { mesh?: number }[];
}

/** The GLB's JSON chunk, after checking the container (magic, version, length, chunk types). */
async function read(blob: Blob): Promise<{ json: Gltf; bytes: number }> {
  const buf = await blob.arrayBuffer();
  const dv = new DataView(buf);
  assert.equal(dv.getUint32(0, true), 0x46546c67, 'magic glTF');
  assert.equal(dv.getUint32(4, true), 2, 'version 2');
  assert.equal(dv.getUint32(8, true), buf.byteLength, 'length in the header');
  const jsonLen = dv.getUint32(12, true);
  assert.equal(dv.getUint32(16, true), 0x4e4f534a, 'JSON chunk');
  assert.equal(jsonLen % 4, 0);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen))) as Gltf;
  assert.equal(dv.getUint32(20 + jsonLen + 4, true), 0x004e4942, 'BIN chunk');
  return { json, bytes: buf.byteLength };
}

/** Extent of the whole model along x, y, z (metres), from the POSITION accessors' min/max. */
function extent(g: Gltf) {
  const pos = g.meshes.flatMap((m) => m.primitives.map((p) => g.accessors[p.attributes.POSITION]));
  const min = [0, 1, 2].map((k) => Math.min(...pos.map((a) => a.min![k])));
  const max = [0, 1, 2].map((k) => Math.max(...pos.map((a) => a.max![k])));
  return { min, max, size: max.map((v, k) => v - min[k]) };
}
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test('GLB: one mesh per part, each in its filament colour (linear), matte plastic', async () => {
  const { json } = await read(toGlb([box('Base', [0, 0, 0], [20, 20, 5], '#ff0000'), box('Text', [5, 5, 5], [10, 10, 2], '#1c2c5a')], 'Sign', { upright: false }));
  assert.equal(json.asset.version, '2.0');
  assert.deepEqual(json.meshes.map((m) => m.name), ['Base', 'Text']);
  const [red, navy] = json.meshes.map((m) => json.materials[m.primitives[0].material].pbrMetallicRoughness);
  assert.deepEqual(red.baseColorFactor, [1, 0, 0, 1]);
  near(navy.baseColorFactor[2], 0.10224); // 0x5a in linear
  assert.equal(red.metallicFactor, 0);
  assert.ok(red.roughnessFactor >= 0.6, 'matte');
});

test('GLB: real size in metres, standing on the ground, centred', async () => {
  const { json } = await read(toGlb([box('Cup', [100, 100, 0], [80, 60, 100], '#ffffff')], 'Cup', { upright: false }));
  const e = extent(json);
  // Lying as printed: model Z (height) is glTF's Y (up).
  near(e.size[0], 0.08); near(e.size[1], 0.1); near(e.size[2], 0.06);
  near(e.min[1], 0);
  near(e.min[0] + e.max[0], 0); near(e.min[2] + e.max[2], 0);
});

test('GLB upright: a flat piece stands with its face to the front, as on a wall', async () => {
  const { json } = await read(toGlb([box('Plaque', [0, 0, 0], [200, 100, 4], '#ffffff')], 'Plaque', { upright: true }));
  const e = extent(json);
  // Its width stays x, its drawing's up (model Y) is up, its thickness comes towards the viewer.
  near(e.size[0], 0.2); near(e.size[1], 0.1); near(e.size[2], 0.004);
  near(e.min[1], 0);
});

test('GLB: painted parts and LayerTone parts keep their colours per vertex', async () => {
  const painted = box('Figure', [0, 0, 0], [10, 10, 10], '#808080');
  painted.paint = { filaments: [{ color: '#ff0000' }, { color: '#0000ff' }] as never, tri: new Uint8Array(12).map((_, i) => i % 2) };
  const relief = box('Relief', [20, 0, 0], [10, 10, 2], '#ffffff');
  relief.vertexColors = new Float32Array(relief.positions.length).fill(0.5);
  const plain = box('Plain', [40, 0, 0], [10, 10, 10], '#00ff00');
  const { json } = await read(toGlb([painted, relief, plain], 'Mix', { upright: false }));
  const attrs = json.meshes.map((m) => m.primitives[0].attributes);
  assert.ok('COLOR_0' in attrs[0], 'painted');
  assert.ok('COLOR_0' in attrs[1], 'LayerTone');
  assert.ok(!('COLOR_0' in attrs[2]), 'plain part uses its material colour');
  // A per-vertex part's material is white, so the colours show as they are.
  assert.deepEqual(json.materials[json.meshes[1].primitives[0].material].pbrMetallicRoughness.baseColorFactor, [1, 1, 1, 1]);
});

test('isFlat: plaques and line art are flat, cups and stands are not', () => {
  assert.equal(isFlat([box('Plaque', [0, 0, 0], [200, 100, 4], '#fff')]), true);
  assert.equal(isFlat([box('Cup', [0, 0, 0], [80, 80, 100], '#fff')]), false);
});
