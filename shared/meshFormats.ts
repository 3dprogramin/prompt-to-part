// Mesh file parsers (STL, OBJ, glTF/GLB, 3MF): positions and triangles. Normals are ignored, and
// so are materials, UVs and textures unless colours are asked for (a coloured Meshy figure): then a
// glTF's base colour (its texture through the UVs, times the material's factor) gives each triangle
// a colour. Runs in the server's locked-down geometry worker (the files are untrusted) and in tests.
import { strFromU8, unzipSync } from 'fflate';

export type MeshFormat = 'stl' | 'obj' | 'glb' | 'gltf' | '3mf';
export const MESH_FORMATS: MeshFormat[] = ['stl', 'obj', 'glb', 'gltf', '3mf'];

/** Triangles as read from a file, before repair: indexed, possibly with duplicate vertices. */
export interface RawMesh {
  positions: Float32Array;
  indices: Uint32Array;
  format: MeshFormat;
  /** The file's up axis: glTF and OBJ (Meshy, Blender) are Y-up; STL and 3MF are Z-up like Jig. */
  up: 'y' | 'z';
  /** Millimetres per file unit when the format says (3MF, glTF metres), or null when unknown. */
  mmPerUnit: number | null;
  warnings: string[];
  /** sRGB colour per triangle (3 bytes each), when colours were asked for and the file has them (glTF base colour). */
  colors?: Uint8Array;
}

/** RGBA pixels of a texture, row by row from the top. */
export interface Raster { width: number; height: number; data: Uint8Array | Uint8ClampedArray }

export interface ParseOptions {
  /** Read each triangle's colour; `decode` turns an embedded PNG or JPEG into pixels (throws on others). */
  colors?: { decode: (bytes: Uint8Array, mimeType: string) => Raster };
}

/** Most triangles a file may have (about 120 MB of positions). */
export const MAX_FILE_TRIANGLES = 5_000_000;
/** Most vertices a file may have: three per triangle (an unshared soup). */
export const MAX_FILE_VERTICES = 3 * MAX_FILE_TRIANGLES;
/** Most placed copies of objects (3MF components and items, glTF nodes) a file may have. */
export const MAX_FILE_INSTANCES = 100_000;
/** Most uncompressed bytes of model files read from a 3MF, and most entries its zip may list. */
export const MAX_3MF_MODEL_BYTES = 256 * 1024 * 1024;
export const MAX_3MF_ENTRIES = 10_000;
const MAX_3MF_MODELS = 256;

export class MeshFormatError extends Error {}

export function meshFormat(filename: string): MeshFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  return MESH_FORMATS.includes(ext as MeshFormat) ? (ext as MeshFormat) : null;
}

export function parseMeshFile(bytes: Uint8Array, filename: string, opts: ParseOptions = {}): RawMesh {
  const format = meshFormat(filename);
  if (!format) throw new MeshFormatError(`${filename}: not a mesh file Jig reads (STL, OBJ, GLB/glTF or 3MF)`);
  let out: RawMesh;
  if (format === 'stl') out = parseStl(bytes);
  else if (format === 'obj') out = parseObj(bytes);
  else if (format === '3mf') out = parse3mf(bytes);
  else out = parseGltf(bytes, opts.colors?.decode);
  if (!out.indices.length) throw new MeshFormatError(`${filename}: the file has no triangles`);
  return out;
}

const tooManyTriangles = () => new MeshFormatError(`More than ${MAX_FILE_TRIANGLES.toLocaleString('en')} triangles`);
const tooManyVertices = () => new MeshFormatError(`More than ${MAX_FILE_VERTICES.toLocaleString('en')} vertices`);
const tooManyInstances = () => new MeshFormatError(`More than ${MAX_FILE_INSTANCES.toLocaleString('en')} placed parts`);

/** The bytes as text; a file too big for one string is refused like any other bad file. */
function text(bytes: Uint8Array): string {
  try { return strFromU8(bytes); } catch { throw new MeshFormatError('The file is too large to read as text'); }
}

// ---- growing typed buffers (files can hold millions of triangles)
class Floats {
  a = new Float32Array(3 * 1024);
  n = 0;
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) {
      if (this.n / 3 >= MAX_FILE_VERTICES) throw tooManyVertices();
      const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b;
    }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
  done() { return this.a.slice(0, this.n); }
}
class Ints {
  a = new Uint32Array(3 * 1024);
  n = 0;
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) {
      if (this.n / 3 >= MAX_FILE_TRIANGLES) throw tooManyTriangles();
      const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b;
    }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
  done() { return this.a.slice(0, this.n); }
}

