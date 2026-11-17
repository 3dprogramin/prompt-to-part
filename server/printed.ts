import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config';
import { DESIGNS, ID_RE, isDesign, writeAtomically } from './routes/store';
import { BACK_TEXT_KEY } from '../shared/backText';
import { designKind } from '../shared/designKind';
import { cleanPrintedMap, PRINTED_FILE, type PrintedMap, type PrintedMark } from '../shared/printed';
import type { Design, DesignVersion } from '../shared/types';

/** JSON with object keys sorted at every depth, so equal content gives equal text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x) ?? 'null').join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** What makes a version the same print: its code and values (not its summary or date). */
export const versionFingerprint = (v: Pick<DesignVersion, 'code' | 'values'>) =>
  createHash('sha256').update(canonical({ code: v.code, values: v.values })).digest('hex');

/** The first mark whose version is missing from the design or has changed, or null. */
export const printedGuard = (design: Pick<Design, 'versions'>, marks: PrintedMark[]): PrintedMark | null =>
  marks.find((m) => { const ver = design.versions[m.v]; return !ver || versionFingerprint(ver) !== m.fp; }) ?? null;

export const PRINTED_JSON = path.join(DATA_DIR, 'printed.json');
const validId = (id: string) => ID_RE.test(id);

/** The stored marks: none when there is no file; a damaged or unreadable file is recovered first (recoverPrinted). */
export async function readPrinted(): Promise<PrintedMap> {
  for (let tries = 0; tries < 3; tries++) {
    const marks = await readMarks();
    if (marks) return marks;
    recovery ??= recoverPrinted().finally(() => { recovery = null; });
    await recovery;
  }
  throw new Error('printed.json (the printed versions) could not be read or recovered');
}

