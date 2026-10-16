// Print settings (PLA on the Bambu Lab A1, 0.20 mm Standard as the baseline).
// Only values that differ from the baseline are written to an exported Bambu project.

export type Supports = 'off' | 'normal' | 'tree';
/** 'auto' and 'none' map to Bambu's brim types; a number is an outer brim of that width in mm. */
export type Brim = 'auto' | 'none' | number;

export interface PrintSettings {
  layerHeight?: number;
  walls?: number;
  topLayers?: number;
  bottomLayers?: number;
  infill?: number; // %
  infillPattern?: string;
  supports?: Supports;
  brim?: Brim;
}

/** Model-wide settings plus optional per-part overrides (layer height is model-wide only). */
export interface PrintProfile extends PrintSettings {
  parts?: Record<string, Omit<PrintSettings, 'layerHeight'>>;
}

export const PRINT_KEY = '$print';

/** Bambu Lab A1 · 0.20mm Standard @BBL A1 · Bambu PLA Basic (read from Bambu Studio 2.8 profiles). */
export const A1_DEFAULTS: Required<PrintSettings> = {
  layerHeight: 0.2, walls: 2, topLayers: 5, bottomLayers: 3, infill: 15, infillPattern: 'grid', supports: 'off', brim: 'auto',
};

export const LAYER_HEIGHTS = [0.08, 0.12, 0.16, 0.2, 0.24, 0.28];

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
  layerHeight: 'Layer height', walls: 'Walls', topLayers: 'Top layers', bottomLayers: 'Bottom layers',
  infill: 'Infill', infillPattern: 'Infill pattern', supports: 'Supports', brim: 'Brim',
};

const clampInt = (v: unknown, lo: number, hi: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : undefined);

/** Sanitise settings from a script or saved JSON; drops anything invalid. */
export function cleanSettings(raw: unknown, allowLayer = true): PrintSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: PrintSettings = {};
  if (allowLayer && Number.isFinite(Number(o.layerHeight))) {
    const lh = Number(o.layerHeight);
    out.layerHeight = LAYER_HEIGHTS.reduce((a, b) => (Math.abs(b - lh) < Math.abs(a - lh) ? b : a));
  }
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
  if (o.brim === 'auto' || o.brim === 'none') out.brim = o.brim;
  else if (Number.isFinite(Number(o.brim)) && Number(o.brim) > 0) out.brim = Math.min(20, Number(o.brim));
  else if (Number(o.brim) === 0) out.brim = 'none';
  return out;
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

/** Effective settings for a part: A1 defaults ← AI model-wide ← AI part ← user model-wide ← user part. */
export function effectiveSettings(ai: PrintProfile, user: PrintProfile, part?: string): Required<PrintSettings> {
  const pick = (p: PrintProfile) => { const { parts: _p, ...g } = p; return g; };
  return {
    ...A1_DEFAULTS,
    ...pick(ai), ...(part ? ai.parts?.[part] : undefined),
    ...pick(user), ...(part ? user.parts?.[part] : undefined),
  } as Required<PrintSettings>;
}

/** Bambu Studio setting keys for the values that differ from the A1 baseline. */
export function bambuOverrides(s: Required<PrintSettings>): Record<string, string> {
  const out: Record<string, string> = {};
  const d = A1_DEFAULTS;
  if (s.layerHeight !== d.layerHeight) out.layer_height = String(s.layerHeight);
  if (s.walls !== d.walls) out.wall_loops = String(s.walls);
  if (s.topLayers !== d.topLayers) out.top_shell_layers = String(s.topLayers);
  if (s.bottomLayers !== d.bottomLayers) out.bottom_shell_layers = String(s.bottomLayers);
  if (s.infill !== d.infill) out.sparse_infill_density = `${s.infill}%`;
  if (s.infillPattern !== d.infillPattern) out.sparse_infill_pattern = s.infillPattern;
  if (s.supports !== d.supports) {
    out.enable_support = s.supports === 'off' ? '0' : '1';
    if (s.supports !== 'off') out.support_type = s.supports === 'tree' ? 'tree(auto)' : 'normal(auto)';
  }
  if (s.brim !== d.brim) {
    if (s.brim === 'none') out.brim_type = 'no_brim';
    else if (s.brim === 'auto') out.brim_type = 'auto_brim';
    else { out.brim_type = 'outer_only'; out.brim_width = String(s.brim); }
  }
  return out;
}

export function describeSetting(key: keyof PrintSettings, v: PrintSettings[keyof PrintSettings]): string {
  switch (key) {
    case 'layerHeight': return `${v} mm`;
    case 'infill': return `${v} %`;
    case 'infillPattern': return INFILL_PATTERNS.find((p) => p.id === v)?.label ?? String(v);
    case 'supports': return v === 'off' ? 'Off' : v === 'tree' ? 'Tree' : 'Normal';
    case 'brim': return v === 'auto' ? 'Auto' : v === 'none' ? 'None' : `${v} mm`;
    default: return String(v);
  }
}
