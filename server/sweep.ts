// At startup: leftovers of work a crash (or a killed container) cut short, removed from the data
// folder. Only these, each by its exact name pattern, are ever removed:
// - `.backup-import-<uuid>.zip`, a backup being restored (up to 4 GB), older than an hour;
// - `<file>.<uuid>.tmp`, a file being written (writeAtomically, the mesh store), older than an hour,
//   in the data folder, designs/, designs/<id>/ and designs/<id>/meshes/;
// - workspaces/<id> of a design that was never saved (or is gone), untouched for a day.
import path from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';
import { DATA_DIR } from './config';
import { ID_RE } from './routes/store';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BACKUP_UPLOAD = new RegExp(`^\\.backup-import-${UUID}\\.zip$`);
const TEMP_FILE = new RegExp(`^.+\\.${UUID}\\.tmp$`);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

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
  return { removed };
}
