// Restore points of the hand edits (line art's Edit drawing, the artwork brush): each change to the
// edits (an editor closed with Done, Clear edits, a recolour) is kept with the design as what it
// changed, so the edits can go back to how they were before any of them.

/** The design's values key holding the history (not a setting: not in versions, not sent to the server). */
export const EDIT_HISTORY_KEY = '$editHistory';
/** The most entries kept per kind of edits. */
export const MAX_HISTORY = 30;
/** The most characters of a kind's entries together: the oldest go first beyond it. */
const MAX_HISTORY_CHARS = 2_000_000;
const MAX_LABEL = 120;
/** As many as a drawing can have (MAX_LINEART_STROKES, MAX_ARTWORK_STROKES). */
const MAX_REMOVED = 400;

export type HistoryKind = 'lineart' | 'artwork';
/**
 * What one change did to a drawing's strokes: the first `prefix` stayed, the ones after them
 * (`removed`) went and others came, leaving `afterLen` strokes hashing to `afterHash`. `fp`: the
 * fingerprint the strokes before had (else the one after).
 */
export interface HistoryChange<S = unknown> { fp: string; prefix: number; removed: S[]; afterLen: number; afterHash: string }
export interface HistoryEntry<S = unknown> { at: number; label: string; changes: Record<string, HistoryChange<S>> }
export type EditHistory = Partial<Record<HistoryKind, HistoryEntry[]>>;
/** Hand edits: line art's and artwork's have this shape. */
export type StrokeEdits<S> = Record<string, { fp: string; strokes: S[] }>;

/** A short hash of strokes (FNV-1a, 32 bits, hex). */
export function hashStrokes(strokes: readonly unknown[]): string {
  const s = JSON.stringify(strokes);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The history with the change from `before` to `after` added (the same array when nothing changed). */
export function recordChange<S>(history: HistoryEntry[] | undefined, before: StrokeEdits<S>, after: StrokeEdits<S>, label: string, at: number): HistoryEntry[] {
  const changes: Record<string, HistoryChange> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[name], a = after[name];
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
    const bs = b?.strokes ?? [], as = a?.strokes ?? [];
    let prefix = 0;
    // (Strokes made on another drawing don't carry over.)
    if (!b || !a || b.fp === a.fp) while (prefix < bs.length && prefix < as.length && JSON.stringify(bs[prefix]) === JSON.stringify(as[prefix])) prefix++;
    changes[name] = { fp: (b ?? a).fp, prefix, removed: bs.slice(prefix), afterLen: as.length, afterHash: hashStrokes(as) };
  }
  if (!Object.keys(changes).length) return history ?? [];
  const list = [...(history ?? []), { at, label: label.slice(0, MAX_LABEL), changes }].slice(-MAX_HISTORY);
  const sizes = list.map((e) => JSON.stringify(e).length);
  let total = sizes.reduce((s, n) => s + n, 0), drop = 0;
  while (list.length - drop > 1 && total > MAX_HISTORY_CHARS) total -= sizes[drop++];
  return drop ? list.slice(drop) : list;
}

/** One step back: the edits before `e`, from those after it (null: they aren't what it left). */
function stepBack<S>(e: HistoryEntry, cur: StrokeEdits<S>): StrokeEdits<S> | null {
  const out = { ...cur };
  for (const [name, c] of Object.entries(e.changes)) {
    const strokes = cur[name]?.strokes ?? [];
    if (strokes.length !== c.afterLen || hashStrokes(strokes) !== c.afterHash) return null;
    const back = strokes.slice(0, c.prefix).concat(c.removed as S[]);
    if (back.length) out[name] = { fp: c.fp, strokes: back }; else delete out[name];
  }
  return out;
}

/**
 * For each entry, the edits as they were before it, walking back from `current` (the edits now);
 * null from where a change that wasn't recorded (the AI's, say) broke the chain.
 */
export function restorePoints<S>(history: HistoryEntry[], current: StrokeEdits<S>): (StrokeEdits<S> | null)[] {
  const out: (StrokeEdits<S> | null)[] = history.map(() => null);
  let state: StrokeEdits<S> | null = current;
  for (let i = history.length - 1; i >= 0 && state; i--) out[i] = state = stepBack(history[i], state);
  return out;
}