/** Unshared triangles: vertex i of the soup is used once (repair welds them). */
function soup(positions: Float32Array): Uint32Array {
  const idx = new Uint32Array(positions.length / 3);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  return idx;
}

// ---------------------------------------------------------------------------- STL
function parseStl(bytes: Uint8Array): RawMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length >= 84 ? view.getUint32(80, true) : -1;
  // Binary when the size matches the triangle count; many binary files start with "solid" too.
  const binary = count >= 0 && 84 + count * 50 === bytes.length;
  const head = strFromU8(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  if (!binary && head.startsWith('solid') && /facet|endsolid/.test(strFromU8(bytes.subarray(0, Math.min(bytes.length, 4096))))) return parseAsciiStl(text(bytes));
  if (!binary) {
    // Some exporters pad or truncate: read the whole triangles that are there.
    if (count < 0 || bytes.length < 84 + 50) throw new MeshFormatError('Not a valid STL file');
  }
  const n = Math.min(count, Math.floor((bytes.length - 84) / 50));
  if (n > MAX_FILE_TRIANGLES) throw new MeshFormatError(`More than ${MAX_FILE_TRIANGLES.toLocaleString('en')} triangles`);
  const positions = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12; // skip the normal
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(o + k * 4, true);
  }
  const warnings = n < count ? [`The STL says ${count} triangles but holds ${n}`] : [];
  return { positions, indices: soup(positions), format: 'stl', up: 'z', mmPerUnit: null, warnings };
}

function parseAsciiStl(text: string): RawMesh {
  const pos = new Floats();
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  for (let m; (m = re.exec(text));) pos.push3(Number(m[1]), Number(m[2]), Number(m[3]));
  const n = Math.floor(pos.n / 9) * 9;
  const positions = pos.done().slice(0, n);
  if (positions.length / 9 > MAX_FILE_TRIANGLES) throw new MeshFormatError(`More than ${MAX_FILE_TRIANGLES.toLocaleString('en')} triangles`);
  return { positions, indices: soup(positions), format: 'stl', up: 'z', mmPerUnit: null, warnings: [] };
}

// ---------------------------------------------------------------------------- OBJ
function parseObj(bytes: Uint8Array): RawMesh {
  const src = text(bytes);
  const pos = new Floats();
  const idx = new Ints();
  const face: number[] = [];
  let bad = 0;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ') || line.startsWith('v\t')) {
      const p = line.split(/\s+/);
      pos.push3(Number(p[1]), Number(p[2]), Number(p[3]));
    } else if (line.startsWith('f ') || line.startsWith('f\t')) {
      const p = line.split(/\s+/);
      const nv = pos.n / 3;
      face.length = 0;
      for (let i = 1; i < p.length; i++) {
        if (!p[i]) continue;
        // "v", "v/vt", "v//vn", "v/vt/vn"; negative indices count back from the last vertex.
        const v = parseInt(p[i], 10);
        const k = v < 0 ? nv + v : v - 1;
        face.push(k);
      }
      if (face.length < 3 || face.some((k) => !(k >= 0 && k < nv))) { bad++; continue; }
      // Polygons as fans (OBJ faces are planar and convex in practice).
      for (let i = 1; i + 1 < face.length; i++) idx.push3(face[0], face[i], face[i + 1]);
    }
  }
  const warnings = bad ? [`${bad} faces with missing vertices were skipped`] : [];
  return { positions: pos.done(), indices: idx.done(), format: 'obj', up: 'y', mmPerUnit: null, warnings };
}

// ---------------------------------------------------------------------------- glTF / GLB
type Mat4 = number[]; // column-major, as glTF stores it
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

