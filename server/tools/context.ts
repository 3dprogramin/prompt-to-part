// What the CAD tool groups share within one generation (see cadTools).
import type { requestImage } from '../artwork';
import type { LineArtStyle } from '../../shared/lineart';
import type { MeshyClient } from '../meshy';
import type { AgentEvent } from '../../shared/api';
import type { ParamValues } from '../../shared/types';

/** The user's photos (data URLs) an image model may work from, and the generation's abort signal. */
export interface AiImages { references: string[]; signal?: AbortSignal }

/** cadTools' `meshy` option. */
export type MeshyOptions = AiImages & { client: MeshyClient; designId: string; concepts?: boolean; color?: boolean };

/** cadTools' `lineArt` option. */
export type LineArtOptions = AiImages & { style: LineArtStyle; pictures: boolean };

/**
 * The generation's values every evaluation starts from (`base`, which the tools add pictures,
 * drawings and meshes to), its events, the tools' shared `state`, the image model, model.js as it
 * is now (`readModel`) and `v`, which puts parameter values on top of `base`.
 */
export interface ToolContext {
  base: ParamValues;
  emit: (e: AgentEvent) => void;
  state: { submitted: boolean; meshyCalls: number; newConcepts: Set<string>; asked: boolean };
  drawImage: typeof requestImage;
  readModel: () => Promise<string | null>;
  v: (values?: ParamValues) => ParamValues;
}
