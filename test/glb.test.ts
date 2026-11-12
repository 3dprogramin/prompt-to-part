import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGlb, isFlat } from '../src/lib/glb';
import jpeg from 'jpeg-js';
import type { PartMesh } from '../shared/types';
import { layerToneMesh, resolveLayerToneOptions, toLayerToneImage, vertexColors as layerToneVertexColors, type LayerColor, type LayerToneImage } from '../shared/layertone';
import { lithophaneMesh, lithoVertexColors, resolveLithoOptions } from '../shared/lithophane';

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
async function read(blob: Blob | Promise<Blob>): Promise<{ json: Gltf; bytes: number }> {
  const buf = await (await blob).arrayBuffer();
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

test('GLB: a degenerate triangle never gets a zero-length normal', async () => {
  const p = box('Gold', [0, 0, 0], [10, 10, 2], '#d4af37');
  // A zero-area sliver (two corners at the same point), as booleans leave on line art.
  const pos = new Float32Array([...p.positions, 5, 5, 2, 5, 5, 2, 6, 5, 2]);
  const idx = new Uint32Array([...p.indices, 8, 9, 10]);
  p.positions = pos; p.indices = idx;
  const blob = await toGlb([p], 'Sliver', { upright: true });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const { json } = await read(blob);
  const acc = json.accessors[json.meshes[0].primitives[0].attributes.NORMAL] as unknown as { bufferView: number; count: number };
  const view = (json as unknown as { bufferViews: { byteOffset: number }[] }).bufferViews[acc.bufferView];
  const jsonLen = new DataView(buf.buffer).getUint32(12, true);
  const n = new Float32Array(buf.slice(20 + jsonLen + 8 + view.byteOffset).buffer, 0, acc.count * 3);
  for (let i = 0; i < acc.count; i++) near(Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]), 1);
});

test('GLB: a per-vertex coloured part that is no flat picture keeps its shared corners and leaves the normals to the viewer (size)', async () => {
  const relief = box('Relief', [0, 0, 0], [10, 10, 2], '#ffffff');
  relief.vertexColors = new Float32Array(relief.positions.length).fill(0.5);
  const { json } = await read(toGlb([relief], 'Relief', { upright: true }));
  const prim = json.meshes[0].primitives[0];
  assert.ok(!('NORMAL' in prim.attributes), 'flat steps: the viewer shades them flat');
  assert.equal(json.accessors[prim.attributes.POSITION].count, 8, 'the 8 corners, not one per triangle corner');
});

// ---------------------------------------------------------------------------
// Flat colour reliefs (LayerTone pictures, flat lithophanes): a coarse relief with the picture as a texture
// ---------------------------------------------------------------------------

interface Accessor { bufferView: number; componentType: number; count: number; type: string; min?: number[]; max?: number[] }
interface FullGltf extends Gltf {
  accessors: Accessor[];
  bufferViews: { byteOffset: number; byteLength: number }[];
  images?: { bufferView: number; mimeType: string }[];
  textures?: { source: number; sampler?: number }[];
  materials: (Gltf['materials'][number] & { pbrMetallicRoughness: { baseColorTexture?: { index: number } } })[];
}

/** The whole GLB: JSON plus a reader for its accessors and buffer views. */
async function open(blob: Blob | Promise<Blob>) {
  const b = await blob;
  const buf = new Uint8Array(await b.arrayBuffer());
  const { json, bytes } = await read(b);
  const g = json as unknown as FullGltf;
  const jsonLen = new DataView(buf.buffer).getUint32(12, true);
  const bin = buf.slice(20 + jsonLen + 8);
  const view = (i: number) => bin.slice(g.bufferViews[i].byteOffset, g.bufferViews[i].byteOffset + g.bufferViews[i].byteLength);
  const width: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3 };
  const data = (i: number): ArrayLike<number> => {
    const a = g.accessors[i], v = view(a.bufferView), n = a.count * width[a.type];
    return a.componentType === 5126 ? new Float32Array(v.buffer, 0, n) : a.componentType === 5125 ? new Uint32Array(v.buffer, 0, n) : new Uint16Array(v.buffer, 0, n);
  };
  return { g, bytes, view, data };
}

const triangles = (g: FullGltf) => g.meshes.flatMap((m) => m.primitives).reduce((s, p) => s + g.accessors[p.indices!].count / 3, 0);

