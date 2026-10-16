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
export type ParamDef = NumberParam | BooleanParam | SelectParam;
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
  volume: number;
  surfaceArea: number;
  triCount: number;
  genus: number;
  components: number;
}

export interface EvalResult {
  meta: ModelMeta;
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
  kind: 'text' | 'tool' | 'status' | 'render' | 'error';
  text: string;
  ok?: boolean;
  image?: string; // data URL (render previews)
}

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
}

export interface DesignVersion {
  code: string;
  summary: string;
  createdAt: number;
  source: 'ai' | 'manual';
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
