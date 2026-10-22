// Design tags: a design can have several, to tell real shop products from throwaway tests and to
// group designs ("Ornamente", "Line art perete"). Two are built in, with their own colour and icon;
// the rest are the user's own words. The server keeps them apart from the designs (data/tags.json),
// like the stars, so tagging never changes a design or its place in the list.

export interface BuiltinTag { name: string; icon: string; title: string }

/** The built-in tags, in the order they are listed. */
export const BUILTIN_TAGS: readonly BuiltinTag[] = [
  { name: 'Product', icon: 'bag', title: 'A product: live or planned in the shop' },
  { name: 'Temp', icon: 'timer', title: 'A throwaway test: safe to delete' },
];
export const PRODUCT_TAG = 'Product';
export const TEMP_TAG = 'Temp';

/** Most tags on one design, and the longest tag. */
export const MAX_TAGS = 12;
export const MAX_TAG_CHARS = 32;

/** The built-in tag this name is (any case), or undefined. */
export const builtinTag = (name: string) => BUILTIN_TAGS.find((b) => b.name.toLowerCase() === name.toLowerCase());

/** Case and accents don't matter when tags are compared or searched (ș is s). */
export const foldText = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** A tag as stored: spaces trimmed and collapsed, control characters dropped, a built-in in its own spelling; '' if empty. */
export function cleanTag(raw: string): string {
  const t = raw.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  return builtinTag(t)?.name ?? t;
}

/** What is wrong with a list of tags a page sent, or null. */
export function tagsProblem(v: unknown): string | null {
  if (!Array.isArray(v) || !v.every((t) => typeof t === 'string')) return 'tags must be a list of words';
  const tags = v.map(cleanTag);
  if (tags.some((t) => !t)) return 'a tag cannot be empty';
  if (tags.some((t) => t.length > MAX_TAG_CHARS)) return `a tag can be up to ${MAX_TAG_CHARS} characters`;
  if (new Set(tags.map(foldText)).size > MAX_TAGS) return `a design can have up to ${MAX_TAGS} tags`;
  return null;
}

/**
 * The tags to keep: cleaned, each once (the first spelling wins), the built-ins first, at most
 * MAX_TAGS; anything that isn't a usable tag is left out (a hand-edited or old file).
 */
export function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const t = cleanTag(raw), key = foldText(t);
    if (!t || t.length > MAX_TAG_CHARS || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  const rank = (t: string) => { const i = BUILTIN_TAGS.findIndex((b) => b.name === t); return i < 0 ? BUILTIN_TAGS.length : i; };
  return out.map((t, i) => [t, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t).slice(0, MAX_TAGS);
}

/** Whether `tags` has `tag` (case and accents don't matter). */
export const hasTag = (tags: readonly string[] | undefined, tag: string) => !!tags?.some((t) => foldText(t) === foldText(tag));

/** `tags` with `tag` added or taken away. */
export function withTag(tags: readonly string[] | undefined, tag: string, on: boolean): string[] {
  if (on && hasTag(tags, tag)) return cleanTags(tags);
  const rest = (tags ?? []).filter((t) => foldText(t) !== foldText(tag));
  return cleanTags(on ? [...rest, tag] : rest);
}

/** Every design's tags by id, as kept in data/tags.json: unusable ids and empty lists left out. */
export function cleanTagMap(v: unknown, validId: (id: string) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, tags] of Object.entries(v)) {
    const clean = cleanTags(tags);
    if (validId(id) && clean.length) out[id] = clean;
  }
  return out;
}
