// Makes colour-figure.glb, the textured model the mock Meshy serves for coloured requests: a figure
// turned on a lathe (Y-up, 2 units tall, a UV seam with duplicated vertices like Meshy's models)
// with a 64 × 64 PNG texture in four colour bands – black hair, skin, a red shirt with two tiny
// white buttons, blue trousers – embedded in the GLB.
//
//   npx tsx test/fixtures/meshes/make-colour-figure.ts
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { encode } from 'fast-png';

export const BANDS = [
  { from: 1.55, color: [27, 27, 27] }, // hair
  { from: 1.2, color: [240, 192, 138] }, // skin
  { from: 0.6, color: [200, 32, 42] }, // shirt
  { from: 0, color: [42, 79, 160] }, // trousers
];
const HEIGHT = 2;

/** The figure's outline: radius by height. */
const PROFILE: [number, number][] = [
  [0, 0], [0, 0.38], [0.05, 0.42], [0.3, 0.4], [0.6, 0.36], [0.62, 0.4], [0.9, 0.44], [1.15, 0.38], [1.2, 0.2],
  [1.25, 0.28], [1.4, 0.36], [1.55, 0.37], [1.7, 0.34], [1.85, 0.26], [1.95, 0.14], [2, 0],
];

export function makeColourFigure(): Uint8Array {
  const N = 48, W = 64, H = 64;
  // Texture: v = 0 at the top of the picture (glTF), the figure's top.
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const h = HEIGHT * (1 - (y + 0.5) / H);
    let c = BANDS.find((b) => h >= b.from)!.color;
    // Two buttons on the shirt's front.
    if ((x === 47 || x === 48) && (y === 22 || y === 26)) c = [250, 250, 250];
    px.set([...c, 255], (y * W + x) * 4);
  }
  const png = encode({ width: W, height: H, data: px, channels: 4, depth: 8 });

  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  // A ring of N + 1 vertices per profile point (the last repeats the first, with u = 1); the poles are single points.
  PROFILE.forEach(([y, r]) => {
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * 2 * Math.PI;
      pos.push(r * Math.sin(a), y, r * Math.cos(a));
      uv.push(i / N, 1 - y / HEIGHT);
    }
  });
  const ring = N + 1;
  for (let p = 0; p + 1 < PROFILE.length; p++) for (let i = 0; i < N; i++) {
    const a = p * ring + i, b = a + 1, c = a + ring, d = c + 1;
    // Outward: counter-clockwise seen from outside.
    if (PROFILE[p][1] > 0) idx.push(a, b, d);
    if (PROFILE[p + 1][1] > 0) idx.push(a, d, c);
  }

  // GLB: JSON chunk and one binary buffer (positions, UVs, indices, the PNG).
  const f32 = (a: number[]) => new Uint8Array(new Float32Array(a).buffer);
  const parts = [f32(pos), f32(uv), new Uint8Array(new Uint32Array(idx).buffer), png];
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let off = 0;
  for (const p of parts) { views.push({ buffer: 0, byteOffset: off, byteLength: p.length }); off += Math.ceil(p.length / 4) * 4; }
  const bin = new Uint8Array(off);
  parts.forEach((p, i) => bin.set(p, views[i].byteOffset));
  const min = [0, 1, 2].map((k) => Math.min(...pos.filter((_, i) => i % 3 === k))), max = [0, 1, 2].map((k) => Math.max(...pos.filter((_, i) => i % 3 === k)));
  const json = {
    asset: { version: '2.0', generator: 'Jig test fixture' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
    textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9728, minFilter: 9728 }],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: uv.length / 2, type: 'VEC2' },
      { bufferView: 2, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jl = Math.ceil(text.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + jl + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jl); out.set(text, 20);
  dv.setUint32(20 + jl, bin.length, true); dv.setUint32(24 + jl, 0x004e4942, true);
  out.set(bin, 28 + jl);
  return out;
}

if (process.argv[1] && /make-colour-figure/.test(process.argv[1])) {
  writeFileSync(path.join(import.meta.dirname, 'colour-figure.glb'), makeColourFigure());
}
