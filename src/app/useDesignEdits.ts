// The design's settings the side panel edits: text and SVG features, the LayerTone setup (shown
// recoloured at once), a part's filament and the hand edits of line art and artwork.
import { useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Design } from '../../shared/types';
import { parsePartColors, PART_COLORS_KEY, type PartFilament } from '../../shared/params';
import { parseTextFeatures, TEXT_KEY, type TextFeature } from '../../shared/textFeatures';
import { DRAWINGS_KEY, parseDrawings, parseSvgFeatures, SVG_KEY, type SvgFeature } from '../../shared/svgFeatures';
import { ARTWORK_EDITS_KEY, parseArtworkEdits, pruneArtworkEdits, type ArtworkEdits } from '../../shared/artworkEdits';
import { LAYERTONE_KEY, parseLayerToneSetup, type LayerToneSetup } from '../../shared/layertone';
import { LINEART_DEPTH_KEY, LINEART_EDITS_KEY, parseLineArtEdits, type LineArtEdits } from '../../shared/lineart';
import { findLayerTonePart } from '../components/LayerTonePanel';
import { recolourEdits } from '../lib/lineArtEdit';
import { EDIT_HISTORY_KEY, parseEditHistory, recordChange, type HistoryKind, type StrokeEdits } from '../../shared/editHistory';
import type { useLiveModel } from '../hooks/useLiveModel';

