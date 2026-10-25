// Checking the model: Validate (built and checked at high resolution) and the assembly animation's
// steps (from the assembled and exploded layouts).
import type { Dispatch, SetStateAction } from 'react';
import type { Design, EvalResult, ParamDef, ParamValues, Quality } from '../../shared/types';
import type { GeometryClient } from '../geometry/client';
import type { ValidationState } from '../components/ValidationPanel';
import type { PlaybackStep } from '../viewer/Viewer';
import type { useLiveModel } from '../hooks/useLiveModel';
import type { Notice } from './notice';
import type { usePrintSettings } from './usePrintSettings';

/** Validate and Assemble for the design as it is now (App makes them each render). */
export function modelChecks({ design, shown, geo, quality, fullValues, hiddenParts, printHints, layoutKey, layoutDef, layoutValue,
  setValidating, setValidation, setValidationOpen, setNotice, setPlayback, setPlaybackLoading }: {
  design: Design; shown: ReturnType<typeof useLiveModel>['result']; geo: GeometryClient; quality: Quality; fullValues: () => ParamValues; hiddenParts: string[];
  printHints: ReturnType<typeof usePrintSettings>['printHints'];
  /** The layout parameter, its definition and its value now (none: the model has no layouts). */
  layoutKey: string | undefined; layoutDef: ParamDef | undefined; layoutValue: string | undefined;
  setValidating: Dispatch<SetStateAction<boolean>>; setValidation: Dispatch<SetStateAction<ValidationState | null>>; setValidationOpen: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  setPlayback: Dispatch<SetStateAction<{ result: EvalResult; steps: PlaybackStep[] } | null>>; setPlaybackLoading: Dispatch<SetStateAction<boolean>>;
}) {
  const onValidate = async () => {
    if (!design.code || !shown) return;
    setValidating(true);
    try {
      const o = await geo.evaluate(design.code, fullValues(), 'high', { validate: { layoutValue, exclude: hiddenParts, ...printHints() } });
      if (!o.report || !o.result) { setNotice({ text: `Validation failed: ${o.error?.message ?? 'no result'}`, level: 'error', details: false }); return; }
      setValidation({ report: o.report, label: 'Validation' });
      setValidationOpen(true);
      setNotice(null);
    } finally {
      setValidating(false);
    }
  };

  const startAssembly = async () => {
    if (!layoutKey || !shown) return;
    setPlaybackLoading(true);
    try {
      const base: ParamValues = fullValues();
      const a = await geo.evaluate(design.code, { ...base, [layoutKey]: 'assembled' }, quality, { display: true });
      if (!a.result || !a.result.assembly.length) return;
      const def = layoutDef;
      const hasExploded = def?.type === 'select' && def.options.some((o) => o.value === 'exploded');
      const e = hasExploded ? (await geo.evaluate(design.code, { ...base, [layoutKey]: 'exploded' }, quality)).result : undefined;
      const center = (b: { min: number[]; max: number[] }) => [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
      const size = a.result.bbox ? Math.max(...[0, 1, 2].map((k) => a.result!.bbox!.max[k] - a.result!.bbox!.min[k])) : 50;
      const steps: PlaybackStep[] = a.result.assembly.map((st) => ({
        label: st.label,
        parts: st.parts.map((name) => {
          let from = st.from;
          if (!from) {
            const pa = a.result!.parts.find((p) => p.name === name);
            const pe = e?.parts.find((p) => p.name === name);
            if (pa && pe) {
              const ca = center(pa.bbox), ce = center(pe.bbox);
              from = [ce[0] - ca[0], ce[1] - ca[1], ce[2] - ca[2]];
            }
            if (!from || Math.hypot(...from) < 1e-3) from = [0, 0, size * 0.6];
          }
          return { name, from, rotate: st.rotate };
        }),
      }));
      setPlayback({ result: a.result, steps });
    } finally {
      setPlaybackLoading(false);
    }
  };
  return { onValidate, startAssembly };
}
