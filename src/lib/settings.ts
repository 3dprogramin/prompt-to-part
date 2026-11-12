import type { EvalResult, ParamValue, ParamValues } from '../../shared/types';
import { SCALE_KEY } from '../../shared/params';
import { TEXT_KEY } from '../../shared/textFeatures';
import { DRAWINGS_KEY, SVG_KEY } from '../../shared/svgFeatures';
import { LAYERTONE_IMAGES_KEY, LAYERTONE_KEY } from '../../shared/layertone';
import { LINEART_EDITS_KEY } from '../../shared/lineart';
import { ARTWORK_EDITS_KEY } from '../../shared/artworkEdits';
import { EDIT_HISTORY_KEY } from '../../shared/editHistory';
import { PICTURE_MARKS_KEY } from '../../shared/pictureEdit/mark';

/** Hidden parts, saved with the design (like FreeCAD's visibility), not a setting. */
export const HIDDEN_KEY = '$hidden';
import { ONE_COLOUR_KEY, PRINT_KEY } from '../../shared/print';

type Params = EvalResult['params'];

/** The values that actually change something: script defaults and a 100 % scale are left out. */
function effective(values: ParamValues, params: Params): ParamValues {
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(values)) {
    // Attached drawings and LayerTone pictures come with chat messages, visibility is a view choice
    // and the hand edits' restore points and the picture marks are kept with the design: none of them is a setting to save as a version.
    if (k === DRAWINGS_KEY || k === LAYERTONE_IMAGES_KEY || k === HIDDEN_KEY || k === EDIT_HISTORY_KEY || k === PICTURE_MARKS_KEY || (k === SCALE_KEY ? Number(v) === 1 : k in params ? params[k].value === v : !k.startsWith('$'))) continue;
    out[k] = v;
  }
  return out;
}

function changedKeys(from: ParamValues, to: ParamValues, params: Params): string[] {
  const a = effective(from, params), b = effective(to, params);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** The same values for the build: alike but for the picture marks (they build nothing). */
export function sameBuild(a: ParamValues, b: ParamValues): boolean {
  if (a === b) return true;
  const keys = (v: ParamValues) => Object.keys(v).filter((k) => k !== PICTURE_MARKS_KEY);
  const ka = keys(a), kb = keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/** True when the sliders, scale, text or print overrides differ from `saved`. */
export function settingsChanged(saved: ParamValues, current: ParamValues, params: Params): boolean {
  return changedKeys(saved, current, params).length > 0;
}

/** Version summary for saved settings, e.g. "Settings: Hook width 55 mm, Gusset off, Scale 120 %". */
export function describeSettings(saved: ParamValues, current: ParamValues, params: Params): string {
  const parts = changedKeys(saved, current, params).map((k) => {
    const v = current[k] ?? (k in params ? params[k].value : undefined);
    if (k === SCALE_KEY) return `Scale ${Math.round(Number(v ?? 1) * 100)} %`;
    if (k === TEXT_KEY) return 'text';
    if (k === SVG_KEY) return 'SVG';
    if (k === DRAWINGS_KEY) return 'attached drawings';
    if (k === PRINT_KEY) return 'print settings';
    if (k === ONE_COLOUR_KEY) return v ? 'one colour' : 'colours (AMS)';
    if (k === LAYERTONE_KEY) return 'LayerTone filaments';
    if (k === LINEART_EDITS_KEY) return 'line art edits';
    if (k === ARTWORK_EDITS_KEY) return 'artwork edits';
    const d = params[k];
    return `${d?.label ?? k} ${fmt(v, d)}`;
  });
  return `Settings: ${parts.slice(0, 4).join(', ')}${parts.length > 4 ? ` +${parts.length - 4} more` : ''}`;
}

function fmt(v: ParamValue | undefined, d: Params[string] | undefined): string {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') return `${+v.toFixed(2)}${d && 'unit' in d && d.unit ? ` ${d.unit}` : ''}`;
  if (d?.type === 'select') return d.options.find((o) => o.value === v)?.label ?? String(v);
  return JSON.stringify(v ?? '');
}
