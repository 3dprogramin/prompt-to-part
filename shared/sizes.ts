// Sale sizes: one design sold in several sizes (S / M / L). A size is the design at another overall
// size, made the way the Object tab's Overall size makes it: through the parameters that drive the
// size (`drives`), or, when the main one has none, by scaling the model like Scale % does. A flat
// piece (a plaque, a sign) is scaled only across its face, so its thickness and reliefs stay as
// designed. Each size's geometry is built for real (resolveSize), never estimated.
import { FACE_SCALE_KEY, SCALE_KEY } from './params';
import { PRINTER } from './printer';
import type { SliceStats } from './cost';
import type { DimTarget, EvalResult, NumberParam, ParamValues, SolveResult, Vec3 } from './types';

export type SizeAxis = 0 | 1 | 2;
/** How a size is made: its driving parameters, a uniform scale, or a flat piece's face scale. */
export type SizeHow = 'params' | 'scale' | 'face';

export interface DesignSize {
  id: string;
  /** "S", "M", "L", "30 cm"… */
  label: string;
  /** The axis of the main dimension (the same for every size of a design): 0 W, 1 D, 2 H. */
  axis: SizeAxis;
  /** The main dimension, mm. */
  mm: number;
  /** What it was last built as; out of date when the design changed (its key differs). */
  resolved?: ResolvedSize;
  /** Bambu Studio's slice of it; out of date when the design or the print settings changed. */
  slice?: SizeSlice;
}

export interface ResolvedSize {
  /** sizeKey of what it was built from. */
  key: string;
  /** The values that make this size, on top of the design's (driving parameters, or a scale). */
  values: ParamValues;
  /** The real W × D × H, mm (as assembled). */
  size: Vec3;
  how: SizeHow;
  /** Why the size isn't exactly what was asked for, or a parameter left its slider's range. */
  note?: string;
}

export interface SizeSlice {
  /** hashText(costKey(...)) of what was sliced. */
  key: string;
  stats: SliceStats;
}

export const MAX_SIZES = 8;
export const MAX_SIZE_LABEL = 24;
export const AXIS_NAMES = ['W', 'D', 'H'] as const;
/** Thinner than this share of its face: a flat piece (as shopPlan and the photos have it). */
const FLAT = 0.25;
/** How close a scaled size must get to the main dimension asked for, mm. */
const SCALE_TOL = 0.02;

export const isFlat = (s: Vec3) => s[2] < FLAT * Math.min(s[0], s[1]);

/** The model's W × D × H, mm. */
export function boxSize(r: Pick<EvalResult, 'bbox'> | null): Vec3 | null {
  const b = r?.bbox;
  return b ? [0, 1, 2].map((k) => b.max[k] - b.min[k]) as Vec3 : null;
}

/** The dimension a size is given by: a flat piece's longer side, else its biggest one. */
export function mainAxis(s: Vec3): SizeAxis {
  if (isFlat(s)) return s[0] >= s[1] ? 0 : 1;
  return s[0] >= s[1] && s[0] >= s[2] ? 0 : s[1] >= s[2] ? 1 : 2;
}

/** The axes a size changes: a flat piece's face, anything else all three. */
export const scaledAxes = (s: Vec3): SizeAxis[] => (isFlat(s) ? [0, 1] : [0, 1, 2]);

/** The parameter that drives the size along an axis (`drives`), if the script has one. */
export function driverOf(r: Pick<EvalResult, 'params'>, axis: SizeAxis): [string, NumberParam] | undefined {
  return Object.entries(r.params).find((e): e is [string, NumberParam] => (e[1].type === 'number' || e[1].type === 'integer') && e[1].drives === 'xyz'[axis]);
}

export interface SizePlan {
  how: SizeHow;
  /** The size over the model as it is, along the main axis. */
  factor: number;
  /** 'params': each driven axis's target, the main one first. */
  goals: { axis: SizeAxis; goal: number }[];
  /** 'scale' / 'face': the scale to start from. */
  values: ParamValues;
}

/**
 * How to make the model `mm` long along `axis`: with a driving parameter for that axis, every
 * changed axis that has one goes to the same proportion (the main one first); without, Scale %
 * for a solid object, the face scale for a flat piece.
 */
