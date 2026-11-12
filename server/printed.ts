import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config';
import { ID_RE } from './routes/store';
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
