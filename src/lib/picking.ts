// Picking several items of a list for a bulk action (designs in the Designs menu, product photos),
// as in a file manager: a click picks one or drops it, a shift-click a range.

/**
 * The picked ids after a click on `target`'s box: a plain click picks it or drops it; a shift-click
 * does the same to every item between the last one clicked (`anchor`) and it, in the order shown.
 * Only items in `order` (the shown ones) stay picked.
 */
export function pickIds(order: readonly string[], picked: ReadonlySet<string>, target: string, anchor: string | null, range: boolean): Set<string> {
  const next = new Set([...picked].filter((id) => order.includes(id)));
  const on = !next.has(target);
  const from = anchor == null ? -1 : order.indexOf(anchor), to = order.indexOf(target);
  if (to < 0) return next;
  const ids = range && from >= 0 ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : [target];
  for (const id of ids) if (on) next.add(id); else next.delete(id);
  return next;
}