export function useDesignEdits({ design, setDesign, result, lastGood }: {
  design: Design; setDesign: Dispatch<SetStateAction<Design>>; result: ReturnType<typeof useLiveModel>['result']; lastGood: ReturnType<typeof useLiveModel>['lastGood'];
}) {
  const textFeatures = useMemo(() => parseTextFeatures(design.values[TEXT_KEY]), [design.values]);
  const setTextFeatures = (list: TextFeature[]) => setDesign((d) => {
    const values = { ...d.values };
    if (list.length) values[TEXT_KEY] = JSON.stringify(list); else delete values[TEXT_KEY];
    return { ...d, values, updatedAt: Date.now() };
  });
  const svgFeatures = useMemo(() => parseSvgFeatures(design.values[SVG_KEY]), [design.values]);
  const setSvgFeatures = (list: SvgFeature[]) => setDesign((d) => {
    const values = { ...d.values };
    if (list.length) values[SVG_KEY] = JSON.stringify(list); else delete values[SVG_KEY];
    return { ...d, values, updatedAt: Date.now() };
  });
  // LayerTone: the filament setup (a setting, like the sliders) and the pictures (like attached drawings).
  // Changed LayerTone filaments show in the 3D view at once, on the layers the shown model was built
  // with, until the rebuild (whose heights can shift a little with the new filaments) replaces it.
  const recolor = useMemo(() => {
    const part = findLayerTonePart(result ?? lastGood);
    const want = parseLayerToneSetup(design.values[LAYERTONE_KEY]).filaments;
    if (!part || !want || want.length !== part.layerColors.length) return null;
    if (want.every((f, i) => f.color.toLowerCase() === part.layerColors[i].color.toLowerCase() && f.td === part.layerColors[i].td)) return null;
    return { part: part.name, layers: part.layerColors.map((l, i) => ({ ...l, color: want[i].color, td: want[i].td, name: want[i].name, brand: want[i].brand })) };
  }, [result, lastGood, design.values[LAYERTONE_KEY]]);

  // A filament picked (or reset) in the Object tab shows at once, in the 3D view and the swatch,
  // until the rebuild that brings it arrives: the part's colour as it should be now.
  const partColorsNow = useMemo(() => parsePartColors(design.values[PART_COLORS_KEY]), [design.values[PART_COLORS_KEY]]);
  const previewColors = useMemo(() => {
    const parts = (result ?? lastGood)?.parts ?? [];
    const out: Record<string, string> = {};
    for (const part of parts) {
      if (part.paint || part.layerColors || part.lithophane) continue;
      const want = partColorsNow[part.name]?.color ?? part.scriptColor ?? part.color;
      if (want.toLowerCase() !== part.color.toLowerCase()) out[part.name] = want;
    }
    return Object.keys(out).length ? out : null;
  }, [result, lastGood, partColorsNow]);
  const setLayerTone = (setup: LayerToneSetup | null) => setDesign((d) => {
    const values = { ...d.values };
    if (setup) values[LAYERTONE_KEY] = JSON.stringify(setup); else delete values[LAYERTONE_KEY];
    return { ...d, values, updatedAt: Date.now() };
  });
  // Every change to the hand edits is a restore point (EDIT_HISTORY_KEY), of the edits as saved (as
  // they read back), `label` saying what it did.
  const record = <S,>(values: Design['values'], kind: HistoryKind, before: StrokeEdits<S>, after: StrokeEdits<S>, label = 'Hand edits changed') => {
    const all = parseEditHistory(values[EDIT_HISTORY_KEY]);
    const list = recordChange(all[kind], before, after, label, Date.now());
    if (list.length && list !== all[kind]) values[EDIT_HISTORY_KEY] = JSON.stringify({ ...all, [kind]: list });
  };
  // Line art hand edits (the Edit drawing brush): a setting like the LayerTone setup, saved with versions.
  const setLineArtEdits = (update: (edits: LineArtEdits) => LineArtEdits, label?: string) => setDesign((d) => {
    const before = parseLineArtEdits(d.values[LINEART_EDITS_KEY]);
    const after = update(before);
    if (after === before) return d;
    const values = { ...d.values };
    if (Object.keys(after).length) values[LINEART_EDITS_KEY] = JSON.stringify(after); else delete values[LINEART_EDITS_KEY];
    record(values, 'lineart', before, parseLineArtEdits(values[LINEART_EDITS_KEY]), label);
    // The piece's first colour goes in its top layers (fewer filament changes), unless the user chose a depth.
    const coloured = (e: LineArtEdits) => Object.values(e).some((x) => x.strokes.some((st) => st.filament));
    if (values[LINEART_DEPTH_KEY] == null && !coloured(before) && coloured(after)) values[LINEART_DEPTH_KEY] = 'auto';
    return { ...d, values, updatedAt: Date.now() };
  });
  // Artwork hand edits (the artwork brush), the same way; those of drawings the design no longer has go.
  const setArtworkEdits = (update: (edits: ArtworkEdits) => ArtworkEdits, label?: string) => setDesign((d) => {
    const before = parseArtworkEdits(d.values[ARTWORK_EDITS_KEY]);
    const after = pruneArtworkEdits(update(before), parseDrawings(d.values[DRAWINGS_KEY]));
    if (after === before) return d;
    const values = { ...d.values };
    if (Object.keys(after).length) values[ARTWORK_EDITS_KEY] = JSON.stringify(after); else delete values[ARTWORK_EDITS_KEY];
    record(values, 'artwork', before, parseArtworkEdits(values[ARTWORK_EDITS_KEY]), label);
    return { ...d, values, updatedAt: Date.now() };
  });
  // A filament picked for a part (Object tab), or back to the script's colour. Lines of a line art
  // in another filament (Edit drawing's colours) change filament where they were drawn and painted.
  const setPartColor = (part: string, filament: PartFilament | null) => {
    const painted = (result ?? lastGood)?.parts.find((p) => p.name === part)?.lineArt?.paintedIn;
    if (painted) setLineArtEdits((e) => recolourEdits(e, painted, filament), `Recoloured ${painted.name ?? painted.color} to ${filament ? filament.name ?? filament.color : "the piece's own"}`);
    else setPickedColor(part, filament);
  };
  const setPickedColor = (part: string, filament: PartFilament | null) => setDesign((d) => {
    const { [part]: _old, ...rest } = parsePartColors(d.values[PART_COLORS_KEY]);
    const all = filament ? { ...rest, [part]: filament } : rest;
    const values = { ...d.values };
    if (Object.keys(all).length) values[PART_COLORS_KEY] = JSON.stringify(all); else delete values[PART_COLORS_KEY];
    return { ...d, values, updatedAt: Date.now() };
  });
  return { textFeatures, setTextFeatures, svgFeatures, setSvgFeatures, recolor, previewColors, setLayerTone, setLineArtEdits, setArtworkEdits, setPartColor };
}
