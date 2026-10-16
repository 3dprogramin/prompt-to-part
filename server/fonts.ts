// Font catalog: bundled open-licence fonts (@fontsource) + fonts installed on this machine (fc-list).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export interface FontEntry { id: string; family: string; style: string; source: 'standard' | 'installed' }

const STANDARD: { pkg: string; family: string; weight: number; style: string }[] = [
  { pkg: 'roboto', family: 'Roboto', weight: 400, style: 'Regular' },
  { pkg: 'roboto', family: 'Roboto', weight: 700, style: 'Bold' },
  { pkg: 'roboto', family: 'Roboto', weight: 900, style: 'Black' },
  { pkg: 'inter', family: 'Inter', weight: 400, style: 'Regular' },
  { pkg: 'inter', family: 'Inter', weight: 700, style: 'Bold' },
  { pkg: 'montserrat', family: 'Montserrat', weight: 700, style: 'Bold' },
  { pkg: 'montserrat', family: 'Montserrat', weight: 900, style: 'Black' },
  { pkg: 'oswald', family: 'Oswald', weight: 600, style: 'SemiBold' },
  { pkg: 'roboto-mono', family: 'Roboto Mono', weight: 700, style: 'Bold' },
  { pkg: 'bebas-neue', family: 'Bebas Neue', weight: 400, style: 'Regular' },
  { pkg: 'black-ops-one', family: 'Black Ops One', weight: 400, style: 'Regular' },
  { pkg: 'allerta-stencil', family: 'Allerta Stencil', weight: 400, style: 'Regular' },
  { pkg: 'pacifico', family: 'Pacifico', weight: 400, style: 'Regular' },
  { pkg: 'lobster', family: 'Lobster', weight: 400, style: 'Regular' },
];

const FONTSOURCE = path.resolve(process.cwd(), 'node_modules/@fontsource');
const stdId = (pkg: string, weight: number) => `std:${pkg}-${weight}`;

function standardFiles(pkg: string, weight: number): string[] {
  return ['latin', 'latin-ext']
    .map((sub) => path.join(FONTSOURCE, pkg, 'files', `${pkg}-${sub}-${weight}-normal.woff`))
    .filter((f) => existsSync(f));
}

let installed: (FontEntry & { file: string })[] | null = null;

async function installedFonts() {
  if (installed) return installed;
  try {
    const { stdout } = await promisify(execFile)('fc-list', ['--format', '%{family[0]}\t%{style[0]}\t%{file}\n'], { maxBuffer: 16 * 1024 * 1024 });
    const seen = new Set<string>();
    installed = stdout.split('\n')
      .map((l) => l.split('\t'))
      .filter(([fam, , file]) => fam && file && /\.(ttf|otf)$/i.test(file))
      .map(([family, style, file]) => ({ id: `sys:${family}|${style || 'Regular'}`, family, style: style || 'Regular', source: 'installed' as const, file }))
      .filter((f) => !seen.has(f.id) && (seen.add(f.id), true))
      .sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style));
  } catch {
    installed = [];
  }
  return installed;
}

export async function listFonts(): Promise<FontEntry[]> {
  const std: FontEntry[] = STANDARD.filter((s) => standardFiles(s.pkg, s.weight).length).map((s) => ({ id: stdId(s.pkg, s.weight), family: s.family, style: s.style, source: 'standard' }));
  const sys = (await installedFonts()).map(({ file: _f, ...rest }) => rest);
  return [...std, ...sys];
}

const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const REGULAR = ['regular', 'book', 'normal', 'roman', 'medium'];

/** Resolve an id, or a loose name like "Bangers" / "Roboto Bold", to font files. */
export async function resolveFontFiles(name: string): Promise<string[]> {
  const std = STANDARD.find((s) => stdId(s.pkg, s.weight) === name);
  if (std) return standardFiles(std.pkg, std.weight);
  const sys = await installedFonts();
  const exact = sys.find((f) => f.id === name);
  if (exact) return [exact.file];
  const q = normal(name.replace(/^(std|sys):/, ''));
  const all = [
    ...STANDARD.map((s) => ({ key: normal(s.family + s.style), fam: normal(s.family), style: normal(s.style), files: () => standardFiles(s.pkg, s.weight) })),
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
