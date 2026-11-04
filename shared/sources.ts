// Where the real-world dimensions a design is built around came from (a board's hole spacing, a
// phone's thickness), as Claude reports them when it submits a model.

export type Trust = 'high' | 'medium' | 'low';

export const SOURCE_KINDS = {
  official: { short: 'official', label: 'Official', trust: 'high', hint: "The manufacturer's mechanical drawing, datasheet or spec page" },
  distributor: { short: 'distributor', label: 'Distributor', trust: 'high', hint: 'A datasheet or listing from an authorised distributor or a reputable retailer' },
  user: { short: 'from you', label: 'From you', trust: 'high', hint: 'A number, link or photo you gave in the chat' },
  community: { short: 'community', label: 'Community', trust: 'medium', hint: "A forum or Q&A post, a wiki or blog, or someone else's 3D model" },
  memory: { short: 'from memory', label: 'From memory', trust: 'medium', hint: 'From memory, not looked up in this conversation' },
  social: { short: 'social media', label: 'Social media', trust: 'low', hint: 'An Instagram, TikTok, YouTube or X post' },
  estimate: { short: 'estimated', label: 'Estimate', trust: 'low', hint: 'Guessed, or judged from a photo' },
} as const satisfies Record<string, { short: string; label: string; trust: Trust; hint: string }>;

export type SourceKind = keyof typeof SOURCE_KINDS;
/** Most to least trustworthy. */
export const SOURCE_KIND_NAMES = Object.keys(SOURCE_KINDS) as [SourceKind, ...SourceKind[]];
/** Kinds that come from a web page, so they need its URL. */
export const WEB_KINDS: readonly SourceKind[] = ['official', 'distributor', 'community', 'social'];

export interface DimensionSource {
  /** What the value is, e.g. "Mounting holes". */
  dimension: string;
  /** The value used, with units, e.g. "58 × 49 mm, Ø 2.7". */
  value: string;
  kind: SourceKind;
  url?: string;
  /** The app saw Claude open this page (WebFetch) while working on the design. */
  opened?: boolean;
}

/** The same page for http/https, with or without www., a trailing slash or a #fragment; null if not a web URL. */
export function pageKey(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

/** The site of a web URL as a link shows it ("raspberrypi.com"); null if it is not a valid http(s) URL. */
export function siteName(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
  return u.hostname.toLowerCase().replace(/^www\./, '');
}

/** Why Claude's list of sources can't be accepted, or null. */
export function sourcesProblem(list: DimensionSource[]): string | null {
  for (const s of list) {
    if (WEB_KINDS.includes(s.kind) && !pageKey(s.url)) return `"${s.dimension}" is marked ${s.kind} but has no http(s) URL. Give the page it came from, or use the kind that fits (memory, estimate…).`;
    if (s.url && !pageKey(s.url)) return `"${s.dimension}": the URL must be an http(s) address.`;
  }
  return null;
}

/** The least trustworthy kind in the list. */
export function weakestKind(list: DimensionSource[]): SourceKind | null {
  let worst = -1;
  for (const s of list) worst = Math.max(worst, SOURCE_KIND_NAMES.indexOf(s.kind));
  return worst < 0 ? null : SOURCE_KIND_NAMES[worst];
}

/** "3 official, 1 estimated", most trustworthy first. */
export function sourcesSummary(list: DimensionSource[]): string {
  return SOURCE_KIND_NAMES.map((k) => [k, list.filter((s) => s.kind === k).length] as const)
    .filter(([, n]) => n).map(([k, n]) => `${n} ${SOURCE_KINDS[k].short}`).join(', ');
}
