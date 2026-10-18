// Kept apart from validate.ts so the page can use it without loading the model runtime (the worker's).

/**
 * The parts an export writes: the one named in `only`, or every part not excluded. Chosen from the
 * build being exported, so parts that only exist at the current values are included.
 */
export function exportedParts<P extends { name: string }>(r: { parts: P[] }, opts: { exclude?: string[]; only?: string }): P[] {
  return r.parts.filter((p) => (opts.only != null ? p.name === opts.only : !opts.exclude?.includes(p.name)));
}
