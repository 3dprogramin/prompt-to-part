// The picture and figure modes, in the order their sections and notes appear.
import { artwork } from './artwork';
import { layerTone } from './layerTone';
import { lithophane } from './lithophane';
import { lineArt } from './lineArt';
import { figure } from './figure';
import type { PromptMode } from './types';

export type { PromptMode, TurnContext } from './types';
export const MODES: PromptMode[] = [artwork, layerTone, lithophane, lineArt, figure];
