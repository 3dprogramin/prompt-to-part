// The Filaments tab of Settings, its decisions: the user's filaments (the shelf) with their roll counts,
// the library to add from, and the saves. FilamentsTab.tsx only renders these.
import { cleanRolls, FILAMENT_LIBRARY, MAX_MY_FILAMENTS, myFilamentKey, rollsOf, searchFilaments, searchMyFilaments, type LibraryFilament, type MyFilament } from '../../../shared/filaments';
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
  if (mine.length >= MAX_MY_FILAMENTS) return { list: mine, problem: `My filaments is full: ${MAX_MY_FILAMENTS} at most. Remove one first.` };
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

export type SaverEvent = { kind: 'start' } | { kind: 'saved' } | { kind: 'failed'; error: Error };

/** The tab's saves, made once for the Settings dialog's lifetime so a save outlives the tab being switched away. */
export interface ShelfSaver {
  /** Saves the list: one save at a time, of those waiting only the newest. Settles when the newest save does. */
  save(list: MyFilament[]): Promise<void>;
  /** The newest list sent or waiting, until the saves end; null when none is. Changes are made on it. */
  pending(): MyFilament[] | null;
  /** Hears each save start and the end of the newest; returns the way to stop. */
  listen(f: (e: SaverEvent) => void): () => void;
}

/** A ShelfSaver over `save` (saveMine); after a failed save the list is read again with `refresh`. */
export function shelfSaver(save: (list: MyFilament[]) => Promise<void>, refresh: () => Promise<void>): ShelfSaver {
  let pending: MyFilament[] | null = null;
  let waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const listeners = new Set<(e: SaverEvent) => void>();
  const tell = (e: SaverEvent) => listeners.forEach((f) => f(e));
  const settle = (error?: Error) => {
    pending = null;
    const ws = waiters;
    waiters = [];
    for (const w of ws) { if (error) w.reject(error); else w.resolve(); }
  };
  const enqueue = latestWins<MyFilament[]>(save, {
    onStart: () => tell({ kind: 'start' }),
    onSaved: () => { settle(); tell({ kind: 'saved' }); },
    onFailed: (error) => { settle(error); tell({ kind: 'failed', error }); refresh().catch(() => {}); },
  });
  return {
    save: (list) => new Promise<void>((resolve, reject) => {
      pending = list;
      waiters.push({ resolve, reject });
      enqueue(list);
    }),
    pending: () => pending,
    listen: (f) => { listeners.add(f); return () => { listeners.delete(f); }; },
  };
}
