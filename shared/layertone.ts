// LayerTone filament painting: a picture printed flat as a thin relief, where the brightness
// of each point comes from how much light filament lies over darker filament. Filaments are
// stacked bottom → top and swapped at set layer heights; thin layers let the ones below show
// through, by each filament's TD (transmission distance: the thickness at which it hides what is
// under it).
//
// CONTRACT (LayerTone). The types and signatures here are shared by the engine (this file,
// shared/helpers.ts H.layertone, shared/runtime.ts), the viewer, the side panel, the 3MF export
// and the server.
import { printer } from './printer';
import type { Quality } from './types';

/** Values key: the pictures for H.layertone, as JSON Record<name, LayerToneImage>. */
export const LAYERTONE_IMAGES_KEY = '$images';
/** Values key: the user's LayerTone setup (filaments, swaps), as JSON LayerToneSetup. Edited in the side panel. */
export const LAYERTONE_KEY = '$layertone';

/** Most filaments in one LayerTone print, at least (beyond what the AMS loads, manual swaps). */
export const MAX_LAYERTONE_FILAMENTS = 8;

/** Most filaments in one LayerTone print: 8, or what the printer loads at once if that is more. */
export function maxLayerToneFilaments(): number {
  return Math.max(MAX_LAYERTONE_FILAMENTS, printer().filaments);
}
/** Longest side of a stored picture, pixels. */
export const MAX_LAYERTONE_IMAGE_SIDE = 800;

export interface LayerToneFilament {
  /** E.g. "PLA Basic Black". */
  name: string;
  /** E.g. "Bambu Lab", "eSUN". */
  brand?: string;
  /** #rrggbb */
  color: string;
  /** Transmission distance, mm (TD). */
  td: number;
}

/** A picture as stored in the design: 8-bit luminance, row by row from the top. */
export interface LayerToneImage {
  name: string;
  width: number;
  height: number;
  /** width × height bytes, base64. */
  luma: string;
}

/** What the user set in the side panel (stored under LAYERTONE_KEY); script options are the fallback. */
export interface LayerToneSetup {
  /** Bottom (first printed, usually darkest) → top. */
  filaments?: LayerToneFilament[];
  /**
   * The layer (0-based, counted from the bed) at which each filament after the first starts:
   * filaments.length - 1 ascending numbers. Missing = automatic (autoSwaps).
   */
  swaps?: number[];
}

/** H.layertone options (sliders in the script); all lengths in mm. */
export interface LayerToneOptions {
  /** Width of the picture; its height follows the picture's proportions. */
  width: number;
  /** Default 0.08. */
  layerHeight?: number;
  /** Default 0.16. */
  firstLayerHeight?: number;
  /** Solid backing under the picture, in the first filament (default 0.48: first layer + 4 layers). */
  baseHeight?: number;
  /** Total height at the brightest points (default 1.6). */
  maxHeight?: number;
  /** Plain frame around the picture at full height, mm (default 0 = none). */
  border?: number;
  /** Dark areas high instead of bright ones (default false). */
  invert?: boolean;
  /** Brightness curve before mapping to heights (default 1; < 1 lifts the shadows). */
  gamma?: number;
  /** Filaments when the user hasn't chosen any (default: black and white). */
  filaments?: LayerToneFilament[];
  /** The script's swap layers (as LayerToneSetup.swaps) when the setup has none; missing = automatic. */
  swaps?: number[];
  /** Grid spacing of the relief, mm (default by quality: draft 0.6, normal 0.35, high 0.2). */
  resolution?: number;
}

/** Where each filament starts: z measured from the bed (the part must stay on the bed, z = 0). */
export interface LayerColor {
  /** Height at which this filament starts, mm (the first one starts at 0). */
  z: number;
  /** First layer index printed in this filament. */
  layer: number;
  color: string;
  td: number;
  name?: string;
  brand?: string;
}

/** What H.layertone returns; a script returns it as a part: { name, ...H.layertone(…) } (shape, layerColors), and its print field becomes the part's print settings. */
export interface LayerTonePart {
  shape: unknown; // Manifold
  layerColors: LayerColor[];
  /** Print settings a LayerTone print needs (layer heights, 100 % infill…). */
  print: { layerHeight: number; firstLayerHeight: number; infill: number; infillPattern?: string; walls?: number; topLayers?: number; bottomLayers?: number };
  /** What the relief was made from, for the side panel's preview (PartMesh.layerTone). */
  layerTone: LayerToneSource;
}

