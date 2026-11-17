// The back text: a mirrored line (the shop's address, PTP_BACK_TEXT) printed in the first layers of
// a LayerTone print in a contrasting filament, so it reads from the back. This file decides it (on or
// off, which filament, where, how many layers, what to warn about) and builds its mesh; the exports build on that.
import type { CrossSection } from 'manifold-3d';
import { hexToRgb, simulateRgb, toLab, type LayerColor, type LayerToneFilament } from './layertone';
import { DEFAULT_FONT, FontMissingError, layoutText } from './text';
import type { Box3, ParamValues } from './types';

export const BACK_TEXT_KEY = '$backText';
export const BACK_TEXT_LAYERS = 2;
/** Size (% of the picture's width) in the centre. */
export const DEFAULT_BACK_TEXT_SIZE = 70;
/** Size in the corner, the default place: small, like a maker's mark. */
export const DEFAULT_CORNER_SIZE = 30;
export type BackTextPosition = 'corner' | 'centre';
export const DEFAULT_BACK_TEXT_POSITION: BackTextPosition = 'corner';
/** The default size for a position. */
export const backTextDefaultSize = (p: BackTextPosition) => (p === 'centre' ? DEFAULT_BACK_TEXT_SIZE : DEFAULT_CORNER_SIZE);
const MAX_TEXT = 40;
const MIN_SIZE = 20;
const MAX_SIZE = 95;

export interface BackTextSetting { off?: true; text?: string; filament?: LayerToneFilament; size?: number; position?: BackTextPosition }

let defaultText = '';

/** The text printed on every LayerTone design unless it says otherwise; '' turns the feature off. */
export function setBackTextDefault(text: string): void {
  defaultText = text.trim().slice(0, MAX_TEXT);
}
export function backTextDefault(): string {
  return defaultText;
}

/** The design's `$backText` value (JSON string or object); anything unusable is {} (the defaults). */
export function parseBackText(raw: unknown): BackTextSetting {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw); } catch { return {}; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const r = o as Record<string, unknown>;
  const out: BackTextSetting = {};
  if (r.off === true) out.off = true;
  if (typeof r.text === 'string') out.text = r.text;
  if (typeof r.size === 'number' && Number.isFinite(r.size)) out.size = r.size;
  if (r.position === 'corner' || r.position === 'centre') out.position = r.position;
  const f = r.filament as Record<string, unknown> | undefined;
  if (f && typeof f === 'object' && typeof f.name === 'string' && typeof f.color === 'string' && /^#[0-9a-f]{6}$/i.test(f.color) && typeof f.td === 'number' && f.td > 0) {
    out.filament = { name: f.name, ...(typeof f.brand === 'string' ? { brand: f.brand } : {}), color: f.color, td: f.td };
  }
  return out;
}

export type BackTextNote = 'sameColour' | 'showsThrough';
export type BackTextPlan =
  | { on: true; text: string; filament: LayerToneFilament; auto: boolean; position: BackTextPosition; size: number; layers: number; topZ: number; notes: BackTextNote[] }
  | { on: false; reason: 'disabled' | 'off' | 'empty' | 'tooThin' };

const WHITE: LayerToneFilament = { name: 'PLA Basic Jade White', brand: 'Bambu Lab', color: '#ffffff', td: 5.9 };
const BLACK: LayerToneFilament = { name: 'PLA Basic Black', brand: 'Bambu Lab', color: '#000000', td: 0.2 };

const lightness = (hex: string) => toLab(hexToRgb(hex).map((v) => v * 255))[0];

/** The stack's filament that differs most in lightness from the first (ties: the lighter); black or white when there is only one. */
export function autoBackTextFilament(layers: LayerColor[]): LayerToneFilament {
  const l0 = lightness(layers[0]?.color ?? '#808080');
  if (layers.length < 2) return l0 > 50 ? { ...BLACK } : { ...WHITE };
  let best = layers[1], bestD = -1, bestL = -1;
  for (const l of layers.slice(1)) {
    const L = lightness(l.color), d = Math.abs(L - l0);
    if (d > bestD || (d === bestD && L > bestL)) { best = l; bestD = d; bestL = L; }
  }
  return { name: best.name ?? best.color, ...(best.brand ? { brand: best.brand } : {}), color: best.color, td: best.td };
}

