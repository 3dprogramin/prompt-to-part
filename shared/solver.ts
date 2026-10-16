// Solve for the parameter value that makes a dimension (overall size or a callout) hit a target.
import { evaluateScript } from './runtime';
import type { DimTarget, EvalResult, NumberParam, ParamValues, Quality, SolveResult } from './types';

const AXES = ['x', 'y', 'z'] as const;
const TOL = 0.002; // mm

function measure(r: EvalResult, t: DimTarget): number {
  if (t.kind === 'bbox') return r.bbox ? r.bbox.max[t.axis] - r.bbox.min[t.axis] : NaN;
  const d = r.dimensions[t.index];
  return d ? Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]) : NaN;
}

function sideEffect(a: EvalResult, b: EvalResult, t: DimTarget): number {
  if (!a.bbox || !b.bbox) return 0;
  let s = 0;
  for (let k = 0; k < 3; k++) {
    if (t.kind === 'bbox' && k === t.axis) continue;
    s += Math.abs((b.bbox.max[k] - b.bbox.min[k]) - (a.bbox.max[k] - a.bbox.min[k]));
  }
  return s;
}

export function solveDimension(code: string, values: ParamValues, target: DimTarget, goal: number, quality: Quality): SolveResult {
  if (!(goal > 0)) return { ok: false, message: 'Enter a positive size.' };
  const run = (v: ParamValues) => evaluateScript(code, v, quality, { lite: true });
  const base = run(values);
  const s0 = measure(base, target);
  if (!Number.isFinite(s0)) return { ok: false, message: 'That dimension no longer exists.' };
  if (Math.abs(s0 - goal) < TOL) return { ok: true, achieved: s0 };

  const numeric = Object.entries(base.params).filter((e): e is [string, NumberParam] => e[1].type === 'number' || e[1].type === 'integer');
  let pool = numeric;
  if (target.kind === 'callout') {
    const linked = base.dimensions[target.index]?.param;
    const hit = numeric.filter(([k]) => k === linked);
    if (hit.length) pool = hit;
  } else {
    const declared = numeric.filter(([, d]) => d.drives === AXES[target.axis]);
    if (declared.length) pool = declared;
  }

  // Probe each candidate's influence on the dimension.
  const probes: { key: string; def: NumberParam; slope: number; side: number }[] = [];
  for (const [key, def] of pool) {
    const v = Number(base.values[key]);
    let dv = Math.max(def.step ?? 0, Math.abs(v) * 0.05, (def.max - def.min) * 0.02, 0.01);
    if (def.type === 'integer') dv = Math.max(1, Math.round(dv));
    let v2 = v + dv;
    if (v2 > def.max && v - dv >= def.min) v2 = v - dv;
    try {
      const r = run({ ...values, [key]: v2 });
      const slope = (measure(r, target) - s0) / (v2 - v);
      if (Number.isFinite(slope) && Math.abs(slope) > 0.02) probes.push({ key, def, slope, side: sideEffect(base, r, target) / Math.abs(v2 - v) });
    } catch { /* this value breaks the model – skip candidate */ }
  }
  if (!probes.length) {
    return { ok: false, message: target.kind === 'bbox' ? `No parameter changes the ${AXES[target.axis].toUpperCase()} size.` : 'No parameter changes this dimension.' };
  }
  // Prefer continuous params with few side effects and a ~1:1 relationship.
  const score = (p: (typeof probes)[number]) => (p.def.type === 'integer' ? 10 : 0) + p.side / Math.abs(p.slope) + Math.abs(1 - Math.abs(p.slope)) * 0.2;
  probes.sort((a, b) => score(a) - score(b));

  let best: SolveResult = { ok: false, message: 'Could not reach that size.' };
  let bestErr = Infinity;
  for (const p of probes.slice(0, 3)) {
    let v = Number(base.values[p.key]);
    let s = s0;
    let slope = p.slope;
    const lo = p.def.min >= 0 ? Math.max(1e-3, p.def.min * 0.05) : -Infinity;
    for (let iter = 0; iter < 14; iter++) {
      let next = v + (goal - s) / slope;
      if (p.def.type === 'integer') next = Math.round(next);
      next = Math.max(lo, next);
      if (Math.abs(next - v) < 1e-9) break;
      let r: EvalResult | null = null;
      for (let tries = 0; tries < 6 && !r; tries++) {
        try { r = run({ ...values, [p.key]: next }); } catch { next = (next + v) / 2; }
      }
      if (!r) break;
      const sn = measure(r, target);
      if (!Number.isFinite(sn)) break;
      const ds = sn - s;
      if (Math.abs(next - v) > 1e-9 && Math.abs(ds) > 1e-9) slope = ds / (next - v);
      v = next;
      s = sn;
      const err = Math.abs(s - goal);
      if (err < bestErr) {
        bestErr = err;
        best = { ok: err < 0.05, key: p.key, value: v, achieved: s };
      }
      if (err < TOL) break;
    }
    if (bestErr < TOL) break;
  }
  if (!best.ok && best.key) {
    best.message = `Closest reachable: ${best.achieved?.toFixed(2)} mm via “${base.params[best.key].label ?? best.key}”.`;
  }
  return best;
}
