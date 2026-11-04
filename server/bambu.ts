// Bambu Studio integration: builds the project template for the chosen printer (its machine preset
// with its default process and PLA filament presets) from the user's own Bambu Studio install
// (nothing from Bambu is bundled), cached per printer in data/bambu/templates.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { unzipSync, strFromU8 } from 'fflate';
import { DATA_DIR } from './config';
import { DEFAULT_PRINTER, printer, type Printer } from '../shared/printer';
import type { BambuTemplate } from '../shared/api';
import { defaultsFromTemplate, type PrintSettings } from '../shared/print';
import { findExecutable, installDirs } from './which';

const run = promisify(execFile);
/** The one template the app had before printers could be chosen: the A1 0.4's. */
const LEGACY_CACHE = path.join(DATA_DIR, 'bambu', 'template.json');

/** Where a printer's template is cached: data/bambu/templates/<preset name as a slug>.json. */
export function templateFile(p: Printer): string {
  return path.join(DATA_DIR, 'bambu', 'templates', `${p.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`);
}

async function readCached(p: Printer): Promise<BambuTemplate | null> {
  const file = templateFile(p);
  if (!existsSync(file) && p.id === DEFAULT_PRINTER.id && existsSync(LEGACY_CACHE)) {
    await mkdir(path.dirname(file), { recursive: true });
    await rename(LEGACY_CACHE, file);
  }
  return readFile(file, 'utf8').then((t) => JSON.parse(t) as BambuTemplate, () => null);
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
 * (in Docker: the mounted one). Read only.
 */
export async function bambuUserDirs(): Promise<string[]> {
  const root = process.env.BAMBU_STUDIO_USER_DIR?.trim() || path.join(bambuConfigDir(), 'user');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, 'machine'))).map((e) => path.join(root, e.name)).sort();
}

export async function findBambuBinary(): Promise<string | null> {
  return findExecutable([
    process.env.BAMBU_STUDIO_PATH, 'bambustudio', 'bambu-studio', 'BambuStudio',
    ...installDirs(['Bambu Studio/bambu-studio.exe'], ['/Applications/BambuStudio.app/Contents/MacOS/BambuStudio']),
  ]);
}

