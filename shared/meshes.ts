// Imported and AI-generated meshes (H.mesh). Meshes are too big for a design's values, so each is
// stored as a file next to the design (data/designs/<id>/meshes/<hash>.bin, see server/meshes.ts)
// and the values keep a light index under MESHES_KEY. Evaluation is synchronous, so a mesh that
// isn't loaded yet throws MeshMissingError and the caller loads it and retries (like fonts).
import type { Vec3 } from './types';

/** Values key: the design's meshes, as JSON Record<name, MeshEntry>. */
export const MESHES_KEY = '$meshes';
/** Most meshes in one design. */
export const MAX_MESHES = 12;
/** A mesh file's URL: /api/designs/<design>/meshes/<content hash>.bin */
export const MESH_URL = /^\/api\/designs\/([a-zA-Z0-9-]{8,64})\/meshes\/([0-9a-f]{32}\.bin)$/;
/** A mesh's name in the design (what H.mesh takes). */
export const MESH_NAME = /^[\w.-]{1,60}$/;

export interface MeshEntry {
  /** URL of the stored mesh (MESH_URL). */
  file: string;
  triangles: number;
  /** Size in mm as stored: Z-up, standing on z = 0, centred in X and Y. */
  size: Vec3;
  source: 'upload' | 'meshy';
  /** The uploaded file's name. */
  original?: string;
  /** Meshy: what it was asked for. */
  prompt?: string;
  /** A picture of it: Meshy's textured preview, or a render of the import. */
  preview?: string;
  /** What the import had to fix, for Claude and the user. */
  repairs?: string[];
}

export function parseMeshes(raw: unknown): Record<string, MeshEntry> {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return {}; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: Record<string, MeshEntry> = {};
  for (const [name, e] of Object.entries(o).slice(0, MAX_MESHES)) {
    const m = e as Partial<MeshEntry>;
    if (!MESH_NAME.test(name) || typeof m?.file !== 'string' || !MESH_URL.test(m.file)) continue;
    const size = Array.isArray(m.size) && m.size.length === 3 && m.size.every((x) => Number.isFinite(x)) ? m.size as Vec3 : [0, 0, 0] as Vec3;
    out[name] = {
      file: m.file, triangles: Number(m.triangles) || 0, size, source: m.source === 'meshy' ? 'meshy' : 'upload',
      ...(typeof m.original === 'string' ? { original: m.original.slice(0, 200) } : {}),
      ...(typeof m.prompt === 'string' ? { prompt: m.prompt.slice(0, 2000) } : {}),
      ...(typeof m.preview === 'string' ? { preview: m.preview.slice(0, 300) } : {}),
      ...(Array.isArray(m.repairs) ? { repairs: m.repairs.filter((r): r is string => typeof r === 'string').slice(0, 20).map((r) => r.slice(0, 300)) } : {}),
    };
  }
  return out;
}

/** A mesh name not in use yet, from a file name or Claude's choice ("dragon.stl" → "dragon", then "dragon-2"…). */
export function freeMeshName(want: string, taken: Record<string, unknown>): string {
  const base = want.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'mesh';
  let name = base;
  for (let n = 2; taken[name]; n++) name = `${base}-${n}`;
  return name;
}

/** Rewrites the design id in mesh URLs (a forked design gets its own copies). */
export function rehomeMeshes(raw: unknown, designId: string): string | undefined {
  const meshes = parseMeshes(raw);
  if (!Object.keys(meshes).length) return undefined;
  for (const m of Object.values(meshes)) {
    m.file = m.file.replace(MESH_URL, (_, _id, file) => `/api/designs/${designId}/meshes/${file}`);
    if (m.preview) m.preview = m.preview.replace(/^\/api\/designs\/[a-zA-Z0-9-]{8,64}\//, `/api/designs/${designId}/`);
  }
  return JSON.stringify(meshes);
}

// ---------------------------------------------------------------------------- stored format
// "JIGM", header length (uint32), JSON header padded to 4 bytes, float32 xyz per vertex, uint32
// vertex indices per triangle. The mesh is already repaired: welded, watertight and oriented.
const MAGIC = 0x4d47494a; // "JIGM" little-endian

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

export function encodeMesh(m: MeshData, header: Record<string, unknown> = {}): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ version: 1, vertices: m.positions.length / 3, triangles: m.indices.length / 3, ...header }));
  const hl = Math.ceil(json.length / 4) * 4;
  const out = new Uint8Array(8 + hl + m.positions.byteLength + m.indices.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, hl, true);
  out.fill(0x20, 8, 8 + hl);
  out.set(json, 8);
  out.set(new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength), 8 + hl);
  out.set(new Uint8Array(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength), 8 + hl + m.positions.byteLength);
  return out;
}

export function decodeMesh(bytes: Uint8Array): MeshData & { header: Record<string, unknown> } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || dv.getUint32(0, true) !== MAGIC) throw new Error('Not a Jig mesh file');
  const hl = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl))) as Record<string, unknown>;
  const nv = Number(header.vertices), nt = Number(header.triangles);
  const start = 8 + hl;
  if (!Number.isInteger(nv) || !Number.isInteger(nt) || start + nv * 12 + nt * 12 !== bytes.length) throw new Error('Damaged Jig mesh file');
  // Copied: the views must be aligned, and the caller may keep the buffer.
  const positions = new Float32Array(bytes.slice(start, start + nv * 12).buffer);
  const indices = new Uint32Array(bytes.slice(start + nv * 12).buffer);
  for (let i = 0; i < indices.length; i++) if (indices[i] >= nv) throw new Error('Damaged Jig mesh file');
  return { positions, indices, header };
}

// ---------------------------------------------------------------------------- loaded meshes
export class MeshMissingError extends Error {
  constructor(public url: string) {
    super(`Mesh "${url}" is not loaded yet`);
  }
}

/** Loaded meshes by URL (content-addressed, so they never change). Kept small: meshes are big. */
const loaded = new Map<string, MeshData>();
const failed = new Map<string, string>();
const MAX_LOADED = 8;

export function registerMesh(url: string, data: MeshData) {
  loaded.delete(url);
  loaded.set(url, data);
  while (loaded.size > MAX_LOADED) loaded.delete(loaded.keys().next().value!);
}
export function markMeshFailed(url: string, reason: string) { failed.set(url, reason); }

/** The mesh at `url`; throws MeshMissingError when it still has to be loaded. */
export function getMeshData(url: string): MeshData {
  const m = loaded.get(url);
  if (m) return m;
  const why = failed.get(url);
  if (why) throw new Error(`The mesh file couldn't be loaded: ${why}`);
  throw new MeshMissingError(url);
}

/** Runs fn, loading every mesh it asks for (MeshMissingError) and running it again. */
export async function withMeshes<T>(fn: () => T | Promise<T>, load: (url: string) => Promise<MeshData>): Promise<T> {
  for (let i = 0; i < MAX_MESHES + 1; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof MeshMissingError)) throw e;
      try {
        registerMesh(e.url, await load(e.url));
      } catch (err) {
        // A file that is gone stays gone; a failed download (server restarting) fails only this run.
        if ((err as { transient?: boolean }).transient) throw err;
        markMeshFailed(e.url, (err as Error).message);
      }
    }
  }
  return fn();
}
