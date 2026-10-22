// Normalising the parameters a script declares, and the values the user set for them.
import type { ParamDef, ParamValues } from './types';

/** Uniform scale applied after build (a reserved value key, not a script parameter). */
export const SCALE_KEY = '$scale';
/**
 * A sale size of a flat piece (shared/sizes.ts): its face (X and Y) scaled by this, after SCALE_KEY,
 * while its thickness and reliefs (Z) stay as designed. Only in a size's values, never the design's.
 */
export const FACE_SCALE_KEY = '$faceScale';

/** Filaments the user picked for parts (Object tab), by part name: they win over the script's colours. */
export const PART_COLORS_KEY = '$partColors';
export interface PartFilament { color: string; name?: string; brand?: string }

/** The user's part filaments from the design's values, checked (#rrggbb colours). */
export function parsePartColors(raw: unknown): Record<string, PartFilament> {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return {}; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: Record<string, PartFilament> = {};
  for (const [part, f] of Object.entries(o as Record<string, PartFilament>).slice(0, 200)) {
    const clean = cleanFilament(f);
    if (clean) out[part.slice(0, 120)] = clean;
  }
  return out;
}

/** A filament as the picker gives it, checked (a #rrggbb colour, lower case); undefined when it isn't one. */
export function cleanFilament(raw: unknown): PartFilament | undefined {
  const f = raw as PartFilament | null;
  if (!f || typeof f !== 'object' || typeof f.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(f.color)) return undefined;
  return { color: f.color.toLowerCase(), ...(typeof f.name === 'string' ? { name: f.name.slice(0, 120) } : {}), ...(typeof f.brand === 'string' ? { brand: f.brand.slice(0, 60) } : {}) };
}

function niceStep(range: number) {
  const raw = range / 200;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

// Parameters end up in the sidebar and in Claude's tool results, so their text is bounded.
const MAX_PARAMS = 80;
const MAX_OPTIONS = 100;
const text = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined);

/** The script's `params` as slider/switch/select/text definitions; anything unusable is dropped. */
export function normalizeParams(raw: unknown): Record<string, ParamDef> {
  const out: Record<string, ParamDef> = {};
  if (!raw || typeof raw !== 'object') return out;
  const entries: [string, any][] = (Array.isArray(raw)
    ? raw.map((p: any) => [String(p?.key ?? p?.name), p] as [string, any])
    : Object.entries(raw as object)).slice(0, MAX_PARAMS);
  for (const [key, p] of entries) {
    if (!key || key.length > 80 || !p || typeof p !== 'object') continue;
    const label = text(p.label, 120) ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const value = p.value ?? p.default;
    const owners = (Array.isArray(p.parts) ? p.parts : typeof p.part === 'string' ? [p.part] : []).filter((x: unknown) => typeof x === 'string').slice(0, 20).map((x: string) => x.slice(0, 120));
    const common = { label, group: text(p.group, 60), description: text(p.description, 500), ...(owners.length ? { parts: owners } : {}) };
    let type = p.type;
    // The script's own objects are read, never written: they may be frozen.
    const font = type === 'font' || !!p.font;
    if (type === 'int') type = 'integer';
    if (type === 'bool') type = 'boolean';
    if (type === 'string' || type === 'font') type = 'text';
    if (!type) type = typeof value === 'boolean' ? 'boolean' : Array.isArray(p.options) ? 'select' : typeof value === 'string' ? 'text' : 'number';
    if (type === 'boolean') out[key] = { ...common, type, value: !!value };
    else if (type === 'text') out[key] = { ...common, type, value: String(value ?? '').slice(0, 2000), font };
    else if (type === 'select') {
      const options = (Array.isArray(p.options) ? p.options : []).slice(0, MAX_OPTIONS).map((o: any) =>
        typeof o === 'object' && o ? { value: String(o.value).slice(0, 120), label: String(o.label ?? o.value).slice(0, 120) } : { value: String(o).slice(0, 120), label: String(o).slice(0, 120) });
      if (!options.length) continue;
      const v = options.some((o: any) => o.value === String(value)) ? String(value) : options[0].value;
      out[key] = { ...common, type, options, value: v };
    } else {
      const v = Number(value);
      const val = Number.isFinite(v) ? v : 0;
      // Without bounds, a slider runs from 0 to twice the default; a negative default gets the
      // same span on its own side of zero (-10 → -20…0), so the default is never at an edge.
      const span = Math.max(Math.abs(val), 1);
      let min = Number.isFinite(Number(p.min)) ? Number(p.min) : val >= 0 ? 0 : val - span;
      let max = Number.isFinite(Number(p.max)) ? Number(p.max) : Math.max(val >= 0 ? val * 2 : val + span, min + 1);
      if (max < min) [min, max] = [max, min];
      const isInt = type === 'integer';
      const step = Number(p.step) > 0 ? Number(p.step) : isInt ? 1 : niceStep(max - min || 1);
      const drives = ['x', 'y', 'z'].includes(p.drives) ? p.drives : undefined;
      out[key] = { ...common, type: isInt ? 'integer' : 'number', min, max, step, value: isInt ? Math.round(val) : val, unit: text(p.unit, 16) ?? (isInt ? undefined : 'mm'), drives };
    }
  }
  return out;
}

export function resolveValues(params: Record<string, ParamDef>, input: ParamValues | undefined): ParamValues {
  const out: ParamValues = {};
  for (const [k, def] of Object.entries(params)) {
    const v = input?.[k];
    if (def.type === 'boolean') out[k] = typeof v === 'boolean' ? v : def.value;
    else if (def.type === 'text') out[k] = typeof v === 'string' ? v : def.value;
    else if (def.type === 'select') out[k] = typeof v === 'string' && def.options.some((o) => o.value === v) ? v : def.value;
    else {
      const n = typeof v === 'number' && Number.isFinite(v) ? v : def.value;
      out[k] = def.type === 'integer' ? Math.round(n) : n;
    }
  }
  return out;
}