/** The picture (key in LAYERTONE_IMAGES_KEY) and the options a LayerTone part was built with, defaults filled in. */
export interface LayerToneSource {
  image: string;
  options: Required<Omit<LayerToneOptions, 'filaments' | 'swaps'>>;
}

/** The user's loaded black and white, as in the filament library (shared/filaments.ts). */
export const DEFAULT_FILAMENTS: LayerToneFilament[] = [
  { name: 'PLA Basic Black', brand: 'Bambu Lab', color: '#000000', td: 0.2 },
  { name: 'PLA Basic Jade White', brand: 'Bambu Lab', color: '#ffffff', td: 5.9 },
];

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

// Base64 in plain JS: the same code runs in the browser, the geometry worker and the server.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_CODES = Uint8Array.from(B64, (c) => c.charCodeAt(0));
const B64_INDEX = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) t[B64_CODES[i]] = i; return t; })();

export function toBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0, i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64_CODES[n >> 18]; out[o++] = B64_CODES[(n >> 12) & 63]; out[o++] = B64_CODES[(n >> 6) & 63]; out[o++] = B64_CODES[n & 63];
  }
  if (i < bytes.length) {
    const two = i + 1 < bytes.length;
    const n = (bytes[i] << 16) | (two ? bytes[i + 1] << 8 : 0);
    out[o++] = B64_CODES[n >> 18]; out[o++] = B64_CODES[(n >> 12) & 63];
    out[o++] = two ? B64_CODES[(n >> 6) & 63] : 61; out[o++] = 61; // '='
  }
  let s = '';
  for (let k = 0; k < out.length; k += 0x8000) s += String.fromCharCode(...out.subarray(k, k + 0x8000));
  return s;
}

/** Bytes from base64, or null if it isn't valid base64. */
export function fromBase64(s: string): Uint8Array | null {
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--;
  if (s.length - len > 2 || len % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out;
}

/** Area-weighted (box) resampling of a w × h grey image to nw × nh, rows then columns. */
function boxResize(src: Float32Array, w: number, h: number, nw: number, nh: number): Float32Array {
  // For each output index, the source indices it covers and how much of each.
  const spans = (n: number, nn: number) => Array.from({ length: nn }, (_, o) => {
    const a = (o * n) / nn, b = ((o + 1) * n) / nn;
    const idx: number[] = [], wt: number[] = [];
    for (let i = Math.floor(a); i < Math.min(n, Math.ceil(b)); i++) { idx.push(i); wt.push((Math.min(b, i + 1) - Math.max(a, i)) / (b - a)); }
    return { idx, wt };
  });
  const sx = spans(w, nw), sy = spans(h, nh);
  const rows = new Float32Array(nw * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < nw; x++) {
      const { idx, wt } = sx[x];
      let s = 0;
      for (let k = 0; k < idx.length; k++) s += src[y * w + idx[k]] * wt[k];
      rows[y * nw + x] = s;
    }
  }
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const { idx, wt } = sy[y];
    for (let x = 0; x < nw; x++) {
      let s = 0;
      for (let k = 0; k < idx.length; k++) s += rows[idx[k] * nw + x] * wt[k];
      out[y * nw + x] = s;
    }
  }
  return out;
}

/**
 * RGBA pixels (e.g. from a canvas or a decoded PNG/JPEG) → LayerToneImage, scaled down to `maxSide`
 * (MAX_LAYERTONE_IMAGE_SIDE for pictures stored in a design; the lithophane widget's production
 * files use larger ones, which are never stored).
 */
export function toLayerToneImage(name: string, width: number, height: number, rgba: ArrayLike<number>, maxSide = MAX_LAYERTONE_IMAGE_SIDE): LayerToneImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`toLayerToneImage: invalid size ${width}×${height}`);
  if (rgba.length < width * height * 4) throw new Error(`toLayerToneImage: expected ${width * height * 4} RGBA bytes, got ${rgba.length}`);
  // Rec. 709 luma of the sRGB values; transparent pixels count as white paper.
  let lum: Float32Array = new Float32Array(width * height);
  for (let p = 0; p < lum.length; p++) {
    const a = rgba[p * 4 + 3] / 255;
    lum[p] = (0.2126 * rgba[p * 4] + 0.7152 * rgba[p * 4 + 1] + 0.0722 * rgba[p * 4 + 2]) * a + 255 * (1 - a);
  }
  let w = width, h = height;
  const s = Math.max(width, height) / maxSide;
  if (s > 1) {
    w = Math.max(1, Math.min(maxSide, Math.round(width / s)));
    h = Math.max(1, Math.min(maxSide, Math.round(height / s)));
    lum = boxResize(lum, width, height, w, h);
  }
  const bytes = new Uint8Array(w * h);
  for (let p = 0; p < bytes.length; p++) bytes[p] = Math.max(0, Math.min(255, Math.round(lum[p])));
  return { name, width: w, height: h, luma: toBase64(bytes) };
}

