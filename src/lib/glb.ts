// GLB (binary glTF 2.0) for a shop's 3D product view (Shopify's 360° viewer and "view in your
// room"): what the viewer shows, in its colours, at real size (glTF is in metres, Y up).
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PartMesh } from '../../shared/types';
import { vertexColors as layerToneColors } from '../../shared/layertone';
import { linearColors, paintedGeometry, usableColors } from '../geometry/vertexColors';

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
    const srgb = usableColors(part.vertexColors, part.positions) ?? (part.layerColors?.length ? layerToneColors(part.positions, part.layerColors) : undefined);
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

export function toGlb(parts: PartMesh[], title: string, opts: GlbOptions): Blob {
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
  const add = (data: Float32Array | Uint16Array | Uint32Array, target: number) => {
    const bytes = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
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

  const meshes: object[] = [];
  const materials: object[] = [];
  for (const part of parts) {
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
    const idx = geom.getIndex()!.array as ArrayLike<number>;
    const small = P.count < 65536;
    const indexData = small ? Uint16Array.from(idx) : Uint32Array.from(idx);
    accessors.push({ bufferView: add(indexData, 34963), componentType: small ? 5123 : 5125, count: indexData.length, type: 'SCALAR' });
    const indices = accessors.length - 1;
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
    meshes, materials, accessors, bufferViews,
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
