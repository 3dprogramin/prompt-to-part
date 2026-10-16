// .blend export through a headless Blender process.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BLENDER = process.env.BLENDER_PATH || 'blender';
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'blender_export.py');

export interface BlendRequest {
  name: string;
  code?: string;
  params?: Record<string, number | boolean | string>;
  size?: number;
  parts: { name: string; color: string; positions: string; indices: string }[]; // base64 float32 / uint32
  dimensions?: { label: string; from: number[]; to: number[]; offset?: number[]; color?: string }[];
}

let version: string | null | undefined;

export async function blenderVersion(): Promise<string | null> {
  if (version !== undefined) return version;
  try {
    const { stdout } = await run(BLENDER, ['--version'], { timeout: 20000 });
    version = /Blender\s+([\d.]+(?:\s+\w+)?)/.exec(stdout)?.[1] ?? 'unknown';
  } catch {
    version = null;
  }
  return version;
}

export async function exportBlend(req: BlendRequest): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-designer-blend-'));
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
      await run(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', SCRIPT, '--', dir, out], { timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
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
