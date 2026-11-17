// Settings changed in the app, kept in the data folder and laid over process.env, so everything that
// reads a key from the environment (Claude Code and the other child programs too) sees them.
// settings.json holds the plain ones; secrets.json the keys and the provider address (mode 600).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config';
import { writeAtomically } from './routes/store';
import { SETTINGS, cleanSettingValue, maskSecret, settingProblem, type SettingDef, type SettingRow, type SettingsChange } from '../shared/settings';

/** A save refused; its message is safe to show and never contains a value. */
export class SettingsError extends Error {}

type Stored = Record<string, string>;
const SETTINGS_FILE = 'settings.json';
const SECRETS_FILE = 'secrets.json';
const LOCKED_REASON = 'Set ANTHROPIC_BASE_URL in .env, or set PTP_PASSWORD to change it here.';
const fileOf = (def: SettingDef) => (def.kind === 'secret' || def.restricted ? SECRETS_FILE : SETTINGS_FILE);
const defOf = (env: string) => SETTINGS.find((d) => d.env === env);

let dir: string | undefined;
/** What is set here, over both files. */
let saved: Stored = {};
/**
 * The environment's own value of each setting, taken the first time one is laid over and kept for the
 * life of the process: a later initSettings must not mistake a value it applied for the environment's.
 */
const baseline = new Map<string, string | undefined>();
let queue: Promise<unknown> = Promise.resolve();

function apply(env: string, value: string | undefined) {
  if (!baseline.has(env)) baseline.set(env, process.env[env]);
  const v = value ?? baseline.get(env);
  if (v === undefined) delete process.env[env];
  else process.env[env] = v;
}

/** The valid values of one file's own rows; a damaged file counts as empty and is left as it is. */
function readStored(file: string): Stored {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dir!, file), 'utf8'));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') console.warn(`[settings] Could not read ${file}: ${err.code ?? err.name}`);
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[settings] Could not read ${file}: not an object`);
    return {};
  }
  const out: Stored = {};
  for (const def of SETTINGS) {
    const v = (raw as Record<string, unknown>)[def.env];
    if (fileOf(def) === file && typeof v === 'string' && v && !settingProblem(def, v)) out[def.env] = v;
  }
  return out;
}

/** Remembers the environment's own values, then lays the saved ones over process.env. Idempotent per data folder. */
export function initSettings(dataDir: string = DATA_DIR): void {
  dir = dataDir;
  const next = { ...readStored(SETTINGS_FILE), ...readStored(SECRETS_FILE) };
  for (const env of Object.keys(saved)) if (!(env in next)) apply(env, undefined);
  for (const [env, v] of Object.entries(next)) apply(env, v);
  saved = next;
}

function folder(): string {
  if (dir === undefined) initSettings();
  return dir!;
}

async function write(file: string, values: Stored) {
  const own = Object.fromEntries(Object.entries(values).filter(([env]) => fileOf(defOf(env)!) === file));
  await mkdir(folder(), { recursive: true });
  await writeAtomically(path.join(folder(), file), `${JSON.stringify(own, null, 2)}\n`, 0o600);
}

/** One save or reset at a time, each on top of the last, so two tabs saving never lose each other's rows. */
function serially<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

/** Validates all, then writes and applies; throws SettingsError (message safe to show, never containing a value) and changes nothing on any problem. */
export function saveSettings(change: SettingsChange, opts: { allowRestricted: boolean }): Promise<void> {
  return serially(async () => {
    folder();
    const next = { ...saved };
    const files = new Set<string>();
    for (const [env, raw] of Object.entries(change)) {
      const def = defOf(env);
      if (!def) throw new SettingsError('Unknown setting.');
      if (def.restricted && !opts.allowRestricted) throw new SettingsError(LOCKED_REASON);
      if (raw !== null && typeof raw !== 'string') throw new SettingsError(`${def.label} must be text.`);
      const v = raw === null ? '' : cleanSettingValue(raw);
      const problem = v ? settingProblem(def, v) : undefined;
      if (problem) throw new SettingsError(problem);
      if (v) next[env] = v;
      else delete next[env];
      files.add(fileOf(def));
    }
    // Only a file whose rows changed is written, so a damaged one stays as it is until a save touches it.
    for (const file of files) await write(file, next);
    for (const env of new Set([...Object.keys(saved), ...Object.keys(next)])) if (saved[env] !== next[env]) apply(env, next[env]);
    saved = next;
  });
}

/** Removes everything set here. */
export function resetSettings(): Promise<void> {
  return serially(async () => {
    for (const file of [SETTINGS_FILE, SECRETS_FILE]) if (existsSync(path.join(folder(), file))) await write(file, {});
    for (const env of Object.keys(saved)) apply(env, undefined);
    saved = {};
  });
}

export function settingRows(opts: { allowRestricted: boolean }): SettingRow[] {
  folder();
  return SETTINGS.map((def) => {
    const value = process.env[def.env]?.trim() ? process.env[def.env]! : undefined;
    const locked = !!def.restricted && !opts.allowRestricted;
    return {
      env: def.env,
      source: def.env in saved ? 'here' : value !== undefined ? 'env' : 'unset',
      ...(value === undefined ? {} : def.kind === 'secret' ? { preview: maskSecret(value) } : { value }),
      editable: !locked,
      ...(locked ? { lockedReason: LOCKED_REASON } : {}),
    };
  });
}
