// GLB (binary glTF 2.0) for a shop's 3D product view (Shopify's 360° viewer and "view in your
// room"): what the viewer shows, in its colours, at real size (glTF is in metres, Y up).
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PartMesh } from '../../shared/types';
import { vertexColors as layerToneColors } from '../../shared/layertone';
import { linearColors, paintedGeometry, usableColors } from '../geometry/vertexColors';
import { isFlatPicture, pictureRelief, type Picture } from './glbPicture';

export interface GlbOptions {
  /** Stand a flat piece up, its face to the front, as it hangs on a wall; otherwise it lies as it prints. */
  upright: boolean;
}

/** A flat print (wall art, a sign, a plaque): much thinner than it is wide (the shop photos' rule). */
export function isFlat(parts: PartMesh[]): boolean {
  if (!parts.length) return false;
  const min = [0, 1, 2].map((k) => Math.min(...parts.map((p) => p.bbox.min[k])));
  const max = [0, 1, 2].map((k) => Math.max(...parts.map((p) => p.bbox.max[k])));
  const s = max.map((v, k) => v - min[k]);
  return s[2] < 0.25 * Math.min(s[0], s[1]);
}

/** PLA: matte, not metal. */
const ROUGHNESS = 0.7;
/** JPEG quality (0-1) of a flat picture's colours, and of its fine relief (normal map: shading only, it stands more loss). */
const JPEG_QUALITY = 0.85;
const NORMAL_QUALITY = 0.75;

/** A picture (RGBA) as a JPEG file. */
export type JpegEncoder = (image: Picture, quality: number) => Promise<Uint8Array>;

/** The browser's own encoder; in Node (tests) jpeg-js, which needs Node's Buffer. */
export const encodeJpeg: JpegEncoder = async ({ width, height, rgba }, quality) => {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
  }
  const { default: jpeg } = await import('jpeg-js');
  return new Uint8Array(jpeg.encode({ data: rgba, width, height }, Math.round(quality * 100)).data);
};

/** The part's colours per vertex as sRGB 0-1, if it has them (LayerTone's from its heights). */
const srgbColors = (part: PartMesh) => usableColors(part.vertexColors, part.positions) ?? (part.layerColors?.length ? layerToneColors(part.positions, part.layerColors) : undefined);

/**
 * The part as a three.js geometry with its colours per vertex (linear) when it has them, and normals
 * unless it is a LayerTone relief or a lithophane: those are millions of flat steps, so they keep their
 * shared corners and the viewer shades them flat (a glTF without normals), at a fraction of the size.
 */
function partGeometry(part: PartMesh): { geom: THREE.BufferGeometry; perVertex: boolean; normals: boolean } {
  let g = paintedGeometry(part);
  if (!g) {
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
    const srgb = srgbColors(part);
    if (srgb) g.setAttribute('color', new THREE.BufferAttribute(linearColors(srgb), 3));
    g.setIndex(new THREE.BufferAttribute(part.indices, 1));
  }
  const perVertex = !!g.getAttribute('color');
  if (perVertex && !part.paint) return { geom: g, perVertex, normals: false };
  // Sharp edges stay sharp, curved faces smooth (as in the viewer); then shared corners again, for size.
  const creased = toCreasedNormals(g, THREE.MathUtils.degToRad(32));
  g.dispose();
  const geom = mergeVertices(creased, 1e-4);
  creased.dispose();
  return { geom, perVertex, normals: true };
}

/**
 * The model as a GLB. A flat colour relief (a LayerTone picture, a flat lithophane) becomes a coarse
 * relief with the picture as a JPEG texture (glbPicture.ts): a few MB instead of tens.
 */
