// The parts hidden in the 3D view (saved with the design), and which parts each parameter changes
// while some are hidden (to grey out the parameters of hidden parts).
import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Design } from '../../shared/types';
import type { GeometryClient } from '../geometry/client';
import { HIDDEN_KEY } from '../lib/settings';

export function useHiddenParts({ design, setDesign, geo }: { design: Design; setDesign: Dispatch<SetStateAction<Design>>; geo: GeometryClient }) {
  // Hidden parts are saved with the design (they stay hidden after a reload or a new version).
  const hiddenParts = useMemo<string[]>(() => {
    try {
      const a = JSON.parse(String(design.values[HIDDEN_KEY] ?? '[]'));
      return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  }, [design.values]);
  const setHiddenParts = (list: string[]) => setDesign((d) => {
    const values = { ...d.values };
    if (list.length) values[HIDDEN_KEY] = JSON.stringify([...new Set(list)]); else delete values[HIDDEN_KEY];
    return { ...d, values };
  });
  const toggleHidden = (n: string) => setHiddenParts(hiddenParts.includes(n) ? hiddenParts.filter((x) => x !== n) : [...hiddenParts, n]);
  // Which parts each parameter changes, measured while parts are hidden (to grey out the
  // parameters of hidden parts); kept for the code and values it was measured with.
  const [paramOwners, setParamOwners] = useState<{ key: string; owners: Record<string, string[]> } | null>(null);
  const ownersKey = JSON.stringify([design.code, Object.fromEntries(Object.entries(design.values).filter(([k]) => k !== HIDDEN_KEY))]);
  useEffect(() => {
    if (!hiddenParts.length || !design.code || paramOwners?.key === ownersKey) return;
    let stale = false;
    // After the preview has settled, so the measuring builds don't hold it up.
    const t = setTimeout(() => {
      geo.owners(design.code, Object.fromEntries(Object.entries(design.values).filter(([k]) => k !== HIDDEN_KEY))).then((owners) => {
        if (!stale && owners) setParamOwners({ key: ownersKey, owners });
      });
    }, 600);
    return () => { stale = true; clearTimeout(t); };
  }, [hiddenParts.length > 0, ownersKey]);
  return { hiddenParts, setHiddenParts, toggleHidden, paramOwners, ownersKey };
}
