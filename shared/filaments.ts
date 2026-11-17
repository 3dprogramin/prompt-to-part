// Filament library for LayerTone prints: brands, colours and TD (transmission distance) values.
//
// CONTRACT (LayerTone): the side panel uses FILAMENT_LIBRARY and searchFilaments; the server
// answers POST /api/filaments/lookup { brand, name } with FilamentLookup (TD found on the web),
// which the page calls through lookupFilament() in src/lib/api.ts.
import { ADDED_FILAMENTS, BASE_FILAMENT_LIBRARY, FILAMENT_LIBRARY } from './filamentLibrary';
import { hexToRgb, type LayerToneFilament } from './layertone';

export interface LibraryFilament extends LayerToneFilament {
  brand: string;
  /** Product line, e.g. "PLA Basic", "PLA Matte", "PLA+". */
  line?: string;
  /** Where the TD value comes from (URL or "measured by …"). */
  source?: string;
  /** The source doesn't say how its TD was found and it looks guessed: treat it as an estimate. */
  unverified?: boolean;
}

/** POST /api/filaments/lookup reply. */
export interface FilamentLookup {
  filament: LibraryFilament;
  /** How sure the lookup is: 'listed' (a published TD for this exact filament), 'similar' (from a close match), 'estimate'. */
  confidence: 'listed' | 'similar' | 'estimate';
  note?: string;
}

/** Longest brand and filament name POST /api/filaments/lookup accepts. */
export const MAX_BRAND_CHARS = 60;
export const MAX_FILAMENT_NAME_CHARS = 120;

// ---------------------------------------------------------------- the user's own filaments

/** Most filaments the user can save (GET/PUT /api/filaments/mine, data/filaments.json). */
export const MAX_MY_FILAMENTS = 100;
/** TD range a saved filament may have, mm. */
export const MY_TD_RANGE: [number, number] = [0.05, 20];

/** A filament the user saved: a LayerTone filament plus how many rolls of it they have (a note only). */
export interface MyFilament extends LayerToneFilament { rolls?: number }
/** Most rolls of one filament the note holds. */
export const MAX_ROLLS = 99;
/** The rolls of a saved filament: its count, or 1 when it has none. */
export const rollsOf = (f: MyFilament): number => f.rolls ?? 1;
/** A typed roll count as a valid one: whole, 0 to MAX_ROLLS; empty and not-a-number give 0. */
export function cleanRolls(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(MAX_ROLLS, Math.max(0, Math.round(n))) : 0;
}
/** The saved filaments as plain LayerTone filaments (name, brand, colour, TD): the roll count is a note for the user, never for a prompt, a tool or a design. */
export const withoutRolls = (list: MyFilament[]): LayerToneFilament[] => list.map((f) => ({ name: f.name, ...(f.brand ? { brand: f.brand } : {}), color: f.color, td: f.td }));

/** What is wrong with a list of the user's filaments for PUT /api/filaments/mine, if anything. */
export function myFilamentsProblem(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return 'Send { filaments: [...] }';
  if (raw.length > MAX_MY_FILAMENTS) return `At most ${MAX_MY_FILAMENTS} filaments`;
  for (const [i, f] of raw.entries()) {
    const at = `Filament ${i + 1}`;
    if (!f || typeof f !== 'object') return `${at} is not a filament`;
    const { name, brand, color, td, rolls } = f as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) return `${at} needs a name`;
    if (name.length > MAX_FILAMENT_NAME_CHARS) return `${at}: the name is longer than ${MAX_FILAMENT_NAME_CHARS} characters`;
    if (brand != null && typeof brand !== 'string') return `${at}: the brand must be text`;
    if (typeof brand === 'string' && brand.length > MAX_BRAND_CHARS) return `${at}: the brand is longer than ${MAX_BRAND_CHARS} characters`;
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return `${at}: the colour must be #rrggbb`;
    if (typeof td !== 'number' || !(td >= MY_TD_RANGE[0] && td <= MY_TD_RANGE[1])) return `${at}: TD must be ${MY_TD_RANGE[0]}–${MY_TD_RANGE[1]} mm`;
    if ('rolls' in (f as object) && (typeof rolls !== 'number' || !Number.isInteger(rolls) || rolls < 0 || rolls > MAX_ROLLS)) return `${at}: rolls must be a whole number from 0 to ${MAX_ROLLS}`;
  }
  return undefined;
}