export async function toGlb(parts: PartMesh[], title: string, opts: GlbOptions, encode: JpegEncoder = encodeJpeg): Promise<Blob> {
  // One move for the whole model: centred, standing on the ground (y = 0), in metres.
  const min = [0, 1, 2].map((k) => Math.min(...parts.map((p) => p.bbox.min[k])));
  const max = [0, 1, 2].map((k) => Math.max(...parts.map((p) => p.bbox.max[k])));
  const c = min.map((v, k) => (v + max[k]) / 2);
  // Model space is Z up (as printed). Lying: Z becomes glTF's up (Y), Y goes away from the viewer.
  // Upright: the piece's face (+Z) looks at the viewer, its drawing's up (+Y) stays up.
  const place = opts.upright
    ? (x: number, y: number, z: number) => [(x - c[0]) / 1000, (y - min[1]) / 1000, (z - c[2]) / 1000]
    : (x: number, y: number, z: number) => [(x - c[0]) / 1000, (z - min[2]) / 1000, -(y - c[1]) / 1000];
  const turn = opts.upright ? (x: number, y: number, z: number) => [x, y, z] : (x: number, y: number, z: number) => [x, z, -y];

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const add = (data: Float32Array | Uint16Array | Uint32Array | Uint8Array, target?: number) => {
    const bytes = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    chunks.push(bytes);
    offset += bytes.byteLength;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
    return bufferViews.length - 1;
  };
  const vec3 = (data: Float32Array, withBounds: boolean) => {
    const view = add(data, 34962);
    const a: Record<string, unknown> = { bufferView: view, componentType: 5126, count: data.length / 3, type: 'VEC3' };
    if (withBounds) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], data[i + k]); hi[k] = Math.max(hi[k], data[i + k]); }
      a.min = lo; a.max = hi;
    }
    accessors.push(a);
    return accessors.length - 1;
  };

  const indexAccessor = (idx: ArrayLike<number>, vertices: number) => {
    const small = vertices < 65536;
    const data = small ? Uint16Array.from(idx) : Uint32Array.from(idx);
    accessors.push({ bufferView: add(data, 34963), componentType: small ? 5123 : 5125, count: data.length, type: 'SCALAR' });
    return accessors.length - 1;
  };
  const placed = (P: Float32Array, f: (x: number, y: number, z: number) => number[]) => {
    const out = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) out.set(f(P[i], P[i + 1], P[i + 2]), i);
    return out;
  };

  const meshes: object[] = [];
  const materials: object[] = [];
  const images: object[] = [];
  const textures: object[] = [];
  const matte = (name: string, extra: object = {}, normalTexture?: number) => {
    materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], ...extra, metallicFactor: 0, roughnessFactor: ROUGHNESS }, ...(normalTexture != null ? { normalTexture: { index: normalTexture } } : {}) });
    return materials.length - 1;
  };
  for (const part of parts) {
    const srgb = isFlatPicture(part) ? srgbColors(part) : undefined;
    const relief = srgb && pictureRelief(part, srgb);
    if (relief) {
      const { front, rest, image, normalMap } = relief;
      const texture = async (picture: Picture, quality: number) => {
        images.push({ bufferView: add(await encode(picture, quality)), mimeType: 'image/jpeg' });
        textures.push({ sampler: 0, source: images.length - 1 });
        return textures.length - 1;
      };
      const colour = await texture(image, JPEG_QUALITY), bumps = await texture(normalMap, NORMAL_QUALITY);
      accessors.push({ bufferView: add(front.uvs, 34962), componentType: 5126, count: front.uvs.length / 2, type: 'VEC2' });
      const uv = accessors.length - 1;
      const face = {
        attributes: { POSITION: vec3(placed(front.positions, place), true), NORMAL: vec3(placed(front.normals, turn), false), TEXCOORD_0: uv },
        indices: indexAccessor(front.indices, front.positions.length / 3),
        material: matte(part.name, { baseColorTexture: { index: colour } }, bumps), mode: 4,
      };
      const sides = {
        attributes: { POSITION: vec3(placed(rest.positions, place), true), COLOR_0: vec3(rest.colors, false) },
        indices: indexAccessor(rest.indices, rest.positions.length / 3),
        material: matte(`${part.name} (sides)`), mode: 4,
      };
      meshes.push({ name: part.name, primitives: rest.indices.length ? [face, sides] : [face] });
      continue;
    }
    const { geom, perVertex, normals } = partGeometry(part);
    const P = geom.getAttribute('position'), N = geom.getAttribute('normal'), C = geom.getAttribute('color');
    const pos = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) pos.set(place(P.getX(i), P.getY(i), P.getZ(i)), i * 3);
    const attributes: Record<string, number> = { POSITION: vec3(pos, true) };
    if (normals) {
      const nor = new Float32Array(P.count * 3);
      for (let i = 0; i < P.count; i++) {
        const [x, y, z] = turn(N.getX(i), N.getY(i), N.getZ(i));
        // A zero-area sliver has no direction: glTF wants unit normals, so it gets "up".
        const l = Math.hypot(x, y, z);
        nor.set(l > 1e-8 ? [x / l, y / l, z / l] : [0, 1, 0], i * 3);
      }
      attributes.NORMAL = vec3(nor, false);
    }
    if (perVertex && C) attributes.COLOR_0 = vec3(Float32Array.from(C.array as ArrayLike<number>), false);
    const indices = indexAccessor(geom.getIndex()!.array as ArrayLike<number>, P.count);
    geom.dispose();

    // A per-vertex part is white, so its colours show as they are; any other its filament colour.
    const col = perVertex ? [1, 1, 1] : (() => { const k = new THREE.Color(part.color); return [k.r, k.g, k.b]; })();
    materials.push({ name: part.name, pbrMetallicRoughness: { baseColorFactor: [...col.map((v) => Math.round(v * 1e5) / 1e5), 1], metallicFactor: 0, roughnessFactor: ROUGHNESS } });
    meshes.push({ name: part.name, primitives: [{ attributes, indices, material: materials.length - 1, mode: 4 }] });
  }

  const json = {
    asset: { version: '2.0', generator: 'prompt-to-part' },
    scene: 0,
    scenes: [{ name: title, nodes: meshes.map((_, i) => i) }],
    nodes: meshes.map((m, i) => ({ name: (m as { name: string }).name, mesh: i })),
    meshes, materials,
    ...(images.length ? { images, textures, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }] } : {}),
    accessors, bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) { const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20); padded.set(jsonBytes); jsonBytes = padded; }

  const total = 12 + 8 + jsonBytes.length + 8 + offset;
  const header = new DataView(new ArrayBuffer(20));
  header.setUint32(0, 0x46546c67, true); // "glTF"
  header.setUint32(4, 2, true);
  header.setUint32(8, total, true);
  header.setUint32(12, jsonBytes.length, true);
  header.setUint32(16, 0x4e4f534a, true); // "JSON"
  const binHeader = new DataView(new ArrayBuffer(8));
  binHeader.setUint32(0, offset, true);
  binHeader.setUint32(4, 0x004e4942, true); // "BIN\0"
  return new Blob([header.buffer, jsonBytes, binHeader.buffer, ...chunks], { type: 'model/gltf-binary' });
}
