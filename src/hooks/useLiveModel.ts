import { useEffect, useRef, useState } from 'react';
import type { Design, EvalResult, Quality, ScriptErrorInfo } from '../../shared/types';
import type { GeometryClient } from '../geometry/client';

/**
 * Evaluates the open design whenever its code, values or the preview quality change. `lastGood`
 * is the last model that built (shown while a broken edit is fixed) and is never carried over
 * from another design; `resultCode` is the code `result` was built from.
 */
export function useLiveModel(geo: GeometryClient, design: Design, quality: Quality) {
  const [result, setResult] = useState<EvalResult | null>(null);
  const [lastGood, setLastGood] = useState<EvalResult | null>(null);
  const [error, setError] = useState<ScriptErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const resultCode = useRef('');

  // A newly opened design never shows (or exports) the previous one's model while its own builds.
  useEffect(() => {
    resultCode.current = '';
    setResult(null);
    setLastGood(null);
    setError(null);
  }, [design.id]);

  useEffect(() => {
    if (!design.code.trim()) { resultCode.current = ''; setResult(null); setLastGood(null); setError(null); setBusy(false); return; }
    let cancelled = false;
    setBusy(true);
    geo.preview(design.code, design.values, quality).then((o) => {
      if (cancelled || !o) return;
      setBusy(false);
      if (o.result) { resultCode.current = design.code; setResult(o.result); setLastGood(o.result); setError(null); }
      else { setError(o.error); setResult(null); }
    });
    return () => { cancelled = true; };
  }, [geo, design.id, design.code, design.values, quality]);

  return { result, lastGood, error, busy, resultCode };
}
