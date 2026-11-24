import type { Design, ParamValues } from './types';

/**
 * A new design from version `vi` of `design` (Clone / New design from vN): a fresh chat with that
 * version's script and `values`, remembering which design and version it came from. `fresh` is the
 * new, empty design (its id and dates).
 */
export function forkedDesign(design: Design, vi: number, fresh: Design, values: ParamValues): Design {
  const v = design.versions[vi];
  return {
    ...fresh,
    name: `${design.name} (from v${vi + 1})`,
    code: v.code,
    values,
    versions: [{ ...v, values, summary: `From "${design.name}" v${vi + 1}: ${v.summary}`, createdAt: fresh.createdAt }],
    currentVersion: 0,
    forkedFrom: { id: design.id, version: vi },
  };
}
