// Finds installed programs (Bambu Studio, Blender) on Linux, macOS and Windows without a shell.
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Default install locations that are not on PATH. */
export function installDirs(win: string[], mac: string[]): string[] {
  if (process.platform === 'darwin') return mac;
  if (process.platform !== 'win32') return [];
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((r): r is string => !!r);
  return roots.flatMap((r) => win.flatMap((rel) => expand(path.join(r, rel))));
}

/** Expands one `*` directory segment (e.g. "Blender Foundation/*\/blender.exe"), newest name first. */
function expand(p: string): string[] {
  const i = p.indexOf('*');
  if (i < 0) return [p];
  const dir = path.dirname(p.slice(0, i + 1));
  const rest = p.slice(i + 2);
  try {
    return readdirSync(dir).sort().reverse().map((d) => path.join(dir, d, rest));
  } catch {
    return [];
  }
}

/** The first candidate that is an executable file: a path as given, or a bare name looked up on PATH. */
export function findExecutable(candidates: (string | undefined)[]): string | null {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const c of candidates) {
    if (!c) continue;
    const tries = /[\\/]/.test(c) ? [path.resolve(c)] : dirs.map((d) => path.join(d, c));
    for (const t of tries) for (const e of exts) if (isExecutable(t + e)) return t + e;
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
