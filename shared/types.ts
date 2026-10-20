import type { DimensionSource } from './sources';
import type { PrintProfile } from './print';
import type { LayerToneSource, LayerColor } from './layertone';
import type { LithophaneSource } from './lithophane';
import type { LineArtInfo } from './lineart';
import type { PaintFilament } from './meshColors';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Quality = 'draft' | 'normal' | 'high';

export interface NumberParam {
  type: 'number' | 'integer';
  label?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit?: string;
  group?: string;
  description?: string;
  /** The part(s) this parameter changes: greyed out while they are hidden. */
  parts?: string[];
  /** This parameter sets the model's overall size along this axis (used when editing dimensions directly). */
  drives?: 'x' | 'y' | 'z';
}
export interface BooleanParam {
  type: 'boolean';
  label?: string;
  value: boolean;
  group?: string;
  description?: string;
  /** The part(s) this parameter changes: greyed out while they are hidden. */
  parts?: string[];
}
export interface SelectParam {
  type: 'select';
  label?: string;
  options: { value: string; label: string }[];
  value: string;
  group?: string;
  description?: string;
  /** The part(s) this parameter changes: greyed out while they are hidden. */
  parts?: string[];
}
export interface TextParam {
  type: 'text';
  label?: string;
  value: string;
  group?: string;
  description?: string;
  /** The part(s) this parameter changes: greyed out while they are hidden. */
  parts?: string[];
  /** Show a font picker next to the text box (the value of this param is a font id). */
  font?: boolean;
}
export type ParamDef = NumberParam | BooleanParam | SelectParam | TextParam;
export type ParamValue = number | boolean | string;
export type ParamValues = Record<string, ParamValue>;

export interface ModelMeta {
  name?: string;
  description?: string;
}

export interface DimensionAnnotation {
  label?: string;
  from: Vec3;
  to: Vec3;
  /** Optional world-space offset applied to the drawn dimension line. */
  offset?: Vec3;
  /** Parameter this callout represents; editing the callout adjusts it. */
  param?: string;
}

/** What a dimension edit targets: an overall bounding-box axis or one callout. */
export type DimTarget = { kind: 'bbox'; axis: 0 | 1 | 2 } | { kind: 'callout'; index: number };

export interface SolveResult {
  ok: boolean;
  key?: string;
  value?: number;
  achieved?: number;
  message?: string;
}

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

export interface PartMesh {
  name: string;
  color: string;
  /** xyz per vertex */
  positions: Float32Array;
  indices: Uint32Array;
  bbox: Box3;
  /** Bounding box before the text tool's features were applied (only when there are some). */
  textBase?: Box3;
  /** Ready-to-draw mesh for the viewer, prepared in the geometry worker (live previews only). */
  display?: PartDisplay;
  volume: number;
  surfaceArea: number;
  triCount: number;
  genus: number;
  components: number;
  /** LayerTone part (H.layertone): the filament stack by height, for the viewer's colours and the 3MF's filament swaps. */
  layerColors?: LayerColor[];
  /** RGB 0–1 per vertex (LayerTone parts: the simulated print colour; lithophanes: lit from behind); the viewer uses it instead of `color`. */
  vertexColors?: Float32Array;
  /** LayerTone part: the picture and options it was built with (lengths scaled with the part), for simulateImage. */
  layerTone?: LayerToneSource;
  /** Lithophane part (H.lithophane): the picture and options it was built with (lengths scaled with the part), for simulateLithophane. */
  lithophane?: LithophaneSource;
  /** The script's colour, when the user picked another filament for the part (PART_COLORS_KEY). */
  scriptColor?: string;
  /** Line-art part (H.lineart): its style, drawings, size and what Jig fixed (bridges, dropped specks). */
  lineArt?: LineArtInfo;
  /**
   * A part coloured per triangle (it has a coloured mesh, H.mesh): its filaments and each triangle's
   * index into them. Triangles of the script's own geometry are in the part's colour.
   */
  paint?: { filaments: PaintFilament[]; tri: Uint8Array; source?: PaintSource };
}

/**
 * Where each triangle of a painted part came from, for repainting by hand (a click on the part
 * finds the stored mesh's triangle): `meshes[mesh[t]]` and its triangle `face[t]`; the script's own
 * triangles have mesh 255 (and face 0xffffffff).
 */
export interface PaintSource {
  meshes: string[];
  mesh: Uint8Array;
  face: Uint32Array;
}

export interface PartDisplay {
  /** Non-indexed triangles with creased normals. */
  positions: Float32Array;
  normals: Float32Array;
  /** Feature-edge line segments. */
  edges: Float32Array;
  /** three-mesh-bvh SerializedBVH for raycasting (hover, measure, pick). */
  bvh: unknown;
  /** RGB per vertex of `positions` (from PartMesh.vertexColors). */
  colors?: Float32Array;
}

