// What the host page configures (sizes, prices, Shopify variants, thicknesses) and how a size
// preset becomes Jig's lithophane options. Plain data and arithmetic, no DOM: the unit tests and the
// production page use it as it is.
import type { LithophaneOptions, LithophaneShape } from '../../shared/lithophane';
import type { Lang } from './i18n';

/** Shapes the widget offers, in shared/lithophane's terms. */
export const SHAPES: LithophaneShape[] = ['flat', 'curved', 'cylinder'];

export type Orientation = 'landscape' | 'portrait';

/** One size the customer can choose. */
export interface SizePreset {
  /** Stable key, saved with the order (e.g. "flat-10x15"). */
  id: string;
  shape: LithophaneShape;
  /**
   * Outer size in mm, frame included. Flat and curved panels: width × height as a landscape piece
   * (the customer can turn it to portrait); curved: the width is measured along the arc. Lamp
   * (cylinder): width is the outside diameter, height the lamp's height.
   */
  width: number;
  height: number;
  /** Shown instead of the generated "10 × 15 cm". */
  label?: string;
  /** Price in the shop's currency, when no Shopify variant gives one. */
  price?: number;
  /** Shopify variant id for this size (and shape). */
  variant?: number | string;
  /** Or: the variant whose option values include all of these (e.g. ["Panou drept", "10×15 cm"]). */
  options?: string[];
  /** curved: the angle the panel spans, degrees (default: the config's angle). */
  angle?: number;
  /** A foot so a panel stands on a shelf: its depth in mm (default: the config's stand). */
  stand?: number;
}

/** The widget's whole configuration (attribute `config`, or a child <script type="application/json">). */
export interface LithoConfig {
  sizes: SizePreset[];
  /** Written after prices, e.g. "lei" (default) or "RON". */
  currency: string;
  /** Solid frame around the picture, mm (a lamp has it top and bottom only). */
  border: number;
  /** Thickness at the brightest and darkest points, mm. */
  minThickness: number;
  maxThickness: number;
  /** Curved panels: the angle they span, degrees. */
  angle: number;
  /** Flat panels: depth of a foot along the bottom, mm (0 = none). */
  stand: number;
  /** Longest side of the photo kept in the browser and attached to the order, pixels. */
  photoMaxSide: number;
}

/** Sizes, prices and thicknesses when the host page sets none; prices are examples only. */
export const DEFAULT_CONFIG: LithoConfig = {
  sizes: [
    { id: 'flat-10x15', shape: 'flat', width: 150, height: 100, price: 79 },
    { id: 'flat-13x18', shape: 'flat', width: 180, height: 130, price: 99 },
    { id: 'flat-15x20', shape: 'flat', width: 200, height: 150, price: 129 },
    { id: 'curved-10x15', shape: 'curved', width: 150, height: 100, price: 89 },
    { id: 'curved-13x18', shape: 'curved', width: 180, height: 130, price: 115 },
    { id: 'lamp-8x12', shape: 'cylinder', width: 80, height: 120, price: 119 },
    { id: 'lamp-10x15', shape: 'cylinder', width: 100, height: 150, price: 149 },
    { id: 'lamp-12x18', shape: 'cylinder', width: 120, height: 180, price: 179 },
  ],
  currency: 'lei',
  border: 3,
  minThickness: 0.8,
  maxThickness: 3,
  angle: 120,
  stand: 0,
  photoMaxSide: 2400,
};

/** A Bambu Lab A1's build volume bounds what can be printed in one piece (standing up); the shop widget has no Jig printer setting. */
const MAX_SIDE_MM = 250;

const num = (v: unknown, def: number, lo: number, hi: number) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

/** A size preset from the host's JSON, checked; null if unusable. */
function cleanSize(raw: unknown, i: number): SizePreset | null {
  const o = raw as Partial<SizePreset> | null;
  if (!o || typeof o !== 'object') return null;
  const shape = SHAPES.includes(o.shape as LithophaneShape) ? o.shape! : 'flat';
  const width = num(o.width, NaN, 20, MAX_SIDE_MM), height = num(o.height, NaN, 20, MAX_SIDE_MM);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const size: SizePreset = { id: typeof o.id === 'string' && o.id ? o.id.slice(0, 60) : `${shape}-${i + 1}`, shape, width, height };
  if (typeof o.label === 'string' && o.label.trim()) size.label = o.label.trim().slice(0, 60);
  const price = num(o.price, NaN, 0, 1e7);
  if (Number.isFinite(price)) size.price = price;
  if ((typeof o.variant === 'number' && o.variant > 0) || (typeof o.variant === 'string' && /^\d+$/.test(o.variant))) size.variant = o.variant;
  if (Array.isArray(o.options)) size.options = o.options.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 3);
  if (o.angle != null) size.angle = num(o.angle, 120, 10, 350);
  if (o.stand != null) size.stand = num(o.stand, 0, 0, 60);
  return size;
}