/** Signed volume of every primitive together (outward-facing and closed: the solid's volume), m³. */
function signedVolume(o: Awaited<ReturnType<typeof open>>): number {
  let v = 0;
  for (const p of o.g.meshes.flatMap((m) => m.primitives)) {
    const P = o.data(p.attributes.POSITION), I = o.data(p.indices!);
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
      v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    }
  }
  return v;
}
function meshVolume(pos: Float32Array, idx: Uint32Array): number {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    v += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6;
  }
  return v;
}

function bboxOf(pos: Float32Array): PartMesh['bbox'] {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  return { min: min as [number, number, number], max: max as [number, number, number] };
}

/** A picture 400 × 300 px: dark on the left half and along the top quarter, bright in the bottom right. */
function testPicture(): LayerToneImage {
  const w = 400, h = 300, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = x < 200 || y < 75 ? 0 : 255; rgba.set([v, v, v, 255], (y * w + x) * 4); }
  return toLayerToneImage('test', w, h, rgba);
}

const FOUR: LayerColor[] = [['#161616', 0, 0], ['#808080', 0.48, 5], ['#ff0000', 0.8, 9], ['#ffffff', 1.12, 13]].map(([color, z, layer]) => ({ color: color as string, z: z as number, layer: layer as number, td: 1 }));

/** A LayerTone picture 100 × 75 mm as H.layertone builds it, with its colours per vertex. */
function layerTonePart(): PartMesh {
  const r = resolveLayerToneOptions({ width: 100, border: 3, resolution: 0.25 });
  const m = layerToneMesh(testPicture(), FOUR, r);
  const positions = m.vertProperties, indices = m.triVerts;
  return { name: 'Relief', color: '#161616', positions, indices, bbox: bboxOf(positions), volume: meshVolume(positions, indices), surfaceArea: 0, triCount: indices.length / 3, genus: 0, components: 1, layerColors: FOUR, vertexColors: layerToneVertexColors(positions, FOUR) };
}

/** A lithophane as H.lithophane builds it (standing, the picture to the front, -Y), coloured as lit from behind. */
function lithophanePart(shape: 'flat' | 'curved'): PartMesh {
  const r = resolveLithoOptions({ width: 80, shape });
  const m = lithophaneMesh(testPicture(), r);
  const nv = m.vertProperties.length / 4;
  const positions = new Float32Array(nv * 3), thickness = new Float32Array(nv);
  for (let v = 0; v < nv; v++) { positions.set(m.vertProperties.subarray(v * 4, v * 4 + 3), v * 3); thickness[v] = m.vertProperties[v * 4 + 3]; }
  const indices = m.triVerts;
  return { name: 'Lithophane', color: '#ffffff', positions, indices, bbox: bboxOf(positions), volume: meshVolume(positions, indices), surfaceArea: 0, triCount: indices.length / 3, genus: 0, components: 1, lithophane: { image: 'test', options: r }, vertexColors: lithoVertexColors(thickness, r) };
}

test('GLB: a LayerTone picture is a coarse relief with the picture as a JPEG texture', async () => {
  const part = layerTonePart();
  const o = await open(toGlb([part], 'Picture', { upright: true }));
  assert.equal(o.g.images?.length, 2, 'the picture and its fine relief');
  assert.ok(o.g.images!.every((i) => i.mimeType === 'image/jpeg'));
  const front = o.g.meshes[0].primitives[0];
  assert.ok('TEXCOORD_0' in front.attributes, 'the picture is mapped onto the top');
  assert.ok('NORMAL' in front.attributes, 'a smooth relief');
  const mat = o.g.materials[front.material].pbrMetallicRoughness;
  assert.equal(o.g.textures![mat.baseColorTexture!.index].source, 0);
  assert.deepEqual(mat.baseColorFactor, [1, 1, 1, 1]);
  assert.equal(mat.metallicFactor, 0);
  const tris = triangles(o.g);
  assert.ok(tris < 100_000 && tris < part.triCount / 5, `${tris} triangles from ${part.triCount}`);
  // Real size: 100 mm + 2 × 3 mm frame across, upright (the face to the front), as thick as the relief.
  const e = extent(o.g);
  near(e.size[0], 0.106); near(e.size[1], 0.081);
  assert.ok(Math.abs(e.size[2] - (part.bbox.max[2] - part.bbox.min[2]) / 1000) < 0.0002, `thickness ${e.size[2]}`);
  near(e.min[1], 0);
});

