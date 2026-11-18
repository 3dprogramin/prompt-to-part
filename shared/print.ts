// Print settings (PLA on the chosen printer, its default process preset as the baseline, read from
// the user's Bambu Studio when its template has been built).
// Only values that differ from the baseline are written to an exported Bambu project.

import { layerHeights, printer, type Printer } from './printer';

export type Supports = 'off' | 'normal' | 'tree';
/** 'auto' and 'none' map to Bambu's brim types; a number is an outer brim of that width in mm. */
export type Brim = 'auto' | 'none' | number;
export type Ironing = 'off' | 'top' | 'topmost' | 'solid';
export type Seam = 'aligned' | 'nearest' | 'back' | 'random';
export type WallOrder = 'inner-outer' | 'outer-inner' | 'inner-outer-inner';
export type FuzzySkin = 'none' | 'external' | 'all';
export type TopPattern = 'monotonic' | 'monotonicline' | 'zig-zag' | 'alignedrectilinear' | 'concentric' | 'hilbertcurve' | 'archimedeanchords' | 'octagramspiral';
export type SupportStyle = 'default' | 'grid' | 'snug' | 'tree_slim' | 'tree_strong' | 'tree_hybrid' | 'tree_organic';
/** One wall on top surfaces: never, on every top surface, or on the topmost one only. */
export type TopOneWall = 'off' | 'all' | 'topmost';
export type WallGenerator = 'classic' | 'arachne';
/** Scarf (sloped) seam: none, on outer walls, or on all walls. */
export type ScarfSeam = 'none' | 'external' | 'all';

/** Bambu Studio's values for the settings whose names differ from the app's. */
const IRONING: Record<Ironing, string> = { off: 'no ironing', top: 'top', topmost: 'topmost', solid: 'solid' };
const WALL_ORDER: Record<WallOrder, string> = { 'inner-outer': 'inner wall/outer wall', 'outer-inner': 'outer wall/inner wall', 'inner-outer-inner': 'inner-outer-inner wall' };
export const SEAMS: Seam[] = ['aligned', 'nearest', 'back', 'random'];
export const FUZZY_SKIN: FuzzySkin[] = ['none', 'external', 'all'];
export const SUPPORT_STYLES: SupportStyle[] = ['default', 'grid', 'snug', 'tree_slim', 'tree_strong', 'tree_hybrid', 'tree_organic'];
const TOP_ONE_WALL_BAMBU: Record<TopOneWall, string> = { off: 'not apply', all: 'all top', topmost: 'topmost' };
export const TOP_ONE_WALL = Object.keys(TOP_ONE_WALL_BAMBU) as TopOneWall[];
export const WALL_GENERATORS: WallGenerator[] = ['classic', 'arachne'];
export const SCARF_SEAMS: ScarfSeam[] = ['none', 'external', 'all'];
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
  /** How the visible top faces are filled: straight lines (monotonic), rings that follow the outline (concentric)… */
  topPattern?: TopPattern;
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
  /** Spiral vase: one continuous outer wall, no top, no infill, no supports (model-wide only). */
  spiralVase?: boolean;
  /** Overhang angle (degrees) below which supports are added. */
  supportAngle?: number;
  /** Air gap between a support and the model above it, mm. */
  supportGap?: number;
  /** Dense layers of the support under the model. */
  supportInterfaceLayers?: number;
  supportStyle?: SupportStyle;
  topOneWall?: TopOneWall;
  /** Angle of the infill lines, degrees. */
  infillDirection?: number;
  wallGenerator?: WallGenerator;
  scarfSeam?: ScarfSeam;
  /** Ironing speed, mm/s. */
  ironingSpeed?: number;
  /** Ironing flow, % of the normal flow. */
  ironingFlow?: number;
  /** Distance between ironing lines, mm. */
  ironingSpacing?: number;
  /** Grow (+) or shrink (-) holes, mm. */
  holeCompensation?: number;
  /** Grow (+) or shrink (-) the outline, mm. */
  contourCompensation?: number;
  /** Elephant foot compensation, mm. */
  elephantFoot?: number;
}

