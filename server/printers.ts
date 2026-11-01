// The printers the user can pick: every Bambu Lab printer and nozzle in their Bambu Studio, plus the
// printer presets they saved in Bambu Studio themselves (when based on a Bambu Lab printer). Read
// only: nothing in Bambu Studio's folders is ever written.
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_PRINTERS, printerName, type Printer } from '../shared/printer';
import { bambuVersion, readPreset, resolvePreset, systemProfilesDir } from './bambu';

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** A resolved machine preset as a Printer, or null if it lacks what Jig needs. */
function toPrinter(r: Record<string, unknown>, id: string, custom: boolean): Printer | null {
  const nozzle = Number(first(r.nozzle_diameter)), height = Number(r.printable_height), model = r.printer_model;
  const area = (Array.isArray(r.printable_area) ? r.printable_area : []).map((p) => String(p).split('x').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
  if (typeof model !== 'string' || !model || !Number.isFinite(nozzle) || nozzle <= 0 || !Number.isFinite(height) || height <= 0 || area.length < 3) return null;
  const xs = area.map((p) => p[0]), ys = area.map((p) => p[1]);
  const process = r.default_print_profile, filament = first(r.default_filament_profile);
  return {
    id, name: custom ? id : printerName(model, nozzle), model, nozzle,
    bed: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], origin: [Math.min(...xs), Math.min(...ys)], height,
    structure: r.printer_structure === 'i3' ? 'bedslinger' : 'corexy',
    presets: typeof process === 'string' && typeof filament === 'string' ? { machine: id, process, filament } : null,
    custom,
  };
}

async function presetNames(dir: string): Promise<string[]> {
  const files = await readdir(path.join(dir, 'machine')).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

/** The first preset of the chain that is Bambu's own (in `systemDir`), or null if the chain never reaches one. */
async function systemAncestor(dirs: string[], systemDir: string, name: string): Promise<Record<string, unknown> | null> {
  for (let i = 0, n: unknown = name; i < 20 && typeof n === 'string' && n; i++) {
    const found = await readPreset(dirs, 'machine', n);
    if (!found) return null;
    if (found.dir === systemDir) return found.data;
    n = found.data.inherits;
  }
  return null;
}

/**
 * The printers in a Bambu Studio profiles folder (`systemDir`: BBL, with machine/ process/ filament/)
 * and the user's preset folders (`userDirs`: each with machine/…): Bambu's own first, by model and
 * nozzle, then the user's, by name. A user preset counts only if it is based on a Bambu Lab printer.
 */
export async function scanPrinters(systemDir: string, userDirs: string[]): Promise<Printer[]> {
  const builtIn: Printer[] = [];
  for (const name of await presetNames(systemDir)) {
    const raw = await readPreset([systemDir], 'machine', name).catch(() => null);
    if (raw?.data.type !== 'machine' || raw.data.instantiation !== 'true') continue;
    const p = await resolvePreset([systemDir], 'machine', name).then((r) => toPrinter(r, name, false), () => null);
    if (p) builtIn.push(p);
  }
  builtIn.sort((a, b) => a.model.localeCompare(b.model) || a.nozzle - b.nozzle);
  const dirs = [...userDirs, systemDir], ids = new Set(builtIn.map((p) => p.id)), mine: Printer[] = [];
  for (const userDir of userDirs) {
    for (const file of await presetNames(userDir)) {
      try {
        const raw = await readPreset([userDir], 'machine', file);
        const id = typeof raw?.data.name === 'string' && raw.data.name ? raw.data.name : file;
        if (!raw || raw.data.type !== 'machine' || typeof raw.data.inherits !== 'string' || ids.has(id)) continue;
        const parent = await systemAncestor(dirs, systemDir, raw.data.inherits);
        if (!parent || typeof parent.name !== 'string' || !parent.name.startsWith('Bambu Lab ')) continue;
        const p = toPrinter(await resolvePreset(dirs, 'machine', file), id, true);
        if (p) { mine.push(p); ids.add(id); }
      } catch {
        // An unreadable or broken preset is left out; the rest still load.
      }
    }
  }
  mine.sort((a, b) => a.name.localeCompare(b.name));
  return [...builtIn, ...mine];
}

/** Bambu Studio's settings folder for this platform (where it keeps the user's presets). */
function bambuConfigDir(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'BambuStudio');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'BambuStudio');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'BambuStudio');
}

/**
 * The user's preset folders: each folder in Bambu Studio's `user` folder (one per account, and
 * "default") that has a machine/ folder. BAMBU_STUDIO_USER_DIR points at that `user` folder
 * (in Docker: the mounted one).
 */
export async function bambuUserDirs(): Promise<string[]> {
  const root = process.env.BAMBU_STUDIO_USER_DIR?.trim() || path.join(bambuConfigDir(), 'user');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, 'machine'))).map((e) => path.join(root, e.name)).sort();
}

let cached: { version: string | null; list: Promise<Printer[]> } | null = null;

/**
 * Every printer the user can pick, read once per Bambu Studio version; the built-in list when
 * Bambu Studio isn't installed or its profiles can't be read. The user's presets are read again
 * after `refresh` (a preset saved in Bambu Studio shows up on the next Print tab visit).
 */
export async function listPrinters(refresh = false): Promise<Printer[]> {
  const version = await bambuVersion();
  if (!version) return BUILTIN_PRINTERS;
  if (!cached || cached.version !== version || refresh) {
    const list = (async () => {
      const found = await scanPrinters(await systemProfilesDir(), await bambuUserDirs());
      return found.length ? found : BUILTIN_PRINTERS;
    })();
    cached = { version, list };
    list.catch(() => { if (cached?.list === list) cached = null; });
  }
  return cached.list.catch(() => BUILTIN_PRINTERS);
}

/** Exposed for tests: forget the scanned list. */
export function forgetPrinters(): void {
  cached = null;
}

