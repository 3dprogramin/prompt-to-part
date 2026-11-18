// The Designs menu's pictures: drawn by the geometry worker, kept as files named by what they show.
// Derived data: not in backups, deleted with the design. This file knows nothing about Express.
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
const POLL_MS = 500;

/** A design file's time and size: what tells that it changed, without reading it. */
export interface DesignStat { mtimeMs: number; size: number }
type Thumb = { file: string; size: Vec3 };
/** A render stopped by a generation: nothing written, nothing remembered, the next ask queues it again. */
type Stopped = 'stopped';

export interface ThumbStoreOptions {
  dir: string;
  render: (code: string, values: unknown, signal: AbortSignal) => Promise<{ png?: string; size?: Vec3 }>;
  /** The design's code and values, read once per picture drawn. */
  readDesign: (id: string) => Promise<{ code: string; values: unknown } | null>;
  /** The design file's time and size, or null when it is gone. */
  statDesign: (id: string) => Promise<DesignStat | null>;
  /** True while a generation runs: nothing is drawn then, and a render under way is stopped. */
  busy: () => boolean;
  /** The running app's build: a design that failed in another build is tried again. */
  build: string;
}

export function thumbStore({ dir, render, readDesign, statDesign, busy, build }: ThumbStoreOptions) {
  // Keys whose render crashed: not the design's fault, so nothing on disk, but not retried until a restart.
  const crashed = new Set<string>();
  const pending = new Map<string, Promise<Thumb | null | Stopped>>();
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

  async function draw(id: string, key: string): Promise<Thumb | null | Stopped> {
    const name = `${id}-${key}`;
    while (busy()) await new Promise((r) => setTimeout(r, POLL_MS));
    // The time and size before the read: a save after it shows when they are compared again.
    const before = await statDesign(id);
    if (!before) return null;
    const design = await readDesign(id);
    if (!design || thumbKey(design.code, design.values) !== key) return null;
    // A generation may have started while the design was read.
    if (busy()) return 'stopped';
    const ac = new AbortController();
    const watch = setInterval(() => { if (busy()) ac.abort(); }, POLL_MS);
    let out: { png?: string; size?: Vec3 } = {};
    try { out = await render(design.code, design.values, ac.signal); } catch {
      if (ac.signal.aborted) return 'stopped';
      crashed.add(name);
      return null;
    } finally { clearInterval(watch); }
    if (ac.signal.aborted) return 'stopped';
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
  function ensure(id: string, key: string): Promise<Thumb | null | Stopped> {
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

  return {
    async get(id: string, key: string): Promise<Thumb | null> {
      if (!SAFE_ID_RE.test(id) || !THUMB_KEY_RE.test(key)) return null;
      const known = await fromDisk(id, key);
      if (known !== undefined) return known;
      if (crashed.has(`${id}-${key}`)) return null;
      const r = await ensure(id, key);
      return r === 'stopped' ? null : r;
    },
    /**
     * Like get, but never holds a request long: the render is queued, and waited for (at most
     * `waitMs`) only when it is the first in line and no generation runs. 'pending' means it is not
     * there yet (the render stays queued).
     */
    async peek(id: string, key: string, waitMs: number): Promise<Thumb | null | 'pending'> {
      if (!SAFE_ID_RE.test(id) || !THUMB_KEY_RE.test(key)) return null;
      const known = await fromDisk(id, key);
      if (known !== undefined) return known;
      const name = `${id}-${key}`;
      if (crashed.has(name)) return null;
      const p = ensure(id, key);
      if (waitMs <= 0 || busy() || line[0] !== name) return 'pending';
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<'pending'>((r) => { timer = setTimeout(() => r('pending'), waitMs); });
      try {
        const r = await Promise.race([p, limit]);
        return r === 'stopped' ? 'pending' : r;
      } finally { clearTimeout(timer); }
    },
    async drop(id: string): Promise<void> {
      if (!SAFE_ID_RE.test(id)) return;
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