export function planBackText(setting: BackTextSetting, layers: LayerColor[], r: { layerHeight: number; firstLayerHeight: number }): BackTextPlan {
  if (!defaultText) return { on: false, reason: 'disabled' };
  if (setting.off) return { on: false, reason: 'off' };
  const text = (setting.text ?? defaultText).trim().slice(0, MAX_TEXT);
  if (!text) return { on: false, reason: 'empty' };
  const n = Math.min(BACK_TEXT_LAYERS, (layers[1]?.layer ?? Infinity) - 1);
  if (n < 1) return { on: false, reason: 'tooThin' };
  const position = setting.position ?? DEFAULT_BACK_TEXT_POSITION;
  const size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, setting.size ?? backTextDefaultSize(position)));
  const topZ = Math.round((r.firstLayerHeight + (n - 1) * r.layerHeight) * 1e6) / 1e6;
  const auto = !setting.filament;
  const filament = setting.filament ?? autoBackTextFilament(layers);

  const notes: BackTextNote[] = [];
  if (filament.color.toLowerCase() === (layers[0]?.color ?? '').toLowerCase()) notes.push('sameColour');
  // The text filament sits under the first one: does it show through the first filament's own layers?
  const z = layers[1]?.z ?? topZ + r.layerHeight;
  const withText: LayerColor[] = [{ ...filament, z: 0, layer: 0 }, { ...layers[0], z: topZ, layer: n }, ...layers.slice(1)];
  const a = toLab(simulateRgb(z, layers).map((v) => v * 255)), b = toLab(simulateRgb(z, withText).map((v) => v * 255));
  if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 2) notes.push('showsThrough');
  return { on: true, text, filament, auto, position, size, layers: n, topZ, notes };
}

/**
 * What the LayerTone panel says about a back text that is on: printed (`printLayers` of the print's
 * layers), or why not. `box`: the part's; no room in the corner is decided from it by the rule
 * backTextMesh builds by (cornerFits), not from whether the last build has the text, which lags a
 * change. `file`: the 3MF the export makes; the text is only in a Bambu Studio project with colours
 * (toBambuProject), so in one colour or a plain 3MF it isn't printed, whatever the layers say.
 * Null: nothing to say (an empty text).
 */
export function backTextStatus(plan: BackTextPlan, printLayers: number, box: Box3, file: { oneColour: boolean; project: boolean }): 'printed' | 'tooThin' | 'noRoom' | 'oneColour' | 'noProject' | null {
  if (!plan.on && plan.reason !== 'tooThin') return null;
  if (file.oneColour) return 'oneColour';
  if (!file.project) return 'noProject';
  if (!plan.on || printLayers === 0) return 'tooThin';
  return plan.position === 'corner' && !cornerFits(box) ? 'noRoom' : 'printed';
}

/**
 * The values with `$backText` written out as it prints now (for marking printed): the text, size,
 * position and a chosen filament, or off (no PTP_BACK_TEXT, turned off, or an empty text), so re-exporting later
 * prints the same whatever the default becomes. An automatic filament stays unpinned: the printed
 * version's stack is locked, so autoBackTextFilament picks the same one. The same object when the
 * stored setting already says exactly that, or the design isn't LayerTone.
 */
export function pinBackText(values: ParamValues, layerTone: boolean): ParamValues {
  if (!layerTone) return values;
  const s = parseBackText(values[BACK_TEXT_KEY]);
  const text = defaultText && !s.off ? (s.text ?? defaultText).trim().slice(0, MAX_TEXT) : '';
  const position = s.position ?? DEFAULT_BACK_TEXT_POSITION;
  const pinned: BackTextSetting = text ? { text, size: s.size ?? backTextDefaultSize(position), position, ...(s.filament ? { filament: s.filament } : {}) } : { off: true };
  // parseBackText's key order is the same (off, text, size, position, filament): equal settings compare equal.
  if (BACK_TEXT_KEY in values && JSON.stringify(s) === JSON.stringify(pinned)) return values;
  return { ...values, [BACK_TEXT_KEY]: JSON.stringify(pinned) };
}

