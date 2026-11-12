// Printed marks: a design can have versions marked "Printed" (a real print was made from them).
// The server keeps the marks apart from the designs (data/printed.json), like tags, and refuses
// any save that would change a printed version.

export interface PrintedMark {
  /** The version's index in the design's versions. */
  v: number;
  /** When it was marked, in ms. */
  at: number;
  /** The version's fingerprint when marked (server/printed.ts). */
  fp: string;
  /** A 3MF of the print is stored. */
  file: boolean;
  /** That 3MF has print settings in it. */
  settings: boolean;
}

/** Marks by design id, each list sorted by v, one mark per v. */
export type PrintedMap = Record<string, PrintedMark[]>;

export const MAX_PRINTED_BYTES = 200 * 1024 * 1024;
export const PRINTED_FILE = /^v[1-9]\d{0,4}\.3mf$/;
/** The stored 3MF's name for version index v. */
export const printedFileName = (v: number) => `v${v + 1}.3mf`;

/** The marks to keep; anything unusable (a hand-edited or old file) is left out. */
export function cleanPrintedMap(v: unknown, validId: (id: string) => boolean): PrintedMap {
  const out: PrintedMap = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, list] of Object.entries(v)) {
    if (!validId(id) || !Array.isArray(list)) continue;
    const byV = new Map<number, PrintedMark>();
    for (const m of list as Partial<PrintedMark>[]) {
      if (!m || typeof m !== 'object' || !Number.isInteger(m.v) || m.v! < 0 || typeof m.fp !== 'string' || byV.has(m.v!)) continue;
      byV.set(m.v!, { v: m.v!, at: Number.isFinite(m.at) ? m.at! : 0, fp: m.fp, file: m.file === true, settings: m.settings === true });
    }
    if (byV.size) out[id] = [...byV.values()].sort((a, b) => a.v - b.v);
  }
  return out;
}