interface Gltf {
  asset?: { version?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number; material?: number; extensions?: Record<string, unknown> }[] }[];
  materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index: number; texCoord?: number } } }[];
  textures?: { source?: number }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean; sparse?: unknown }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { uri?: string; byteLength: number }[];
  extensionsRequired?: string[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

class Bytes {
  a = new Uint8Array(3 * 1024);
  n = 0;
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) { const b = new Uint8Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
  done() { return this.a.slice(0, this.n); }
}

/** linear 0–1 → sRGB 0–1 (glTF colour factors are linear). */
const srgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function parseGltf(bytes: Uint8Array, decode?: (bytes: Uint8Array, mimeType: string) => Raster): RawMesh {
  let json: Gltf;
  const buffers: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 12 && view.getUint32(0, true) === 0x46546c67) { // "glTF"
    let at = 12;
    let jsonText = '';
    let bin: Uint8Array | null = null;
    while (at + 8 <= bytes.length) {
      const len = view.getUint32(at, true), type = view.getUint32(at + 4, true);
      const chunk = bytes.subarray(at + 8, at + 8 + len);
      if (type === 0x4e4f534a) jsonText = text(chunk);
      else if (type === 0x004e4942 && !bin) bin = chunk;
      at += 8 + len;
    }
    if (!jsonText) throw new MeshFormatError('Not a valid GLB file (no JSON chunk)');
    try { json = JSON.parse(jsonText); } catch { throw new MeshFormatError('Not a valid GLB file (its JSON is broken)'); }
    if (bin) buffers[0] = bin;
  } else {
    try { json = JSON.parse(text(bytes)); } catch (e) { throw e instanceof MeshFormatError ? e : new MeshFormatError('Not a valid glTF file'); }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new MeshFormatError('Not a valid glTF file');
  const unsupported = (json.extensionsRequired ?? []).filter((e) => e !== 'KHR_mesh_quantization' && e !== 'KHR_materials_pbrSpecularGlossiness' && !e.startsWith('KHR_texture') && !e.startsWith('KHR_materials'));
  if (unsupported.length) throw new MeshFormatError(`This glTF needs ${unsupported.join(', ')}, which Jig doesn't read (export it without ${/draco|meshopt/i.test(unsupported.join()) ? 'mesh compression' : 'these extensions'})`);
  (json.buffers ?? []).forEach((b, i) => {
    if (buffers[i] && !b.uri) return;
    const m = b.uri && /^data:[^;,]*;base64,(.*)$/.exec(b.uri);
    if (m) buffers[i] = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    else if (b.uri) throw new MeshFormatError('This .gltf refers to a separate .bin file: upload the .glb version instead');
  });

  // Values read from accessors over the whole file: an instanced mesh is read again for every
  // copy, so this bounds the work as well as each accessor's own size.
  let readBudget = 8 * MAX_FILE_VERTICES;
  const whole = (x: unknown) => x === undefined || (Number.isInteger(x) && (x as number) >= 0);
  const read = (ai: number, what: 'positions' | 'indices' | 'UVs'): Float64Array => {
    const a = json.accessors?.[ai];
    if (!a) throw new MeshFormatError(`glTF accessor ${ai} is missing`);
    if (a.sparse) throw new MeshFormatError('Sparse glTF accessors are not supported');
    const comps = COMPONENTS[a.type] ?? 1;
    const count = a.count;
    // Checked before anything is allocated: the count is only a number in the JSON.
    if (!Number.isInteger(count) || count < 0) throw new MeshFormatError(`glTF ${what}: bad count`);
    if (count > MAX_FILE_VERTICES || count * comps > 3 * MAX_FILE_VERTICES) throw new MeshFormatError(`glTF ${what}: more than ${MAX_FILE_VERTICES.toLocaleString('en')} values`);
    if ((readBudget -= count * comps) < 0) throw tooManyVertices();
    if (a.bufferView == null) return new Float64Array(count * comps); // all zeros, per the spec
    const bv = json.bufferViews?.[a.bufferView];
    const buf = bv && buffers[bv.buffer];
    if (!bv || !buf) throw new MeshFormatError(`glTF ${what}: buffer missing`);
    const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
    if (!size) throw new MeshFormatError(`glTF ${what}: unsupported component type ${a.componentType}`);
    if (!whole(bv.byteOffset) || !whole(bv.byteStride) || !whole(bv.byteLength) || !whole(a.byteOffset)) throw new MeshFormatError(`glTF ${what}: bad buffer offsets`);
    const stride = bv.byteStride || size * comps;
    const viewStart = bv.byteOffset ?? 0;
    const viewEnd = Math.min(buf.length, viewStart + (bv.byteLength ?? buf.length));
    const base = viewStart + (a.byteOffset ?? 0);
    if (count && base + stride * (count - 1) + size * comps > viewEnd) throw new MeshFormatError(`glTF ${what}: data runs past its buffer`);
    const out = new Float64Array(count * comps);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // Normalised integers (KHR_mesh_quantization) map to [-1, 1] or [0, 1].
    const norm = a.normalized ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType as 5120] ?? 1 : 1;
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < comps; c++) {
        const o = base + i * stride + c * size;
        let v: number;
        switch (a.componentType) {
          case 5120: v = Math.max(dv.getInt8(o) / norm, a.normalized ? -1 : -Infinity); break;
          case 5121: v = dv.getUint8(o) / norm; break;
          case 5122: v = Math.max(dv.getInt16(o, true) / norm, a.normalized ? -1 : -Infinity); break;
          case 5123: v = dv.getUint16(o, true) / norm; break;
          case 5125: v = dv.getUint32(o, true); break;
          default: v = dv.getFloat32(o, true);
        }
        out[i * comps + c] = v;
      }
    }
    return out;
  };

  const pos = new Floats();
  const idx = new Ints();
  const warnings: string[] = [];
  let skipped = 0;
  // Colours: each material's base colour texture (decoded once) and factor.
  const cols = decode ? new Bytes() : null;
  const rasters = new Map<number, Raster | null>();
  const raster = (ii: number): Raster | null => {
    if (rasters.has(ii)) return rasters.get(ii)!;
    let r: Raster | null = null;
    try {
      const img = json.images?.[ii];
      let data: Uint8Array | undefined, mime = img?.mimeType ?? '';
      if (img?.bufferView != null) {
        const bv = json.bufferViews?.[img.bufferView];
        const buf = bv && buffers[bv.buffer];
        if (bv && buf) data = buf.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
      } else if (img?.uri) {
        const m = /^data:([^;,]*);base64,(.*)$/.exec(img.uri);
        if (m) { data = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); mime ||= m[1]; }
      }
      if (data) r = decode!(data, mime);
    } catch (e) { warnings.push(`A texture couldn't be read (${(e as Error).message}): its triangles are grey`); }
    rasters.set(ii, r);
    return r;
  };
  const addMesh = (mi: number, m: Mat4) => {
    for (const prim of json.meshes?.[mi]?.primitives ?? []) {
      const mode = prim.mode ?? 4;
      if (prim.extensions && Object.keys(prim.extensions).some((e) => /draco|meshopt/i.test(e))) throw new MeshFormatError('This glTF is compressed (Draco or meshopt): export it without mesh compression');
      if (prim.attributes.POSITION == null || ![4, 5, 6].includes(mode)) { skipped++; continue; }
      const p = read(prim.attributes.POSITION, 'positions');
      const first = pos.n / 3;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        pos.push3(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
      const nv = p.length / 3;
      const ix = prim.indices != null ? read(prim.indices, 'indices') : Float64Array.from({ length: nv }, (_, i) => i);
      // A mirrored node transform turns the triangles inside out: flip them back.
      const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
      // The triangle's colour: the texture at its centre and three points towards its corners (averaged), times the factor.
      let color: ((a: number, b: number, c: number) => void) | null = null;
      if (cols) {
        const pbr = prim.material != null ? json.materials?.[prim.material]?.pbrMetallicRoughness : undefined;
        const f = (pbr?.baseColorFactor ?? [1, 1, 1, 1]).slice(0, 3).map((x) => srgb(Math.min(1, Math.max(0, Number(x) || 0))));
        const tex = pbr?.baseColorTexture;
        const src = tex ? json.textures?.[tex.index]?.source : undefined;
        const img = src != null ? raster(src) : null;
        const uvAttr = prim.attributes[`TEXCOORD_${tex?.texCoord ?? 0}`];
        const uv = img && uvAttr != null ? read(uvAttr, 'UVs') : null;
        const flat = f.map((x) => Math.round(x * 255));
        const W = [[1 / 3, 1 / 3, 1 / 3], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]];
        color = (a, b, c) => {
          if (!img || !uv || uv.length < nv * 2) return cols.push3(flat[0], flat[1], flat[2]);
          let r = 0, g = 0, bl = 0;
          for (const [wa, wb, wc] of W) {
            const u = wa * uv[2 * a] + wb * uv[2 * b] + wc * uv[2 * c], v = wa * uv[2 * a + 1] + wb * uv[2 * b + 1] + wc * uv[2 * c + 1];
            // Repeat wrapping; glTF's UV origin is the image's top left.
            const x = Math.min(img.width - 1, Math.floor((u - Math.floor(u)) * img.width)), y = Math.min(img.height - 1, Math.floor((v - Math.floor(v)) * img.height));
            const o = (y * img.width + x) * 4;
            r += img.data[o]; g += img.data[o + 1]; bl += img.data[o + 2];
          }
          cols.push3(Math.round((r / 4) * f[0]), Math.round((g / 4) * f[1]), Math.round((bl / 4) * f[2]));
        };
      }
      const tri = (a: number, b: number, c: number) => {
        if (!(Number.isInteger(a) && Number.isInteger(b) && Number.isInteger(c) && a >= 0 && b >= 0 && c >= 0 && a < nv && b < nv && c < nv)) return;
        if (det < 0) idx.push3(first + a, first + c, first + b); else idx.push3(first + a, first + b, first + c);
        color?.(a, b, c);
      };
      if (mode === 4) for (let i = 0; i + 2 < ix.length; i += 3) tri(ix[i], ix[i + 1], ix[i + 2]);
      else if (mode === 5) for (let i = 0; i + 2 < ix.length; i++) (i % 2 ? tri(ix[i + 1], ix[i], ix[i + 2]) : tri(ix[i], ix[i + 1], ix[i + 2]));
      else for (let i = 1; i + 1 < ix.length; i++) tri(ix[0], ix[i], ix[i + 1]);
    }
  };
  // Nodes form a tree: a node that is its own ancestor (a cycle) is skipped, and the number of
  // placed nodes is capped (a node listed twice as a child at every level doubles each time).
  const onPath = new Set<number>();
  let instances = 0;
  const visit = (ni: number, parent: Mat4, depth: number) => {
    const n = json.nodes?.[ni];
    if (!n || depth > 64 || onPath.has(ni)) return;
    if (++instances > MAX_FILE_INSTANCES) throw tooManyInstances();
    const local = n.matrix?.length === 16 ? n.matrix : trs(n.translation, n.rotation, n.scale);
    const m = mul(parent, local);
    if (n.mesh != null) addMesh(n.mesh, m);
    onPath.add(ni);
    for (const c of n.children ?? []) visit(c, m, depth + 1);
    onPath.delete(ni);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene?.nodes?.length) for (const ni of scene.nodes) visit(ni, IDENTITY, 0);
  else (json.meshes ?? []).forEach((_, mi) => addMesh(mi, IDENTITY));
  if (skipped) warnings.push(`${skipped} parts that aren't triangles (points or lines) were skipped`);
  return { positions: pos.done(), indices: idx.done(), format: 'glb', up: 'y', mmPerUnit: 1000, warnings, ...(cols ? { colors: cols.done() } : {}) };
}

