// The Designs menu's pictures: drawn by the geometry worker, kept as files named by what they show.
// Derived data: not in backups, deleted with the design. This file knows nothing about Express.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Vec3 } from '../shared/types';
import { writeAtomically } from './routes/store';

/** Raise when the picture's look changes, so old pictures are drawn again. */
export const THUMB_VERSION = 1;

/** What a picture shows, as 16 hex characters: the code and its values. None for a design without code. */
export function thumbKey(code: string, values: unknown): string | null {
  if (!code) return null;
  return createHash('sha256').update(`${THUMB_VERSION}\n${code}\n${JSON.stringify(values ?? {})}`).digest('hex').slice(0, 16);
}

export const THUMB_KEY_RE = /^[0-9a-f]{16}$/;
const SAFE_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const FILE_RE = /^(.+)-([0-9a-f]{16})\.(png|json)$/;
const POLL_MS = 500;

export interface ThumbStoreOptions {
  dir: string;
  render: (code: string, values: unknown, signal: AbortSignal) => Promise<{ png?: string; size?: Vec3 }>;
  readDesign: (id: string) => Promise<{ code: string; values: unknown } | null>;
  /** True while a generation runs: nothing is drawn then. */
  busy: () => boolean;
}

export function thumbStore({ dir, render, readDesign, busy }: ThumbStoreOptions) {
  // Keys whose render crashed: not the design's fault, so nothing on disk, but not retried until a restart.
  const crashed = new Set<string>();
  const pending = new Map<string, Promise<{ file: string; size: Vec3 } | null>>();
  let queue: Promise<unknown> = Promise.resolve();
  const base = (id: string, key: string) => path.join(dir, `${id}-${key}`);

  async function fromDisk(id: string, key: string): Promise<{ file: string; size: Vec3 } | null | undefined> {
    let info: { size?: Vec3; failed?: boolean };
    try { info = JSON.parse(await readFile(`${base(id, key)}.json`, 'utf8')); } catch { return undefined; }
    if (info.failed || !info.size) return null;
    return { file: `${base(id, key)}.png`, size: info.size };
  }

  async function removeFiles(id: string, keep?: string) {
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const m = FILE_RE.exec(f);
      if (m && m[1] === id && m[2] !== keep) await rm(path.join(dir, f), { force: true });
    }
  }

  async function draw(id: string, key: string): Promise<{ file: string; size: Vec3 } | null> {
    while (busy()) await new Promise((r) => setTimeout(r, POLL_MS));
    const design = await readDesign(id);
    if (!design || thumbKey(design.code, design.values) !== key) return null;
    let out: { png?: string; size?: Vec3 } = {};
    try { out = await render(design.code, design.values, new AbortController().signal); } catch {
      crashed.add(`${id}-${key}`);
      return null;
    }
    // The design may have changed or gone while it was drawn: then this picture is not wanted.
    const now = await readDesign(id);
    if (!now || thumbKey(now.code, now.values) !== key) return null;
    try {
      await mkdir(dir, { recursive: true });
      if (!out.png || !out.size) {
        await writeAtomically(`${base(id, key)}.json`, JSON.stringify({ failed: true }));
        await removeFiles(id, key);
        return null;
      }
      await writeAtomically(`${base(id, key)}.png`, Buffer.from(out.png, 'base64'));
      await writeAtomically(`${base(id, key)}.json`, JSON.stringify({ size: out.size }));
      await removeFiles(id, key);
    } catch {
      // The disk refused (full, not writable): not the design's fault, not tried again until a restart.
      crashed.add(`${id}-${key}`);
      return null;
    }
    // Deleted between the check and the writes: nothing may stay behind.
    if (!(await readDesign(id))) { await removeFiles(id); return null; }
    return out.png && out.size ? { file: `${base(id, key)}.png`, size: out.size } : null;
  }

  /** The render of this picture, queued once per id-key; null at once for a key that is not the design's current one. */
  function ensure(id: string, key: string): Promise<{ file: string; size: Vec3 } | null> {
    const name = `${id}-${key}`;
    let p = pending.get(name);
    if (!p) {
      p = (async () => {
        const design = await readDesign(id);
        if (!design || thumbKey(design.code, design.values) !== key) return null;
        // One at a time; a failed job must not stop the ones behind it.
        const run = queue.then(() => draw(id, key)).catch(() => null);
        queue = run;
        return run;
      })().catch(() => null);
      pending.set(name, p);
      void p.finally(() => pending.delete(name));
    }
    return p;
  }

  return {
    async get(id: string, key: string): Promise<{ file: string; size: Vec3 } | null> {
      if (!SAFE_ID_RE.test(id) || !THUMB_KEY_RE.test(key)) return null;
      const known = await fromDisk(id, key);
      if (known !== undefined) return known;
      if (crashed.has(`${id}-${key}`)) return null;
      return ensure(id, key);
    },
    /**
     * Like get, but never waits long: the render is queued and waited for at most `waitMs`, and hardly
     * at all while a generation runs. 'pending' means it is not there yet (the render stays queued).
     */
    async peek(id: string, key: string, waitMs: number): Promise<{ file: string; size: Vec3 } | null | 'pending'> {
      if (!SAFE_ID_RE.test(id) || !THUMB_KEY_RE.test(key)) return null;
      const known = await fromDisk(id, key);
      if (known !== undefined) return known;
      if (crashed.has(`${id}-${key}`)) return null;
      const p = ensure(id, key);
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<'pending'>((r) => { timer = setTimeout(() => r('pending'), busy() ? Math.min(waitMs, 100) : waitMs); });
      try { return await Promise.race([p, limit]); } finally { clearTimeout(timer); }
    },
    async drop(id: string): Promise<void> {
      if (!SAFE_ID_RE.test(id)) return;
      await removeFiles(id);
    },
  };
}

/** The server's folder for the pictures: reads a design file only when a picture is asked for. */
export async function readDesignCode(file: string): Promise<{ code: string; values: unknown } | null> {
  try {
    const d = JSON.parse(await readFile(file, 'utf8'));
    return { code: typeof d.code === 'string' ? d.code : '', values: d.values };
  } catch { return null; }
}
