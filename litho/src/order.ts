// The customer's choices as they travel with the order (a hidden line item property, `_litho`) and
// come back on the production page: everything needed to rebuild the same lithophane from the
// attached photo, in one short JSON string.
import { resolveLithoOptions, type LithophaneOptions, type LithophaneShape } from '../../shared/lithophane';
import { SHAPES, type Orientation } from './config';
import type { Rect } from './crop';

/** Line item property that carries OrderSettings (the underscore hides it from the customer at checkout). */
export const ORDER_PROPERTY = '_litho';

export interface OrderSettings {
  /** Format version. */
  v: 1;
  /** The size preset's id and label as the customer saw it. */
  size: string;
  label: string;
  shape: LithophaneShape;
  orient: Orientation;
  /** Outer size, mm (lamp: diameter × height). */
  mm: [number, number];
  /** The part of the attached photo used, as fractions of it. */
  crop: Rect;
  /** Jig's lithophane options (shared/lithophane), resolution excepted: the production page picks it. */
  litho: LithophaneOptions;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/** OrderSettings as compact JSON. */
export function encodeOrder(s: OrderSettings): string {
  const o = s.litho;
  const litho: LithophaneOptions = { width: round(o.width) };
  for (const k of ['minThickness', 'maxThickness', 'border', 'angle', 'stand', 'gamma'] as const) if (o[k] != null) litho[k] = round(o[k] as number);
  if (o.shape) litho.shape = o.shape;
  if (o.invert) litho.invert = true;
  return JSON.stringify({ ...s, mm: s.mm.map((v) => round(v, 1)), litho });
}

/** OrderSettings from the property's text (or an object), checked; null if it isn't one. */
export function decodeOrder(raw: unknown): OrderSettings | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    // Pasted from an order page, the JSON may come with the property's name in front ("_litho: {…}").
    const at = raw.indexOf('{');
    try { o = JSON.parse(at >= 0 ? raw.slice(at, raw.lastIndexOf('}') + 1) : raw); } catch { return null; }
  }
  const s = o as Partial<OrderSettings> | null;
  if (!s || typeof s !== 'object' || s.v !== 1 || !s.litho || typeof s.litho !== 'object' || !s.crop || typeof s.crop !== 'object') return null;
  const { x, y, w, h } = s.crop;
  const inUnit = [x, y, w, h].every((v) => typeof v === 'number' && v >= 0 && v <= 1);
  if (!inUnit || !(w > 0) || !(h > 0) || x + w > 1.0001 || y + h > 1.0001) return null;
  let litho: LithophaneOptions;
  try {
    // Checked by Jig's own resolver; out-of-range values are clamped there too.
    const r = resolveLithoOptions(s.litho);
    litho = { width: r.width, minThickness: r.minThickness, maxThickness: r.maxThickness, border: r.border, shape: r.shape, angle: r.angle, stand: r.stand, gamma: r.gamma, invert: r.invert };
  } catch { return null; }
  const shape = SHAPES.includes(s.shape as LithophaneShape) ? s.shape! : litho.shape!;
  const mm = Array.isArray(s.mm) && s.mm.length === 2 && s.mm.every((v) => typeof v === 'number' && v > 0) ? s.mm as [number, number] : [0, 0] as [number, number];
  return {
    v: 1, size: String(s.size ?? '').slice(0, 60), label: String(s.label ?? '').slice(0, 60), shape,
    orient: s.orient === 'portrait' ? 'portrait' : 'landscape', mm, crop: { x, y, w, h }, litho,
  };
}
