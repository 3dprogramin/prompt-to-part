// Which parts each parameter changes, found by building the model with that parameter nudged and
// comparing the parts: a parameter can then be greyed out while all the parts it changes are hidden.
import type { EvalResult, ParamDef, ParamValue, ParamValues } from './types';

/** A different value of the same kind (null: not worth trying, e.g. a font). */
export function nudge(d: ParamDef, v: ParamValue): ParamValue | null {
  if (d.type === 'boolean') return !v;
  if (d.type === 'select') return d.options.find((o) => o.value !== v)?.value ?? null;
  if (d.type === 'text') {
    if (d.font) return null;
    const s = String(v);
    // Same length (some scripts need words of equal length), last letter swapped.
    return s ? s.slice(0, -1) + (s.at(-1) === 'A' ? 'B' : 'A') : 'A';
  }
  const span = d.max - d.min, n = Number(v);
  let next = n + span * 0.1 <= d.max ? n + span * 0.1 : n - span * 0.1;
  if (d.type === 'integer') next = Math.round(next) === n ? (n + 1 <= d.max ? n + 1 : n - 1) : Math.round(next);
  return next === n ? null : next;
}

const signature = (p: EvalResult['parts'][number]) =>
  [...p.bbox.min, ...p.bbox.max, p.volume].map((x) => Math.round(x * 1000)).join(',') + `:${p.triCount}`;

/**
 * Parameter → names of the parts it changes. `evaluate` builds the model with the given values
 * (and may throw); parameters whose variant fails or changes nothing are left out.
 */
export function probeParamOwners(base: EvalResult, values: ParamValues, evaluate: (values: ParamValues) => EvalResult): Record<string, string[]> {
  const before = new Map(base.parts.map((p) => [p.name, signature(p)]));
  const out: Record<string, string[]> = {};
  for (const [k, d] of Object.entries(base.params)) {
    const v = nudge(d, base.values[k]);
    if (v == null) continue;
    let r: EvalResult;
    try { r = evaluate({ ...values, [k]: v }); } catch { continue; }
    const after = new Map(r.parts.map((p) => [p.name, signature(p)]));
    const changed = [...before.keys()].filter((n) => after.get(n) !== before.get(n));
    if (changed.length) out[k] = changed;
  }
  return out;
}