/** Settings Bambu Studio only has for the whole print. */
export type ModelWideKey = 'layerHeight' | 'firstLayerHeight' | 'spiralVase';

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
  layerHeight: 0.2, firstLayerHeight: 0.2, walls: 2, topLayers: 5, bottomLayers: 3, infill: 15, infillPattern: 'grid', topPattern: 'monotonicline', supports: 'off', brim: 'auto',
  ironing: 'off', seam: 'aligned', supportsOnPlate: false, wallOrder: 'inner-outer', fuzzySkin: 'none',
  spiralVase: false, supportAngle: 30, supportGap: 0.2, supportInterfaceLayers: 2, supportStyle: 'default', topOneWall: 'all', infillDirection: 45, wallGenerator: 'classic',
  scarfSeam: 'none', ironingSpeed: 30, ironingFlow: 10, ironingSpacing: 0.15, holeCompensation: 0, contourCompensation: 0, elephantFoot: 0.075,
};

/** The support styles that fit a support type (Bambu ignores the others). */
export function supportStylesFor(supports: Supports): SupportStyle[] {
  return supports === 'normal' ? ['default', 'grid', 'snug'] : supports === 'tree' ? ['default', 'tree_slim', 'tree_strong', 'tree_hybrid', 'tree_organic'] : ['default'];
}

/** The settings as the Print tab groups them (the main rows are not in a group). */
export const SETTING_GROUPS: { id: string; label: string; keys: (keyof PrintSettings)[] }[] = [
  { id: 'supports', label: 'Supports', keys: ['supportStyle', 'supportAngle', 'supportGap', 'supportInterfaceLayers'] },
  { id: 'top', label: 'Top surface', keys: ['topOneWall', 'infillDirection'] },
  { id: 'seam', label: 'Seam', keys: ['scarfSeam'] },
  { id: 'ironing', label: 'Ironing', keys: ['ironingSpeed', 'ironingFlow', 'ironingSpacing'] },
  { id: 'fit', label: 'Fit', keys: ['holeCompensation', 'contourCompensation', 'elephantFoot'] },
  { id: 'advanced', label: 'Advanced', keys: ['wallGenerator', 'spiralVase'] },
];

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

/** Bambu Studio top surface pattern ids (all verified to slice) and display names. */
export const TOP_PATTERNS: { id: TopPattern; label: string }[] = [
  { id: 'monotonic', label: 'Monotonic' },
  { id: 'monotonicline', label: 'Monotonic line' },
  { id: 'zig-zag', label: 'Rectilinear' },
  { id: 'alignedrectilinear', label: 'Aligned rectilinear' },
  { id: 'concentric', label: 'Concentric' },
  { id: 'hilbertcurve', label: 'Hilbert curve' },
  { id: 'archimedeanchords', label: 'Archimedean chords' },
  { id: 'octagramspiral', label: 'Octagram spiral' },
];

export const SETTING_LABELS: Record<keyof PrintSettings, string> = {
  layerHeight: 'Layer height', firstLayerHeight: 'First layer height', walls: 'Walls', topLayers: 'Top layers', bottomLayers: 'Bottom layers',
  infill: 'Infill', infillPattern: 'Infill pattern', topPattern: 'Top surface pattern', supports: 'Supports', brim: 'Brim',
  ironing: 'Ironing', seam: 'Seam', supportsOnPlate: 'Supports from plate only', wallOrder: 'Wall order', fuzzySkin: 'Fuzzy skin',
  spiralVase: 'Spiral vase', supportAngle: 'Support angle', supportGap: 'Support gap', supportInterfaceLayers: 'Support interface layers', supportStyle: 'Support style',
  topOneWall: 'One wall on top', infillDirection: 'Infill direction', wallGenerator: 'Wall generator', scarfSeam: 'Scarf seam', ironingSpeed: 'Ironing speed',
  ironingFlow: 'Ironing flow', ironingSpacing: 'Ironing line spacing', holeCompensation: 'Hole compensation', contourCompensation: 'Outline compensation', elephantFoot: 'Elephant foot',
};

