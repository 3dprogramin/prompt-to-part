// A reply's photo list (`references`) grows when the user sends pictures while it works. They are
// appended so photo numbers never shift, but the image tools take only the first few photos, so
// when they must cut they keep the mid-reply pictures (the newest the user sent).

/** How many photos each reply's list held when it started, set when the first mid-reply picture arrives. */
const startCount = new WeakMap<string[], number>();

/** Append pictures sent mid-reply. */
export function addSteeredPhotos(references: string[], urls: string[]): void {
  if (!startCount.has(references)) startCount.set(references, references.length);
  references.push(...urls);
}

/**
 * At most `max` of `list` (the reply's photos in order, maybe filtered, with earlier chat photos after them), as a new array:
 * the mid-reply pictures are kept first, the rest filled from the start. Chosen by position, so a repeated photo counts once each.
 */
export function cutPhotos(references: string[], list: string[], max: number): string[] {
  if (list.length <= max) return list.slice();
  const start = startCount.get(references);
  if (start === undefined) return list.slice(0, max); // nothing was sent mid-reply
  let at = 0;
  const mid = list.map((p) => { while (at < references.length && references[at] !== p) at++; return at < references.length && at++ >= start; });
  const kept = new Set<number>();
  for (let i = list.length - 1; i >= 0 && kept.size < max; i--) if (mid[i]) kept.add(i);
  for (let i = 0; i < list.length && kept.size < max; i++) if (!mid[i]) kept.add(i);
  return list.filter((_, i) => kept.has(i));
}