export function sizePlan(r: Pick<EvalResult, 'bbox' | 'params'>, values: ParamValues, axis: SizeAxis, mm: number): SizePlan | null {
  const s = boxSize(r);
  if (!s || !(s[axis] > 0) || !(mm > 0)) return null;
  const factor = mm / s[axis];
  const axes = scaledAxes(s);
  if (driverOf(r, axis)) {
    const goals = [axis, ...axes.filter((k) => k !== axis && driverOf(r, k))].map((k) => ({ axis: k, goal: k === axis ? mm : s[k] * factor }));
    return { how: 'params', factor, goals, values: {} };
  }
  if (isFlat(s)) return { how: 'face', factor, goals: [], values: { [FACE_SCALE_KEY]: positive(values[FACE_SCALE_KEY]) * factor } };
  return { how: 'scale', factor, goals: [], values: { [SCALE_KEY]: positive(values[SCALE_KEY]) * factor } };
}

const positive = (v: unknown) => { const n = Number(v ?? 1); return Number.isFinite(n) && n > 0 ? n : 1; };

/** Builds the model for a size: the geometry worker's evaluate and Overall size's solver. */
export interface SizeTools {
  /** The model with these values, or the reason it failed. */
  evaluate: (values: ParamValues) => Promise<EvalResult | { error: string }>;
  solve: (values: ParamValues, target: DimTarget, goal: number) => Promise<SolveResult>;
}

/**
 * Builds a size: the values that make it, on top of `base` (the design's values as assembled), and
 * the real size they give. `base` may be given already built (`built`).
 */
export async function resolveSize(tools: SizeTools, base: ParamValues, axis: SizeAxis, mm: number, key: string, built?: EvalResult): Promise<ResolvedSize | { error: string }> {
  const first = built ?? await tools.evaluate(base);
  if ('error' in first) return first;
  const plan = sizePlan(first, base, axis, mm);
  if (!plan) return { error: 'The model has no size to start from.' };
  let values: ParamValues = { ...base, ...plan.values };
  const notes: string[] = [];
  let last: EvalResult | null = null;
  if (plan.how === 'params') {
    for (const g of plan.goals) {
      const r = await tools.solve(values, { kind: 'bbox', axis: g.axis }, g.goal);
      if (r.key && r.value != null) values = { ...values, [r.key]: +r.value.toFixed(4) };
      if (!r.ok && r.message) notes.push(`${AXIS_NAMES[g.axis]}: ${r.message}`);
    }
    for (const k of Object.keys(values)) {
      const d = first.params[k];
      const v = Number(values[k]);
      if (values[k] === base[k] || !d || (d.type !== 'number' && d.type !== 'integer') || (v >= d.min - 1e-9 && v <= d.max + 1e-9)) continue;
      notes.push(`${d.label ?? k} is ${+v.toFixed(2)}, outside its slider's range (${d.min} to ${d.max}).`);
    }
  } else {
    // Scaling is exact for the model, but added text or a drawing may stick out: a few corrections.
    const scaleKey = plan.how === 'face' ? FACE_SCALE_KEY : SCALE_KEY;
    for (let i = 0; i < 4; i++) {
      const r = await tools.evaluate(values);
      if ('error' in r) return r;
      last = r;
      const got = boxSize(r)?.[axis] ?? 0;
      if (!(got > 0) || Math.abs(got - mm) < SCALE_TOL) break;
      values = { ...values, [scaleKey]: +(Number(values[scaleKey]) * mm / got).toFixed(6) };
      last = null;
    }
  }
  const end = last ?? await tools.evaluate(values);
  if ('error' in end) return end;
  const size = boxSize(end)!;
  const delta: ParamValues = {};
  for (const [k, v] of Object.entries(values)) if (v !== base[k]) delta[k] = v;
  return { key, values: delta, size: size.map((v) => +v.toFixed(2)) as Vec3, how: plan.how, ...(notes.length ? { note: notes.join(' ') } : {}) };
}

/** What a size is built from: another key means its build is out of date. */
export function sizeKey(code: string, values: ParamValues, axis: SizeAxis, mm: number): string {
  return hashText(JSON.stringify([code, values, axis, mm]));
}

/**
 * The design's shape apart from its overall size: its script and values, without the ones that only
 * size it (the driving parameters, Scale %) or only show it (`ignore`: hidden parts, the layout).
 * Photos keep it: another shape means they show an earlier version of the product.
 */
export function shapeKey(code: string, values: ParamValues, params: EvalResult['params'], ignore: string[] = []): string {
  const v: ParamValues = {};
  for (const k of Object.keys(values).sort()) {
    const d = params[k];
    if (k === SCALE_KEY || ignore.includes(k) || (d && (d.type === 'number' || d.type === 'integer') && d.drives)) continue;
    v[k] = values[k];
  }
  return hashText(JSON.stringify([code, v]));
}