/** The host's configuration (an object or JSON text) over the defaults; anything invalid falls back to them. */
export function parseConfig(raw: unknown): LithoConfig {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { o = null; } }
  const c = (o && typeof o === 'object' && !Array.isArray(o) ? o : {}) as Partial<Record<keyof LithoConfig, unknown>>;
  const sizes = Array.isArray(c.sizes) ? c.sizes.map(cleanSize).filter((s): s is SizePreset => !!s) : [];
  const minThickness = num(c.minThickness, DEFAULT_CONFIG.minThickness, 0.3, 5);
  return {
    sizes: sizes.length ? sizes : DEFAULT_CONFIG.sizes,
    currency: typeof c.currency === 'string' ? c.currency.slice(0, 12) : DEFAULT_CONFIG.currency,
    border: num(c.border, DEFAULT_CONFIG.border, 0, 15),
    minThickness,
    maxThickness: num(c.maxThickness, DEFAULT_CONFIG.maxThickness, minThickness + 0.2, 8),
    angle: num(c.angle, DEFAULT_CONFIG.angle, 10, 350),
    stand: num(c.stand, DEFAULT_CONFIG.stand, 0, 60),
    photoMaxSide: Math.round(num(c.photoMaxSide, DEFAULT_CONFIG.photoMaxSide, 600, 6000)),
  };
}

/** The shapes that have at least one size, in the usual order. */
export const shapesOf = (c: LithoConfig): LithophaneShape[] => SHAPES.filter((s) => c.sizes.some((z) => z.shape === s));

// ---------------------------------------------------------------------------
// Size → lithophane
// ---------------------------------------------------------------------------

/** What a size preset prints: Jig's options, the outer size and the picture's proportions. */
export interface SizeGeometry {
  options: LithophaneOptions;
  /** Outer size, mm: width × height as it stands (lamp: diameter × height). */
  outer: [number, number];
  /** The picture itself, mm: width × height (lamp: around the circumference). */
  picture: [number, number];
}

/** A size preset (turned to `orient`) as Jig's lithophane options; `gamma` from the brightness slider. */
export function sizeGeometry(size: SizePreset, orient: Orientation, c: LithoConfig, gamma = 1): SizeGeometry {
  const B = c.border, common = { minThickness: c.minThickness, maxThickness: c.maxThickness, border: B, gamma };
  if (size.shape === 'cylinder') {
    // The picture wraps the lamp's back (light-side) surface; its relief stands out by up to
    // maxThickness, so the outside diameter is about the preset's.
    const width = Math.PI * Math.max(10, size.width - 2 * c.maxThickness);
    const height = Math.max(10, size.height - 2 * B);
    return { options: { ...common, width, shape: 'cylinder' }, outer: [size.width, size.height], picture: [width, height] };
  }
  const long = Math.max(size.width, size.height), short = Math.min(size.width, size.height);
  const [ow, oh] = orient === 'portrait' ? [short, long] : [long, short];
  const width = Math.max(10, ow - 2 * B), height = Math.max(10, oh - 2 * B);
  const options: LithophaneOptions = { ...common, width, shape: size.shape };
  if (size.shape === 'curved') options.angle = size.angle ?? c.angle;
  const stand = size.stand ?? (size.shape === 'flat' ? c.stand : 0);
  if (stand > 0) options.stand = stand;
  return { options, outer: [ow, oh], picture: [width, height] };
}

/** "10 × 15 cm" (as it stands, height first as people say it), "Ø 10 × 15 cm" for a lamp, or the preset's own label. */
export function sizeLabel(size: SizePreset, lang: Lang): string {
  if (size.label) return size.label;
  const cm = (mm: number) => (Math.round(mm) / 10).toLocaleString(lang === 'ro' ? 'ro-RO' : 'en-GB', { maximumFractionDigits: 1 });
  if (size.shape === 'cylinder') return `Ø ${cm(size.width)} × ${cm(size.height)} cm`;
  return `${cm(Math.min(size.width, size.height))} × ${cm(Math.max(size.width, size.height))} cm`;
}

// ---------------------------------------------------------------------------
// Prices and Shopify variants
// ---------------------------------------------------------------------------

/** A product variant as Liquid's `{{ product.variants | json }}` gives it (price in cents). */
export interface ShopVariant {
  id: number | string;
  title?: string;
  options?: string[];
  price?: number;
  available?: boolean;
}

/** The variants from JSON text or an array, checked. */
export function parseVariants(raw: unknown): ShopVariant[] {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(o)) return [];
  return o.filter((v): v is ShopVariant => !!v && typeof v === 'object' && (typeof v.id === 'number' || typeof v.id === 'string'));
}

/** Option values compared loosely: case, diacritics, spaces and "10 × 15" vs "10x15" don't matter. */
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').replace(/(\d)[×*](\d)/g, '$1x$2');

/** The Shopify variant a size maps to: by its `variant` id, else by its `options` values; undefined if none. */
export function findVariant(size: SizePreset, variants: ShopVariant[]): ShopVariant | undefined {
  if (size.variant != null) return variants.find((v) => String(v.id) === String(size.variant)) ?? { id: size.variant };
  if (!size.options?.length) return undefined;
  const want = size.options.map(norm);
  return variants.find((v) => { const have = (v.options ?? []).map(norm); return want.every((w) => have.includes(w)); });
}

/** The price shown for a size: its Shopify variant's (cents → units) when known, else the preset's. */
export function sizePrice(size: SizePreset, variants: ShopVariant[]): number | undefined {
  const v = findVariant(size, variants);
  return typeof v?.price === 'number' ? v.price / 100 : size.price;
}

/** "79 lei", "129,50 lei" (Romanian decimals) or "129.50 lei". */
export function formatPrice(n: number, lang: Lang, currency: string): string {
  const s = n.toLocaleString(lang === 'ro' ? 'ro-RO' : 'en-GB', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  return currency ? `${s} ${currency}` : s;
}
