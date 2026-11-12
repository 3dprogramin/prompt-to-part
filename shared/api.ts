// Request and response shapes of the HTTP API, shared by the server and the browser app so the
// two can't drift apart.
import type { LineArtStroke, LineArtStyle } from './lineart';
import type { AgentStep, ParamValues } from './types';
import type { DimensionSource } from './sources';
import type { SvgDrawing } from './svgFeatures';
import type { ScadFile } from './scad';
import type { LayerToneImage, LayerToneSetup } from './layertone';
import type { PrintSettings } from './print';
import type { ActivePrinter, Printer } from './printer';
import type { ConceptEntry, MeshEntry } from './meshes';
import type { ImportReport } from './meshRepair';
import type { UsageWindow } from './usage';
import type { ChatQuestion } from './questions';
import type { StabilityReport } from './stability';
import type { PictureMark } from './pictureEdit/mark';

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
  /** The design's sessionCostUsd: what the session had cost before this reply (API keys only). */
  sessionCostUsd?: number;
  /** 'fable' | 'opus' | 'sonnet' | 'haiku', or a full model ID */
  model?: string;
  /** 'low' | 'medium' | 'high' | 'xhigh' | 'max' */
  effort?: string;
  /** Description of text the user placed with the text tool (applied after the script). */
  textNote?: string;
  /** Follow-ups: screenshot of the user's current viewer (their camera angle, with dimension labels). */
  currentView?: ImageData;
  /** Follow-ups: full values to render the current state exactly ($scale, $text included). */
  renderValues?: ParamValues;
  /** The design's pictures ($images), meshes ($meshes), concept pictures ($concepts) and LayerTone setup ($layertone), with every request (renderValues comes only with follow-ups on a finished version). */
  pictures?: ParamValues;
  /** Uniform scale the user applied in the app (1 = none). */
  scale?: number;
  /** Restored-version / manual-edit note. */
  versionNote?: string;
  /** Let Claude use WebSearch / WebFetch (on by default; the user can turn it off per design). */
  webSearch?: boolean;
  /** "Ask first" (on by default): before building, Claude asks the few questions it can't answer itself (none, or up to 5); off, it picks defaults and says which. */
  askFirst?: boolean;
  /** The image tool (on by default): in 3D model mode, with an image model, Claude can have a picture drawn to model from (generate_image); false turns it off. */
  imageTool?: boolean;
  /** SVG drawings attached in the chat (name → drawing): model scripts use them with H.svg(name). */
  drawings?: Record<string, SvgDrawing>;
  /** OpenSCAD files attached in the chat: Claude rebuilds them as model scripts. */
  scad?: ScadFile[];
  /** Let Claude have artwork drawn by an image model (off unless turned on; needs OPENROUTER_API_KEY). Superseded by imageMode. */
  artwork?: boolean;
  /**
   * The chat's picture mode (the palette menu): 'artwork' = flat AI artwork traced into colour
   * shapes (H.svg); 'layertone' = a LayerTone filament painting (H.layertone) from the attached
   * photo or an AI picture; 'lithophane' = a backlit white-PLA panel (H.lithophane) from one;
   * 'figure' = a 3D figure: an AI mesh from Meshy (generate_3d, H.mesh) from a description or the
   * attached photo; 'lineart' = a one-piece wall cut-out of a drawing (H.lineart) from an attached
   * SVG or picture, or one the image model draws; 'off' (default) = Claude models subjects as 3D objects.
   */
  imageMode?: 'off' | 'artwork' | 'layertone' | 'lithophane' | 'lineart' | 'figure';
  /** Line art mode's style (its ▾ menu): what the piece is – key holder, outline, framed, … (the message may ask for another). */
  lineArtStyle?: LineArtStyle;
  /** 3D figure mode's Colour: figures in colour (a textured Meshy model, printed in up to 4 filaments; more Meshy credits). */
  figureColor?: boolean;
  /** Names (in the design's MESHES_KEY index, sent in `pictures`) of meshes attached with this message: Claude gets a render and report of each. */
  meshes?: string[];
  /** The design's recent conversation, shortened: context for a fresh session when the old one can't be continued. */
  history?: { role: 'user' | 'assistant'; text: string }[];
}

