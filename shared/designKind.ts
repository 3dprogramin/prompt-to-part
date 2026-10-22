// What kind of design a script makes (line art, a LayerTone painting, a 3D figure…), told from its
// code and values like server/agent.ts tells it on every request: a design stays its kind in
// follow-ups whatever the chat's picture menu says, so its current code is the truth. Shown in
// the Designs menu and by the open design's name.
import { LAYERTONE_IMAGES_KEY, parseLayerToneImages } from './layertone';
import { isLineArt } from './lineart';
import { isLithophane } from './lithophane';
import { MESHES_KEY, parseMeshes } from './meshes';
import { DRAWINGS_KEY } from './svgFeatures';
import type { ParamValues } from './types';

export type DesignKind = 'lineart' | 'layertone' | 'lithophane' | 'figure' | 'artwork' | 'model';

/** Each kind's name, for tooltips. */
export const DESIGN_KIND_LABEL: Record<DesignKind, string> = {
  lineart: 'Line art', layertone: 'LayerTone', lithophane: 'Lithophane', figure: '3D figure', artwork: 'AI artwork', model: 'Parametric model',
};

/**
 * The design's kind, in the server's order: line art (H.lineart), a lithophane (H.lithophane), a
 * LayerTone painting (H.layertone, or LayerTone pictures kept with it); then a 3D figure: the
 * script uses H.mesh and a mesh Meshy made (an uploaded mesh alone is a model built on it); then
 * AI artwork: the script uses H.svg and a drawing the image model drew (attached SVGs keep their
 * ".svg" file name; a logo on a box alone is a model); anything else is a parametric model.
 */
export function designKind(code: string | undefined, values: ParamValues | undefined): DesignKind {
  const src = code ?? '';
  if (isLineArt(src)) return 'lineart';
  if (isLithophane(src)) return 'lithophane';
  if (/\bH\.layertone\s*\(/.test(src) || Object.keys(parseLayerToneImages(values?.[LAYERTONE_IMAGES_KEY])).length > 0) return 'layertone';
  if (/\bH\.mesh\s*\(/.test(src) && Object.values(parseMeshes(values?.[MESHES_KEY])).some((m) => m.source === 'meshy')) return 'figure';
  if (/\bH\.svg\s*\(/.test(src) && drawingNames(values?.[DRAWINGS_KEY]).some((n) => !/\.svg$/i.test(n))) return 'artwork';
  return 'model';
}

/** The attached drawings' names, without checking each drawing's shapes (parseDrawings does that). */
function drawingNames(raw: unknown): string[] {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return []; } }
  return o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : [];
}
