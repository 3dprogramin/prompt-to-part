// Normalising the parameters a script declares, and the values the user set for them.
import type { ParamDef, ParamValues } from './types';

/** Uniform scale applied after build (a reserved value key, not a script parameter). */
export const SCALE_KEY = '$scale';

function niceStep(range: number) {
  const raw = range / 200;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

/** The script's `params` as slider/switch/select/text definitions; anything unusable is dropped. */
export function normalizeParams(raw: unknown): Record<string, ParamDef> {
  const out: Record<string, ParamDef> = {};
  if (!raw || typeof raw !== 'object') return out;
  const entries: [string, any][] = Array.isArray(raw)
    ? raw.map((p: any) => [String(p?.key ?? p?.name), p])
    : Object.entries(raw as object);
  for (const [key, p] of entries) {
    if (!key || !p || typeof p !== 'object') continue;
    const label = typeof p.label === 'string' ? p.label : key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const value = p.value ?? p.default;
    const common = { label, group: typeof p.group === 'string' ? p.group : undefined, description: typeof p.description === 'string' ? p.description : undefined };
    let type = p.type;
    // The script's own objects are read, never written: they may be frozen.
    const font = type === 'font' || !!p.font;
    if (type === 'int') type = 'integer';
    if (type === 'bool') type = 'boolean';
    if (type === 'string' || type === 'font') type = 'text';
    if (!type) type = typeof value === 'boolean' ? 'boolean' : Array.isArray(p.options) ? 'select' : typeof value === 'string' ? 'text' : 'number';
    if (type === 'boolean') out[key] = { ...common, type, value: !!value };
    else if (type === 'text') out[key] = { ...common, type, value: String(value ?? ''), font };
    else if (type === 'select') {
      const options = (Array.isArray(p.options) ? p.options : []).map((o: any) =>
        typeof o === 'object' && o ? { value: String(o.value), label: String(o.label ?? o.value) } : { value: String(o), label: String(o) });
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
      out[key] = { ...common, type: isInt ? 'integer' : 'number', min, max, step, value: isInt ? Math.round(val) : val, unit: typeof p.unit === 'string' ? p.unit : isInt ? undefined : 'mm', drives };
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
