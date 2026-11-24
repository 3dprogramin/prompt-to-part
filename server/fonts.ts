// Font catalog: bundled open-licence fonts (@fontsource) + fonts installed on this machine
// (fontconfig's fc-list on Linux, otherwise the system font folders of macOS and Windows).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './config';
import type { FontEntry } from '../shared/api';
import { STANDARD_FONTS, normalFontName as normal, standardFontFiles, standardFontId, type StandardFont } from '../shared/fontCatalog';


const FONTSOURCE = path.join(ROOT, 'node_modules', '@fontsource');

/** A bundled font's files that exist on disk. */
const standardFiles = (f: StandardFont): string[] => standardFontFiles(f).map((rel) => path.join(FONTSOURCE, rel)).filter((p) => existsSync(p));

let installed: (FontEntry & { file: string })[] | null = null;

async function installedFonts() {
  if (installed) return installed;
  let found: [string, string, string][];
  try {
    const { stdout } = await promisify(execFile)('fc-list', ['--format', '%{family[0]}\t%{style[0]}\t%{file}\n'], { maxBuffer: 16 * 1024 * 1024 });
    found = stdout.split('\n').map((l) => l.split('\t') as [string, string, string]);
  } catch {
    found = await scanFontFolders(systemFontFolders());
  }
  const seen = new Set<string>();
  installed = found
    .filter(([fam, , file]) => fam && file && /\.(ttf|otf)$/i.test(file))
    .map(([family, style, file]) => ({ id: `sys:${family}|${style || 'Regular'}`, family, style: style || 'Regular', source: 'installed' as const, file }))
    .filter((f) => !seen.has(f.id) && (seen.add(f.id), true))
    .sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style));
  return installed;
}

/**
 * Family and style from a TTF/OTF file's `name` table, read directly: parsing whole fonts with
 * opentype.js would take seconds for a system's fonts.
 */
export function fontNames(b: Buffer): { family: string; style: string } | null {
  const tables = b.readUInt16BE(4);
  let at = -1;
  for (let i = 0; i < tables; i++) if (b.toString('latin1', 12 + i * 16, 16 + i * 16) === 'name') at = b.readUInt32BE(20 + i * 16);
  if (at < 0) return null;
  const count = b.readUInt16BE(at + 2), strings = at + b.readUInt16BE(at + 4);
  const found: Record<number, { text: string; rank: number }> = {};
  for (let i = 0; i < count; i++) {
    const r = at + 6 + i * 12;
    const [platform, , language, id, length, offset] = [0, 2, 4, 6, 8, 10].map((o) => b.readUInt16BE(r + o));
    if (![1, 2, 16, 17].includes(id)) continue;
    const raw = b.subarray(strings + offset, strings + offset + length);
    // Windows (UTF-16BE), US English first; Mac Roman as the fallback.
    const rank = platform === 3 ? (language === 0x409 ? 0 : 1) : platform === 1 ? 2 : 3;
    const text = platform === 1 ? raw.toString('latin1') : Buffer.from(raw).swap16().toString('utf16le');
    if (!found[id] || rank < found[id].rank) found[id] = { text, rank };
  }
  const family = (found[16] ?? found[1])?.text;
  return family ? { family, style: (found[17] ?? found[2])?.text ?? 'Regular' } : null;
}

/** Where macOS and Windows keep installed fonts (Linux has fontconfig). */
function systemFontFolders(): string[] {
  if (process.platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts')];
  if (process.platform === 'win32') {
    return [path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')] : [])];
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.local', 'share', 'fonts')];
}

/** [family, style, file] of every TTF/OTF font in these folders (and their subfolders). */
export async function scanFontFolders(folders: string[]): Promise<[string, string, string][]> {
  const out: [string, string, string][] = [];
  const walk = async (dir: string, depth: number) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) await walk(file, depth + 1);
      else if (/\.(ttf|otf)$/i.test(e.name)) {
        try {
          const names = fontNames(await readFile(file));
          if (names) out.push([names.family, names.style, file]);
        } catch { /* not a font we can read */ }
      }
    }
  };
  for (const f of folders) await walk(f, 0);
  return out;
}

export async function listFonts(): Promise<FontEntry[]> {
  const std: FontEntry[] = STANDARD_FONTS.filter((s) => standardFiles(s).length).map((s) => ({ id: standardFontId(s), family: s.family, style: s.style, source: 'standard' }));
  const sys = (await installedFonts()).map(({ file: _f, ...rest }) => rest);
  return [...std, ...sys];
}

const REGULAR = ['regular', 'book', 'normal', 'roman', 'medium'];

/** Resolve an id, or a loose name like "Bangers" / "Roboto Bold", to font files. */
export async function resolveFontFiles(name: string): Promise<string[]> {
  const std = STANDARD_FONTS.find((s) => standardFontId(s) === name);
  if (std) return standardFiles(std);
  const sys = await installedFonts();
  const exact = sys.find((f) => f.id === name);
  if (exact) return [exact.file];
  const q = normal(name.replace(/^(std|sys):/, ''));
  const all = [
    ...STANDARD_FONTS.map((s) => ({ key: normal(s.family + s.style), fam: normal(s.family), style: normal(s.style), files: () => standardFiles(s) })),
    ...sys.map((f) => ({ key: normal(f.family + f.style), fam: normal(f.family), style: normal(f.style), files: () => [f.file] })),
  ];
  const hit = all.find((f) => f.key === q)
    ?? all.find((f) => f.fam === q && REGULAR.includes(f.style))
    ?? all.find((f) => f.fam === q)
    ?? all.find((f) => f.key.startsWith(q));
  if (!hit) throw new Error(`Unknown font "${name}"`);
  return hit.files();
}

export async function loadFontBuffers(name: string): Promise<ArrayBuffer[]> {
  const files = await resolveFontFiles(name);
  if (!files.length) throw new Error(`No files for font "${name}"`);
  return Promise.all(files.map(async (f) => { const b = await readFile(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; }));
}