/**
 * Before the script runs: throws FontMissingError when this design may get the back text and its
 * font isn't loaded yet, so the font retry loads it before the relief is built, not after (which
 * built the whole picture twice). Any other font problem is left to backTextMesh (a warning).
 */
export function requireBackTextFont(code: string, raw: unknown): void {
  if (!defaultText || !code.includes('layertone') || parseBackText(raw).off) return;
  try {
    layoutText('a', { font: DEFAULT_FONT, size: 1 });
  } catch (e) {
    if (e instanceof FontMissingError) throw e;
  }
}

/** In the centre the text never covers more than this share of the part's depth (a long line on a tall picture stays a line). */
const MAX_DEPTH_SHARE = 0.25;
/** In the corner: letters at most this tall, this far from the edges (mm), clear of a brim or elephant's foot. */
const CORNER_MAX_HEIGHT = 8;
const CORNER_MARGIN = 8;

/** Whether the corner has room for the text: the part more than 16 mm (both margins) on both sides. */
export function cornerFits(box: Box3): boolean {
  return box.max[0] - box.min[0] > 2 * CORNER_MARGIN && box.max[1] - box.min[1] > 2 * CORNER_MARGIN;
}

/**
 * The back text's mesh in the part's coordinates, mirrored in X so it reads from the back, from the
 * box's bottom up to topZ. In the centre: `size` % of the box's width (25 % of its depth at most). In
 * the corner: `size` % of the width with letters 8 mm tall at most, 8 mm from the edges, at the
 * bottom-right as seen from the back (the picture turned over left to right), the model's bottom-left.
 * Throws FontMissingError while the font isn't loaded (the caller's font retry loads it).
 */
export function backTextMesh(plan: Extract<BackTextPlan, { on: true }>, box: Box3, C: typeof CrossSection): { positions: Float32Array; indices: Uint32Array } {
  const contours = layoutText(plan.text, { font: DEFAULT_FONT, size: 10, halign: 'center', valign: 'center' });
  if (!contours.length) return { positions: new Float32Array(0), indices: new Uint32Array(0) };
  const cs = new C(contours, 'NonZero');
  const b = cs.bounds();
  const tw = b.max[0] - b.min[0], th = b.max[1] - b.min[1];
  const W = box.max[0] - box.min[0], D = box.max[1] - box.min[1];
  const corner = plan.position === 'corner';
  // No corner inside the margins on a part 16 mm or less on either side: no text (the panel says so).
  if (corner && !cornerFits(box)) return { positions: new Float32Array(0), indices: new Uint32Array(0) };
  const k = corner
    ? Math.min((plan.size / 100) * W / tw, CORNER_MAX_HEIGHT / th, (W - 2 * CORNER_MARGIN) / tw, (D - 2 * CORNER_MARGIN) / th)
    : Math.min((plan.size / 100) * W / tw, (MAX_DEPTH_SHARE * D) / th);
  // A scale of 0 or below would build a flat or flipped text off the part (cornerFits keeps the
  // corner above 0; this also catches a degenerate glyph outline).
  if (!(k > 0)) return { positions: new Float32Array(0), indices: new Uint32Array(0) };
  // Centred on its own bounds (the font's centre line isn't the glyphs' middle), then mirrored.
  const cx = corner ? box.min[0] + CORNER_MARGIN + (tw * k) / 2 : (box.min[0] + box.max[0]) / 2;
  const cy = corner ? box.min[1] + CORNER_MARGIN + (th * k) / 2 : (box.min[1] + box.max[1]) / 2;
  const placed = cs.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2]).scale(k).mirror([1, 0]).translate([cx, cy]);
  const mesh = placed.extrude(plan.topZ).translate([0, 0, box.min[2]]).getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties, nv = vp.length / np;
  const positions = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) { positions[v * 3] = vp[v * np]; positions[v * 3 + 1] = vp[v * np + 1]; positions[v * 3 + 2] = vp[v * np + 2]; }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}