/** Server-sent events of POST /api/generate. */
export type AgentEvent =
  /** The first event: the reply's id on the server, to catch up with it (GET /api/generate/:id/events). */
  | { type: 'run'; runId: string }
  /** The last event to a page another page (or tab) took the reply over from. */
  | { type: 'moved' }
  | { type: 'session'; sessionId: string }
  | { type: 'step'; step: AgentStep }
  /** stability: submit_model's tipping check (missing if it couldn't run). */
  | { type: 'model'; code: string; summary: string; sources: DimensionSource[]; stability?: StabilityReport }
  | { type: 'done'; durationMs: number; turns: number; submitted: boolean; text: string; costUsd?: number; sessionCostUsd?: number }
  /** resetsAt: when the reached usage limit lifts (ms), if known; the page adds it in local time. */
  | { type: 'error'; message: string; resetsAt?: number }
  /** Artwork Claude had drawn (generate_artwork), kept with the design's attached drawings for H.svg. */
  | { type: 'drawing'; name: string; drawing: SvgDrawing }
  /** Line art: the hand edits of a drawing are now part of it (a partial edit by the image model redrew it with them), so the design drops them; `kept`: their colours, on the new drawing. */
  | { type: 'lineArtEditsBaked'; name: string; kept?: { fp: string; strokes: LineArtStroke[] } }
  /** A picture for H.layertone or H.lithophane (an attached photo or one the image model drew), kept with the design under LAYERTONE_IMAGES_KEY. */
  | { type: 'layerToneImage'; name: string; image: LayerToneImage }
  /** A mesh Claude had made (generate_3d), kept in the design's MESHES_KEY index for H.mesh. */
  | { type: 'mesh'; name: string; entry: MeshEntry }
  /** A concept picture of a 3D figure (generate_concept), kept in the design's CONCEPTS_KEY index for generate_3d's from_concept. */
  | { type: 'concept'; name: string; entry: ConceptEntry }
  /** "Ask first": Claude's questions before it builds (ask_questions), shown under its reply as a card of options. */
  | { type: 'questions'; questions: ChatQuestion[] }
  /** Claude changed the LayerTone setup (set_layertone): the design's LAYERTONE_KEY value, or null to clear it. */
  | { type: 'layerToneSetup'; setup: LayerToneSetup | null }
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
  /** 3D figures from Meshy can be made (MESHY_API_KEY set). */
  meshy: boolean;
  /** The chat's starting model and effort (PTP_MODEL, PTP_EFFORT). */
  model: string;
  effort: string;
  /** The currency costs are in (PTP_CURRENCY). */
  currency: string;
  /** Claude runs through OpenRouter, so the model menu offers OpenRouter's models (GET /api/models). */
  openRouterModels: boolean;
}

/** A model on OpenRouter that can run the app (tools, text in and out), for the model menu. */
export interface OpenRouterModel {
  id: string;
  /** Without the provider in front ("DeepSeek V4.1 Flash"). */
  name: string;
  /** As OpenRouter writes it ("DeepSeek: DeepSeek V4.1 Flash"). */
  fullName: string;
  /** When OpenRouter added it (Unix seconds). */
  created: number;
  contextLength: number | null;
  /** USD per token. */
  pricing: { prompt: number; completion: number; cacheRead: number; cacheWrite: number };
  /** Takes pictures as input. */
  images: boolean;
  /** One of the menu's top models (the newest of each well-known family). */
  featured?: boolean;
}

/** GET /api/models (only when Claude runs through OpenRouter). */
export interface ModelsResponse { models: OpenRouterModel[] }

