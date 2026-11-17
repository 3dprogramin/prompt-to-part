// The app's busy state for the owner's Docker rebuild (scripts/rebuild.sh): work that runs no process
// of its own (a picture edit, a product photo, both waiting on the image model) holds a marker file
// /tmp/ptp-busy-* with the server's process id, and the rebuild waits while one exists.
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';

export const BUSY_PREFIX = 'ptp-busy-';
/** The marker file of a running job of this kind. */
export const busyFile = (kind: string, id: string, dir = os.tmpdir()) => path.join(dir, `${BUSY_PREFIX}${kind}-${id}`);

/** Marks a job busy until the returned function is called (call it before the answer goes out). */
export async function markBusy(kind: string, id: string = randomUUID(), dir = os.tmpdir()): Promise<() => Promise<void>> {
  const file = busyFile(kind, id, dir);
  await writeFile(file, `${process.pid}\n`);
  return () => rm(file, { force: true }).catch(() => undefined);
}

/** Whether a process with this id is running (one of another user counts). */
const processRuns = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Removes the markers of jobs that no longer run. Node dying mid-job leaves its marker, and a
 * container restarted in place keeps /tmp, so the Docker rebuild would wait its whole 30 minutes for
 * it. Stale: a marker of this process (it has run no job yet; in the container the restarted server
 * often gets the same id), of a process that is gone, or unreadable. Another running server's marker
 * (a test run next to the app) stays.
 */
export function clearStaleBusyFiles(dir = os.tmpdir()) {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(BUSY_PREFIX)) continue;
    const file = path.join(dir, name);
    let pid = NaN;
    try { pid = Number.parseInt(readFileSync(file, 'utf8'), 10); } catch { /* unreadable: stale */ }
    if (pid > 0 && pid !== process.pid && processRuns(pid)) continue;
    try { rmSync(file, { force: true }); } catch { /* gone already, or not ours to remove */ }
  }
}
