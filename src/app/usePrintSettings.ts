// The print settings: the AI's suggestions in the script, the user's own ($print), Print in one colour,
// how many differ from the profile, and which parts print with supports or a brim.
import { useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Design } from '../../shared/types';
import { effectiveSettings, ONE_COLOUR_KEY, parseOneColour, parseProfile, PRINT_KEY, type PrintProfile, type PrintSettings } from '../../shared/print';
import type { useLiveModel } from '../hooks/useLiveModel';

export function usePrintSettings({ design, setDesign, result, lastGood, printBase }: {
  design: Design; setDesign: Dispatch<SetStateAction<Design>>; result: ReturnType<typeof useLiveModel>['result']; lastGood: ReturnType<typeof useLiveModel>['lastGood'];
  /** The profile in the user's Bambu Studio template (what the 3MF starts from). */
  printBase: Required<PrintSettings>;
}) {
  // ---- print settings (AI suggestions in the script, user overrides in $print) ----
  const aiPrint: PrintProfile = (result ?? lastGood)?.print ?? {};
  const userPrint = useMemo(() => parseProfile(design.values[PRINT_KEY]), [design.values]);
  const setUserPrint = (p: PrintProfile) => setDesign((d) => {
    const values = { ...d.values };
    if (Object.keys(p).length) values[PRINT_KEY] = JSON.stringify(p); else delete values[PRINT_KEY];
    return { ...d, values, updatedAt: Date.now() };
  });
  // "Print in one colour" (per design): one filament for the 3MF, the slice and the 3D view.
  const oneColour = parseOneColour(design.values[ONE_COLOUR_KEY]);
  const setOneColour = (choice: null | 'main' | string) => setDesign((d) => {
    const values = { ...d.values };
    if (choice) values[ONE_COLOUR_KEY] = choice === 'main' ? true : choice; else delete values[ONE_COLOUR_KEY];
    return { ...d, values, updatedAt: Date.now() };
  });
  const partNames = (result ?? lastGood)?.parts.map((p) => p.name) ?? [];
  // Number of print settings (as shown in the Print tab) that differ from the profile on any part.
  const printChanges = useMemo(() => {
    const changed = new Set<string>();
    for (const name of partNames.length ? partNames : [undefined]) {
      const eff = effectiveSettings(aiPrint, userPrint, name, printBase);
      for (const k of Object.keys(printBase) as (keyof typeof printBase)[]) if (eff[k] !== printBase[k]) changed.add(k);
    }
    return changed.size;
  }, [aiPrint, userPrint, printBase, partNames.join('\u0000')]);
  /** Which parts will print with supports / an explicit brim (validation takes these into account). */
  const printHints = () => ({
    supportParts: partNames.filter((n) => effectiveSettings(aiPrint, userPrint, n, printBase).supports !== 'off'),
    brimParts: partNames.filter((n) => typeof effectiveSettings(aiPrint, userPrint, n, printBase).brim === 'number'),
  });
  return { aiPrint, userPrint, setUserPrint, oneColour, setOneColour, printChanges, printHints };
}
