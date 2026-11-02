// Which picture or figure mode a request puts the design in, decided in one place. The menu's mode
// wins; a design also keeps its mode in follow-ups from what its code and pictures already hold.
import type { GenerateRequest } from '../../shared/api';
import { LAYERTONE_IMAGES_KEY, parseLayerToneImages } from '../../shared/layertone';
import { isLithophane } from '../../shared/lithophane';
import { isLineArt } from '../../shared/lineart';
import { CONCEPTS_KEY, MESHES_KEY, parseConcepts, parseMeshes } from '../../shared/meshes';
import type { ParamValues } from '../../shared/types';

/** What the server has available right now. */
export interface DetectEnv {
  /** artworkAvailable(): the image model is set up. */
  images: boolean;
  /** !!meshyClient(): Meshy is set up. */
  meshy: boolean;
}

export interface ActiveModes {
  artwork: boolean; layerTone: boolean; lithophane: boolean; lineArt: boolean;
  figure: boolean; figureColor: boolean; meshTools: boolean; conceptTools: boolean;
}

/** `pictureValues` is the design's pictures with the follow-up's values over them, before new photos are added. */
export function detectModes(req: GenerateRequest, pictureValues: ParamValues, env: DetectEnv): ActiveModes {
  const mode = req.imageMode ?? (req.artwork ? 'artwork' : 'off');
  const artwork = mode === 'artwork' && env.images;
  // Line art stays line art in follow-ups; a design is one kind of picture print.
  const lineArt = mode === 'lineart' || (isLineArt(req.code) && mode !== 'layertone' && mode !== 'lithophane');
  // A LayerTone or lithophane design stays one in follow-ups, whatever the menu says now (unless it asks for the other).
  const lithophane = !lineArt && (mode === 'lithophane' || (mode !== 'layertone' && isLithophane(req.code)));
  const layerTone = !lineArt && !lithophane && (mode === 'layertone' || /\bH\.layertone\s*\(/.test(req.code ?? '') || Object.keys(parseLayerToneImages(pictureValues[LAYERTONE_IMAGES_KEY])).length > 0);
  const figure = mode === 'figure';
  const figureColor = figure && !!req.figureColor;
  // generate_3d: in 3D figure mode, and in follow-ups on designs that have meshes or concepts.
  const hasMeshes = Object.keys(parseMeshes(pictureValues[MESHES_KEY])).length > 0;
  const hasConcepts = Object.keys(parseConcepts(pictureValues[CONCEPTS_KEY])).length > 0;
  const meshTools = env.meshy && (figure || hasMeshes || hasConcepts);
  // With the image model, a figure starts as a concept picture the user approves.
  const conceptTools = meshTools && env.images;
  return { artwork, layerTone, lithophane, lineArt, figure, figureColor, meshTools, conceptTools };
}
