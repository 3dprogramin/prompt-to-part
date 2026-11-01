// Print settings (PLA on the Bambu Lab A1, 0.20 mm Standard as the baseline, read from the user's
// Bambu Studio when its template has been built).
// Only values that differ from the baseline are written to an exported Bambu project.

import { layerHeights, printer, type Printer } from './printer';

export type Supports = 'off' | 'normal' | 'tree';
/** 'auto' and 'none' map to Bambu's brim types; a number is an outer brim of that width in mm. */
export type Brim = 'auto' | 'none' | number;
export type Ironing = 'off' | 'top' | 'topmost' | 'solid';
export type Seam = 'aligned' | 'nearest' | 'back' | 'random';
export type WallOrder = 'inner-outer' | 'outer-inner' | 'inner-outer-inner';
export type FuzzySkin = 'none' | 'external' | 'all';

/** Bambu Studio's values for the settings whose names differ from Jig's. */
const IRONING: Record<Ironing, string> = { off: 'no ironing', top: 'top', topmost: 'topmost', solid: 'solid' };
const WALL_ORDER: Record<WallOrder, string> = { 'inner-outer': 'inner wall/outer wall', 'outer-inner': 'outer wall/inner wall', 'inner-outer-inner': 'inner-outer-inner wall' };
export const SEAMS: Seam[] = ['aligned', 'nearest', 'back', 'random'];
export const FUZZY_SKIN: FuzzySkin[] = ['none', 'external', 'all'];
export const IRONING_TYPES = Object.keys(IRONING) as Ironing[];
export const WALL_ORDERS = Object.keys(WALL_ORDER) as WallOrder[];

export interface PrintSettings {
  layerHeight?: number;
  /** Height of the first layer, mm (model-wide only, like layerHeight). */
  firstLayerHeight?: number;
  walls?: number;
  topLayers?: number;
  bottomLayers?: number;
  infill?: number; // %
  infillPattern?: string;
  supports?: Supports;
  brim?: Brim;
  /** Smooth flat top surfaces with a second, almost flowless pass. */
  ironing?: Ironing;
  seam?: Seam;
  /** Supports may only stand on the build plate, never on the model. */
  supportsOnPlate?: boolean;
  /** Order of the walls: outer first gives truer outside dimensions, inner first cleaner overhangs. */
  wallOrder?: WallOrder;
  /** A rough, grippy outer surface (adds about 0.3 mm). */
  fuzzySkin?: FuzzySkin;
}

/** Settings Bambu Studio only has for the whole print. */
export type ModelWideKey = 'layerHeight' | 'firstLayerHeight';

/** Model-wide settings plus optional per-part overrides (layer heights are model-wide only). */
export interface PrintProfile extends PrintSettings {
  parts?: Record<string, Omit<PrintSettings, ModelWideKey>>;
}

export const PRINT_KEY = '$print';

/**
 * "Print in one colour" (Print tab), per design: true prints everything in the design's main
 * filament, a colour (#RRGGBB) in that one of its filaments. Unset: one filament per colour (AMS).
 */
export const ONE_COLOUR_KEY = '$oneColour';

/** The design's one-colour choice: null (off), 'main', or the colour of the filament picked (#RRGGBB). */
export function parseOneColour(v: unknown): null | 'main' | string {
  if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  return v === true || v === 'main' ? 'main' : null;
}

/**
 * Bambu Lab A1 · 0.20mm Standard @BBL A1 · Bambu PLA Basic (read from Bambu Studio 2.8 profiles).
 * Only a fallback: the baseline is read from the user's Bambu Studio template (defaultsFromTemplate)
 * once it has been built, so a Bambu Studio update that changes the profile changes it too.
 */
export const A1_DEFAULTS: Required<PrintSettings> = {
  layerHeight: 0.2, firstLayerHeight: 0.2, walls: 2, topLayers: 5, bottomLayers: 3, infill: 15, infillPattern: 'grid', supports: 'off', brim: 'auto',
  ironing: 'off', seam: 'aligned', supportsOnPlate: false, wallOrder: 'inner-outer', fuzzySkin: 'none',
};

/**
 * A printer's baseline until its Bambu Studio template is built: the A1 0.4's, with the nozzle's
 * standard layer height (half the nozzle: 0.10 mm on a 0.2 nozzle, 0.40 mm on a 0.8).
 */
export function printDefaultsFor(p: Pick<Printer, 'nozzle'>): Required<PrintSettings> {
  const heights = layerHeights(p.nozzle);
  const h = heights.reduce((a, b) => (Math.abs(b - p.nozzle / 2) < Math.abs(a - p.nozzle / 2) ? b : a));
  return { ...A1_DEFAULTS, layerHeight: h, firstLayerHeight: h };
}

