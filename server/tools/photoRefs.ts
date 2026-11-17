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

/** At most `max` of `list` (taken from `references`, in order): the mid-reply pictures first kept, the rest filled from the start. */
export function cutPhotos(references: string[], list: string[], max: number): string[] {
  if (list.length <= max) return list;
  const steered = new Set(references.slice(startCount.get(references) ?? references.length));
  const mid = list.filter((p) => steered.has(p)).slice(-max);
  const rest = list.filter((p) => !steered.has(p)).slice(0, max - mid.length);
  return list.filter((p) => rest.includes(p) || mid.includes(p));
}