let versionCache: string | null | undefined;
export async function bambuVersion(): Promise<string | null> {
  if (versionCache !== undefined) return versionCache;
  const bin = await findBambuBinary();
  if (!bin) return (versionCache = null);
  try {
    // Bambu Studio writes a result.json into its working directory – keep that out of the project.
    const { stdout } = await run(bin, ['--help'], { cwd: os.tmpdir(), timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    versionCache = /BambuStudio-([\d.]+)/.exec(stdout)?.[1] ?? 'installed';
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? '');
    versionCache = /BambuStudio-([\d.]+)/.exec(out)?.[1] ?? null;
  }
  return versionCache;
}

/** Profiles directory (resources/profiles/BBL) – extracted from the AppImage when needed. */
async function profilesDir(bin: string, work: string): Promise<string> {
  const header = Buffer.alloc(11);
  const fh = await open(bin, 'r');
  await fh.read(header, 0, 11, 0);
  await fh.close();
  const isAppImage = header.subarray(8, 11).toString('latin1') === 'AI\x02';
  if (isAppImage) {
    for (const kind of ['machine', 'process', 'filament']) {
      await run(bin, ['--appimage-extract', `resources/profiles/BBL/${kind}/*`], { cwd: work, timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
    }
    return path.join(work, 'squashfs-root', 'resources', 'profiles', 'BBL');
  }
  const real = await realpath(bin);
  // Linux packages, Windows (resources next to the .exe) and macOS (Contents/Resources in the .app).
  const roots = [path.join(path.dirname(real), '..', 'resources'), path.join(path.dirname(real), 'resources'), path.join(path.dirname(real), '..', 'Resources'),
    '/usr/share/bambu-studio/resources', '/opt/bambu-studio/resources', '/usr/share/BambuStudio/resources'];
  for (const r of roots) if (existsSync(path.join(r, 'profiles', 'BBL', 'process'))) return path.join(r, 'profiles', 'BBL');
  throw new Error('Could not find Bambu Studio printer profiles');
}

/** A preset file as it is (not resolved): the first of `dirs` (each holding machine/, process/, filament/) that has it, or null. */
export async function readPreset(dirs: string[], kind: string, name: string): Promise<{ data: Record<string, unknown>; dir: string } | null> {
  for (const dir of dirs) {
    const text = await readFile(path.join(dir, kind, `${name}.json`), 'utf8').catch(() => null);
    if (text != null) return { data: JSON.parse(text) as Record<string, unknown>, dir };
  }
  return null;
}

/** A preset with its `inherits` chain merged in, looked up in `dirs` in order (the user's presets first, then Bambu's). */
export async function resolvePreset(dirs: string[], kind: string, name: string, depth = 0): Promise<Record<string, unknown>> {
  const found = await readPreset(dirs, kind, name);
  if (!found) throw new Error(`Bambu Studio has no ${kind} preset "${name}"`);
  if (depth > 20) throw new Error(`The ${kind} preset "${name}" inherits in a loop`);
  const d = found.data;
  const base = typeof d.inherits === 'string' && d.inherits ? await resolvePreset(dirs, kind, d.inherits, depth + 1) : {};
  return { ...base, ...d };
}

let systemDir: Promise<string> | null = null;

/**
 * Bambu Studio's own profiles (resources/profiles/BBL): in place for an installed Bambu Studio, or
 * extracted once per version from an AppImage into data/bambu/profiles.
 */
export function systemProfilesDir(): Promise<string> {
  systemDir ??= (async () => {
    const bin = await findBambuBinary();
    if (!bin) throw new Error('Bambu Studio was not found on this computer');
    const version = (await bambuVersion()) ?? 'unknown';
    const target = path.join(DATA_DIR, 'bambu', 'profiles', version.replace(/[^\w.-]/g, '_'));
    const done = path.join(target, '.done');
    if (existsSync(done)) return readFile(done, 'utf8');
    await mkdir(target, { recursive: true });
    const dir = await profilesDir(bin, target);
    await writeFile(done, dir);
    return dir;
  })();
  systemDir.catch(() => { systemDir = null; });
  return systemDir;
}

function cubeStl(): Buffer {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + f.length * 50);
  buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => {
    let o = 84 + i * 50 + 12;
    for (const k of t) for (const c of v[k]) { buf.writeFloatLE(c, o); o += 4; }
  });
  return buf;
}

async function projectSettings(bin: string, work: string, filaments: number): Promise<Record<string, unknown>> {
  const outDir = path.join(work, `out${filaments}`);
  await mkdir(outDir, { recursive: true });
  const fil = Array(filaments).fill(path.join(work, 'filament.json')).join(';');
  await run(bin, ['--load-settings', `${path.join(work, 'machine.json')};${path.join(work, 'process.json')}`, '--load-filaments', fil,
    path.join(work, 'cube.stl'), '--export-3mf', 'p.3mf', '--outputdir', outDir], { cwd: work, timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const zip = unzipSync(new Uint8Array(await readFile(path.join(outDir, 'p.3mf'))));
  return JSON.parse(strFromU8(zip['Metadata/project_settings.config'])) as Record<string, unknown>;
}

/**
 * The baseline print settings of the printer's template if it has been built, or null (building
 * one runs Bambu Studio for minutes, so it is never started here).
 */
export async function cachedPrintDefaults(p: Printer = printer()): Promise<Required<PrintSettings> | null> {
  const tpl = await readCached(p).catch(() => null);
  return tpl ? defaultsFromTemplate(tpl.settings) : null;
}

/** The printer's three presets, resolved (the user's own presets first, then Bambu's). */
async function printerPresets(p: Printer): Promise<{ kind: string; name: string; preset: Record<string, unknown> }[]> {
  if (!p.presets) throw new Error(`Pick a Bambu Studio printer: ${p.name} has no Bambu Studio presets`);
  const dirs = [...(p.custom ? await bambuUserDirs() : []), await systemProfilesDir()];
  return Promise.all(Object.entries(p.presets).map(async ([kind, name]) => ({ kind, name, preset: await resolvePreset(dirs, kind, name) })));
}

const presetHash = (presets: { preset: Record<string, unknown> }[]) => createHash('sha256').update(JSON.stringify(presets.map((x) => x.preset))).digest('hex').slice(0, 16);

const pending = new Map<string, Promise<BambuTemplate>>();

/** The printer's project template: cached, or built now (minutes) when there is none, or Bambu Studio or the presets changed. */
export async function bambuTemplate(p: Printer = printer()): Promise<BambuTemplate> {
  // Bambu Studio 2.8's command line fails to slice the app's projects on two-nozzle printers.
  if (p.extruders > 1) throw new Error(`The Bambu Studio project isn't supported for the ${p.name} yet (two nozzles): export a plain 3MF and set it up in Bambu Studio`);
  const presets = await printerPresets(p);
  const version = (await bambuVersion()) ?? 'unknown', hash = presetHash(presets);
  const cached = await readCached(p);
  // Templates from before printers could be chosen have no hash: the version alone decides.
  if (cached && cached.version === version && (cached.presetHash ?? hash) === hash) return cached;
  let job = pending.get(p.id);
  if (!job) {
    job = (async () => {
      const bin = await findBambuBinary();
      if (!bin) throw new Error('Bambu Studio was not found on this computer');
      const work = await mkdtemp(path.join(os.tmpdir(), 'ptp-bambu-'));
      try {
        for (const { kind, name, preset } of presets) {
          const out = { ...preset };
          delete out.inherits;
          out.from = 'system';
          out.name = name;
          await writeFile(path.join(work, `${kind}.json`), JSON.stringify(out));
        }
        await writeFile(path.join(work, 'cube.stl'), cubeStl());
        const one = await projectSettings(bin, work, 1);
        const three = await projectSettings(bin, work, 3);
        const perFilament: string[] = [], perFilamentPlus2: string[] = [];
        for (const [k, v] of Object.entries(one)) {
          const t = three[k];
          if (!Array.isArray(v) || !Array.isArray(t)) continue;
          if (v.length === 1 && t.length === 3) perFilament.push(k);
          else if (t.length === v.length + 2) perFilamentPlus2.push(k);
        }
        // filament_map / filament_self_index are written inconsistently by the CLI - always per filament.
        for (const k of ['filament_map', 'filament_self_index', 'filament_colour']) if (!perFilament.includes(k) && k in one) perFilament.push(k);
        const tpl: BambuTemplate = { version, presetHash: hash, settings: one, perFilament, perFilamentPlus2 };
        const file = templateFile(p);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(tpl));
        return tpl;
      } finally {
        await rm(work, { recursive: true, force: true });
        pending.delete(p.id);
      }
    })();
    pending.set(p.id, job);
  }
  return job;
}
