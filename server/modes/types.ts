// A picture or figure mode: its section of the system prompt and its notes in the first message,
// kept together so a mode lives in one place.
import type { GenerateRequest, ImageData } from '../../shared/api';
import type { LayerToneImage } from '../../shared/layertone';
import type { LineArtStyle } from '../../shared/lineart';
import type { ConceptEntry, MeshEntry } from '../../shared/meshes';
import type { SvgDrawing } from '../../shared/svgFeatures';
import type { ParamValues } from '../../shared/types';
import type { SystemPromptOptions } from '../systemPrompt';
import type { ActiveModes } from './detect';

/** What a mode's notes are built from: the request and what runGeneration has gathered for it. */
export interface TurnContext {
  req: GenerateRequest; isFollowUp: boolean; pictureValues: ParamValues;
  drawings: Record<string, SvgDrawing>; refs: ImageData[];
  layerToneImages: Record<string, LayerToneImage>; newPictures: string[];
  meshes: Record<string, MeshEntry>; concepts: Record<string, ConceptEntry>;
  /** Mesh files attached with this request (their own note and picture come from agent.ts). */
  attachedMeshes: string[];
  references: string[]; images: boolean; lineArtStyle: LineArtStyle;
}

export interface PromptMode {
  id: 'artwork' | 'layerTone' | 'lithophane' | 'lineArt' | 'figure';
  active(m: ActiveModes): boolean;
  /** The mode's system prompt section, '' when the options leave the mode out. */
  system(o: SystemPromptOptions): string;
  /** The mode's notes in the first message, for an active mode. */
  turnNotes(c: TurnContext, m: ActiveModes): string[];
}
