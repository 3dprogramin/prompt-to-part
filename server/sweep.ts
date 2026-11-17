// At startup: leftovers of work a crash (or a killed container) cut short, removed from the data
// folder. Only these, each by its exact name pattern, are ever removed:
// - `.backup-import-<uuid>.zip`, a backup being restored (up to 4 GB), older than an hour;
// - `<file>.<uuid>.tmp`, a file being written (writeAtomically, the mesh store), older than an hour,
//   in the data folder, designs/, designs/<id>/ and designs/<id>/meshes/;
// - workspaces/<id> of a design that was never saved (or is gone), untouched for a day;
// - the mesh files (MESH_FILE) in designs/<id>/meshes/ of a chat never saved: no designs/<id>.json
//   and no save of it under way, nothing in its folders or its workspace changed for MESH_GRACE, and
//   its id in no design file (any version or message) and no printed record. When one of those files
//   can't be read, none are removed. The folders go only when that leaves them empty.
// It runs before the server listens, so no reply, upload or restore can be using them.
import path from 'node:path';
import { readdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { DATA_DIR } from './config';
import { MESH_FILE } from './meshes';
import { ID_RE } from './routes/store';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BACKUP_UPLOAD = new RegExp(`^\\.backup-import-${UUID}\\.zip$`);
const TEMP_FILE = new RegExp(`^.+\\.${UUID}\\.tmp$`);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** How long a never-saved chat's mesh uploads are kept: its tab may still be open, about to send. */
export const MESH_GRACE = 7 * DAY;

export interface SweepResult { removed: string[] }

const list = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);
const mtime = (p: string) => stat(p).then((s) => s.mtimeMs, () => null);

/** Removes the leftovers listed above from `dataDir`; returns their paths. */
export async function sweepDataDir(dataDir = DATA_DIR, now = Date.now()): Promise<SweepResult> {
  const removed: string[] = [];
  const remove = async (p: string, recursive = false) => {
    try {
      await rm(p, { recursive, force: true });
      removed.push(p);
    } catch (e) {
      console.warn('[sweep] Could not remove', p, (e as Error).message);
    }
  };
  /** Old temp files directly in `dir` (and backup uploads when `backups`). */
  const sweepFiles = async (dir: string, backups = false) => {
    for (const e of await list(dir)) {
      if (!e.isFile() || !(TEMP_FILE.test(e.name) || (backups && BACKUP_UPLOAD.test(e.name)))) continue;
      const p = path.join(dir, e.name);
      const t = await mtime(p);
      if (t !== null && now - t > HOUR) await remove(p);
    }
  };

  await sweepFiles(dataDir, true);
  const designs = path.join(dataDir, 'designs');
  await sweepFiles(designs);
  for (const e of await list(designs)) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
    await sweepFiles(path.join(designs, e.name));
    await sweepFiles(path.join(designs, e.name, 'meshes'));
  }

  // A workspace's last use: the newest of the folder and what is directly in it (model.js is
  // rewritten in place, which doesn't change the folder's own time).
  const workspaces = path.join(dataDir, 'workspaces');
  for (const e of await list(workspaces)) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
    const ws = path.join(workspaces, e.name);
    if (await mtime(path.join(designs, `${e.name}.json`)) !== null) continue;
    let last = await mtime(ws) ?? now;
    for (const f of await list(ws)) last = Math.max(last, await mtime(path.join(ws, f.name)) ?? now);
    if (now - last > DAY) await remove(ws, true);
  }

  await sweepMeshUploads(dataDir, now, remove);
  return { removed };
}

/** The newest change time of `dir` and what is directly in it (null: it isn't there; one that can't be listed counts as now). */
async function lastChange(dir: string): Promise<number | null> {
  let last = await mtime(dir);
  if (last === null) return null;
  const files = await readdir(dir).catch(() => null);
  if (!files) return Infinity;
  for (const f of files) last = Math.max(last, await mtime(path.join(dir, f)) ?? Infinity);
  return last;
}

/** The mesh uploads of never-saved chats (see the top of this file). */
async function sweepMeshUploads(dataDir: string, now: number, remove: (p: string) => Promise<void>) {
  const designs = path.join(dataDir, 'designs');
  const entries = await list(designs);
  const names = new Set(entries.map((e) => e.name));
  const saving = (id: string) => entries.some((e) => e.name.startsWith(`${id}.json.`));
  const candidates: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !ID_RE.test(e.name) || names.has(`${e.name}.json`) || saving(e.name)) continue;
    const times = await Promise.all([path.join(designs, e.name), path.join(designs, e.name, 'meshes'), path.join(dataDir, 'workspaces', e.name)].map(lastChange));
    if (times[1] === null) continue;
    if (times.every((t) => t === null || now - t > MESH_GRACE)) candidates.push(e.name);
  }
  if (!candidates.length) return;

  // Every design file and printed record, as text: an id found anywhere in them keeps its files.
  const texts: string[] = [];
  try {
    // printed.json read by name (only a missing one is none), the copies kept aside (H4) by listing.
    texts.push(await readFile(path.join(dataDir, 'printed.json'), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e; }));
    for (const n of await readdir(dataDir)) if (n.startsWith('printed.json.')) texts.push(await readFile(path.join(dataDir, n), 'utf8'));
    for (const e of entries) if (e.name.endsWith('.json')) texts.push(await readFile(path.join(designs, e.name), 'utf8'));
  } catch (e) {
    console.warn('[sweep] Mesh uploads of unsaved chats kept: could not read', (e as Error).message);
    return;
  }
  for (const id of candidates) {
    if (texts.some((t) => t.includes(id))) continue;
    const meshes = path.join(designs, id, 'meshes');
    for (const f of await list(meshes)) if (f.isFile() && MESH_FILE.test(f.name)) await remove(path.join(meshes, f.name));
    // Only when empty: anything else in them (chat images) stays.
    for (const dir of [meshes, path.join(designs, id)]) await rmdir(dir).catch(() => undefined);
  }
}