// ---------------------------------------------------------------------------- 3MF
const UNITS: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].replace(/^[\w]+:(?!path)/, '')] = m[2] ?? m[3];
  return out;
}
/** A 3MF transform ("m00 m01 m02 m10 … m32", row vectors) as a column-major 4×4. */
function transform3mf(s: string | undefined): Mat4 {
  const v = (s ?? '').trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return IDENTITY;
  return [v[0], v[1], v[2], 0, v[3], v[4], v[5], 0, v[6], v[7], v[8], 0, v[9], v[10], v[11], 1];
}

function parse3mf(bytes: Uint8Array): RawMesh {
  let files: Record<string, Uint8Array>;
  try {
    // Only the model files: textures and thumbnails can be big. fflate inflates each accepted
    // entry into a buffer of its declared size (and no more), so capping the declared sizes caps
    // the memory; every listed entry passes through the filter, so counting them caps the work.
    let entries = 0, models = 0, total = 0;
    files = unzipSync(bytes, {
      filter: (f) => {
        if (++entries > MAX_3MF_ENTRIES) throw new MeshFormatError(`Not a 3MF Jig reads (more than ${MAX_3MF_ENTRIES.toLocaleString('en')} files in the archive)`);
        if (!/\.model$/i.test(f.name)) return false;
        total += f.originalSize;
        if (++models > MAX_3MF_MODELS || !(total <= MAX_3MF_MODEL_BYTES)) throw new MeshFormatError(`The 3MF's models are too large (over ${MAX_3MF_MODEL_BYTES / 1024 / 1024} MB unpacked)`);
        return true;
      },
    });
  } catch (e) { throw e instanceof MeshFormatError ? e : new MeshFormatError('Not a valid 3MF file (not a zip archive)'); }
  const main = Object.keys(files).find((f) => /^\/?3D\/3dmodel\.model$/i.test(f)) ?? Object.keys(files)[0];
  if (!main) throw new MeshFormatError('Not a valid 3MF file (no 3D/3dmodel.model)');
  type Obj = { mesh?: { pos: number[]; tri: number[] }; components: { id: string; path?: string; m: Mat4 }[] };
  const models = new Map<string, Map<string, Obj>>();
  let mmPerUnit = 1;
  const load = (name: string) => {
    const key = name.replace(/^\//, '');
    if (models.has(key)) return models.get(key)!;
    const objs = new Map<string, Obj>();
    models.set(key, objs);
    const file = files[key] ?? files[`/${key}`];
    if (!file) return objs;
    const xml = text(file);
    if (key === main.replace(/^\//, '')) mmPerUnit = UNITS[attrs(/<(?:\w+:)?model\b[^>]*>/.exec(xml)?.[0] ?? '').unit ?? 'millimeter'] ?? 1;
    for (const om of xml.matchAll(/<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g)) {
      const id = attrs(om[1]).id;
      const body = om[2];
      const obj: Obj = { components: [] };
      if (/<(?:\w+:)?mesh\b/.test(body)) {
        const p: number[] = [], t: number[] = [];
        for (const v of body.matchAll(/<(?:\w+:)?vertex\b([^>]*)\/?>/g)) { const a = attrs(v[1]); p.push(Number(a.x), Number(a.y), Number(a.z)); }
        for (const v of body.matchAll(/<(?:\w+:)?triangle\b([^>]*)\/?>/g)) { const a = attrs(v[1]); t.push(Number(a.v1), Number(a.v2), Number(a.v3)); }
        obj.mesh = { pos: p, tri: t };
      }
      for (const c of body.matchAll(/<(?:\w+:)?component\b([^>]*)\/?>/g)) {
        const a = attrs(c[1]);
        obj.components.push({ id: a.objectid, path: a['p:path'] ?? a.path, m: transform3mf(a.transform) });
      }
      if (id) objs.set(id, obj);
    }
    return objs;
  };
  const pos = new Floats();
  const idx = new Ints();
  // Components form a tree: one that contains itself (a cycle) is skipped, and the number of placed
  // objects and of triangles looked at is capped (a component listed twice per level doubles).
  const onPath = new Set<string>();
  let instances = 0, looked = 0;
  const emit = (file: string, id: string, m: Mat4, depth: number) => {
    const obj = load(file).get(id);
    const key = `${file.replace(/^\//, '')}#${id}`;
    if (!obj || depth > 32 || onPath.has(key)) return;
    if (++instances > MAX_FILE_INSTANCES) throw tooManyInstances();
    if (obj.mesh) {
      if ((looked += obj.mesh.tri.length / 3) > MAX_FILE_TRIANGLES) throw tooManyTriangles();
      const first = pos.n / 3, nv = obj.mesh.pos.length / 3;
      const p = obj.mesh.pos;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        pos.push3(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
      const t = obj.mesh.tri;
      const ok = (k: number) => Number.isInteger(k) && k >= 0 && k < nv;
      for (let i = 0; i + 2 < t.length; i += 3) if (ok(t[i]) && ok(t[i + 1]) && ok(t[i + 2])) idx.push3(first + t[i], first + t[i + 1], first + t[i + 2]);
    }
    onPath.add(key);
    for (const c of obj.components) emit(c.path ?? file, c.id, mul(m, c.m), depth + 1);
    onPath.delete(key);
  };
  const mainXml = text(files[main]);
  load(main);
  const items = [...mainXml.matchAll(/<(?:\w+:)?item\b([^>]*)\/?>/g)].map((m) => attrs(m[1]));
  if (items.length) for (const it of items) emit(it['p:path'] ?? it.path ?? main, it.objectid, transform3mf(it.transform), 0);
  else for (const id of load(main).keys()) emit(main, id, IDENTITY, 0);
  return { positions: pos.done(), indices: idx.done(), format: '3mf', up: 'z', mmPerUnit, warnings: [] };
}