/** A short hash of a text (cyrb53), for keys stored with the design. */
export function hashText(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A round size: whole mm when small, then 5 mm, then 10 mm steps. */
export function niceMm(v: number): number {
  const step = v < 40 ? 1 : v < 150 ? 5 : 10;
  return Math.max(step, Math.round(v / step) * step);
}

/**
 * The longest the main dimension can be with the model still fitting the printer (each changed
 * axis grows in proportion; a flat piece's thickness stays).
 */
export function printableMax(s: Vec3, axis: SizeAxis): number {
  const room = [PRINTER.bed[0], PRINTER.bed[1], PRINTER.height];
  // Turned on the bed, the longer side can use the longer room (the bed is square, so no matter).
  return Math.min(...scaledAxes(s).map((k) => (s[axis] * room[k]) / Math.max(s[k], 1e-6)));
}

/**
 * Three sizes around the model's own: S, M (as it is, rounded) and L, kept within `range` (the
 * driving parameter's limits and the printer). Fewer when the range is too narrow for three.
 */
export function suggestSizes(current: number, range: [number, number]): { label: string; mm: number }[] {
  const [lo, hi] = range;
  const fit = (v: number) => Math.min(Math.max(niceMm(v), Math.ceil(lo)), Math.floor(hi));
  const out: { label: string; mm: number }[] = [];
  for (const [label, k] of [['S', 0.7], ['M', 1], ['L', 1.4]] as const) {
    const mm = fit(current * k);
    if (mm > 0 && !out.some((o) => Math.abs(o.mm - mm) < 1)) out.push({ label, mm });
  }
  return out;
}

const NEXT_LABELS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];

/** One more size after the others: the next letter (or "Size n"), a quarter bigger than the biggest, within `hi`. */
export function nextSize(sizes: Pick<DesignSize, 'label' | 'mm'>[], current: number, hi: number): { label: string; mm: number } {
  const used = new Set(sizes.map((s) => s.label));
  const after = Math.max(-1, ...sizes.map((s) => NEXT_LABELS.indexOf(s.label)));
  const label = (after >= 0 ? NEXT_LABELS.slice(after + 1) : []).find((l) => !used.has(l))
    ?? [...Array(MAX_SIZES + 1).keys()].map((i) => `Size ${i + 1}`).find((l) => !used.has(l))!;
  if (!sizes.length) return { label: 'M', mm: niceMm(current) };
  const biggest = Math.max(...sizes.map((s) => s.mm));
  const up = niceMm(biggest * 1.25);
  // Past the printer only when the biggest already fills it (the user may print it in pieces).
  const capped = Math.min(up, Math.floor(hi));
  return { label, mm: capped > biggest ? capped : up };
}

/** The sizes stored with a design, checked (an old design has none: it is sold in its one size). */
export function cleanSizes(raw: unknown): DesignSize[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignSize[] = [];
  for (const s of raw.slice(0, MAX_SIZES)) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Partial<DesignSize>;
    if (typeof o.id !== 'string' || !o.id || o.id.length > 64 || typeof o.label !== 'string') continue;
    if (!(o.axis === 0 || o.axis === 1 || o.axis === 2) || typeof o.mm !== 'number' || !(o.mm > 0 && o.mm < 10000)) continue;
    const size: DesignSize = { id: o.id, label: o.label.slice(0, MAX_SIZE_LABEL), axis: o.axis, mm: o.mm };
    const r = o.resolved;
    if (r && typeof r.key === 'string' && r.values && typeof r.values === 'object' && isVec3(r.size) && ['params', 'scale', 'face'].includes(r.how)) {
      size.resolved = { key: r.key, values: r.values, size: r.size, how: r.how, ...(typeof r.note === 'string' ? { note: r.note.slice(0, 500) } : {}) };
    }
    const sl = o.slice;
    if (sl && typeof sl.key === 'string' && sl.stats && Number.isFinite(sl.stats.seconds) && Number.isFinite(sl.stats.grams)) {
      size.slice = { key: sl.key, stats: { seconds: sl.stats.seconds, grams: sl.stats.grams, filaments: Array.isArray(sl.stats.filaments) ? sl.stats.filaments : [] } };
    }
    out.push(size);
  }
  return out;
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** "240 × 160 × 6 mm" (without the unit: "240 × 160 × 6") */
export const sizeText = (s: Vec3, unit = true) => `${s.map((v) => (v >= 100 ? Math.round(v) : +v.toFixed(1))).join(' × ')}${unit ? ' mm' : ''}`;
