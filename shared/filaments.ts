// Filament library for HueForge prints: brands, colours and TD (transmission distance) values.
//
// CONTRACT (feat/hueforge): the side panel uses FILAMENT_LIBRARY and searchFilaments; the server
// answers POST /api/filaments/lookup { brand, name } with FilamentLookup (TD found on the web),
// which the page calls through lookupFilament() in src/lib/api.ts.
import { hexToRgb, type HfFilament } from './hueforge';

export interface LibraryFilament extends HfFilament {
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

/** What is wrong with a list of the user's filaments for PUT /api/filaments/mine, if anything. */
export function myFilamentsProblem(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return 'Send { filaments: [...] }';
  if (raw.length > MAX_MY_FILAMENTS) return `At most ${MAX_MY_FILAMENTS} filaments`;
  for (const [i, f] of raw.entries()) {
    const at = `Filament ${i + 1}`;
    if (!f || typeof f !== 'object') return `${at} is not a filament`;
    const { name, brand, color, td } = f as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) return `${at} needs a name`;
    if (name.length > MAX_FILAMENT_NAME_CHARS) return `${at}: the name is longer than ${MAX_FILAMENT_NAME_CHARS} characters`;
    if (brand != null && typeof brand !== 'string') return `${at}: the brand must be text`;
    if (typeof brand === 'string' && brand.length > MAX_BRAND_CHARS) return `${at}: the brand is longer than ${MAX_BRAND_CHARS} characters`;
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return `${at}: the colour must be #rrggbb`;
    if (typeof td !== 'number' || !(td >= MY_TD_RANGE[0] && td <= MY_TD_RANGE[1])) return `${at}: TD must be ${MY_TD_RANGE[0]}–${MY_TD_RANGE[1]} mm`;
  }
  return undefined;
}

/**
 * The user's filaments as stored: valid ones only (as myFilamentsProblem checks), trimmed, colour in
 * lower case, one per brand and name (the last wins), at most MAX_MY_FILAMENTS.
 */
export function cleanMyFilaments(raw: unknown): HfFilament[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, HfFilament>();
  for (const f of raw) {
    if (myFilamentsProblem([f])) continue;
    const name = f.name.trim(), brand = typeof f.brand === 'string' ? f.brand.trim() : '';
    out.delete(myFilamentKey({ name, brand }));
    out.set(myFilamentKey({ name, brand }), { name, ...(brand ? { brand } : {}), color: f.color.toLowerCase(), td: f.td });
  }
  return [...out.values()].slice(-MAX_MY_FILAMENTS);
}

/** Brand and name, in any case and spelling: a saved filament with the same key is the same one. */
export const myFilamentKey = (f: { brand?: string; name: string }) => `${normalizeFilamentText(f.brand ?? '')}|${normalizeFilamentText(f.name)}`;

// Published TD values only, each with its source; sorted by brand, line, then name. Where sources
// disagree, a TD measured on a swatch (filamentcolors.xyz, with that swatch's colour) wins over the
// community-compiled lists, and color_tools only fills colours nothing else has (marked unverified).
// Other colours are the makers' own hex codes (Bambu Lab's from Bambu Studio's
// filaments_color_codes.json). TD varies between batches and with how it is measured: the values are
// a starting point a test print corrects.
const COMMUNITY_BAMBU = 'https://github.com/penleychan/hueforge-td/blob/main/public/data/filaments/bambu-lab.json';
const COMMUNITY_ESUN = 'https://github.com/penleychan/hueforge-td/blob/main/public/data/filaments/esun.json';
// Its TDs come from its author's HueForge library by fuzzy name matching, with no measurement
// method, and follow colour families rather than products (every blue 4, every white 6.1, Silk+
// the same as PLA Basic): unverified.
const COLOR_TOOLS = 'https://github.com/dterracino/color_tools/blob/main/color_tools/data/filaments.json';

