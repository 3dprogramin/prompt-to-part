// Filament library for HueForge prints: brands, colours and TD (transmission distance) values.
//
// CONTRACT (feat/hueforge): the side panel uses FILAMENT_LIBRARY and searchFilaments; the server
// answers POST /api/filaments/lookup { brand, name } with FilamentLookup (TD found on the web),
// which the page calls through lookupFilament() in src/lib/api.ts.
import type { HfFilament } from './hueforge';

export interface LibraryFilament extends HfFilament {
  brand: string;
  /** Product line, e.g. "PLA Basic", "PLA Matte", "PLA+". */
  line?: string;
  /** Where the TD value comes from (URL or "measured by …"). */
  source?: string;
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

// Published TD values only, each with its source; sorted by brand, line, then name. Where sources
// disagree, a TD measured on a swatch (filamentcolors.xyz, with that swatch's colour) wins over the
// community-compiled lists, and color_tools only fills colours nothing else has. Other colours are
// the makers' own hex codes (Bambu Lab's from Bambu Studio's filaments_color_codes.json). TD varies
// between batches and with how it is measured: the values are a starting point a test print corrects.
const COMMUNITY_BAMBU = 'https://github.com/penleychan/hueforge-td/blob/main/public/data/filaments/bambu-lab.json';
const COMMUNITY_ESUN = 'https://github.com/penleychan/hueforge-td/blob/main/public/data/filaments/esun.json';
// Its values are often rounded (2, 4, 6.1), so less sure than the others.
const COLOR_TOOLS = 'https://github.com/dterracino/color_tools/blob/main/color_tools/data/filaments.json';

export const FILAMENT_LIBRARY: LibraryFilament[] = [
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Bambu Green', color: '#00ae42', td: 1.2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Beige', color: '#f7e6de', td: 3.4, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Black', color: '#000000', td: 0.2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Blue', color: '#23529a', td: 2.6, source: 'https://filamentcolors.xyz/swatch/2532/' },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Blue Gray', color: '#657a89', td: 1.6, source: 'https://filamentcolors.xyz/swatch/2820/' },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Bright Green', color: '#becf00', td: 2, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Bronze', color: '#847d48', td: 1, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Brown', color: '#9d432c', td: 2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Cobalt Blue', color: '#0056b8', td: 4, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Cocoa Brown', color: '#6f5034', td: 2, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Cyan', color: '#0086d6', td: 2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Dark Gray', color: '#545454', td: 0.1, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Gold', color: '#e4bd68', td: 2.8, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Gray', color: '#8e9089', td: 0.4, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Hot Pink', color: '#f5547c', td: 8, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Indigo Purple', color: '#482960', td: 3, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Jade White', color: '#ffffff', td: 5.9, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Light Gray', color: '#d1d3d5', td: 4, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Magenta', color: '#ec008c', td: 2.8, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Maroon Red', color: '#9d2235', td: 4, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Mistletoe Green', color: '#3f8e43', td: 1, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Orange', color: '#ff6a13', td: 5.9, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Pink', color: '#f55a74', td: 8, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Pumpkin Orange', color: '#ff9016', td: 5, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Purple', color: '#5e43b7', td: 1.4, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Red', color: '#c12e1f', td: 4.2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Silver', color: '#a6a9aa', td: 0.5, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Sunflower Yellow', color: '#fec600', td: 6, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Turquoise', color: '#00b1b7', td: 1.4, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Yellow', color: '#f4ee2a', td: 4.8, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Apple Green', color: '#c2e189', td: 2, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Ash Gray', color: '#9b9ea0', td: 1.5, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Bone White', color: '#cbc6b8', td: 6.1, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Caramel', color: '#ae835b', td: 5, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Charcoal', color: '#000000', td: 0.3, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Dark Blue', color: '#042f56', td: 0.1, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Dark Brown', color: '#7d6556', td: 0.1, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Dark Chocolate', color: '#4d3324', td: 2, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Dark Green', color: '#68724d', td: 0.7, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Dark Red', color: '#bb3d43', td: 1.5, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Desert Tan', color: '#e8dbb7', td: 1, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Grass Green', color: '#76b56f', td: 0.8, source: 'https://filamentcolors.xyz/swatch/2986/' },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Ice Blue', color: '#a3d8e1', td: 1.8, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Ivory White', color: '#ebebe3', td: 3.4, source: 'https://filamentcolors.xyz/swatch/3916/' },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Latte Brown', color: '#bf9e82', td: 0.9, source: 'https://filamentcolors.xyz/swatch/3909/' },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Lemon Yellow', color: '#f7d959', td: 2.5, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Lilac Purple', color: '#ae96d4', td: 1, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Mandarin Orange', color: '#fc9257', td: 2.5, source: 'https://filamentcolors.xyz/swatch/3431/' },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Marine Blue', color: '#0078bf', td: 2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Nardo Gray', color: '#757575', td: 0.7, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Plum', color: '#950051', td: 4, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Sakura Pink', color: '#eab8ca', td: 2.2, source: 'https://filamentcolors.xyz/swatch/3908/' },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Scarlet Red', color: '#de4343', td: 2.2, source: COMMUNITY_BAMBU },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Sky Blue', color: '#56b7e6', td: 4, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Matte', name: 'PLA Matte Terracotta', color: '#b15533', td: 3, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Baby Blue', color: '#a8c6ee', td: 4, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Blue', color: '#008bda', td: 4, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Candy Green', color: '#018814', td: 2, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Candy Red', color: '#d02727', td: 0.7, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Champagne', color: '#f3cfb2', td: 3, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Gold', color: '#f4a925', td: 5, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Mint', color: '#96dcb9', td: 3, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Pink', color: '#f7ada6', td: 8, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Purple', color: '#8671cb', td: 3, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Rose Gold', color: '#ba9594', td: 5, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Silver', color: '#c8c8c8', td: 0.5, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ Titan Gray', color: '#5f6367', td: 4, source: COLOR_TOOLS },
  { brand: 'Bambu Lab', line: 'PLA Silk+', name: 'PLA Silk+ White', color: '#ffffff', td: 6.1, source: COLOR_TOOLS },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Beige', color: '#eccab0', td: 3.9, source: 'https://filamentcolors.xyz/swatch/3939/' },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Black', color: '#000000', td: 0.2, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Blue', color: '#054795', td: 1.4, source: 'https://filamentcolors.xyz/swatch/3388/' },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Bone White', color: '#ddd7c7', td: 5.7, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Cold White', color: '#f6fafd', td: 1.9, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Dark Blue', color: '#11204b', td: 1.4, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Dark Brown', color: '#55351c', td: 1.8, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Gold', color: '#f4c93f', td: 5.3, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Green', color: '#005e59', td: 1.6, source: COMMUNITY_ESUN },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Grey', color: '#949494', td: 0.7, source: COMMUNITY_ESUN },
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
function score(f: LibraryFilament, query: string[]): number {
  const fields: [string[], number][] = [[colourWords(f), 3], [words(`${f.line ?? ''} ${f.name}`), 2], [words(f.brand), 2]];
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

/** Library filaments matching a free-text query ("bambu black", "esun pla+ red"), best first. */
export function searchFilaments(query: string, limit = 20): LibraryFilament[] {
  const q = words(query);
  if (!q.length) return FILAMENT_LIBRARY.slice(0, limit);
  return FILAMENT_LIBRARY
    .map((f, i) => ({ f, i, s: score(f, q), finish: finishWords(f).length, extra: colourWords(f).length }))
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
