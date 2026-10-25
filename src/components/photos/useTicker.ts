// The time now, ticking while photos are being made (their seconds so far).
import { useEffect, useState } from 'react';

/** Date.now(), updated every half second while `on`. */
export function useTicker(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
