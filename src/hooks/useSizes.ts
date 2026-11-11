import { printer } from '../../shared/printer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Design, EvalResult, ParamValues, Quality, Vec3 } from '../../shared/types';
import type { BambuTemplate } from '../../shared/api';
import type { PrintProfile } from '../../shared/print';
import { costKey } from '../../shared/cost';
import { boxSize, cleanSizes, driverOf, hashText, mainAxis, MAX_SIZES, nextSize, printableMax, resolveSize, shapeKey, sizeKey, suggestSizes, type DesignSize, type ResolvedSize, type SizeAxis, type SizeTools } from '../../shared/sizes';
import { HIDDEN_KEY } from '../lib/settings';
import { EDIT_HISTORY_KEY } from '../../shared/editHistory';
import { uid } from '../lib/files';
import { sliceBuild, type CostStage } from './useCost';
import type { GeometryClient } from '../geometry/client';

interface Inputs {
  design: Design;
  /** Changes a design (the open one, or one still open in the background). */
  updateDesign: (id: string, fn: (d: Design) => Design) => void;
  /** The model as the design is (for the sizes' starting point). */
  shown: EvalResult | null;
  quality: Quality;
  /** The layout parameter and its print option: sizes are measured assembled and sliced laid out for print. */
  layoutKey?: string;
  printLayout?: string;
  hiddenParts: string[];
  userPrint: PrintProfile;
  oneColour: null | 'main' | string;
  onTemplate: (tpl: BambuTemplate) => void;
}

/** Slicing the sizes one after the other: which one, its stage, and how far the run got. */
export interface SizesSlicing { designId: string; sizeId: string; stage: CostStage; since: number; done: number; total: number; stopping: boolean }

/**
 * The open design's sale sizes (shared/sizes.ts): adding, renaming and removing them, building each
 * (cached with the design until the design changes), showing one in the 3D view, and slicing them
 * one at a time for their print time, grams and cost (cancellable, kept per size).
 */