export const FILAMENT_LIBRARY: LibraryFilament[] = [
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Bambu Green', color: '#00ae42', td: 1.2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Beige', color: '#f7e6de', td: 3.4, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Black', color: '#000000', td: 0.2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Blue', color: '#23529a', td: 2.6, source: 'https://filamentcolors.xyz/swatch/2532/' },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Blue Gray', color: '#657a89', td: 1.6, source: 'https://filamentcolors.xyz/swatch/2820/' },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Bright Green', color: '#becf00', td: 2, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Bronze', color: '#847d48', td: 1, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Brown', color: '#9d432c', td: 2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Cobalt Blue', color: '#0056b8', td: 4, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Cocoa Brown', color: '#6f5034', td: 2, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Cyan', color: '#0086d6', td: 2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Dark Gray', color: '#545454', td: 0.1, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Gold', color: '#e4bd68', td: 2.8, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Gray', color: '#8e9089', td: 0.4, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Hot Pink', color: '#f5547c', td: 8, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Indigo Purple', color: '#482960', td: 3, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Jade White', color: '#ffffff', td: 5.9, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Light Gray', color: '#d1d3d5', td: 4, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Magenta', color: '#ec008c', td: 2.8, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Maroon Red', color: '#9d2235', td: 4, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Mistletoe Green', color: '#3f8e43', td: 1, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Orange', color: '#ff6a13', td: 5.9, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Pink', color: '#f55a74', td: 8, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Pumpkin Orange', color: '#ff9016', td: 5, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Purple', color: '#5e43b7', td: 1.4, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Red', color: '#c12e1f', td: 4.2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Silver', color: '#a6a9aa', td: 0.5, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Sunflower Yellow', color: '#fec600', td: 6, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Turquoise', color: '#00b1b7', td: 1.4, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Yellow', color: '#f4ee2a', td: 4.8, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Apple Green', color: '#c2e189', td: 2, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Ash Gray', color: '#9b9ea0', td: 1.5, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Bone White', color: '#cbc6b8', td: 6.1, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Caramel', color: '#ae835b', td: 5, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Charcoal', color: '#000000', td: 0.3, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Dark Blue', color: '#042f56', td: 0.1, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Dark Brown', color: '#7d6556', td: 0.1, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Dark Chocolate', color: '#4d3324', td: 2, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Dark Green', color: '#68724d', td: 0.7, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Dark Red', color: '#bb3d43', td: 1.5, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Desert Tan', color: '#e8dbb7', td: 1, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Grass Green', color: '#76b56f', td: 0.8, source: 'https://filamentcolors.xyz/swatch/2986/' },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Ice Blue', color: '#a3d8e1', td: 1.8, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Ivory White', color: '#ebebe3', td: 3.4, source: 'https://filamentcolors.xyz/swatch/3916/' },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Latte Brown', color: '#bf9e82', td: 0.9, source: 'https://filamentcolors.xyz/swatch/3909/' },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Lemon Yellow', color: '#f7d959', td: 2.5, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Lilac Purple', color: '#ae96d4', td: 1, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Mandarin Orange', color: '#fc9257', td: 2.5, source: 'https://filamentcolors.xyz/swatch/3431/' },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Marine Blue', color: '#0078bf', td: 2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Nardo Gray', color: '#757575', td: 0.7, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Plum', color: '#950051', td: 4, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Sakura Pink', color: '#eab8ca', td: 2.2, source: 'https://filamentcolors.xyz/swatch/3908/' },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Scarlet Red', color: '#de4343', td: 2.2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Sky Blue', color: '#56b7e6', td: 4, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Terracotta', color: '#b15533', td: 3, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Baby Blue', color: '#a8c6ee', td: 4, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Blue', color: '#008bda', td: 4, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Candy Green', color: '#018814', td: 2, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Candy Red', color: '#d02727', td: 0.7, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Champagne', color: '#f3cfb2', td: 3, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Gold', color: '#f4a925', td: 5, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Mint', color: '#96dcb9', td: 3, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Pink', color: '#f7ada6', td: 8, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Purple', color: '#8671cb', td: 3, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Rose Gold', color: '#ba9594', td: 5, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Silver', color: '#c8c8c8', td: 0.5, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Titan Gray', color: '#5f6367', td: 4, source: COLOR_TOOLS, unverified: true },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ White', color: '#ffffff', td: 6.1, source: COLOR_TOOLS, unverified: true },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Beige', color: '#eccab0', td: 3.9, source: 'https://filamentcolors.xyz/swatch/3939/' },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Black', color: '#000000', td: 0.2, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Blue', color: '#054795', td: 1.4, source: 'https://filamentcolors.xyz/swatch/3388/' },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Bone White', color: '#ddd7c7', td: 5.7, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Cold White', color: '#f6fafd', td: 1.9, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Dark Blue', color: '#11204b', td: 1.4, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Dark Brown', color: '#55351c', td: 1.8, source: COMMUNITY_ESUN },
  // Colour measured on filamentcolors.xyz swatch 641 (the community list gives none).
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Fire Engine Red', color: '#91202b', td: 3.8, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Gold', color: '#f4c93f', td: 5.3, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Green', color: '#005e59', td: 1.6, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Grey', color: '#949494', td: 0.7, source: COMMUNITY_ESUN },
  // A HueForge model's description gives TD 1 for it (printables.com/model/624618).
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Light Blue', color: '#0cc1f5', td: 3.4, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Light Brown', color: '#c17a00', td: 1.5, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Magenta', color: '#f20666', td: 3.1, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Olive Green', color: '#455340', td: 0.2, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Orange', color: '#ff7713', td: 4.7, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Peak Green', color: '#6ce36a', td: 3.9, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Pine Green', color: '#005133', td: 0.2, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Pink', color: '#ff749e', td: 4.5, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Purple', color: '#b8008a', td: 1.4, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Red', color: '#c4402b', td: 3.5, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Silver', color: '#8b888a', td: 1.1, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ White', color: '#e1e9e9', td: 7.2, source: 'https://filamentcolors.xyz/swatch/3662/' },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Yellow', color: '#fbce2d', td: 4.3, source: COMMUNITY_ESUN },
];

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
 * ones it names ("matte black" finds PLA Matte Charcoal).
 */