/** A number, or a numeric string; null, '', false and the like mean "not set" (they are not 0). */
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const clampInt = (v: unknown, lo: number, hi: number) => { const n = num(v); return n == null ? undefined : Math.min(hi, Math.max(lo, Math.round(n))); };
/** Clamped to lo..hi and rounded to `decimals` places. */
const clampNum = (v: unknown, lo: number, hi: number, decimals: number) => {
  const n = num(v);
  if (n == null) return undefined;
  const f = 10 ** decimals;
  return Math.round(Math.min(hi, Math.max(lo, n)) * f) / f;
};

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
  if (typeof o.topPattern === 'string') {
    const t = String(o.topPattern).toLowerCase();
    const p = TOP_PATTERNS.find((x) => x.id === t || x.label.toLowerCase() === t);
    if (p) out.topPattern = p.id;
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
  if (allowLayer && typeof o.spiralVase === 'boolean') out.spiralVase = o.spiralVase;
  const supportAngle = clampInt(o.supportAngle, 0, 90); if (supportAngle != null) out.supportAngle = supportAngle;
  const supportGap = clampNum(o.supportGap, 0, 1, 2); if (supportGap != null) out.supportGap = supportGap;
  const supportInterfaceLayers = clampInt(o.supportInterfaceLayers, 0, 5); if (supportInterfaceLayers != null) out.supportInterfaceLayers = supportInterfaceLayers;
  const supportStyle = oneOf(o.supportStyle, SUPPORT_STYLES); if (supportStyle) out.supportStyle = supportStyle;
  const topOneWall = o.topOneWall === true ? 'all' : o.topOneWall === false ? 'off' : oneOf(o.topOneWall, TOP_ONE_WALL); if (topOneWall) out.topOneWall = topOneWall;
  const infillDirection = clampInt(o.infillDirection, 0, 180); if (infillDirection != null) out.infillDirection = infillDirection;
  const wallGenerator = oneOf(o.wallGenerator, WALL_GENERATORS); if (wallGenerator) out.wallGenerator = wallGenerator;
  const scarf = o.scarfSeam === true ? 'external' : o.scarfSeam === false ? 'none' : oneOf(o.scarfSeam, SCARF_SEAMS); if (scarf) out.scarfSeam = scarf;
  const ironingSpeed = clampInt(o.ironingSpeed, 10, 100); if (ironingSpeed != null) out.ironingSpeed = ironingSpeed;
  const ironingFlow = clampInt(o.ironingFlow, 5, 30); if (ironingFlow != null) out.ironingFlow = ironingFlow;
  const ironingSpacing = clampNum(o.ironingSpacing, 0.05, 0.3, 2); if (ironingSpacing != null) out.ironingSpacing = ironingSpacing;
  const holeCompensation = clampNum(o.holeCompensation, -0.5, 0.5, 2); if (holeCompensation != null) out.holeCompensation = holeCompensation;
  const contourCompensation = clampNum(o.contourCompensation, -0.5, 0.5, 2); if (contourCompensation != null) out.contourCompensation = contourCompensation;
  const elephantFoot = clampNum(o.elephantFoot, 0, 1, 3); if (elephantFoot != null) out.elephantFoot = elephantFoot;
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
      infill: str('sparse_infill_density')?.replace('%', ''), infillPattern: str('sparse_infill_pattern'), topPattern: str('top_surface_pattern'),
      supports: str('enable_support') === '1' ? (str('support_type')?.startsWith('normal') ? 'normal' : 'tree') : 'off',
      brim: brimType === 'no_brim' ? 'none' : brimType === 'auto_brim' ? 'auto' : str('brim_width'),
      ironing: key(IRONING, str('ironing_type')), seam: str('seam_position'),
      supportsOnPlate: str('support_on_build_plate_only') === undefined ? undefined : str('support_on_build_plate_only') === '1',
      wallOrder: key(WALL_ORDER, str('wall_sequence')), fuzzySkin: str('fuzzy_skin'),
      spiralVase: str('spiral_mode') === undefined ? undefined : str('spiral_mode') === '1',
      supportAngle: str('support_threshold_angle'), supportGap: str('support_top_z_distance'), supportInterfaceLayers: str('support_interface_top_layers'), supportStyle: str('support_style'),
      topOneWall: key(TOP_ONE_WALL_BAMBU, str('top_one_wall_type')), infillDirection: str('infill_direction'), wallGenerator: str('wall_generator'), scarfSeam: str('seam_slope_type'),
      ironingSpeed: str('ironing_speed'), ironingFlow: str('ironing_flow')?.replace('%', ''), ironingSpacing: str('ironing_spacing'),
      holeCompensation: str('xy_hole_compensation'), contourCompensation: str('xy_contour_compensation'), elephantFoot: str('elefant_foot_compensation'),
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
  const vase = s.spiralVase;
  const density = vase ? '0%' : `${s.infill}%`;
  return {
    layer_height: String(s.layerHeight),
    initial_layer_print_height: String(s.firstLayerHeight),
    wall_loops: vase ? '1' : String(s.walls),
    top_shell_layers: vase ? '0' : String(s.topLayers),
    bottom_shell_layers: String(s.bottomLayers),
    sparse_infill_density: density,
    skeleton_infill_density: density,
    skin_infill_density: density,
    sparse_infill_pattern: s.infillPattern,
    top_surface_pattern: s.topPattern,
    enable_support: vase || s.supports === 'off' ? '0' : '1',
    support_type: s.supports === 'normal' ? 'normal(auto)' : 'tree(auto)',
    brim_type: s.brim === 'none' ? 'no_brim' : s.brim === 'auto' ? 'auto_brim' : 'outer_only',
    brim_width: typeof s.brim === 'number' ? String(s.brim) : '5',
    ironing_type: IRONING[s.ironing],
    seam_position: s.seam,
    support_on_build_plate_only: s.supportsOnPlate ? '1' : '0',
    wall_sequence: WALL_ORDER[s.wallOrder],
    fuzzy_skin: s.fuzzySkin,
    spiral_mode: vase ? '1' : '0',
    support_threshold_angle: String(s.supportAngle),
    support_top_z_distance: String(s.supportGap),
    support_interface_top_layers: String(s.supportInterfaceLayers),
    support_style: supportStylesFor(s.supports).includes(s.supportStyle) ? s.supportStyle : 'default',
    top_one_wall_type: TOP_ONE_WALL_BAMBU[s.topOneWall],
    infill_direction: String(s.infillDirection),
    wall_generator: s.wallGenerator,
    seam_slope_type: s.scarfSeam,
    ironing_speed: String(s.ironingSpeed),
    ironing_flow: `${s.ironingFlow}%`,
    ironing_spacing: String(s.ironingSpacing),
    xy_hole_compensation: String(s.holeCompensation),
    xy_contour_compensation: String(s.contourCompensation),
    elefant_foot_compensation: String(s.elephantFoot),
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
    case 'topPattern': return TOP_PATTERNS.find((p) => p.id === v)?.label ?? String(v);
    case 'supports': return v === 'off' ? 'Off' : v === 'tree' ? 'Tree' : 'Normal';
    case 'brim': return v === 'auto' ? 'Auto' : v === 'none' ? 'None' : `${v} mm`;
    case 'ironing': return ({ off: 'Off', top: 'Top surfaces', topmost: 'Topmost surface', solid: 'All solid layers' } as Record<string, string>)[String(v)] ?? String(v);
    case 'seam': return ({ aligned: 'Aligned', nearest: 'Nearest', back: 'Back', random: 'Random' } as Record<string, string>)[String(v)] ?? String(v);
    case 'supportsOnPlate': return v ? 'On' : 'Off';
    case 'wallOrder': return ({ 'inner-outer': 'Inner, then outer', 'outer-inner': 'Outer, then inner', 'inner-outer-inner': 'Inner, outer, inner' } as Record<string, string>)[String(v)] ?? String(v);
    case 'fuzzySkin': return ({ none: 'Off', external: 'Outer walls', all: 'All walls' } as Record<string, string>)[String(v)] ?? String(v);
    case 'spiralVase': return v ? 'On' : 'Off';
    case 'supportAngle': case 'infillDirection': return `${v}°`;
    case 'supportGap': case 'ironingSpacing': case 'holeCompensation': case 'contourCompensation': case 'elephantFoot': return `${v} mm`;
    case 'supportInterfaceLayers': return String(v);
    case 'ironingSpeed': return `${v} mm/s`;
    case 'ironingFlow': return `${v} %`;
    case 'supportStyle': { const t = String(v).replace('_', ' '); return t.charAt(0).toUpperCase() + t.slice(1); }
    case 'topOneWall': return ({ off: 'Off', all: 'All top surfaces', topmost: 'Topmost surface' } as Record<string, string>)[String(v)] ?? String(v);
    case 'wallGenerator': return ({ classic: 'Classic', arachne: 'Arachne' } as Record<string, string>)[String(v)] ?? String(v);
    case 'scarfSeam': return ({ none: 'Off', external: 'Outer wall', all: 'All walls' } as Record<string, string>)[String(v)] ?? String(v);
    default: return String(v);
  }
}
