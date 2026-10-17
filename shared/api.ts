// Request and response shapes of the HTTP API, shared by the server and the browser app so the
// two can't drift apart.
import type { AgentStep, ParamValues } from './types';
import type { DimensionSource } from './sources';
import type { SvgDrawing } from './svgFeatures';
import type { ScadFile } from './scad';
import type { HfImage, HueforgeSetup } from './hueforge';
import type { PrintSettings } from './print';

/** A base64 image as sent to Claude. */
export interface ImageData { mediaType: string; data: string }

/** POST /api/generate */
export interface GenerateRequest {
  designId: string;
  prompt: string;
  images?: ImageData[];
  code?: string;
  values?: ParamValues;
  sessionId?: string;
  /** 'opus' | 'sonnet' | 'haiku' */
  model?: string;
  /** 'low' | 'medium' | 'high' | 'xhigh' | 'max' */
  effort?: string;
  /** Description of text the user placed with the text tool (applied after the script). */
  textNote?: string;
  /** Follow-ups: screenshot of the user's current viewer (their camera angle, with dimension labels). */
  currentView?: ImageData;
  /** Follow-ups: full values to render the current state exactly ($scale, $text included). */
  renderValues?: ParamValues;
  /** The design's pictures ($images) and HueForge setup ($hueforge), with every request (renderValues comes only with follow-ups on a finished version). */
  pictures?: ParamValues;
  /** Uniform scale the user applied in the app (1 = none). */
  scale?: number;
  /** Restored-version / manual-edit note. */
  versionNote?: string;
  /** Let Claude use WebSearch / WebFetch (on by default; the user can turn it off per design). */
  webSearch?: boolean;
  /** SVG drawings attached in the chat (name → drawing): model scripts use them with H.svg(name). */
  drawings?: Record<string, SvgDrawing>;
  /** OpenSCAD files attached in the chat: Claude rebuilds them as Jig scripts. */
  scad?: ScadFile[];
  /** Let Claude have artwork drawn by an image model (off unless turned on; needs OPENROUTER_API_KEY). Superseded by imageMode. */
  artwork?: boolean;
  /**
   * The chat's picture mode (the palette menu): 'artwork' = flat AI artwork traced into colour
   * shapes (H.svg); 'hueforge' = a HueForge-style filament painting (H.hueforge) from the attached
   * photo or an AI picture; 'lithophane' = a backlit white-PLA panel (H.lithophane) from one;
   * 'off' (default) = Claude models subjects as 3D objects.
   */
  imageMode?: 'off' | 'artwork' | 'hueforge' | 'lithophane';
  /** The design's recent conversation, shortened: context for a fresh session when the old one can't be continued. */
  history?: { role: 'user' | 'assistant'; text: string }[];
}

/** Server-sent events of POST /api/generate. */
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'step'; step: AgentStep }
  | { type: 'model'; code: string; summary: string; sources: DimensionSource[] }
  | { type: 'done'; durationMs: number; turns: number; submitted: boolean; text: string }
  | { type: 'error'; message: string }
  /** Artwork Claude had drawn (generate_artwork), kept with the design's attached drawings for H.svg. */
  | { type: 'drawing'; name: string; drawing: SvgDrawing }
  /** A picture for H.hueforge or H.lithophane (an attached photo or one the image model drew), kept with the design under HF_IMAGES_KEY. */
  | { type: 'hfImage'; name: string; image: HfImage }
  /** Claude changed the HueForge setup (set_hueforge): the design's HF_KEY value, or null to clear it. */
  | { type: 'hfSetup'; setup: HueforgeSetup | null }
  /** Transient one-line status (throttled), replaced by the next one. */
  | { type: 'live'; text: string }
  /** Live transcript: a content block starts, its text grows, or a tool call's input fields are re-sent as they stream. */
  | { type: 'block'; op: 'start'; kind: 'thinking' | 'text' | 'tool'; name?: string; label?: string; at?: number }
  | { type: 'block'; op: 'append'; text: string }
  | { type: 'block'; op: 'fields'; fields: Record<string, string> };

/** POST /api/speech/token: a single-use ElevenLabs token and the languages to listen for. */
export interface SpeechToken {
  token: string;
  /** Main language (ISO 639 code); undefined = detected. */
  language?: string;
  /** Other languages that may be spoken. */
  secondaryLanguages: string[];
}

/** GET /api/fonts */
export interface FontEntry { id: string; family: string; style: string; source: 'standard' | 'installed' }

/** GET /api/capabilities: optional programs found on this computer. */
export interface Capabilities {
  blender: string | null;
  /** Why .blend export can't use the installed Blender (too old), or null. */
  blenderProblem: string | null;
  bambu: string | null;
  /** Dictation is set up (ELEVENLABS_API_KEY). */
  speech: boolean;
  /** Baseline print settings from the user's Bambu Studio template (null: none built yet). */
  printDefaults: Required<PrintSettings> | null;
  /** Why Claude can't run as configured (no API key), or null. */
  claude: string | null;
  /** The image model for AI artwork (OPENROUTER_API_KEY set), or null. */
  artwork: string | null;
  /** The chat's starting model and effort (JIG_MODEL, JIG_EFFORT). */
  model: string;
  effort: string;
}

/** POST /api/bambu/template: the A1 + PLA project settings from the user's Bambu Studio. */
export interface BambuTemplate {
  version: string;
  /** project_settings.config for one filament */
  settings: Record<string, unknown>;
  /** keys holding one value per filament */
  perFilament: string[];
  /** keys holding (filaments + 2) entries */
  perFilamentPlus2: string[];
}

/** POST /api/export/blend */
export interface BlendRequest {
  name: string;
  code?: string;
  params?: Record<string, number | boolean | string>;
  size?: number;
  parts: { name: string; color: string; positions: string; indices: string }[]; // base64 float32 / uint32
  dimensions?: { label: string; from: number[]; to: number[]; offset?: number[]; color?: string }[];
}

/** POST /api/price: what Claude needs to suggest a selling price. */
export interface PriceRequest {
  name: string;
  /** Claude's summary of the version (what the item is). */
  description?: string;
  /** "85 × 56 × 30 mm" */
  size: string;
  parts: number;
  colours: number;
  grams: number;
  seconds: number;
  filamentCost: number | null;
  electricityCost: number | null;
}

/** Claude's suggested selling price (an opinion, not a calculation). */
export interface PriceSuggestion {
  price: number;
  low: number;
  high: number;
  reasoning: string;
  currency: string;
}