/**
 * The user's filaments as stored: valid ones only (as myFilamentsProblem checks), trimmed, colour in
 * lower case, one per brand and name (the last wins), at most MAX_MY_FILAMENTS.
 */
export function cleanMyFilaments(raw: unknown): MyFilament[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, MyFilament>();
  for (const f of raw) {
    if (myFilamentsProblem([f])) continue;
    const name = f.name.trim(), brand = typeof f.brand === 'string' ? f.brand.trim() : '';
    out.delete(myFilamentKey({ name, brand }));
    out.set(myFilamentKey({ name, brand }), { name, ...(brand ? { brand } : {}), color: f.color.toLowerCase(), td: f.td, ...('rolls' in f ? { rolls: f.rolls } : {}) });
  }
  return [...out.values()].slice(-MAX_MY_FILAMENTS);
}

/** Brand and name, in any case and spelling: a saved filament with the same key is the same one. */
export const myFilamentKey = (f: { brand?: string; name: string }) => `${normalizeFilamentText(f.brand ?? '')}|${normalizeFilamentText(f.name)}`;

/** Why one more filament can't be saved. */
export const MY_FILAMENTS_FULL = `My filaments is full: ${MAX_MY_FILAMENTS} at most. Remove one first.`;
/** Why a saved filament can't be renamed to another's brand and name. */
export const DUPLICATE_FILAMENT = 'You already have a filament with this brand and name.';

/**
 * The list with a filament saved: `original` (the key of the saved one being edited) changed in place, or
 * else the one with the same brand and name changed in place, or else this one added at the end. The roll
 * count stays with the filament it belongs to. Refused when an edit would take another saved filament's
 * brand and name (that one would be lost), or when a new one does not fit.
 */
export function withMyFilament(list: MyFilament[], f: LayerToneFilament, original?: string): { list: MyFilament[]; problem?: string } {
  const key = myFilamentKey(f);
  if (original != null && key !== original && list.some((m) => myFilamentKey(m) === key)) return { list, problem: DUPLICATE_FILAMENT };
  const at = list.findIndex((m) => myFilamentKey(m) === (original ?? key));
  const same = list.findIndex((m) => myFilamentKey(m) === key);
  if (at < 0 && same < 0 && list.length >= MAX_MY_FILAMENTS) return { list, problem: MY_FILAMENTS_FULL };
  const rest = list.filter((_, i) => i !== at && i !== same);
  const rolls = (list[at] ?? list[same])?.rolls;
  const keep: MyFilament = { name: f.name, ...(f.brand ? { brand: f.brand } : {}), color: f.color, td: f.td, ...(rolls == null ? {} : { rolls }) };
  if (at < 0) return { list: same < 0 ? [...rest, keep] : [...rest.slice(0, same), keep, ...rest.slice(same)] };
  return { list: [...rest.slice(0, at), keep, ...rest.slice(at)] };
}

// ---------------------------------------------------------------- the library

// The entries are in shared/filamentLibrary: a frozen base list and the brands added after it.
export { ADDED_FILAMENTS, BASE_FILAMENT_LIBRARY, FILAMENT_LIBRARY };

/**
 * The library entries the agent is shown: those of the brands the user has filaments from; the base
 * list when none of their brands is in the library (no saved filaments, or custom ones only).
 */
export function promptLibrary(mine: { brand?: string }[], library: readonly LibraryFilament[] = FILAMENT_LIBRARY): LibraryFilament[] {
  const owned = new Set(mine.map((f) => normalizeFilamentText(f.brand ?? '')).filter(Boolean));
  const shown = library.filter((f) => owned.has(normalizeFilamentText(f.brand)));
  return shown.length ? shown : [...BASE_FILAMENT_LIBRARY];
}

// Spellings that mean the same: "Bambu Lab"/"BambuLab"/"bambu", "PLA Plus"/"PLA+", "grey"/"gray".
const ALIASES: [RegExp, string][] = [
  [/\bbambu\s*lab\b|\bbbl\b/g, 'bambu'],
  [/\bpla\s*(?:\+|plus\b)/g, 'pla+'],
  [/\bgrey\b/g, 'gray'],
];

