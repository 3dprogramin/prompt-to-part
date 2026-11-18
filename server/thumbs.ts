// The Designs menu's pictures: drawn by the geometry worker, kept as files named by what they show.
// Derived data: not in backups, deleted with the design. This file knows nothing about Express.
// Drawn at any time, also while a generation runs (it spends nearly all its time waiting for the AI):
// one render at a time, each sent to the worker's queue only when the one before has finished, so a
// generation's build waits behind at most one picture (typically 1 to 3 s, at most the 20 s timeout).
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Vec3 } from '../shared/types';
import { NON_BUILD_KEYS } from '../shared/buildKeys';
import { writeAtomically } from './routes/store';

/** Raise when the picture's look or the key changes, so old pictures are drawn again. */
export const THUMB_VERSION = 2;

/**
 * What a picture shows, as 16 hex characters: the code and the values that build something (a
 * cache key, so sha1 is enough). None for a design without code.
 */
export function thumbKey(code: string, values: unknown): string | null {
  if (!code.trim()) return null;
  const built = values && typeof values === 'object' && !Array.isArray(values)
    ? Object.fromEntries(Object.entries(values).filter(([k]) => !NON_BUILD_KEYS.includes(k)))
    : values ?? {};
  return createHash('sha1').update(`${THUMB_VERSION}\n${code}\n${JSON.stringify(built)}`).digest('hex').slice(0, 16);
}

export const THUMB_KEY_RE = /^[0-9a-f]{16}$/;
const SAFE_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const FILE_RE = /^(.+)-([0-9a-f]{16})\.(png|json)$/;

/** A design file's time and size: what tells that it changed, without reading it. */
export interface DesignStat { mtimeMs: number; size: number }
type Thumb = { file: string; size: Vec3 };

export interface ThumbStoreOptions {
  dir: string;
  render: (code: string, values: unknown) => Promise<{ png?: string; size?: Vec3 }>;
  /** The design's code and values, read once per picture drawn. */
  readDesign: (id: string) => Promise<{ code: string; values: unknown } | null>;
  /** The design file's time and size, or null when it is gone. */
  statDesign: (id: string) => Promise<DesignStat | null>;
  /** The running app's build: a design that failed in another build is tried again. */
  build: string;
}