const lumaCache = new WeakMap<LayerToneImage, Uint8Array>();
/** The picture's luminance bytes (decoded once per picture object). */
export function layerToneLuma(image: LayerToneImage): Uint8Array {
  let bytes = lumaCache.get(image);
  if (!bytes) {
    const b = fromBase64(image.luma);
    if (!b || b.length !== image.width * image.height) throw new Error(`H.layertone: picture "${image.name}" is damaged`);
    lumaCache.set(image, bytes = b);
  }
  return bytes;
}

/** At most this many pictures per design. */
export const MAX_LAYERTONE_IMAGES = 12;

/** A picture from saved JSON, checked (its bytes are decoded only when used), or null. */
export function cleanLayerToneImage(raw: unknown, name: string): LayerToneImage | null {
  const o = raw as LayerToneImage | null;
  if (!o || typeof o !== 'object' || typeof o.luma !== 'string') return null;
  const { width, height } = o;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_LAYERTONE_IMAGE_SIDE || height > MAX_LAYERTONE_IMAGE_SIDE) return null;
  if (o.luma.length !== Math.ceil((width * height) / 3) * 4) return null;
  return { name, width, height, luma: o.luma };
}

// Pictures are large strings, and a live preview evaluates the same ones on every slider move.
let lastImagesRaw: unknown;
let lastImages: Record<string, LayerToneImage> = {};
/** Pictures from the design's values (name → picture), checked. */
export function parseLayerToneImages(raw: unknown): Record<string, LayerToneImage> {
  if (raw === lastImagesRaw && typeof raw === 'string') return lastImages;
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return {}; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: Record<string, LayerToneImage> = {};
  for (const [name, img] of Object.entries(o).slice(0, MAX_LAYERTONE_IMAGES)) {
    const clean = cleanLayerToneImage(img, name.slice(0, 120));
    if (clean) out[clean.name] = clean;
  }
  if (typeof raw === 'string') { lastImagesRaw = raw; lastImages = out; }
  return out;
}

// ---------------------------------------------------------------------------
// Filaments and setup
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;

/** Filaments from a script or saved JSON, checked (at most maxLayerToneFilaments()), or undefined if none are usable. */
export function cleanFilaments(raw: unknown): LayerToneFilament[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: LayerToneFilament[] = [];
  for (const f of raw.slice(0, maxLayerToneFilaments())) {
    if (!f || typeof f !== 'object' || typeof f.color !== 'string' || !HEX.test(f.color)) continue;
    const td = Number(f.td);
    if (!(td > 0) || !Number.isFinite(td)) continue;
    out.push({
      name: typeof f.name === 'string' && f.name ? f.name.slice(0, 80) : f.color.toLowerCase(),
      ...(typeof f.brand === 'string' && f.brand ? { brand: f.brand.slice(0, 80) } : {}),
      color: f.color.toLowerCase(), td: Math.min(100, Math.max(0.01, td)),
    });
  }
  return out.length ? out : undefined;
}

/** A filament as the stack stores it: name, brand, colour and TD only (no library line or source). */
export const stackFilament = (f: LayerToneFilament): LayerToneFilament => ({ name: f.name, ...(f.brand ? { brand: f.brand } : {}), color: f.color, td: f.td });

/** The stack with filament `i` swapped for `f`, in place: the order (and so the swaps) stay. */
export const replaceFilament = (list: LayerToneFilament[], i: number, f: LayerToneFilament): LayerToneFilament[] => list.map((g, j) => (j === i ? stackFilament(f) : g));

/** The user's setup from the design's values (LAYERTONE_KEY), checked. */
export function parseLayerToneSetup(raw: unknown): LayerToneSetup {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return {}; } }
  if (!o || typeof o !== 'object') return {};
  const s = o as Record<string, unknown>;
  const out: LayerToneSetup = {};
  const filaments = cleanFilaments(s.filaments);
  if (filaments) out.filaments = filaments;
  if (Array.isArray(s.swaps) && s.swaps.length <= maxLayerToneFilaments() && s.swaps.every((n) => Number.isFinite(n))) out.swaps = s.swaps.map((n) => Math.round(n as number));
  return out;
}

