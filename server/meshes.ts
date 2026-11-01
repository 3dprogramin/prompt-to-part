// Mesh files kept with a design (data/designs/<id>/meshes/): the repaired mesh (<hash>.bin, what
// H.mesh loads), the original upload and a picture of it, each named by its content so they never
// change. The design's values only index them (MESHES_KEY in shared/meshes.ts).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config';
import { MESH_URL, type MeshEntry } from '../shared/meshes';
import { filamentLabel } from '../shared/meshColors';
import { printer } from '../shared/printer';
import { meshFormat } from '../shared/meshFormats';
import type { ImportReport } from '../shared/meshRepair';
import type { ImportedMesh } from './geometry';

export const DESIGNS = path.join(DATA_DIR, 'designs');
/** Largest mesh file accepted (an upload, or a download from Meshy). */
export const MAX_MESH_BYTES = 100 * 1024 * 1024;
/** Files in a design's meshes folder. */
export const MESH_FILE = /^[0-9a-f]{32}\.(bin|png|jpg|webp|stl|obj|glb|gltf|3mf)$/;

export const meshDir = (designId: string) => path.join(DESIGNS, designId, 'meshes');

/** The stored mesh a MESH_URL points to. */
export async function readMeshFile(url: string): Promise<Uint8Array> {
  const m = MESH_URL.exec(url);
  if (!m) throw new Error('not a mesh URL');
  return new Uint8Array(await readFile(path.join(meshDir(m[1]), m[2])));
}

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 32);

async function writeOnce(dir: string, name: string, bytes: Uint8Array) {
  const file = path.join(dir, name);
  if (existsSync(file)) return;
  // Written whole or not at all: a half-written file would be served (and cached) forever.
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

/**
 * Stores an imported mesh with the design: the .bin, the original file and a picture (the given
 * one, e.g. Meshy's preview, else the four-view render). `stillThere` runs right before writing
 * (in the design's write queue): false when the design was deleted meanwhile.
 */
export async function storeMesh(designId: string, imported: ImportedMesh, original: { bytes: Uint8Array; filename: string }, extra: {
  source: MeshEntry['source']; prompt?: string; picture?: { bytes: Uint8Array; ext: 'png' | 'jpg' | 'webp' };
}, write: <T>(fn: () => Promise<T>) => Promise<T | null> = (fn) => fn()): Promise<MeshEntry | null> {
  const dir = meshDir(designId);
  const binName = `${hash(imported.bin)}.bin`;
  const ext = meshFormat(original.filename) ?? 'bin';
  const picture = extra.picture ?? { bytes: Buffer.from(imported.png, 'base64'), ext: 'png' as const };
  const picName = `${hash(picture.bytes)}.${picture.ext}`;
  const done = await write(async () => {
    await mkdir(dir, { recursive: true });
    await writeOnce(dir, binName, imported.bin);
    await writeOnce(dir, `${hash(original.bytes)}.${ext}`, original.bytes);
    await writeOnce(dir, picName, picture.bytes);
    return true;
  });
  if (!done) return null;
  const r = imported.report;
  return {
    file: `/api/designs/${designId}/meshes/${binName}`, triangles: r.triangles, size: r.size, source: extra.source,
    original: original.filename.slice(0, 200), ...(extra.prompt ? { prompt: extra.prompt } : {}),
    preview: `/api/designs/${designId}/meshes/${picName}`, repairs: r.repairs,
    ...(imported.palette?.length ? { palette: imported.palette } : {}),
  };
}

/** Stores a concept picture (generate_concept) with the design's meshes; returns its URL. */
export async function storeConceptPicture(designId: string, picture: { bytes: Uint8Array; ext: 'png' | 'jpg' | 'webp' }): Promise<string> {
  const dir = meshDir(designId);
  const name = `${hash(picture.bytes)}.${picture.ext}`;
  await mkdir(dir, { recursive: true });
  await writeOnce(dir, name, picture.bytes);
  return `/api/designs/${designId}/meshes/${name}`;
}

/** Copies every mesh file of one design to another (a design started from a version of it). */
export async function copyMeshes(from: string, to: string): Promise<number> {
  const names = (await readdir(meshDir(from)).catch(() => [] as string[])).filter((n) => MESH_FILE.test(n));
  if (!names.length) return 0;
  await mkdir(meshDir(to), { recursive: true });
  for (const n of names) if (!existsSync(path.join(meshDir(to), n))) await copyFile(path.join(meshDir(from), n), path.join(meshDir(to), n));
  return names.length;
}

const f = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

/** The import, in words for Claude: size, triangles and what had to be repaired. */
export function describeImport(name: string, entry: MeshEntry, report?: ImportReport): string {
  const [x, y, z] = entry.size;
  const lines = [
    `Mesh "${name}"${entry.original ? ` (from ${entry.original})` : ''}: ${f(x)} × ${f(y)} × ${f(z)} mm as stored (W×D×H; Z up, standing on z = 0, centred), ${entry.triangles.toLocaleString('en')} triangles, watertight.`,
  ];
  if (report) lines.push(`Imported from ${report.inputTriangles.toLocaleString('en')} triangles in ${(report.timeMs / 1000).toFixed(1)} s; volume ${(report.volume / 1000).toFixed(1)} cm³, ${report.components} solid piece(s).`);
  lines.push(entry.repairs?.length ? `Import repairs: ${entry.repairs.join('; ')}.` : 'It needed no repairs.');
  if (entry.palette?.length) {
    lines.push(`In colour: its texture reduced to ${entry.palette.length} colour${entry.palette.length > 1 ? 's' : ''}, each printed with a filament (the user can change them in the Object tab): ${entry.palette.map((c) => `${c.color} → ${filamentLabel(c.filament)} ${c.filament.color} (${Math.round(c.share * 100)} %)`).join('; ')}. H.mesh keeps these colours on its triangles through unions, cuts and trims; geometry you add has its part's colour – give it one of these filament colours (e.g. ${entry.palette.map((c) => c.filament.color).slice(0, 2).join(' or ')}) to stay within the ${printer().filaments} filaments the ${printer().name} loads at once.`);
  }
  lines.push(`Use it with H.mesh("${name}", { height }) (or width, depth, size, scale; rotate: [x, y, z] degrees).`);
  return lines.join('\n');
}
