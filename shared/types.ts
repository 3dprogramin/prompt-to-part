import type { PrintProfile } from './print';

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
  /** This parameter sets the model's overall size along this axis (used when editing dimensions directly). */
  drives?: 'x' | 'y' | 'z';
}
export interface BooleanParam {
  type: 'boolean';
  label?: string;
  value: boolean;
  group?: string;
  description?: string;
}
export interface SelectParam {
  type: 'select';
  label?: string;
  options: { value: string; label: string }[];
  value: string;
  group?: string;
  description?: string;
}
export interface TextParam {
  type: 'text';
  label?: string;
  value: string;
  group?: string;
  description?: string;
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
}

export interface PartDisplay {
  /** Non-indexed triangles with creased normals. */
  positions: Float32Array;
  normals: Float32Array;
  /** Feature-edge line segments. */
  edges: Float32Array;
  /** three-mesh-bvh SerializedBVH for raycasting (hover, measure, pick). */
  bvh: unknown;
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
  kind: 'text' | 'tool' | 'status' | 'thinking' | 'render' | 'assembly' | 'error';
  text: string;
  ok?: boolean;
  image?: string; // data URL (render previews)
  /** ms since the request started */
  at?: number;
  /** Only shown in verbose mode */
  verbose?: boolean;
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
  steps?: AgentStep[];
  versionIndex?: number;
  error?: string;
  createdAt: number;
  durationMs?: number;
  /** Transient live status while generating (not meaningful once done) */
  live?: string;
  /** Live transcript of the reply (thinking, text, tool calls, results); in memory only, never saved. */
  activity?: ActivityItem[];
}

export interface DesignVersion {
  code: string;
  summary: string;
  createdAt: number;
  /** Claude's script, the user's code edit, or the user's saved slider/scale/text/print settings. */
  source: 'ai' | 'manual' | 'settings';
  /** Parameter values that go with this version; restoring the version brings them back. */
  values?: ParamValues;
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
}

export interface DesignSummary {
  id: string;
  name: string;
  updatedAt: number;
  versions: number;
}
