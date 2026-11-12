import { useEffect, useRef, useState } from 'react';
import type { Design, EvalResult, Quality, ScriptErrorInfo } from '../../shared/types';
import { sameBuild } from '../lib/settings';
import type { GeometryClient } from '../geometry/client';

/**
 * Evaluates the open design whenever its code, values or the preview quality change. `lastGood`
 * is the last model that built (shown while a broken edit is fixed) and is never carried over
 * from another design; `resultCode` is the code `result` was built from.
 */
/** `printerId`: the chosen printer; a new one builds the model again (what fits, its checks and line art splits follow the bed). */
export function useLiveModel(geo: GeometryClient, design: Design, quality: Quality, printerId = '') {
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

  // The values built: kept the same object while only the picture marks change (they build nothing,
  // and are saved as the user brushes them).
  const builtValues = useRef(design.values);
  if (!sameBuild(builtValues.current, design.values)) builtValues.current = design.values;
  const values = builtValues.current;

  useEffect(() => {
    if (!design.code.trim()) { resultCode.current = ''; setResult(null); setLastGood(null); setError(null); setBusy(false); return; }
    let cancelled = false;
    setBusy(true);
    geo.preview(design.code, values, quality).then((o) => {
      if (cancelled || !o) return;
      setBusy(false);
      if (o.result) { resultCode.current = design.code; setResult(o.result); setLastGood(o.result); setError(null); }
      else { setError(o.error); setResult(null); }
    });
    return () => { cancelled = true; };
  }, [geo, design.id, design.code, values, quality, printerId]);

  return { result, lastGood, error, busy, resultCode };
}