/** Swaps that fit `count` filaments (count - 1 ascending layers, the first ≥ 1), or undefined. */
export function checkSwaps(swaps: number[] | undefined, count: number): number[] | undefined {
  if (!swaps || swaps.length !== count - 1) return undefined;
  for (let i = 0; i < swaps.length; i++) if (!Number.isInteger(swaps[i]) || swaps[i] < (i ? swaps[i - 1] + 1 : 1)) return undefined;
  return swaps;
}

// ---------------------------------------------------------------------------
// Options and layers
// ---------------------------------------------------------------------------

/** Options with defaults filled in and the relief's layer range: tops of `nBase` to `nMax` layers. */
export interface LayerToneResolved extends Required<Omit<LayerToneOptions, 'filaments' | 'swaps'>> {
  nBase: number;
  nMax: number;
}

const RESOLUTION: Record<Quality, number> = { draft: 0.6, normal: 0.35, high: 0.2 };

export function resolveLayerToneOptions(o: LayerToneOptions, quality: Quality = 'normal'): LayerToneResolved {
  const num = (v: unknown, def: number, lo: number, hi: number) => { const n = Number(v); return v == null || !Number.isFinite(n) ? def : Math.min(hi, Math.max(lo, n)); };
  const width = Number(o?.width);
  if (!(width > 0) || !Number.isFinite(width)) throw new Error('H.layertone: width must be > 0 (mm)');
  const layerHeight = num(o.layerHeight, 0.08, 0.04, 0.32);
  const firstLayerHeight = num(o.firstLayerHeight, 0.16, 0.04, 0.4);
  const count = (h: number) => (h <= firstLayerHeight + 1e-9 ? 1 : 1 + Math.round((h - firstLayerHeight) / layerHeight));
  const baseHeight = num(o.baseHeight, 0.48, firstLayerHeight, 20);
  const nBase = count(baseHeight);
  const nMax = Math.max(nBase + 1, count(num(o.maxHeight, 1.6, 0, 50)));
  const top = (n: number) => firstLayerHeight + (n - 1) * layerHeight;
  return {
    width, layerHeight, firstLayerHeight, baseHeight: top(nBase), maxHeight: top(nMax),
    border: num(o.border, 0, 0, width), invert: !!o.invert, gamma: num(o.gamma, 1, 0.1, 10),
    resolution: num(o.resolution, RESOLUTION[quality] ?? RESOLUTION.normal, 0.05, 10), nBase, nMax,
  };
}

/** Height of the top of `n` layers, mm. */
export function layerTop(n: number, r: { layerHeight: number; firstLayerHeight: number }): number {
  return n <= 0 ? 0 : r.firstLayerHeight + (n - 1) * r.layerHeight;
}

/** The filament stack: where each filament starts (swaps: the layer each one after the first starts at). */
export function stackLayers(filaments: LayerToneFilament[], swaps: number[], r: { layerHeight: number; firstLayerHeight: number }): LayerColor[] {
  return filaments.map((f, i) => {
    const layer = i ? swaps[i - 1] : 0;
    return { z: layerTop(layer, r), layer, color: f.color, td: f.td, name: f.name, ...(f.brand ? { brand: f.brand } : {}) };
  });
}

/**
 * The stack for a picture: filaments from the user's setup, else the script's, else black and
 * white; the user's swaps if they fit, else autoSwaps.
 */
export function layerToneLayers(image: LayerToneImage, o: LayerToneOptions, setup: LayerToneSetup = {}, quality: Quality = 'normal'): LayerColor[] {
  const r = resolveLayerToneOptions(o, quality);
  const filaments = setup.filaments ?? cleanFilaments(o.filaments) ?? DEFAULT_FILAMENTS;
  return stackLayers(filaments, checkSwaps(setup.swaps, filaments.length) ?? checkSwaps(o.swaps, filaments.length) ?? autoSwaps(image, filaments, o), r);
}