/** Bambu Studio infill pattern ids (all verified to slice) and display names. */
export const INFILL_PATTERNS: { id: string; label: string }[] = [
  { id: 'grid', label: 'Grid' },
  { id: 'gyroid', label: 'Gyroid' },
  { id: 'cubic', label: 'Cubic' },
  { id: 'adaptivecubic', label: 'Adaptive cubic' },
  { id: 'honeycomb', label: 'Honeycomb' },
  { id: '3dhoneycomb', label: '3D honeycomb' },
  { id: 'triangles', label: 'Triangles' },
  { id: 'crosshatch', label: 'Cross hatch' },
  { id: 'lightning', label: 'Lightning' },
  { id: 'zig-zag', label: 'Rectilinear' },
  { id: 'line', label: 'Line' },
  { id: 'concentric', label: 'Concentric' },
];

export const SETTING_LABELS: Record<keyof PrintSettings, string> = {
  layerHeight: 'Layer height', firstLayerHeight: 'First layer height', walls: 'Walls', topLayers: 'Top layers', bottomLayers: 'Bottom layers',
  infill: 'Infill', infillPattern: 'Infill pattern', supports: 'Supports', brim: 'Brim',
  ironing: 'Ironing', seam: 'Seam', supportsOnPlate: 'Supports from plate only', wallOrder: 'Wall order', fuzzySkin: 'Fuzzy skin',
};

/** A number, or a numeric string; null, '', false and the like mean "not set" (they are not 0). */
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const clampInt = (v: unknown, lo: number, hi: number) => { const n = num(v); return n == null ? undefined : Math.min(hi, Math.max(lo, Math.round(n))); };

/** Sanitise settings from a script or saved JSON; drops anything invalid. */
export function cleanSettings(raw: unknown, allowLayer = true): PrintSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: PrintSettings = {};
  const heights = layerHeights(printer().nozzle);
  const nearest = (h: number) => heights.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
  const lh = num(o.layerHeight), flh = num(o.firstLayerHeight);
  if (allowLayer && lh != null) out.layerHeight = nearest(lh);
  if (allowLayer && flh != null) out.firstLayerHeight = nearest(flh);
  const walls = clampInt(o.walls, 1, 10); if (walls != null) out.walls = walls;
  const top = clampInt(o.topLayers, 0, 30); if (top != null) out.topLayers = top;
  const bottom = clampInt(o.bottomLayers, 0, 30); if (bottom != null) out.bottomLayers = bottom;
  const infill = clampInt(o.infill, 0, 100); if (infill != null) out.infill = infill;
  if (typeof o.infillPattern === 'string') {
    const p = INFILL_PATTERNS.find((x) => x.id === o.infillPattern || x.label.toLowerCase() === String(o.infillPattern).toLowerCase());
    if (p) out.infillPattern = p.id;
  }
  if (o.supports === 'off' || o.supports === 'normal' || o.supports === 'tree') out.supports = o.supports;
  else if (o.supports === true) out.supports = 'tree';
  else if (o.supports === false) out.supports = 'off';
  const brim = num(o.brim);
  if (o.brim === 'auto' || o.brim === 'none') out.brim = o.brim;
  else if (brim != null && brim > 0) out.brim = Math.min(20, brim);
  else if (brim === 0) out.brim = 'none';
  const oneOf = <T extends string>(v: unknown, list: readonly T[]) => (list as readonly unknown[]).includes(v) ? v as T : undefined;
  const ironing = o.ironing === true ? 'top' : o.ironing === false ? 'off' : oneOf(o.ironing, IRONING_TYPES); if (ironing) out.ironing = ironing;
  const seam = oneOf(o.seam, SEAMS); if (seam) out.seam = seam;
  if (typeof o.supportsOnPlate === 'boolean') out.supportsOnPlate = o.supportsOnPlate;
  const wallOrder = oneOf(o.wallOrder, WALL_ORDERS); if (wallOrder) out.wallOrder = wallOrder;
  const fuzzy = o.fuzzySkin === true ? 'external' : o.fuzzySkin === false ? 'none' : oneOf(o.fuzzySkin, FUZZY_SKIN); if (fuzzy) out.fuzzySkin = fuzzy;
  return out;
}

/** The baseline settings in a Bambu Studio project template (missing or odd values: the A1 fallback). */
export function defaultsFromTemplate(t: Record<string, unknown>): Required<PrintSettings> {
  const str = (k: string) => { const v = Array.isArray(t[k]) ? (t[k] as unknown[])[0] : t[k]; return v == null ? undefined : String(v); };
  const key = <T extends string>(map: Record<T, string>, v?: string) => (Object.keys(map) as T[]).find((k) => map[k] === v);
  const brimType = str('brim_type');
  return {
    ...A1_DEFAULTS,
    ...cleanSettings({
      layerHeight: str('layer_height'), firstLayerHeight: str('initial_layer_print_height'), walls: str('wall_loops'), topLayers: str('top_shell_layers'), bottomLayers: str('bottom_shell_layers'),
      infill: str('sparse_infill_density')?.replace('%', ''), infillPattern: str('sparse_infill_pattern'),
      supports: str('enable_support') === '1' ? (str('support_type')?.startsWith('normal') ? 'normal' : 'tree') : 'off',
      brim: brimType === 'no_brim' ? 'none' : brimType === 'auto_brim' ? 'auto' : str('brim_width'),
      ironing: key(IRONING, str('ironing_type')), seam: str('seam_position'),
      supportsOnPlate: str('support_on_build_plate_only') === undefined ? undefined : str('support_on_build_plate_only') === '1',
      wallOrder: key(WALL_ORDER, str('wall_sequence')), fuzzySkin: str('fuzzy_skin'),
    }),
  };
}