export function searchFilaments(query: string, limit = 20, { families = false } = {}): LibraryFilament[] {
  const q = words(query);
  if (!q.length) return FILAMENT_LIBRARY.slice(0, limit);
  return FILAMENT_LIBRARY
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
 * find PLA Silk+ White).
 */
export function matchFilament(brand: string, name: string): LibraryFilament | undefined {
  const b = normalizeFilamentText(brand);
  const brandWords = b.split(' ');
  const q = new Set(words(name).filter((w) => !brandWords.includes(w)));
  if (!q.size) return undefined;
  let best: LibraryFilament | undefined;
  let bestExtra = Infinity;
  for (const f of FILAMENT_LIBRARY) {
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
 * The colours most HueForge prints use, one click away: black, white and greys for the values,
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
 * the one its brand and name mean (matchFilament). Undefined for custom filaments.
 */
export function libraryFilament(f: { brand?: string; name: string }): LibraryFilament | undefined {
  if (!f.brand) return undefined;
  const b = normalizeFilamentText(f.brand), n = normalizeFilamentText(f.name);
  return FILAMENT_LIBRARY.find((l) => normalizeFilamentText(l.brand) === b && normalizeFilamentText(l.name) === n) ?? matchFilament(f.brand, f.name);
}

/** The filament's TD is the library's estimate (unverified), not a published or the user's own value. */
export function estimatedTd(f: HfFilament): boolean {
  const l = libraryFilament(f);
  return !!l?.unverified && Math.abs(l.td - f.td) < 1e-6;
}

/** The picker's filaments: those matching the query (colour words included), of one line (its key) or all. */
export function pickerFilaments(query: string, line?: string): LibraryFilament[] {
  return searchFilaments(query, Infinity, { families: true }).filter((f) => !line || lineKey(f) === line);
}

/** The user's filaments matching a query: every word in the brand, the name or the colour's family. */
export function searchMyFilaments(list: HfFilament[], query: string): HfFilament[] {
  const q = words(query);
  return list.filter((f) => {
    const ws = [...words(`${f.brand ?? ''} ${f.name}`), ...colourFamilies(f.color)];
    return q.every((w) => ws.some((x) => x.includes(w)));
  });
}