/** One step of the assembly animation. Parts move from `from` (offset relative to their assembled position) into place. */
export interface AssemblyStep {
  label: string;
  parts: string[];
  /** Start offset in mm relative to the assembled position; omitted = taken from the exploded layout. */
  from?: Vec3;
  /** Optional turning while moving in (e.g. screwing): rotates by `degrees` around `axis` through `center`. */
  rotate?: { axis: Vec3; degrees: number; center?: Vec3 };
}

export interface EvalResult {
  meta: ModelMeta;
  /** Assembly sequence returned by the script (may be empty). */
  assembly: AssemblyStep[];
  /** Print settings suggested by the script (only what differs from the A1 0.20 mm Standard profile). */
  print: PrintProfile;
  params: Record<string, ParamDef>;
  values: ParamValues;
  parts: PartMesh[];
  dimensions: DimensionAnnotation[];
  bbox: Box3 | null;
  timeMs: number;
  warnings: string[];
  logs: string[];
  quality: Quality;
}

export interface ScriptErrorInfo {
  message: string;
  line?: number;
  column?: number;
  stage: 'compile' | 'params' | 'build' | 'output';
}

// ---- Chat / design persistence ----

export interface AgentStep {
  /** 'user': a message the user sent while Claude worked. */
  kind: 'text' | 'tool' | 'status' | 'thinking' | 'render' | 'assembly' | 'error' | 'user';
  text: string;
  ok?: boolean;
  image?: string; // data URL (render previews)
  /** ms since the request started */
  at?: number;
  /** Only shown in verbose mode */
  verbose?: boolean;
  /** The full text behind the step (what Claude was sent or got back), shown in the activity panel. */
  detail?: string;
  /** A change Claude saved to a file, in lines (consecutive ones are shown as one row). */
  edit?: { file: string; added: number; removed: number };
  /** Show `detail` unfolded (e.g. the prompt an artwork was drawn from). */
  detailOpen?: boolean;
}

/** One entry of a reply's live transcript, shown in the activity panel. */
export type ActivityItem =
  | { kind: 'thinking' | 'text'; text: string; at: number }
  /** A tool call; `fields` are its (possibly still streaming) input, e.g. the model.js being written. */
  | { kind: 'tool'; name: string; label: string; fields: Record<string, string>; at: number }
  | { kind: 'step'; step: AgentStep };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images?: string[]; // data URLs
  /** Names of the OpenSCAD files attached to this message. */
  files?: string[];
  steps?: AgentStep[];
  versionIndex?: number;
  error?: string;
  createdAt: number;
  durationMs?: number;
  /** Transient live status while generating (not meaningful once done) */
  live?: string;
  /**
   * Live transcript of the reply (thinking, text, tool calls, results). Saved only for the design's
   * newest reply, shortened (src/lib/activity.ts trimActivity); earlier ones are rebuilt from `steps`.
   */
  activity?: ActivityItem[];
  /**
   * Jig was still working on this reply when it was saved (saves run every few seconds while it
   * works). Still set when nothing is working on it: the reply was interrupted (the server restarted
   * before it ended, or a page reload found it gone); the final save of a reply that ended clears it.
   */
  pending?: boolean;
  /** The server's run of this pending reply and how many of its events this copy has (a page opened later catches up from there). */
  run?: { id: string; seen: number };
}

export interface DesignVersion {
  code: string;
  summary: string;
  createdAt: number;
  /** Claude's script, the user's code edit, or the user's saved slider/scale/text/print settings. */
  source: 'ai' | 'manual' | 'settings';
  /** Parameter values that go with this version; restoring the version brings them back. */
  values?: ParamValues;
  /** Claude's versions: where the real-world dimensions it designed around came from. */
  sources?: DimensionSource[];
}

export interface Design {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  messages: ChatMessage[];
  versions: DesignVersion[];
  currentVersion: number;
  code: string;
  values: ParamValues;
  /** Revision on the server, counted up by every save (missing until the first save). */
  rev?: number;
  /** Product photos made from the model (newest last). */
  photos?: ProductPhoto[];
}

/** A product photo: the image model's picture of the printed design in a scene. */
export interface ProductPhoto {
  /** The stored photo (/api/designs/:id/images/…). */
  url: string;
  /** The render it was made from. */
  render?: string;
  /** A scene preset's id, or 'custom'. */
  scene: string;
  /** The custom scene or the extra wishes. */
  notes?: string;
  /** A redo of another photo (its URL), with what was changed. */
  editOf?: string;
  change?: string;
  aspect: string;
  prompt: string;
  model: string;
  /** USD (null if OpenRouter didn't say). */
  cost: number | null;
  createdAt: number;
}

export interface DesignSummary {
  id: string;
  name: string;
  updatedAt: number;
  versions: number;
  /** Starred in the Designs menu (listed first). */
  starred?: boolean;
}