/** The file's marks, {} when there is none, null when it is damaged or can't be read. */
async function readMarks(): Promise<PrintedMap | null> {
  let text: string;
  try {
    text = await readFile(PRINTED_JSON, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null;
  }
  try {
    const o: unknown = JSON.parse(text);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return cleanPrintedMap((o as { printed?: unknown }).printed, validId);
  } catch {
    return null;
  }
}

let recovery: Promise<void> | null = null;
let problem: string | null = null;
/** What went wrong with printed.json in this run (for the page), or null. */
export const printedProblem = () => problem;

/**
 * printed.json is damaged or can't be read: it must neither stop every save nor be taken as "nothing
 * printed". It is kept as it is under printed.json.damaged-<time>-<random> (linked, so the name never
 * goes missing in between), and the marks are rebuilt from what can still be read: each whole mark in
 * its text, and each stored print 3MF (designs/<id>/printed/vN.3mf) that has no mark from the text.
 * When the file can't be kept aside, nothing changes and the read fails, as before.
 */
async function recoverPrinted(): Promise<void> {
  if (await readMarks()) return; // another recovery (or a write) fixed it meanwhile
  const aside = `${PRINTED_JSON}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  await link(PRINTED_JSON, aside).catch(() => copyFile(PRINTED_JSON, aside, constants.COPYFILE_EXCL));
  const text = await readFile(aside, 'utf8').catch(() => '');
  const marks = salvageMarks(text);
  const fromText = Object.values(marks).reduce((n, l) => n + l.length, 0);
  const from3mf = await marksFromPrintFiles(marks);
  await writeAtomically(PRINTED_JSON, JSON.stringify({ printed: marks }));
  problem = `The list of printed versions (printed.json) was damaged or could not be read. It is kept as ${path.basename(aside)} in the data folder; ${fromText} printed mark(s) were read back from it and ${from3mf} from the stored print files. A version marked printed without a print file whose mark could not be read is no longer marked: mark it again.`;
  console.error(`[printed] ${problem}`);
}

/** Every whole mark in a damaged printed.json's text, by design (each checked like a sound file's). */
function salvageMarks(text: string): PrintedMap {
  const raw: Record<string, unknown[]> = {};
  const entry = /"([a-zA-Z0-9-]{8,64})"\s*:\s*\[([^\]]*)/g;
  for (const [, id, body] of text.matchAll(entry)) {
    // A mark is a flat object but for its build ({ version, commit }).
    for (const [obj] of body.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g)) {
      try { (raw[id] ??= []).push(JSON.parse(obj)); } catch { /* not whole */ }
    }
  }
  return cleanPrintedMap(raw, validId);
}

/** Adds a mark for each stored print 3MF that has none in `marks`; returns how many. */
async function marksFromPrintFiles(marks: PrintedMap): Promise<number> {
  let added = 0;
  for (const id of await readdir(DESIGNS).catch(() => [] as string[])) {
    if (!validId(id)) continue;
    const dir = path.join(DESIGNS, id, 'printed');
    const files = (await readdir(dir).catch(() => [] as string[])).filter((n) => PRINTED_FILE.test(n));
    if (!files.length) continue;
    const design = await readFile(path.join(DESIGNS, `${id}.json`), 'utf8').then((t) => JSON.parse(t) as Design, () => null);
    for (const n of files) {
      const v = Number(n.slice(1, -4)) - 1;
      if (marks[id]?.some((m) => m.v === v)) continue;
      const file = path.join(dir, n);
      const [bytes, st] = await Promise.all([readFile(file), stat(file)]).catch(() => [null, null]);
      if (!bytes || !st) continue;
      const ver = Array.isArray(design?.versions) ? design.versions[v] : undefined;
      // No version to fingerprint: an empty one, which locks the design's saves until the mark is removed.
      const fp = ver ? versionFingerprint(ver) : '';
      marks[id] = [...(marks[id] ?? []), { v, at: st.mtimeMs, fp, file: true, settings: bytes.includes('Metadata/project_settings.config') }].sort((x, y) => x.v - y.v);
      added++;
    }
  }
  return added;
}

const BACK_TEXT_OFF = JSON.stringify({ off: true });

/**
 * Once at start, before the server listens: a LayerTone version marked printed without `$backText`
 * was marked by code from before the back text (marking now always writes the key first), so it was
 * printed without one. It gets the back text turned off in its values (and in the open values when it
 * is the current version), so it keeps printing as it was printed; its mark gets the new fingerprint.
 * Returns how many versions it pinned. Idempotent: a version with the key, a version that no longer
 * matches its mark (logged) and an unreadable design are left alone. A run stopped between the design
 * and printed.json is finished by the next one.
 */
export async function pinLegacyBackText(): Promise<number> {
  const all = await readPrinted();
  let pinned = 0, marksChanged = false;
  for (const [id, marks] of Object.entries(all)) {
    const file = path.join(DESIGNS, `${id}.json`);
    let design: Design;
    try {
      const d: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!isDesign(d)) throw new Error('not a design');
      design = d;
    } catch (e) {
      console.warn(`[printed] Back text not pinned in ${id}: ${(e as Error).message}`);
      continue;
    }
    let designChanged = false;
    for (const m of marks) {
      const ver = design.versions[m.v];
      if (!ver || designKind(ver.code, ver.values) !== 'layertone') continue;
      const values = ver.values ?? {};
      if (!(BACK_TEXT_KEY in values)) {
        if (versionFingerprint(ver) !== m.fp) {
          console.warn(`[printed] ${id} v${m.v + 1} no longer matches its printed mark: back text not pinned`);
          continue;
        }
        ver.values = { ...values, [BACK_TEXT_KEY]: BACK_TEXT_OFF };
        if (design.currentVersion === m.v && !(BACK_TEXT_KEY in design.values)) design.values = { ...design.values, [BACK_TEXT_KEY]: BACK_TEXT_OFF };
        m.fp = versionFingerprint(ver);
        designChanged = marksChanged = true;
        pinned++;
      } else if (values[BACK_TEXT_KEY] === BACK_TEXT_OFF && versionFingerprint(ver) !== m.fp) {
        // Pinned by a run that stopped before printed.json was written.
        const { [BACK_TEXT_KEY]: _pin, ...before } = values;
        if (versionFingerprint({ code: ver.code, values: before }) === m.fp) { m.fp = versionFingerprint(ver); marksChanged = true; }
      }
    }
    // A new revision: a tab still holding the old copy is told a newer one was saved, instead of
    // saving the version back without the key (which the printed guard would refuse).
    if (designChanged) await writeAtomically(file, JSON.stringify({ ...design, rev: (design.rev ?? 0) + 1 }));
  }
  if (marksChanged) {
    await mkdir(DATA_DIR, { recursive: true });
    await writeAtomically(PRINTED_JSON, JSON.stringify({ printed: all }));
  }
  return pinned;
}

/** Which printed.json the legacy pin last finished on (its size and time), so a start with the same one skips the pin. */
export const PRINTED_MARKER = path.join(DATA_DIR, 'printed-backtext-pinned');
const printedSignature = () => stat(PRINTED_JSON).then((s) => `${s.size}:${s.mtimeMs}`, () => 'none');

/**
 * pinLegacyBackText at start, but only when printed.json is not the one the last run finished on:
 * a start with nothing new to look at reads no design (it parsed every printed design before the
 * server could listen). New marks always write the key first, so only a printed.json from older code
 * (a restored backup) holds versions to pin, and that changes the file. Returns how many it pinned.
 */
export async function pinLegacyBackTextOnce(): Promise<number> {
  if (await readFile(PRINTED_MARKER, 'utf8').catch(() => null) === await printedSignature()) return 0;
  const pinned = await pinLegacyBackText();
  // Taken after the run, which rewrites printed.json when it pinned something. Not written when the run threw: the next start tries again.
  await mkdir(DATA_DIR, { recursive: true });
  await writeAtomically(PRINTED_MARKER, await printedSignature());
  return pinned;
}