export function useSizes(geo: GeometryClient, i: Inputs) {
  const { design, updateDesign, shown, layoutKey, printLayout } = i;
  const sizes = useMemo(() => cleanSizes(design.sizes), [design.sizes]);
  // Sizes are measured assembled (what the customer gets), not laid out for printing.
  const assembled = useMemo((): ParamValues => {
    const v = { ...design.values };
    delete v[HIDDEN_KEY];
    delete v[EDIT_HISTORY_KEY];
    if (layoutKey) v[layoutKey] = 'assembled';
    return v;
  }, [design.values, layoutKey]);
  const keyOf = useCallback((s: Pick<DesignSize, 'axis' | 'mm'>) => sizeKey(design.code, assembled, s.axis, s.mm), [design.code, assembled]);
  /** A size's build, if it is of the design as it is now. */
  const resolvedOf = useCallback((s: DesignSize): ResolvedSize | null => (s.resolved && s.resolved.key === keyOf(s) ? s.resolved : null), [keyOf]);
  /** What a size is sliced with: the design's values, the size's, laid out for print. */
  const printValues = useCallback((r: ResolvedSize): ParamValues => ({ ...design.values, ...r.values, ...(layoutKey && printLayout ? { [layoutKey]: printLayout } : {}) }), [design.values, layoutKey, printLayout]);
  const sliceKeyOf = useCallback((r: ResolvedSize) => hashText(costKey(design.code, printValues(r), i.hiddenParts, i.userPrint, i.oneColour, printer().id)), [design.code, printValues, i.hiddenParts, i.userPrint, i.oneColour, printer().id]);

  const latest = useRef({ design, assembled, keyOf, printValues, sliceKeyOf, i });
  latest.current = { design, assembled, keyOf, printValues, sliceKeyOf, i };

  const setSizes = useCallback((designId: string, fn: (s: DesignSize[]) => DesignSize[]) => updateDesign(designId, (d) => {
    const next = fn(cleanSizes(d.sizes));
    const out = { ...d, updatedAt: Date.now() };
    if (next.length) out.sizes = next; else delete out.sizes;
    return out;
  }), [updateDesign]);
  const patchSize = useCallback((designId: string, id: string, patch: Partial<DesignSize>) => setSizes(designId, (all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s))), [setSizes]);

  // ---- building sizes: one at a time (each is a few model builds in the geometry worker)
  const [building, setBuilding] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const tools = useCallback((code: string): SizeTools => ({
    evaluate: async (v) => { const o = await geo.evaluate(code, v, 'normal'); return o.result ?? { error: o.error.message }; },
    solve: (v, target, goal) => geo.solve(code, v, 'normal', target, goal),
  }), [geo]);
  /** A size built for the design as it is now (from the design when it is up to date). */
  const resolve = useCallback((s: DesignSize): Promise<ResolvedSize | null> => {
    const { design: d, assembled: base, keyOf: key } = latest.current;
    const k = key(s);
    if (s.resolved?.key === k) return Promise.resolve(s.resolved);
    const job = chain.current.then(async () => {
      // Built meanwhile (an earlier call for the same size)?
      const now = cleanSizes(latest.current.design.sizes).find((x) => x.id === s.id);
      if (now?.resolved?.key === k) return now.resolved;
      setBuilding((b) => [...b, s.id]);
      try {
        const r = await resolveSize(tools(d.code), base, s.axis, s.mm, k);
        if ('error' in r) { setErrors((e) => ({ ...e, [s.id]: r.error })); return null; }
        setErrors((e) => { const next = { ...e }; delete next[s.id]; return next; });
        patchSize(d.id, s.id, { resolved: r });
        return r;
      } finally {
        setBuilding((b) => b.filter((x) => x !== s.id));
      }
    });
    chain.current = job.catch(() => null);
    return job;
  }, [tools, patchSize]);

  // ---- adding, renaming, removing
  const base = useMemo(() => boxSize(shown), [shown]);
  const axis: SizeAxis | null = sizes[0]?.axis ?? (base ? mainAxis(base) : null);
  /** The main dimension's range the driving parameter allows (measured at its limits), or null when nothing limits it. */
  const limitsRef = useRef<{ key: string; range: [number, number] | null } | null>(null);
  const paramLimits = useCallback(async (): Promise<[number, number] | null> => {
    if (!shown || axis == null) return null;
    const driver = driverOf(shown, axis);
    if (!driver) return null;
    const key = JSON.stringify([design.code, assembled, axis]);
    if (limitsRef.current?.key === key) return limitsRef.current.range;
    const at = async (v: number) => boxSize((await geo.evaluate(design.code, { ...assembled, [driver[0]]: v }, 'normal')).result ?? null)?.[axis];
    const [a, b] = [await at(driver[1].min), await at(driver[1].max)];
    const range: [number, number] | null = a && b ? [+Math.min(a, b).toFixed(2), +Math.max(a, b).toFixed(2)] : null;
    limitsRef.current = { key, range };
    return range;
  }, [shown, axis, geo, design.code, assembled]);
  /** Where suggested sizes may go: within the driving parameter's limits and the printer. */
  const range = useCallback(async (): Promise<[number, number]> => {
    if (!base || axis == null) return [1, 1];
    let lo = Math.max(1, base[axis] * 0.2), hi = printableMax(base, axis);
    const limits = await paramLimits();
    if (limits) { lo = Math.max(lo, limits[0]); hi = Math.min(hi, limits[1]); }
    return [lo, Math.max(lo, hi)];
  }, [base, axis, paramLimits]);
  const suggest = useCallback(async () => {
    if (!base || axis == null) return;
    const r = await range();
    const list = suggestSizes(base[axis], r).map((s) => ({ id: uid(), label: s.label, axis, mm: s.mm }));
    setSizes(design.id, () => list);
  }, [base, axis, range, setSizes, design.id]);
  const add = useCallback(async () => {
    if (!base || axis == null || sizes.length >= MAX_SIZES) return;
    const [, hi] = await range();
    const n = nextSize(sizes, base[axis], hi);
    setSizes(design.id, (all) => [...all, { id: uid(), label: n.label, axis, mm: n.mm }]);
  }, [base, axis, sizes, range, setSizes, design.id]);
  const rename = useCallback((id: string, label: string) => patchSize(design.id, id, { label: label.trim().slice(0, 24) || '?' }), [patchSize, design.id]);
  // Why a size's dimension was kept within the driving parameter's limits (shown until it changes again).
  const [clamped, setClamped] = useState<Record<string, string>>({});
  /** A size's own dimension (only that size changes); kept within the driving parameter's limits, saying so. */
  const setMm = useCallback(async (id: string, mm: number) => {
    if (!(mm > 0 && mm < 10000)) return;
    const limits = await paramLimits();
    let v = +mm.toFixed(2);
    const label = shown && axis != null ? driverOf(shown, axis)?.[1].label ?? 'its parameter' : '';
    let note = '';
    if (limits && (v < limits[0] - 0.01 || v > limits[1] + 0.01)) {
      const to = v < limits[0] ? limits[0] : limits[1];
      note = `${+v.toFixed(1)} mm is outside what ${label} allows (${limits[0]} to ${limits[1]} mm): kept at ${to} mm.`;
      v = to;
    }
    setClamped((c) => { const next = { ...c }; if (note) next[id] = note; else delete next[id]; return next; });
    patchSize(design.id, id, { mm: v });
  }, [paramLimits, shown, axis, patchSize, design.id]);
  const remove = useCallback((id: string) => setSizes(design.id, (all) => all.filter((s) => s.id !== id)), [setSizes, design.id]);
  /** Puts the sizes in order, smallest first (their dimensions stay as they are). */
  const sort = useCallback(() => setSizes(design.id, (all) => [...all].sort((a, b) => a.mm - b.mm)), [setSizes, design.id]);
  /** The design's shape apart from its size: the photos made for another one are out of date. */
  const shape = useMemo(() => (shown ? shapeKey(design.code, design.values, shown.params, [HIDDEN_KEY, EDIT_HISTORY_KEY, ...(layoutKey ? [layoutKey] : [])]) : ''), [design.code, design.values, shown, layoutKey]);

  // ---- the size shown in the 3D view (null: the design as it is)
  const [viewed, setViewed] = useState<string | null>(null);
  // The view's build, of which size (another size's build is never shown under this one's name).
  const [viewResult, setViewResult] = useState<{ id: string; result: EvalResult } | null>(null);
  useEffect(() => { setViewed(null); setViewResult(null); }, [design.id]);
  const viewedSize = sizes.find((s) => s.id === viewed) ?? null;
  const viewedKey = viewedSize ? keyOf(viewedSize) : '';
  useEffect(() => {
    if (!viewedSize) { setViewResult(null); return; }
    let cancelled = false;
    void (async () => {
      const r = await resolve(viewedSize);
      if (cancelled || !r) return;
      // The design's own layout (the view's Print / Assembled choice), at the size.
      const o = await geo.evaluate(design.code, { ...design.values, ...r.values }, i.quality, { display: true });
      if (!cancelled) setViewResult(o.result ? { id: viewedSize.id, result: o.result } : null);
    })();
    return () => { cancelled = true; };
    // A new build when the size or the design changes (viewedKey covers both).
  }, [viewedKey, design.values, i.quality]);
  // A removed size isn't shown any more.
  useEffect(() => { if (viewed && !viewedSize) setViewed(null); }, [viewed, viewedSize]);

  /** A size's model as the view would show it (for its photos): its build at photo resolution. */
  const buildOf = useCallback(async (id: string): Promise<EvalResult | { error: string }> => {
    const s = cleanSizes(latest.current.design.sizes).find((x) => x.id === id);
    if (!s) return { error: 'That size was removed.' };
    const r = await resolve(s);
    if (!r) return { error: `Couldn't build the ${s.label} size.` };
    const { design: d, i: now } = latest.current;
    const o = await geo.evaluate(d.code, { ...d.values, ...r.values }, now.quality, { display: true });
    return o.result ?? { error: o.error.message };
  }, [resolve, geo]);

  // ---- slicing every size, one after the other
  const [slicing, setSlicing] = useState<SizesSlicing | null>(null);
  const stop = useRef(false);
  const sliceAll = useCallback(async () => {
    if (slicing) return;
    const { design: d } = latest.current;
    const list = cleanSizes(d.sizes);
    if (!list.length) return;
    stop.current = false;
    const since = performance.now();
    let done = 0;
    try {
      for (const s of list) {
        if (stop.current) break;
        const show = (stage: CostStage) => setSlicing({ designId: d.id, sizeId: s.id, stage, since, done, total: list.length, stopping: stop.current });
        show('model');
        const r = await resolve(s);
        if (!r) { done++; continue; }
        const { sliceKeyOf: key, printValues: values, i: now } = latest.current;
        const k = key(r);
        const fresh = cleanSizes(latest.current.design.sizes).find((x) => x.id === s.id);
        if (fresh?.slice?.key !== k) {
          try {
            const out = await sliceBuild(geo, { code: d.code, title: d.name, values: values(r), hiddenParts: now.hiddenParts, userPrint: now.userPrint, oneColour: now.oneColour, onTemplate: now.onTemplate, stage: show });
            if ('error' in out) setErrors((e) => ({ ...e, [s.id]: out.error }));
            else { patchSize(d.id, s.id, { slice: { key: k, stats: out.stats } }); setErrors((e) => { const next = { ...e }; delete next[s.id]; return next; }); }
          } catch (e) {
            setErrors((er) => ({ ...er, [s.id]: (e as Error).message }));
          }
        }
        done++;
      }
    } finally {
      setSlicing(null);
    }
  }, [slicing, resolve, geo, patchSize]);
  /** Stops after the slice under way (Bambu Studio can't be stopped halfway; its result is kept). */
  const cancel = useCallback(() => { stop.current = true; setSlicing((s) => (s ? { ...s, stopping: true } : s)); }, []);

  /** A size's slice, if it is of the design and print settings as they are now. */
  const sliceOf = useCallback((s: DesignSize) => {
    const r = resolvedOf(s);
    return r && s.slice && s.slice.key === sliceKeyOf(r) ? s.slice.stats : null;
  }, [resolvedOf, sliceKeyOf]);

  return {
    sizes, axis, base, resolvedOf, sliceOf, resolve, building, errors,
    suggest, add, rename, setMm, remove, sort, clamped, shape,
    viewed: viewedSize, view: setViewed, viewResult: viewedSize && viewResult?.id === viewedSize.id ? viewResult.result : null, buildOf,
    /** The sizes of this design being sliced, or null; `slicingOther`: another design's are. */
    slicing: slicing?.designId === design.id ? slicing : null, slicingOther: !!slicing && slicing.designId !== design.id, sliceAll, cancel,
  };
}

export type SizesControls = ReturnType<typeof useSizes>;

/** W × D × H of the parts shown (hidden parts left out), mm. */
export function visibleSize(r: EvalResult, hidden: string[]): Vec3 | null {
  const parts = r.parts.filter((x) => !hidden.includes(x.name));
  if (!parts.length) return null;
  return [0, 1, 2].map((k) => +(Math.max(...parts.map((x) => x.bbox.max[k])) - Math.min(...parts.map((x) => x.bbox.min[k]))).toFixed(1)) as Vec3;
}