test('GLB: the relief is closed and outward-facing (its volume is the print\'s)', async () => {
  const part = layerTonePart();
  const o = await open(toGlb([part], 'Picture', { upright: false }));
  const v = signedVolume(o) * 1e9;
  assert.ok(Math.abs(v - part.volume) < 0.05 * part.volume, `${v} mm³ vs ${part.volume} mm³`);
});

test('GLB: the texture shows the picture where it is on the relief', async () => {
  const part = layerTonePart();
  const o = await open(toGlb([part], 'Picture', { upright: true }));
  const img = jpeg.decode(o.view(o.g.images![0].bufferView), { useTArray: true });
  const front = o.g.meshes[0].primitives[0].attributes;
  const P = o.data(front.POSITION), UV = o.data(front.TEXCOORD_0);
  // Upright, centred in x, standing on y = 0: the picture (75 mm high, 3 mm frame) spans y 3…78 mm.
  const brightness = (x: number, y: number) => {
    let best = 0, d = Infinity;
    for (let i = 0; i < P.length / 3; i++) { const dd = Math.hypot(P[i * 3] - x, P[i * 3 + 1] - y); if (dd < d) { d = dd; best = i; } }
    const px = Math.min(img.width - 1, Math.floor(UV[best * 2] * img.width)), py = Math.min(img.height - 1, Math.floor(UV[best * 2 + 1] * img.height));
    return img.data[(py * img.width + px) * 4 + 1];
  };
  const bottomRight = brightness(0.03, 0.02), topRight = brightness(0.03, 0.072), left = brightness(-0.03, 0.02);
  assert.ok(bottomRight > 200, `bottom right is bright (${bottomRight})`);
  assert.ok(topRight < 80, `top band is dark (${topRight})`);
  assert.ok(left < 80, `left half is dark (${left})`);
});

test('GLB: a flat lithophane gets the picture on its front, a curved one keeps its mesh', async () => {
  const flat = await open(toGlb([lithophanePart('flat')], 'Litho', { upright: false }));
  assert.equal(flat.g.images?.length, 2);
  const front = flat.g.meshes[0].primitives[0].attributes;
  assert.ok('TEXCOORD_0' in front);
  // Standing, its picture faces -Y: in the GLB (lying as printed) towards the viewer, +Z.
  const N = flat.data(front.NORMAL);
  let z = 0;
  for (let i = 2; i < N.length; i += 3) z += N[i];
  assert.ok(z / (N.length / 3) > 0.9, `front normals face +Z (${z / (N.length / 3)})`);
  near(extent(flat.g).size[0], 0.086);

  const curved = await open(toGlb([lithophanePart('curved')], 'Litho', { upright: false }));
  assert.equal(curved.g.images, undefined);
  assert.ok('COLOR_0' in curved.g.meshes[0].primitives[0].attributes);
  assert.ok(!('TEXCOORD_0' in curved.g.meshes[0].primitives[0].attributes));
});

test('GLB: the relief\'s fine steps stay visible as a normal map', async () => {
  const o = await open(toGlb([layerTonePart()], 'Picture', { upright: true }));
  const mat = o.g.materials[o.g.meshes[0].primitives[0].material] as unknown as { normalTexture?: { index: number } };
  assert.ok(mat.normalTexture, 'a normal texture');
  const img = jpeg.decode(o.view(o.g.images![o.g.textures![mat.normalTexture.index].source].bufferView), { useTArray: true });
  // A row through the bottom half: flat (straight out, 128 128 255) except where the picture
  // steps up from dark (low) to bright (high), left to right: there the surface faces left (red low).
  const y = Math.round(img.height * 0.75), red = (x: number) => img.data[(y * img.width + x) * 4];
  const reds = Array.from({ length: img.width }, (_, x) => red(x));
  const sorted = [...reds].sort((a, b) => a - b);
  assert.ok(Math.abs(sorted[sorted.length >> 1] - 128) < 8, `flat mostly (${sorted[sorted.length >> 1]})`);
  const mid = reds.slice(Math.round(img.width * 0.4), Math.round(img.width * 0.6));
  assert.ok(Math.min(...mid) < 100, `the step faces left (${Math.min(...mid)})`);
});