/** GET /api/connection: what the app runs Claude on, and whether that service answers. */
export interface Connection {
  via: 'subscription' | 'openrouter' | 'anthropic' | 'custom' | 'none';
  ok: boolean;
  /** What was checked, or what is wrong. */
  detail: string;
  /** OpenRouter credit left, in USD (when the key may read it). */
  credit?: number;
  /** The Claude subscription's usage windows, as far as the app knows them (subscription mode). */
  usage?: UsageWindow[];
}

/** GET /api/meshy/balance: the Meshy account's credits (404 when no Meshy key is set). */
export interface MeshyBalance {
  /** Credits left in all. */
  balance: number;
  monthly_credits?: number;
  permanent_credits?: number;
  /** When the monthly credits renew (ms). */
  monthly_resets_at?: number;
}

/** POST /api/designs/:id/meshes: an attached mesh file, imported and stored with the design. */
export interface MeshUpload {
  /** A name from the file's (the app makes it unique in the design). */
  name: string;
  entry: MeshEntry;
  report: ImportReport;
}

/** POST /api/backup/import: what a backup zip (GET /api/backup) brought back. */
export interface BackupImport {
  imported: { id: string; name: string }[];
  /** Designs not imported: one with the same id is already here (it is kept as it is), or the zip's copy is damaged. */
  skipped: { id: string; name: string; reason: string }[];
  /** Settings restored from the zip ('cost settings', 'My filaments'): only those not saved here yet. */
  settings: string[];
}

/** GET /api/designs/:id/files: the images and mesh files stored with a design (file names). */
export interface DesignFiles {
  images: string[];
  meshes: string[];
}

/** POST /api/bambu/template: the chosen printer's + PLA project settings from the user's Bambu Studio. */
/** GET /api/printer: the chosen printer, every printer to pick from, whether to ask (first start). */
export interface PrinterInfo {
  printer: ActivePrinter;
  printers: Printer[];
  /** Nothing saved yet on a new install: the app asks which printer it is. */
  firstStart: boolean;
  /** The saved printer isn't in Bambu Studio any more: the A1 is used until another is picked. */
  missing: boolean;
}

export interface BambuTemplate {
  version: string;
  /** Of the printer's resolved presets: a preset changed in Bambu Studio means a new template. */
  presetHash?: string;
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

/** The kind of picture a picture edit changes: the design's picture mode. */
export type PictureMode = 'artwork' | 'layertone' | 'lithophane' | 'lineart';

/** POST /api/designs/:id/picture-edit: change part of a design's picture with the image model. */
export interface PictureEditRequest {
  mode: PictureMode;
  /** The picture's name (artwork: the drawing's name in $drawings). */
  picture: string;
  /** The design's values as they are now (they hold the picture and its hand edits). */
  values: ParamValues;
  /** Where the change goes (picture units); without one the whole picture is edited. */
  mark?: PictureMark;
  /** What to change, in the user's words. */
  change: string;
  /** Photos of the real subject for the part changed, as data URLs (at most 4). */
  photos: string[];
}

export interface PictureEditResponse {
  /** Value keys to set (null = delete): the drawing or picture, $artworkEdits (strokes cut), $pictureMarks (the mark removed). */
  set: Record<string, string | null>;
  /** PNG data URLs: what was sent and the pasted result (the crop, or the whole picture). */
  before: string;
  after: string;
  masked: boolean;
  /** Checked: outside the mark the picture is unchanged. Only meaningful for a masked edit (always false without a mark: there is no outside). */
  outsideSame: boolean;
  /** The new shapes were simplified harder to stay within the drawing's point limit. */
  simplified?: boolean;
  /** Only when more of the mark than OFF_PALETTE_SHARE wants a colour the design has no filament for; `note` says so in plain words. */
  offPalette?: { share: number; colour: string; note: string };
  prompt: string;
  model: string;
  cost: number | null;
}

