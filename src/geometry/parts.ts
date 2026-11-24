// Kept apart from validate.ts so the page can use it without loading the model runtime (the worker's).

/**
 * The parts an export writes: the one named in `only`, or every part not excluded. Chosen from the
 * build being exported, so parts that only exist at the current values are included.
 */
export function exportedParts<P extends { name: string; qr?: { host: string } }>(r: { parts: P[] }, opts: { exclude?: string[]; only?: string }): P[] {
  return r.parts.filter((p) => (opts.only != null ? p.name === opts.only : !partHidden(p, opts.exclude ?? [])));
}

/** Whether a part is hidden: a QR code's tile and modules also go with the part they sit on. */
export function partHidden(p: { name: string; qr?: { host: string } }, hidden: string[]): boolean {
  return hidden.includes(p.name) || (!!p.qr && hidden.includes(p.qr.host));
}