/** Lower case, aliases applied, words separated by single spaces: "Bambu Lab PLA Plus Grey" → "bambu pla+ gray". */
export function normalizeFilamentText(s: string): string {
  let t = s.toLowerCase();
  for (const [re, to] of ALIASES) t = t.replace(re, to);
  return t.split(/[^a-z0-9+]+/).filter(Boolean).join(' ');
}

const words = (s: string | undefined) => (s ? normalizeFilamentText(s).split(' ').filter(Boolean) : []);
/** The name's words that aren't the line's: "PLA Matte Ash Gray" → ash, gray. */
const colourWords = (f: LibraryFilament) => { const line = words(f.line); return words(f.name).filter((w) => !line.includes(w)); };
/** The line's words for a special finish: "PLA Silk+" → silk+; none for PLA, PLA+ and PLA Basic. */
const finishWords = (f: LibraryFilament) => words(f.line).filter((w) => !['pla', 'pla+', 'basic'].includes(w));

/** How well the filament matches the query words, 0 = not at all. */
function score(f: LibraryFilament, query: string[], families: boolean): number {
  const fields: [string[], number][] = [[colourWords(f), 3], [words(`${f.line ?? ''} ${f.name}`), 2], [words(f.brand), 2]];
  if (families) fields.push([colourFamilies(f.color), 1]);
  let total = 0;
  for (const q of query) {
    let best = 0;
    for (const [ws, weight] of fields) {
      for (const w of ws) best = Math.max(best, w === q ? weight : w.startsWith(q) ? weight * 0.6 : w.includes(q) ? weight * 0.3 : 0);
    }
    if (!best) return 0;
    total += best;
  }
  return total;
}

/**
 * Library filaments matching a free-text query ("bambu black", "esun pla+ red"), best first. With
 * `families`, a colour word also finds the filaments of that colour whatever their name, after the
 * ones it names ("matte black" finds PLA Matte Charcoal). `library` is what it searches (default the whole
 * library).
 */
export function searchFilaments(query: string, limit = 20, { families = false, library = FILAMENT_LIBRARY } = {}): LibraryFilament[] {
  const q = words(query);
  if (!q.length) return library.slice(0, limit);
  return library
    .map((f, i) => ({ f, i, s: score(f, q, families), finish: finishWords(f).length, extra: colourWords(f).length }))
    .filter((m) => m.s > 0)
    // Equal scores: plain filaments before special finishes ("white" finds Jade White before Silk+
    // White), fewer other colour words ("red" finds Red before Maroon Red), then library order.
    .sort((a, b) => b.s - a.s || a.finish - b.finish || a.extra - b.extra || a.i - b.i)
    .slice(0, limit)
    .map((m) => m.f);
}

/**
 * The library filament a brand and name mean, or undefined: every word of the name is in the
 * filament's line and name, and the filament's colour and finish words are in the name ("Black",
 * "PLA Basic Black" and "Bambu Lab PLA Black" all find Bambu Lab PLA Basic Black; "White" doesn't
 * find PLA Silk+ White). `library` is what it searches (default the whole library).
 */
export function matchFilament(brand: string, name: string, library: readonly LibraryFilament[] = FILAMENT_LIBRARY): LibraryFilament | undefined {
  const b = normalizeFilamentText(brand);
  const brandWords = b.split(' ');
  const q = new Set(words(name).filter((w) => !brandWords.includes(w)));
  if (!q.size) return undefined;
  let best: LibraryFilament | undefined;
  let bestExtra = Infinity;
  for (const f of library) {
    if (b && normalizeFilamentText(f.brand) !== b) continue;
    const all = new Set(words(`${f.line ?? ''} ${f.name}`));
    if (![...q].every((w) => all.has(w)) || ![...colourWords(f), ...finishWords(f)].every((w) => q.has(w))) continue;
    const extra = all.size - q.size;
    if (extra < bestExtra) { best = f; bestExtra = extra; }
  }
  return best;
}

/**
 * The plain colour words a #rrggbb looks like ("black", "gray", "beige", "blue", …), for searching
 * by colour: a rough sort by hue, lightness and saturation, not a colour science.
 */
