// The Filaments tab of Settings, its decisions: the user's filaments (the shelf) with their roll counts,
// the library to add from, and the saves. FilamentsTab.tsx only renders these.
import { NOT_LOADED } from '../../lib/mineStore';
import { cleanRolls, FILAMENT_LIBRARY, MAX_MY_FILAMENTS, MY_FILAMENTS_FULL, myFilamentKey, rollsOf, searchFilaments, searchMyFilaments, type LibraryFilament, type MyFilament } from '../../../shared/filaments';
import { latestWins } from './latestWins';

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "14 colours · 19 rolls" numbers for the shelf header. */
export function shelfSummary(mine: MyFilament[]): { colours: number; rolls: number } {
  return { colours: mine.length, rolls: mine.reduce((n, f) => n + rollsOf(f), 0) };
}

/** The shelf header: "14 colours · 19 rolls", "1 colour · 1 roll". */
export function summaryText(s: { colours: number; rolls: number }): string {
  return `${plural(s.colours, 'colour', 'colours')} · ${plural(s.rolls, 'roll', 'rolls')}`;
}

/** The shelf in display order: brand (none last), then name, both case-insensitive; filtered by the search text. */
export function shelfView(mine: MyFilament[], query: string): MyFilament[] {
  const found = query.trim() ? searchMyFilaments(mine, query) : mine;
  return [...found].sort((a, b) => (a.brand ? 0 : 1) - (b.brand ? 0 : 1) || byText(a.brand ?? '', b.brand ?? '') || byText(a.name, b.name));
}

export interface LibraryCard { filament: LibraryFilament; key: string; owned: boolean }

/** Brands of the library in alphabetical order, and the lines of one brand (or of all) in alphabetical order. */
export function libraryBrands(library: LibraryFilament[] = FILAMENT_LIBRARY): string[] {
  return [...new Set(library.map((f) => f.brand))].sort((a, b) => a.localeCompare(b));
}
export function libraryLines(brand: string | null, library: LibraryFilament[] = FILAMENT_LIBRARY): string[] {
  return [...new Set(library.filter((f) => brand == null || f.brand === brand).flatMap((f) => (f.line ? [f.line] : [])))].sort((a, b) => a.localeCompare(b));
}

/**
 * The library cards for a search text (name, brand, line or a colour word such as "blue"), a brand and a
 * line; owned by myFilamentKey. With no search text they are sorted by brand, line, name; with one, best
 * match first (the picker's search: the filaments a word names, then the others of that colour).
 */
export function libraryView(q: { query: string; brand: string | null; line: string | null }, mine: MyFilament[], library: LibraryFilament[] = FILAMENT_LIBRARY): LibraryCard[] {
  const owned = new Set(mine.map(myFilamentKey));
  const found = q.query.trim()
    ? searchFilaments(q.query, Infinity, { families: true, library })
    : [...library].sort((a, b) => a.brand.localeCompare(b.brand) || (a.line ?? '').localeCompare(b.line ?? '') || a.name.localeCompare(b.name));
  return found
    .filter((f) => (q.brand == null || f.brand === q.brand) && (q.line == null || f.line === q.line))
    .map((f) => { const key = myFilamentKey(f); return { filament: f, key, owned: owned.has(key) }; });
}

/** A card's accessible name: "Add Jade White, Bambu Lab, TD 4.2", or "…, owned" for one the user has. */
export function cardLabel(c: LibraryCard): string {
  const f = c.filament;
  return `${c.owned ? '' : 'Add '}${f.name}, ${f.brand}, TD ${f.td}${f.unverified ? ', estimated' : ''}${c.owned ? ', owned' : ''}`;
}

/** The library header: "92 colours", or "12 of 92 colours" while a search or filter is on. */
export function libraryCount(shown: number, total: number): string {
  return shown === total ? plural(total, 'colour', 'colours') : `${shown} of ${plural(total, 'colour', 'colours')}`;
}

/** The list after adding a library filament with 1 roll, or a message why not (already owned gives the same list and no message; full gives the message). */
export function addFromLibrary(mine: MyFilament[], f: LibraryFilament): { list: MyFilament[]; problem?: string } {
  const key = myFilamentKey(f);
  if (mine.some((m) => myFilamentKey(m) === key)) return { list: mine };
  if (mine.length >= MAX_MY_FILAMENTS) return { list: mine, problem: MY_FILAMENTS_FULL };
  // As the picker's "Save as mine": name, brand, colour and TD (not the library's line, source or estimate mark).
  return { list: [...mine, { name: f.name, brand: f.brand, color: f.color, td: f.td, rolls: 1 }] };
}

