// Bambu Studio integration: builds the A1 + PLA + 0.20 mm Standard project template from the
// user's own Bambu Studio install (nothing from Bambu is bundled), cached in data/bambu.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { unzipSync, strFromU8 } from 'fflate';
import { DATA_DIR } from './config';
import { PRINTER } from '../shared/printer';
import type { BambuTemplate } from '../shared/api';
import { defaultsFromTemplate, type PrintSettings } from '../shared/print';
import { findExecutable, installDirs } from './which';

const run = promisify(execFile);
const CACHE = path.join(DATA_DIR, 'bambu', 'template.json');
const PRESETS = PRINTER.bambu;

async function findBinary(): Promise<string | null> {
  return findExecutable([
    process.env.BAMBU_STUDIO_PATH, 'bambustudio', 'bambu-studio', 'BambuStudio',
    ...installDirs(['Bambu Studio/bambu-studio.exe'], ['/Applications/BambuStudio.app/Contents/MacOS/BambuStudio']),
  ]);
}

let versionCache: string | null | undefined;
export async function bambuVersion(): Promise<string | null> {
  if (versionCache !== undefined) return versionCache;
  const bin = await findBinary();
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

async function resolvePreset(dir: string, kind: string, name: string): Promise<Record<string, unknown>> {
  const d = JSON.parse(await readFile(path.join(dir, kind, `${name}.json`), 'utf8')) as Record<string, unknown>;
  const base = typeof d.inherits === 'string' && d.inherits ? await resolvePreset(dir, kind, d.inherits) : {};
  return { ...base, ...d };
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
 * The baseline print settings of the template already built from the user's Bambu Studio, or null
 * if there is none yet (building one runs Bambu Studio for minutes, so it is never started here).
 */
export async function cachedPrintDefaults(): Promise<Required<PrintSettings> | null> {
  try {
    return defaultsFromTemplate((JSON.parse(await readFile(CACHE, 'utf8')) as BambuTemplate).settings);
  } catch {
    return null;
  }
}

let pending: Promise<BambuTemplate> | null = null;

export async function bambuTemplate(): Promise<BambuTemplate> {
  if (existsSync(CACHE)) {
    const cached = JSON.parse(await readFile(CACHE, 'utf8')) as BambuTemplate;
    if (cached.version === (await bambuVersion())) return cached;
  }
  pending ??= (async () => {
    const bin = await findBinary();
    if (!bin) throw new Error('Bambu Studio was not found on this computer');
    const work = await mkdtemp(path.join(os.tmpdir(), 'jig-bambu-'));
    try {
      const dir = await profilesDir(bin, work);
      for (const [kind, name] of Object.entries(PRESETS)) {
        const p = await resolvePreset(dir, kind, name);
        delete p.inherits;
        p.from = 'system';
        p.name = name;
        await writeFile(path.join(work, `${kind}.json`), JSON.stringify(p));
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
      // filament_map / filament_self_index are written inconsistently by the CLI – always per filament.
      for (const k of ['filament_map', 'filament_self_index', 'filament_colour']) if (!perFilament.includes(k) && k in one) perFilament.push(k);
      const tpl: BambuTemplate = { version: (await bambuVersion()) ?? 'unknown', settings: one, perFilament, perFilamentPlus2 };
      await mkdir(path.dirname(CACHE), { recursive: true });
      await writeFile(CACHE, JSON.stringify(tpl));
      return tpl;
    } finally {
      await rm(work, { recursive: true, force: true });
      pending = null;
    }
  })();
  return pending;
}