export function thumbStore({ dir, render, readDesign, statDesign, build }: ThumbStoreOptions) {
  // Keys whose render crashed: not the design's fault, so nothing on disk, but not retried until a restart.
  const crashed = new Set<string>();
  const pending = new Map<string, Promise<Thumb | null>>();
  // Keys found not to be the design's current one (or its design gone), with the design file's time
  // and size then: answered "not there" at once while the file stays as it was.
  const notCurrent = new Map<string, DesignStat | 'missing'>();
  const forget = (id: string) => { for (const n of notCurrent.keys()) if (n.startsWith(`${id}-`) && THUMB_KEY_RE.test(n.slice(id.length + 1))) notCurrent.delete(n); };
  // The pictures queued, in order: the first is being drawn (or is the next to start).
  const line: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const base = (id: string, key: string) => path.join(dir, `${id}-${key}`);
  const same = (a: DesignStat, b: DesignStat | null) => !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;

  /** The picture on disk; null when it is known to fail (in this build); undefined when it is not there yet. */
  async function fromDisk(id: string, key: string): Promise<Thumb | null | undefined> {
    let info: { size?: Vec3; failed?: boolean; build?: string };
    try { info = JSON.parse(await readFile(`${base(id, key)}.json`, 'utf8')); } catch { return undefined; }
    // A failure in another build (or one from before builds were noted) may be fixed now: drawn once more.
    if (info.failed) return info.build === build ? null : undefined;
    if (!info.size) return null;
    return { file: `${base(id, key)}.png`, size: info.size };
  }

  async function removeFiles(id: string, keep?: string) {
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const m = FILE_RE.exec(f);
      if (m && m[1] === id && m[2] !== keep) await rm(path.join(dir, f), { force: true });
    }
  }

  async function draw(id: string, key: string): Promise<Thumb | null> {
    const name = `${id}-${key}`;
    // The time and size before the read: a save after it shows when they are compared again.
    const before = await statDesign(id);
    if (!before) { notCurrent.set(name, 'missing'); return null; }
    const design = await readDesign(id);
    if (!design || thumbKey(design.code, design.values) !== key) { notCurrent.set(name, before); return null; }
    let out: { png?: string; size?: Vec3 } = {};
    try { out = await render(design.code, design.values); } catch {
      crashed.add(name);
      return null;
    }
    // The design may have changed or gone while it was drawn: then this picture is not wanted.
    if (!same(before, await statDesign(id))) return null;
    const { png, size } = out;
    try {
      await mkdir(dir, { recursive: true });
      if (!png || !size) {
        await writeAtomically(`${base(id, key)}.json`, JSON.stringify({ failed: true, build }));
        await removeFiles(id, key);
      } else {
        await writeAtomically(`${base(id, key)}.png`, Buffer.from(png, 'base64'));
        await writeAtomically(`${base(id, key)}.json`, JSON.stringify({ size }));
        await removeFiles(id, key);
      }
      forget(id);
    } catch {
      // The disk refused (full, not writable): not the design's fault, not tried again until a restart.
      crashed.add(name);
      return null;
    }
    // Deleted between the check and the writes: nothing may stay behind.
    if (!(await statDesign(id))) { await removeFiles(id); return null; }
    return png && size ? { file: `${base(id, key)}.png`, size } : null;
  }

  /** The render of this picture, queued once per id-key. The design is read only when its turn comes. */
  function ensure(id: string, key: string): Promise<Thumb | null> {
    const name = `${id}-${key}`;
    let p = pending.get(name);
    if (!p) {
      line.push(name);
      // One at a time; a failed job must not stop the ones behind it.
      p = queue.then(() => draw(id, key)).catch(() => null).finally(() => {
        const i = line.indexOf(name);
        if (i >= 0) line.splice(i, 1);
      });
      queue = p;
      pending.set(name, p);
      void p.finally(() => pending.delete(name));
    }
    return p;
  }

  /** True for a key known not to be current while the design file is as it was then (no queueing, no read). */
  async function knownStale(id: string, name: string): Promise<boolean> {
    const was = notCurrent.get(name);
    if (was === undefined) return false;
    const now = await statDesign(id);
    if (was === 'missing' ? !now : same(was, now)) return true;
    // Saved again or back: that key may be the current one now.
    notCurrent.delete(name);
    return false;
  }

  return {
    async get(id: string, key: string): Promise<Thumb | null> {
      if (!SAFE_ID_RE.test(id) || !THUMB_KEY_RE.test(key)) return null;
      const known = await fromDisk(id, key);
      if (known !== undefined) return known;
      if (crashed.has(`${id}-${key}`) || (await knownStale(id, `${id}-${key}`))) return null;
      return ensure(id, key);
    },
    /**
     * Like get, but never holds a request long: the render is queued, and waited for (at most
     * `waitMs`) only when it is the first in line. 'pending' means it is not
     * there yet (the render stays queued).
     */
    async peek(id: string, key: string, waitMs: number): Promise<Thumb | null | 'pending'> {
      if (!SAFE_ID_RE.test(id) || !THUMB_KEY_RE.test(key)) return null;
      const known = await fromDisk(id, key);
      if (known !== undefined) return known;
      const name = `${id}-${key}`;
      if (crashed.has(name) || (await knownStale(id, name))) return null;
      const p = ensure(id, key);
      if (waitMs <= 0 || line[0] !== name) return 'pending';
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<'pending'>((r) => { timer = setTimeout(() => r('pending'), waitMs); });
      try {
        return await Promise.race([p, limit]);
      } finally { clearTimeout(timer); }
    },
    async drop(id: string): Promise<void> {
      if (!SAFE_ID_RE.test(id)) return;
      forget(id);
      await removeFiles(id);
    },
  };
}

/** The server's reader for the pictures: reads a design file only when a picture is drawn. */
export async function readDesignCode(file: string): Promise<{ code: string; values: unknown } | null> {
  try {
    const d = JSON.parse(await readFile(file, 'utf8'));
    return { code: typeof d.code === 'string' ? d.code : '', values: d.values };
  } catch { return null; }
}