/** The list with one filament's rolls set (cleanRolls applied); the same list when that changes nothing. */
export function withRolls(mine: MyFilament[], key: string, raw: unknown): MyFilament[] {
  const rolls = cleanRolls(raw);
  const at = mine.findIndex((f) => myFilamentKey(f) === key);
  if (at < 0 || rollsOf(mine[at]) === rolls) return mine;
  return mine.map((f, i) => (i === at ? { ...f, rolls } : f));
}

/** The list without one filament. */
export function without(mine: MyFilament[], key: string): MyFilament[] {
  return mine.filter((f) => myFilamentKey(f) !== key);
}

/** A change to the list: the new list, and why not when it is refused (then nothing is saved). */
export type ShelfChange = (list: MyFilament[]) => MyFilament[] | { list: MyFilament[]; problem?: string };
export type SaverEvent = { kind: 'queued' } | { kind: 'start' } | { kind: 'saved' } | { kind: 'failed'; error: Error };

/** The tab's saves (the custom form's too), made once for the Settings dialog's lifetime so a save outlives the tab being switched away. */
export interface ShelfSaver {
  /**
   * Makes a change on the newest list (the one waiting to be saved, else the one read) and saves the result:
   * one save at a time, of those waiting only the newest, which holds every change made meanwhile. Settles
   * when a save holding this change answered: resolved when it was saved, rejected with why not (refused,
   * the list was never read, or the save failed).
   */
  change(f: ShelfChange): Promise<void>;
  /** The newest list made and not saved yet; null when none is. */
  pending(): MyFilament[] | null;
  /** Hears each change queued, each save start and the end of the newest; returns the way to stop. */
  listen(f: (e: SaverEvent) => void): () => void;
}

/**
 * A ShelfSaver over `save` (saveMine). `base` is the list as read, or null while it has not been read
 * (then every change is refused: a list never read must not be written). After a failed save the list is
 * read again with `refresh`.
 */
export function shelfSaver(save: (list: MyFilament[]) => Promise<void>, refresh: () => Promise<void>, base: () => MyFilament[] | null): ShelfSaver {
  let pending: { list: MyFilament[]; n: number } | null = null;
  let made = 0;
  let waiters: { n: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  const listeners = new Set<(e: SaverEvent) => void>();
  const tell = (e: SaverEvent) => listeners.forEach((f) => f(e));
  // The changes up to `n` are in a save that answered.
  const settle = (n: number, error?: Error) => {
    const done = waiters.filter((w) => w.n <= n);
    waiters = waiters.filter((w) => w.n > n);
    for (const w of done) { if (error) w.reject(error); else w.resolve(); }
  };
  const enqueue = latestWins<{ list: MyFilament[]; n: number }>(async (v) => {
    try {
      await save(v.list);
      settle(v.n);
    } catch (e) {
      // A newer list waiting to be saved holds these changes too: its answer is theirs.
      if (made === v.n) settle(v.n, e as Error);
      throw e;
    }
  }, {
    onStart: () => tell({ kind: 'start' }),
    onSaved: () => { pending = null; tell({ kind: 'saved' }); },
    onFailed: (error) => { pending = null; tell({ kind: 'failed', error }); refresh().catch(() => {}); },
  });
  return {
    change: (f) => {
      const from = pending?.list ?? base();
      if (!from) return Promise.reject(new Error(NOT_LOADED));
      const r = f(from);
      const { list, problem } = Array.isArray(r) ? { list: r, problem: undefined } : r;
      if (problem) return Promise.reject(new Error(problem));
      if (list === from) return Promise.resolve();
      const n = ++made;
      pending = { list, n };
      const done = new Promise<void>((resolve, reject) => waiters.push({ n, resolve, reject }));
      tell({ kind: 'queued' });
      enqueue(pending);
      return done;
    },
    pending: () => pending?.list ?? null,
    listen: (f) => { listeners.add(f); return () => { listeners.delete(f); }; },
  };
}