/** The edits as they were before entry `index` (null: the chain is broken there or after it). */
export function editsBefore<S>(history: HistoryEntry[], current: StrokeEdits<S>, index: number): StrokeEdits<S> | null {
  let state: StrokeEdits<S> | null = current;
  for (let i = history.length - 1; i >= index && state; i--) state = stepBack(history[i], state);
  return index >= 0 && index < history.length ? state : null;
}

/** The entries that changed these drawings, with only their changes: one editor's restore points. */
export function historyFor(history: HistoryEntry[], names: string | string[]): HistoryEntry[] {
  const keep = new Set(typeof names === 'string' ? [names] : names);
  return history.flatMap((e) => {
    const changes = Object.fromEntries(Object.entries(e.changes).filter(([n]) => keep.has(n)));
    return Object.keys(changes).length ? [{ ...e, changes }] : [];
  });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const MODE_WORDS: Record<string, [string, string]> = {
  draw: ['line drawn', 'lines drawn'], paint: ['painted', 'painted'], fill: ['fill', 'fills'], erase: ['erased', 'erased'], restore: ['area cleared', 'areas cleared'],
};

/** What a change did, for its entry: e.g. "3 painted, 1 erased", "2 lines drawn, 1 fill", "4 strokes taken back". */
export function describeChange<S extends { mode: string }>(before: StrokeEdits<S>, after: StrokeEdits<S>): string {
  const added = new Map<string, number>();
  let removed = 0;
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    // (Strokes in both, as many times as in both, stayed.)
    const left = new Map<string, number>();
    for (const s of before[name]?.strokes ?? []) { const k = JSON.stringify(s); left.set(k, (left.get(k) ?? 0) + 1); }
    for (const s of after[name]?.strokes ?? []) {
      const k = JSON.stringify(s), n = left.get(k) ?? 0;
      if (n) left.set(k, n - 1); else added.set(s.mode, (added.get(s.mode) ?? 0) + 1);
    }
    for (const n of left.values()) removed += n;
  }
  const modes = [...Object.keys(MODE_WORDS).filter((m) => added.has(m)), ...[...added.keys()].filter((m) => !(m in MODE_WORDS))];
  const parts = modes.map((m) => { const w = MODE_WORDS[m] ?? [m, m]; return plural(added.get(m)!, w[0], w[1]); });
  if (removed) parts.push(plural(removed, 'stroke taken back', 'strokes taken back'));
  return parts.length ? parts.join(', ') : 'Hand edits changed';
}

const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

function parseEntry(raw: unknown): HistoryEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at) || typeof o.label !== 'string') return null;
  if (!o.changes || typeof o.changes !== 'object' || Array.isArray(o.changes)) return null;
  const changes: Record<string, HistoryChange> = {};
  for (const [name, c] of Object.entries(o.changes as Record<string, unknown>).slice(0, 12)) {
    if (!c || typeof c !== 'object') return null;
    const x = c as Record<string, unknown>, prefix = int(x.prefix), afterLen = int(x.afterLen);
    if (typeof x.fp !== 'string' || prefix == null || afterLen == null || prefix > afterLen || typeof x.afterHash !== 'string' || !/^[0-9a-f]{8}$/.test(x.afterHash)) return null;
    // (The strokes themselves are checked by the edits' own parser when they are put back.)
    if (!Array.isArray(x.removed) || x.removed.length > MAX_REMOVED || x.removed.some((s) => !s || typeof s !== 'object' || Array.isArray(s))) return null;
    changes[name.slice(0, 120)] = { fp: x.fp.slice(0, 80), prefix, removed: x.removed, afterLen, afterHash: x.afterHash };
  }
  if (!Object.keys(changes).length) return null;
  return { at: o.at, label: o.label.slice(0, MAX_LABEL), changes };
}

/** The history from the design's values (a JSON string or the object), checked. */
export function parseEditHistory(raw: unknown): EditHistory {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return {}; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: EditHistory = {};
  for (const kind of ['lineart', 'artwork'] as const) {
    const list = (o as Record<string, unknown>)[kind];
    if (!Array.isArray(list)) continue;
    const entries = list.map(parseEntry).filter((e): e is HistoryEntry => !!e).slice(-MAX_HISTORY);
    if (entries.length) out[kind] = entries;
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** When an entry was made: "14:32" today, "10 Nov 14:32" before, with the year when not this one. */
export function historyTime(at: number, now = Date.now()): string {
  const d = new Date(at), n = new Date(now);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === n.toDateString()) return time;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === n.getFullYear() ? '' : ` ${d.getFullYear()}`} ${time}`;
}