export function cleanProfile(raw: unknown, partNames?: string[]): PrintProfile {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: PrintProfile = cleanSettings(o);
  if (o.parts && typeof o.parts === 'object') {
    const parts: NonNullable<PrintProfile['parts']> = {};
    for (const [name, s] of Object.entries(o.parts as Record<string, unknown>)) {
      if (partNames && !partNames.includes(name)) continue;
      const c = cleanSettings(s, false);
      if (Object.keys(c).length) parts[name] = c;
    }
    if (Object.keys(parts).length) out.parts = parts;
  }
  return out;
}

export function parseProfile(raw: unknown): PrintProfile {
  if (typeof raw !== 'string' || !raw) return {};
  try { return cleanProfile(JSON.parse(raw)); } catch { return {}; }
}

/** Effective settings for a part: profile defaults ← AI model-wide ← AI part ← user model-wide ← user part. */
export function effectiveSettings(ai: PrintProfile, user: PrintProfile, part?: string, base: Required<PrintSettings> = A1_DEFAULTS): Required<PrintSettings> {
  const pick = (p: PrintProfile) => { const { parts: _p, ...g } = p; return g; };
  return {
    ...base,
    ...pick(ai), ...(part ? ai.parts?.[part] : undefined),
    ...pick(user), ...(part ? user.parts?.[part] : undefined),
  } as Required<PrintSettings>;
}

/** All Bambu Studio setting values for these settings (density also drives skeleton/skin infill, as in Bambu 2.4+). */
export function bambuValues(s: Required<PrintSettings>): Record<string, string> {
  const density = `${s.infill}%`;
  return {
    layer_height: String(s.layerHeight),
    initial_layer_print_height: String(s.firstLayerHeight),
    wall_loops: String(s.walls),
    top_shell_layers: String(s.topLayers),
    bottom_shell_layers: String(s.bottomLayers),
    sparse_infill_density: density,
    skeleton_infill_density: density,
    skin_infill_density: density,
    sparse_infill_pattern: s.infillPattern,
    enable_support: s.supports === 'off' ? '0' : '1',
    support_type: s.supports === 'normal' ? 'normal(auto)' : 'tree(auto)',
    brim_type: s.brim === 'none' ? 'no_brim' : s.brim === 'auto' ? 'auto_brim' : 'outer_only',
    brim_width: typeof s.brim === 'number' ? String(s.brim) : '5',
    ironing_type: IRONING[s.ironing],
    seam_position: s.seam,
    support_on_build_plate_only: s.supportsOnPlate ? '1' : '0',
    wall_sequence: WALL_ORDER[s.wallOrder],
    fuzzy_skin: s.fuzzySkin,
  };
}

/** Bambu keys whose value in `s` differs from `base` (default: the A1 fallback baseline). */
export function bambuOverrides(s: Required<PrintSettings>, base: Required<PrintSettings> = A1_DEFAULTS): Record<string, string> {
  const a = bambuValues(s), b = bambuValues(base);
  return Object.fromEntries(Object.entries(a).filter(([k, v]) => b[k] !== v));
}

export function describeSetting(key: keyof PrintSettings, v: PrintSettings[keyof PrintSettings]): string {
  switch (key) {
    case 'layerHeight': case 'firstLayerHeight': return `${v} mm`;
    case 'infill': return `${v} %`;
    case 'infillPattern': return INFILL_PATTERNS.find((p) => p.id === v)?.label ?? String(v);
    case 'supports': return v === 'off' ? 'Off' : v === 'tree' ? 'Tree' : 'Normal';
    case 'brim': return v === 'auto' ? 'Auto' : v === 'none' ? 'None' : `${v} mm`;
    case 'ironing': return ({ off: 'Off', top: 'Top surfaces', topmost: 'Topmost surface', solid: 'All solid layers' } as Record<string, string>)[String(v)] ?? String(v);
    case 'seam': return ({ aligned: 'Aligned', nearest: 'Nearest', back: 'Back', random: 'Random' } as Record<string, string>)[String(v)] ?? String(v);
    case 'supportsOnPlate': return v ? 'On' : 'Off';
    case 'wallOrder': return ({ 'inner-outer': 'Inner, then outer', 'outer-inner': 'Outer, then inner', 'inner-outer-inner': 'Inner, outer, inner' } as Record<string, string>)[String(v)] ?? String(v);
    case 'fuzzySkin': return ({ none: 'Off', external: 'Outer walls', all: 'All walls' } as Record<string, string>)[String(v)] ?? String(v);
    default: return String(v);
  }
}
