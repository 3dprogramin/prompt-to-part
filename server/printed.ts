import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config';
import { DESIGNS, ID_RE, isDesign, writeAtomically } from './routes/store';
import { BACK_TEXT_KEY } from '../shared/backText';
import { designKind } from '../shared/designKind';
import { cleanPrintedMap, type PrintedMap, type PrintedMark } from '../shared/printed';
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
export const readPrinted = async (): Promise<PrintedMap> =>
  cleanPrintedMap((JSON.parse(await readFile(PRINTED_JSON, 'utf8').catch(() => '{}')) as { printed?: unknown }).printed, (id) => ID_RE.test(id));

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
