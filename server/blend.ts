// .blend export through a headless Blender process.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findExecutable, installDirs } from './which';
import type { BlendRequest } from '../shared/api';

const run = promisify(execFile);
const blenderPath = () => findExecutable([
  process.env.BLENDER_PATH, 'blender',
  ...installDirs(['Blender Foundation/*/blender.exe'], ['/Applications/Blender.app/Contents/MacOS/Blender']),
]);
/** blender_export.py uses Mesh.set_sharp_from_angle, new in Blender 4.1. */
const MIN_VERSION = [4, 1];
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'blender_export.py');

export interface BlenderInfo {
  version: string;
  /** Why .blend export can't use this Blender (too old), or null. */
  problem: string | null;
}

let info: Promise<BlenderInfo | null> | undefined;

/** The installed Blender, or null if there is none. */
export function blenderInfo(): Promise<BlenderInfo | null> {
  info ??= (async () => {
    const bin = blenderPath();
    if (!bin) return null;
    try {
      const { stdout } = await run(bin, ['--version'], { timeout: 20000 });
      const version = /Blender\s+([\d.]+(?:\s+\w+)?)/.exec(stdout)?.[1] ?? 'unknown';
      const [major, minor] = version.split('.').map(Number);
      const old = major < MIN_VERSION[0] || (major === MIN_VERSION[0] && minor < MIN_VERSION[1]);
      return { version, problem: old ? `Blender ${version} is too old – .blend export needs Blender ${MIN_VERSION.join('.')} or newer` : null };
    } catch {
      return null;
    }
  })();
  return info;
}

export async function exportBlend(req: BlendRequest): Promise<Buffer> {
  const blender = await blenderInfo();
  if (!blender) throw new Error('Blender was not found on this computer');
  if (blender.problem) throw new Error(blender.problem);
  const bin = blenderPath()!;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jig-blend-'));
  try {
    const parts = await Promise.all(req.parts.map(async (p, i) => {
      await writeFile(path.join(dir, `p${i}.pos`), Buffer.from(p.positions, 'base64'));
      await writeFile(path.join(dir, `p${i}.idx`), Buffer.from(p.indices, 'base64'));
      return { name: p.name, color: p.color, positions: `p${i}.pos`, indices: `p${i}.idx` };
    }));
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
      name: req.name, code: req.code, params: req.params ?? {}, size: req.size, parts, dimensions: req.dimensions ?? [],
    }));
    const out = path.join(dir, 'model.blend');
    try {
      await run(bin, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', SCRIPT, '--', dir, out], { timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message: string };
      const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.split('\n').filter((l) => /error|Error|Traceback/.test(l)).slice(-6).join('\n');
      throw new Error(`Blender export failed: ${tail || err.message}`);
    }
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
