// A design's values as App changes them: a new design, the values the app owns, the pictures and
// meshes sent to the server, meshes, LayerTone pictures and drawings added, and line art's layouts.
import type { Design, ParamDef, ParamValues } from '../../shared/types';
import { PART_COLORS_KEY } from '../../shared/params';
import { MAX_DRAWINGS, type SvgDrawing } from '../../shared/svgFeatures';
import { LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, parseLayerToneImages, type LayerToneImage } from '../../shared/layertone';
import { ARTWORK_EDITS_KEY } from '../../shared/artworkEdits';
import { EDIT_HISTORY_KEY } from '../../shared/editHistory';
import { PICTURE_MARKS_KEY } from '../../shared/pictureEdit/mark';
import { LINEART_DEPTH_KEY, LINEART_EDITS_KEY, LINEART_ENDS_KEY, LINEART_JOIN_KEY, LINEART_LAYOUT_KEY, LINEART_LAYOUTS, LINEART_SIZE_KEY, LINEART_SPLIT_KEY } from '../../shared/lineart';
import { CONCEPTS_KEY, MESHES_KEY, parseMeshes, type MeshEntry } from '../../shared/meshes';
import { uid } from '../lib/files';

export const UNTITLED = 'Untitled design';

export function newDesign(): Design {
  const now = Date.now();
  return { id: uid(), name: UNTITLED, createdAt: now, updatedAt: now, messages: [], versions: [], currentVersion: -1, code: '', values: {} };
}

/** Values owned by the app rather than the script ($scale, $text, $print) survive resets and new AI versions. */
export function keepAppValues(values: ParamValues): ParamValues {
  return Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith('$')));
}

/** The values without the hand edits' restore points (kept with the design, not with a version, never sent). */
export function withoutEditHistory(values: ParamValues | undefined): ParamValues {
  const { [EDIT_HISTORY_KEY]: _history, ...rest } = values ?? {};
  return rest;
}

/** A version's values with the design's restore points as they are now: going to a version doesn't take them back. */
export function withEditHistoryOf(values: ParamValues | undefined, current: ParamValues): ParamValues {
  const out = withoutEditHistory(values);
  if (current[EDIT_HISTORY_KEY] != null) out[EDIT_HISTORY_KEY] = current[EDIT_HISTORY_KEY];
  return out;
}

/** The layouts of a line art split into pieces, when its script has no layout parameter (LINEART_LAYOUT_KEY). */
export const LINEART_LAYOUT_PARAM: ParamDef = { type: 'select', label: 'Layout', value: 'print', options: LINEART_LAYOUTS.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })) };

/** The design's pictures, meshes, concept pictures, LayerTone setup, line-art and artwork hand edits, line-art split and the marks on pictures, for the server (undefined when there are none). */
export function pictureValues(values: ParamValues): ParamValues | undefined {
  const out: ParamValues = {};
  for (const k of [LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, MESHES_KEY, CONCEPTS_KEY, PART_COLORS_KEY, LINEART_EDITS_KEY, ARTWORK_EDITS_KEY, PICTURE_MARKS_KEY, LINEART_SPLIT_KEY, LINEART_SIZE_KEY, LINEART_JOIN_KEY, LINEART_ENDS_KEY, LINEART_DEPTH_KEY, LINEART_LAYOUT_KEY]) if (typeof values[k] === 'string') out[k] = values[k];
  return Object.keys(out).length ? out : undefined;
}

/** The design with a mesh added (or replaced) under MESHES_KEY. */
export function withMesh(d: Design, name: string, entry: MeshEntry): Design {
  return { ...d, values: { ...d.values, [MESHES_KEY]: JSON.stringify({ ...parseMeshes(d.values[MESHES_KEY]), [name]: entry }) } };
}

export function withLayerToneImage(d: Design, name: string, image: LayerToneImage): Design {
  return { ...d, values: { ...d.values, [LAYERTONE_IMAGES_KEY]: JSON.stringify({ ...parseLayerToneImages(d.values[LAYERTONE_IMAGES_KEY]), [name]: image }) } };
}

/** `known` plus newly attached drawings; a different drawing with a name in use gets "-2", "-3"… */
export function withDrawings(known: Record<string, SvgDrawing>, attached: SvgDrawing[]): Record<string, SvgDrawing> {
  const out = { ...known };
  for (const d of attached) {
    let name = d.name, n = 2;
    while (out[name] && JSON.stringify(out[name].shapes) !== JSON.stringify(d.shapes)) name = d.name.replace(/(\.svg)?$/i, `-${n++}$1`);
    out[name] = { ...d, name };
  }
  // The newest ones are kept when there are too many.
  return Object.fromEntries(Object.entries(out).slice(-MAX_DRAWINGS));
}
