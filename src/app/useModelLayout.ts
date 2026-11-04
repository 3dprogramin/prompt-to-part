// How the model shown is laid out: the layout parameter (print / assembled / exploded, or line
// art's own), the camera's fit key, the print layout, and the line art piece the editor draws on.
import { useCallback, useMemo } from 'react';
import type { Design, ParamDef, Quality } from '../../shared/types';
import { LINEART_EDITS_KEY, LINEART_LAYOUT_KEY } from '../../shared/lineart';
import { assembledLineArt, lineArtPart } from '../components/LineArtPanel';
import type { GeometryClient } from '../geometry/client';
import type { useLiveModel } from '../hooks/useLiveModel';
import { LINEART_LAYOUT_PARAM } from './designValues';

export function useModelLayout({ design, shown, editingLineArt, quality, geo }: {
  design: Design; shown: ReturnType<typeof useLiveModel>['result']; editingLineArt: boolean; quality: Quality; geo: GeometryClient;
}) {
  // The layout parameter (print / assembled / exploded). A line art split into pieces whose script
  // has none keeps its layout in a design value (LINEART_LAYOUT_KEY) that H.lineart reads.
  const shownLineArt = lineArtPart(shown);
  const splitArt = !!shownLineArt?.lineArt.split;
  // The editor draws on the whole piece: a split one put back together.
  const editorPart = useMemo(() => (editingLineArt ? assembledLineArt(shown) : undefined), [editingLineArt, shown]);
  // The line art as the AI made it, without the hand edits: the editor shows it where edits are cleared.
  const lineArtOriginal = useCallback(async () => {
    const { [LINEART_EDITS_KEY]: _edits, ...values } = design.values;
    return assembledLineArt((await geo.evaluate(design.code, values, quality)).result ?? null);
  }, [design.code, design.values, quality]);
  const scriptLayoutKey = shown ? Object.entries(shown.params).find(([, d]) => d.type === 'select' && d.options.some((o) => o.value === 'assembled'))?.[0] : undefined;
  const layoutKey = scriptLayoutKey ?? (splitArt ? LINEART_LAYOUT_KEY : undefined);
  // Re-fit the camera when a new script version arrives, and when the model shown is laid out
  // another way (Print spreads a split piece's pieces wide, Exploded pulls them apart; a line art
  // split or put back in one piece): read from the model itself, so the camera fits the model
  // built with the new layout, not the one before it. Not on other changes (a slider).
  const shownLayout = shownLineArt ? shownLineArt.lineArt.split?.layout ?? (splitArt ? 'split' : 'whole') : scriptLayoutKey ? String(shown?.values[scriptLayoutKey] ?? '') : '';
  const fitKey = `${design.id}:${design.currentVersion}:${design.code.length}:${shownLayout}`;
  const canAssemble = !!layoutKey && !!shown?.assembly.length;
  // The layout option that lays the parts out for printing ('print', or the first that isn't a view).
  const layoutDef: ParamDef | undefined = scriptLayoutKey ? shown?.params[scriptLayoutKey] : layoutKey ? LINEART_LAYOUT_PARAM : undefined;
  const printLayout = layoutDef?.type === 'select'
    ? (layoutDef.options.find((o) => o.value === 'print') ?? layoutDef.options.find((o) => o.value !== 'assembled' && o.value !== 'exploded'))?.value
    : undefined;
  return { shownLineArt, splitArt, editorPart, lineArtOriginal, layoutKey, fitKey, canAssemble, layoutDef, printLayout };
}