export function colourFamilies(hex: string): string[] {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, c = max - min;
  if (max < 0.16) return ['black'];
  if (c < 0.09) return [l > 0.85 ? 'white' : 'gray'];
  const h = (max === r ? ((g - b) / c + 6) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60;
  if (l > 0.7 && h >= 10 && h < 60) return c < 0.25 ? ['beige', 'skin', 'white'] : ['beige', 'skin'];
  if (h < 12 || h >= 350) return l > 0.7 ? ['pink'] : l < 0.35 ? ['red', 'brown'] : ['red'];
  if (h < 45) return l < 0.45 || (c < 0.45 && l < 0.6) ? ['brown'] : c < 0.3 ? ['brown', 'beige'] : ['orange'];
  if (h < 70) return l < 0.4 ? ['brown', 'green'] : ['yellow'];
  if (h < 165) return ['green'];
  if (h < 195) return ['green', 'blue'];
  if (h < 245) return ['blue'];
  if (h < 290) return ['purple'];
  return ['pink', 'purple'];
}

// ---------------------------------------------------------------- picker

/** A product line of the library (e.g. Bambu Lab PLA Matte), its filaments in library order. */
export interface FilamentLine {
  /** "Bambu Lab PLA Matte" */
  key: string;
  brand: string;
  line: string;
  filaments: LibraryFilament[];
}

export const lineKey = (f: { brand?: string; line?: string }) => [f.brand, f.line].filter(Boolean).join(' ');

/** The library's product lines, in library order. */
export function filamentLines(library = FILAMENT_LIBRARY): FilamentLine[] {
  const lines = new Map<string, FilamentLine>();
  for (const f of library) {
    const key = lineKey(f);
    let l = lines.get(key);
    if (!l) lines.set(key, (l = { key, brand: f.brand, line: f.line ?? '', filaments: [] }));
    l.filaments.push(f);
  }
  return [...lines.values()];
}

/**
 * The colours most LayerTone prints use, one click away: black, white and greys for the values,
 * beige and brown for skin and wood, and the primaries. Bambu Lab PLA Basic (what the AMS holds)
 * where it has them.
 */
export const COMMON_FILAMENTS: LibraryFilament[] = [
  'Bambu Lab PLA Basic Black', 'Bambu Lab PLA Basic Jade White', 'Bambu Lab PLA Basic Light Gray', 'Bambu Lab PLA Basic Gray',
  'Bambu Lab PLA Matte Ash Gray', 'Bambu Lab PLA Basic Beige', 'Bambu Lab PLA Basic Brown',
  'Bambu Lab PLA Basic Red', 'Bambu Lab PLA Basic Blue', 'Bambu Lab PLA Basic Yellow', 'Bambu Lab PLA Basic Bambu Green',
].flatMap((id) => FILAMENT_LIBRARY.filter((f) => `${f.brand} ${f.name}` === id));

/**
 * The library filament a stack filament is: the same brand and name (any case and spelling), else
 * the one its brand and name mean (matchFilament). Undefined for custom filaments. `library` is what it
 * searches (default the whole library).
 */
export function libraryFilament(f: { brand?: string; name: string }, library: readonly LibraryFilament[] = FILAMENT_LIBRARY): LibraryFilament | undefined {
  if (!f.brand) return undefined;
  const b = normalizeFilamentText(f.brand), n = normalizeFilamentText(f.name);
  return library.find((l) => normalizeFilamentText(l.brand) === b && normalizeFilamentText(l.name) === n) ?? matchFilament(f.brand, f.name, library);
}

/** The filament's TD is the library's estimate (unverified), not a published or the user's own value. */
export function estimatedTd(f: LayerToneFilament): boolean {
  const l = libraryFilament(f);
  return !!l?.unverified && Math.abs(l.td - f.td) < 1e-6;
}

/** The picker's filaments: those matching the query (colour words included), of one line (its key) or all. */
export function pickerFilaments(query: string, line?: string): LibraryFilament[] {
  return searchFilaments(query, Infinity, { families: true }).filter((f) => !line || lineKey(f) === line);
}

/** The user's filaments matching a query: every word in the brand, the name or the colour's family. */
export function searchMyFilaments<T extends LayerToneFilament>(list: T[], query: string): T[] {
  const q = words(query);
  return list.filter((f) => {
    const ws = [...words(`${f.brand ?? ''} ${f.name}`), ...colourFamilies(f.color)];
    return q.every((w) => ws.some((x) => x.includes(w)));
  });
}