/** Layer colours returned by a script, checked, sorted and scaled by the runtime's uniform scale; undefined if unusable. */
export function cleanLayerColors(raw: unknown, scale = 1): LayerColor[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: LayerColor[] = [];
  for (const l of raw.slice(0, maxLayerToneFilaments())) {
    if (!l || typeof l !== 'object') continue;
    const z = Number(l.z), td = Number(l.td), layer = Number(l.layer);
    if (!(z >= 0) || !Number.isFinite(z) || !(td > 0) || !Number.isFinite(td) || !Number.isInteger(layer) || layer < 0 || typeof l.color !== 'string' || !HEX.test(l.color)) continue;
    out.push({
      z: z * scale, layer, color: l.color.toLowerCase(), td,
      ...(typeof l.name === 'string' ? { name: l.name.slice(0, 80) } : {}),
      ...(typeof l.brand === 'string' ? { brand: l.brand.slice(0, 80) } : {}),
    });
  }
  out.sort((a, b) => a.z - b.z);
  return out.length ? out : undefined;
}

/** A part's LayerTone source returned by a script, checked and scaled by the runtime's uniform scale; undefined if unusable. */
export function cleanLayerToneSource(raw: unknown, scale = 1): LayerToneSource | undefined {
  const o = raw as LayerToneSource | null;
  if (!o || typeof o !== 'object' || typeof o.image !== 'string' || !o.options || typeof o.options !== 'object') return undefined;
  const n = (k: keyof LayerToneSource['options']) => Number(o.options[k]);
  const lengths = (['width', 'layerHeight', 'firstLayerHeight', 'baseHeight', 'maxHeight', 'border', 'resolution'] as const).map(n);
  if (!lengths.every((v) => v >= 0 && Number.isFinite(v)) || !(lengths[0] > 0) || !(n('gamma') > 0)) return undefined;
  const [width, layerHeight, firstLayerHeight, baseHeight, maxHeight, border, resolution] = lengths.map((v) => v * scale);
  return {
    image: o.image.slice(0, 120),
    options: { width, layerHeight, firstLayerHeight, baseHeight, maxHeight, border, resolution, invert: !!o.options.invert, gamma: n('gamma') },
  };
}

// ---------------------------------------------------------------------------
// Colour model
// ---------------------------------------------------------------------------
//
// Each filament is a filter over what lies below it. Light through it falls off exponentially with
// thickness (Beer–Lambert), so its coverage of the colour beneath is 1 - e^(-k·t/TD). The
// published TD of a filament is the thickness beyond which more filament no longer visibly changes the colour (not where
// light stops entirely), taken here as letting 5 % through: k = 3. Exponential coverage composes
// exactly (two 0.1 mm layers look like one 0.2 mm layer), unlike a linear min(1, t/TD), and gives
// the strong change of the first layers and the slow saturation seen on real prints. Colours mix
// in linear light, as light does, and the first filament (the base) is taken as opaque.

const TD_ABSORB = 3;
/** How much of a filament's own colour shows through `t` mm of it (0–1). */
const coverage = (t: number, td: number) => (t > 1e-6 ? 1 - Math.exp((-TD_ABSORB * t) / td) : 0);

/** #rrggbb → sRGB 0–1 (grey for anything else). */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
/** Rec. 709 luma of sRGB 0–1 values (as toLayerToneImage measures the picture). */
export const luma = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** The colour a point looks when the print's top there is at `z` (mm), as sRGB 0–1. `layers` ascending by z. */
export function simulateRgb(z: number, layers: LayerColor[]): [number, number, number] {
  if (!layers.length) return [0.5, 0.5, 0.5];
  const c = hexToRgb(layers[0].color).map(toLinear);
  for (let i = 1; i < layers.length; i++) {
    const a = coverage(Math.min(z, i + 1 < layers.length ? layers[i + 1].z : Infinity) - layers[i].z, layers[i].td);
    if (!a) continue;
    const f = hexToRgb(layers[i].color);
    for (let k = 0; k < 3; k++) c[k] = c[k] * (1 - a) + toLinear(f[k]) * a;
  }
  return [toSrgb(c[0]), toSrgb(c[1]), toSrgb(c[2])];
}

/** The colour a point looks when the print's top there is at height `z` (mm), #rrggbb. */
export function simulateColor(z: number, layers: LayerColor[]): string {
  return `#${simulateRgb(z, layers).map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** RGB 0–1 (sRGB) per vertex from each vertex's height, for PartMesh.vertexColors. */
export function vertexColors(positions: Float32Array, layers: LayerColor[]): Float32Array {
  const out = new Float32Array(positions.length);
  // A relief has few distinct heights.
  const cache = new Map<number, [number, number, number]>();
  for (let v = 0; v < positions.length; v += 3) {
    const z = positions[v + 2];
    let c = cache.get(z);
    if (!c) cache.set(z, c = simulateRgb(z, layers));
    out[v] = c[0]; out[v + 1] = c[1]; out[v + 2] = c[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------

/** Levels of the brightness → layers table (finer than the picture's 256 as averaged pixels fall between). */
const LEVELS = 1024;

/** The picture's tone at brightness v (0–1) after the gamma curve and invert. */
const tone = (v: number, r: LayerToneResolved) => { const g = v ** r.gamma; return r.invert ? 1 - g : g; };

/**
 * Brightness → layer count. Every possible top (nBase…nMax layers) is simulated with the stack;
 * the picture's tones are spread over the darkest…brightest of those, and each tone gets the layer
 * count that looks closest to it (the lowest one on a tie). That keeps the print faithful whatever
 * the filaments and their order are, e.g. a light-first stack puts the dark areas high on its own.
 */
function heightTable(layers: LayerColor[], r: LayerToneResolved, levels = LEVELS): { counts: Uint16Array; sim: Float64Array } {
  const sim = new Float64Array(r.nMax + 1);
  let lo = Infinity, hi = -Infinity;
  for (let n = r.nBase; n <= r.nMax; n++) {
    sim[n] = luma(simulateRgb(layerTop(n, r), layers));
    lo = Math.min(lo, sim[n]); hi = Math.max(hi, sim[n]);
  }
  const counts = new Uint16Array(levels);
  for (let q = 0; q < levels; q++) {
    const goal = lo + tone(q / (levels - 1), r) * (hi - lo);
    let best = r.nBase, bestD = Infinity;
    for (let n = r.nBase; n <= r.nMax; n++) {
      const d = Math.abs(sim[n] - goal);
      if (d < bestD - 1e-12) { bestD = d; best = n; }
    }
    counts[q] = best;
  }
  return { counts, sim };
}

/**
 * Automatic swap layers for the picture and filaments (see LayerToneSetup.swaps).
 *
 * The swaps are scored on the picture's 256-bin brightness histogram, with every tone getting its
 * layer count as in the real print (heightTable):
 * - faithfulness: the mean difference between each pixel's tone and the brightness it prints at;
 * - a useful share for every filament: each one after the first should show in at least half of
 *   an even split of the pixels (counting each pixel it tops by how much of its colour shows
 *   there, its coverage), else the shortfall counts against the swaps. Brightness alone would
 *   squeeze the middle colours to a single, barely visible layer (white over black makes every
 *   grey), while someone who loads blue and yellow wants to see them.
 * Starting from swaps spread evenly over the relief, each swap in turn moves to its best layer
 * between its neighbours until nothing improves. Swaps stay inside the relief (nBase … nMax - 1),
 * where their filament shows.
 */
export function autoSwaps(image: LayerToneImage, filaments: LayerToneFilament[], o: LayerToneOptions): number[] {
  const k = filaments.length - 1;
  if (k <= 0) return [];
  const r = resolveLayerToneOptions(o);
  const lo = r.nBase, hi = r.nMax - 1;
  const span = hi - lo + 1;
  // More filaments than layers: one layer each, the last ones above the relief (unused).
  if (span <= k) return Array.from({ length: k }, (_, i) => lo + i);
  const hist = new Float64Array(256);
  for (const b of layerToneLuma(image)) hist[b]++;
  const total = image.width * image.height;
  const target = Float64Array.from({ length: 256 }, (_, b) => tone(b / 255, r));
  const minShare = 1 / (2 * k);
  const share = new Float64Array(k + 1);
  const cost = (sw: number[]) => {
    const layers = stackLayers(filaments, sw, r);
    const { counts, sim } = heightTable(layers, r, 256);
    let e = 0;
    share.fill(0);
    for (let b = 0; b < 256; b++) {
      if (!hist[b]) continue;
      e += hist[b] * Math.abs(target[b] - sim[counts[b]]);
      // The top filament at this tone (the last one starting below its top layer) and how much it shows.
      let f = 0;
      while (f < k && sw[f] < counts[b]) f++;
      share[f] += hist[b] * coverage(layerTop(counts[b], r) - layers[f].z, layers[f].td);
    }
    let shortfall = 0;
    for (let f = 1; f <= k; f++) shortfall += Math.max(0, minShare - share[f] / total);
    return e / total + shortfall;
  };
  const swaps = Array.from({ length: k }, (_, i) => lo + Math.floor((i * span) / k));
  let best = cost(swaps);
  for (let round = 0; round < 12; round++) {
    let improved = false;
    for (let i = 0; i < k; i++) {
      const from = i ? swaps[i - 1] + 1 : lo, to = i < k - 1 ? swaps[i + 1] - 1 : hi;
      const keep = swaps[i];
      let at = keep;
      for (let s = from; s <= to; s++) {
        if (s === keep) continue;
        swaps[i] = s;
        const c = cost(swaps);
        if (c < best - 1e-9) { best = c; at = s; improved = true; }
      }
      swaps[i] = at;
    }
    if (!improved) break;
  }
  return swaps;
}

/**
 * The picture's brightness (0–255) at pixel coordinates (px, py), for a grid whose cells are
 * `cellPx` pixels wide: averaged over the cell (box filter, from a summed-area table) when it spans
 * several pixels, bilinear otherwise.
 */
export function pictureSampler(image: LayerToneImage, cellPx: number): (px: number, py: number) => number {
  const lum = layerToneLuma(image);
  const iw = image.width, ih = image.height;
  let sat: Float64Array | null = null;
  if (cellPx >= 1.5) {
    sat = new Float64Array((iw + 1) * (ih + 1));
    for (let y = 0; y < ih; y++) {
      let row = 0;
      for (let x = 0; x < iw; x++) { row += lum[y * iw + x]; sat[(y + 1) * (iw + 1) + x + 1] = sat[y * (iw + 1) + x + 1] + row; }
    }
  }
  return (px, py) => {
    if (sat) {
      const half = cellPx / 2;
      let x0 = Math.max(0, Math.round(px - half)), x1 = Math.min(iw, Math.round(px + half));
      let y0 = Math.max(0, Math.round(py - half)), y1 = Math.min(ih, Math.round(py + half));
      if (x1 <= x0) { x0 = Math.min(x0, iw - 1); x1 = x0 + 1; }
      if (y1 <= y0) { y0 = Math.min(y0, ih - 1); y1 = y0 + 1; }
      const S = iw + 1;
      return (sat[y1 * S + x1] - sat[y0 * S + x1] - sat[y1 * S + x0] + sat[y0 * S + x0]) / ((x1 - x0) * (y1 - y0));
    }
    const fx = Math.max(0, Math.min(iw - 1, px - 0.5)), fy = Math.max(0, Math.min(ih - 1, py - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(iw - 1, x0 + 1), y1 = Math.min(ih - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const a = lum[y0 * iw + x0] + (lum[y0 * iw + x1] - lum[y0 * iw + x0]) * tx;
    const b = lum[y1 * iw + x0] + (lum[y1 * iw + x1] - lum[y1 * iw + x0]) * tx;
    return a + (b - a) * ty;
  };
}

/** The most grid points in one relief (the resolution is coarsened past it). */
export const MAX_LAYERTONE_POINTS = 1_500_000;

/**
 * The relief as a closed triangle mesh (top surface, walls, flat bottom at z = 0, centred on XY),
 * vertices shared, outward-facing: ready for a Manifold Mesh.
 */
export function layerToneMesh(image: LayerToneImage, layers: LayerColor[], r: LayerToneResolved): { vertProperties: Float32Array; triVerts: Uint32Array } {
  const { counts } = heightTable(layers, r);
  const W = r.width, Hh = (W * image.height) / image.width, B = r.border;
  const iw = image.width, ih = image.height;
  let res = Math.max(r.resolution, W / iw / 2); // finer than half a pixel adds nothing
  const points = (W / res + 1) * (Hh / res + 1);
  if (points > MAX_LAYERTONE_POINTS) res *= Math.sqrt(points / MAX_LAYERTONE_POINTS);
  const nx = Math.max(1, Math.round(W / res)), ny = Math.max(1, Math.round(Hh / res));
  // Grid lines: the picture's, plus the frame's outer edge and one just outside the picture, so
  // the frame rises steeply at the picture's edge.
  const axis = (size: number, n: number) => {
    const pic = Array.from({ length: n + 1 }, (_, i) => (i / n - 0.5) * size);
    if (!(B > 0)) return pic;
    const e = Math.min(0.05, B / 2);
    return [-(size / 2 + B), -(size / 2 + e), ...pic, size / 2 + e, size / 2 + B];
  };
  const xs = axis(W, nx), ys = axis(Hh, ny);
  const NX = xs.length, NY = ys.length, NT = NX * NY;

  const sample = pictureSampler(image, (res * iw) / W);

  const tops = Float32Array.from({ length: r.nMax + 1 }, (_, n) => layerTop(n, r));
  const verts = new Float32Array((NT + 2 * (NX + NY) - 3) * 3);
  for (let j = 0; j < NY; j++) {
    const y = ys[j];
    const py = ((Hh / 2 - y) / Hh) * ih; // image rows run from the top
    const frameRow = Math.abs(y) > Hh / 2 + 1e-9;
    for (let i = 0; i < NX; i++) {
      const x = xs[i];
      let n = r.nMax;
      if (!frameRow && Math.abs(x) <= W / 2 + 1e-9) n = counts[Math.round((sample(((x + W / 2) / W) * iw, py) / 255) * (LEVELS - 1))];
      const v = (j * NX + i) * 3;
      verts[v] = x; verts[v + 1] = y; verts[v + 2] = tops[n];
    }
  }

  // The top's outline, counter-clockwise seen from above.
  const ring: number[] = [];
  for (let i = 0; i < NX - 1; i++) ring.push(i);
  for (let j = 0; j < NY - 1; j++) ring.push(j * NX + NX - 1);
  for (let i = NX - 1; i > 0; i--) ring.push((NY - 1) * NX + i);
  for (let j = NY - 1; j > 0; j--) ring.push(j * NX);
  const R = ring.length;
  // Bottom: the outline at z = 0 and a centre point to fan from.
  ring.forEach((t, k) => { verts[(NT + k) * 3] = verts[t * 3]; verts[(NT + k) * 3 + 1] = verts[t * 3 + 1]; });
  const centre = NT + R; // already (0, 0, 0)

  const tris = new Uint32Array(((NX - 1) * (NY - 1) * 2 + R * 3) * 3);
  let t = 0;
  for (let j = 0; j < NY - 1; j++) {
    for (let i = 0; i < NX - 1; i++) {
      const a = j * NX + i, b = a + 1, c = a + NX + 1, d = a + NX;
      // Split each cell along the diagonal with the smaller height change, so edges follow the relief.
      if (Math.abs(verts[a * 3 + 2] - verts[c * 3 + 2]) <= Math.abs(verts[b * 3 + 2] - verts[d * 3 + 2])) {
        tris[t++] = a; tris[t++] = b; tris[t++] = c; tris[t++] = a; tris[t++] = c; tris[t++] = d;
      } else {
        tris[t++] = a; tris[t++] = b; tris[t++] = d; tris[t++] = b; tris[t++] = c; tris[t++] = d;
      }
    }
  }
  for (let k = 0; k < R; k++) {
    const k2 = (k + 1) % R;
    const a = ring[k], b = ring[k2], a0 = NT + k, b0 = NT + k2;
    tris[t++] = a0; tris[t++] = b0; tris[t++] = b;
    tris[t++] = a0; tris[t++] = b; tris[t++] = a;
    tris[t++] = centre; tris[t++] = b0; tris[t++] = a0;
  }
  return { vertProperties: verts, triVerts: tris };
}

/** The whole print as it will look, as RGBA pixels (for the side panel's preview and Claude). */
export function simulateImage(image: LayerToneImage, layers: LayerColor[], o: LayerToneOptions): { width: number; height: number; rgba: Uint8ClampedArray } {
  const r = resolveLayerToneOptions(o);
  const lum = layerToneLuma(image);
  const { counts } = heightTable(layers, r);
  const rgbOf = (n: number) => simulateRgb(layerTop(n, r), layers).map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255));
  const byCount = new Map<number, number[]>();
  const colour = (n: number) => { let c = byCount.get(n); if (!c) byCount.set(n, c = rgbOf(n)); return c; };
  const bp = Math.round((r.border / r.width) * image.width);
  const width = image.width + 2 * bp, height = image.height + 2 * bp;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ix = x - bp, iy = y - bp;
      const inside = ix >= 0 && iy >= 0 && ix < image.width && iy < image.height;
      const c = colour(inside ? counts[Math.round((lum[iy * image.width + ix] / 255) * (LEVELS - 1))] : r.nMax);
      const p = (y * width + x) * 4;
      rgba[p] = c[0]; rgba[p + 1] = c[1]; rgba[p + 2] = c[2]; rgba[p + 3] = 255;
    }
  }
  return { width, height, rgba };
}
