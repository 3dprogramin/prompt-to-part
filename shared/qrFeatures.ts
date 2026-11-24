// QR codes placed with the UI's QR code tool: a white tile (the quiet zone) and the black modules,
// each its own part next to the part they sit on, so they print in their own filaments. Placed on
// the surface like text-tool text: a face or a picked point, flat or wrapped.
import type { CrossSection, Manifold } from 'manifold-3d';
import { encode } from 'uqr';
import { SINK, surfacePlacer, type SurfacePlacement } from './textFeatures';
import type { Vec2 } from './types';

export const QR_KEY = '$qr';

export type QrEcc = 'L' | 'M' | 'Q' | 'H';
export type WifiSecurity = 'WPA' | 'WEP' | 'nopass';
export interface WifiContent { ssid: string; password: string; security: WifiSecurity; hidden: boolean }

export interface QrFeature extends SurfacePlacement {
  /** Its part's name (the tile is "<name> tile"): kept, so a filament picked for it stays. */
  name: string;
  /** What it holds: the text (a link mostly) or a Wi-Fi network; both are kept while switching. */
  kind: 'text' | 'wifi';
  text: string;
  wifi: WifiContent;
  /** Error correction: L 7 %, M 15 %, Q 25 %, H 30 % of the code can be lost and still read. */
  ecc: QrEcc;
  /** Side of the whole code, quiet zone included, mm. */
  size: number;
  /** The quiet zone round the modules, in modules (4 is the standard, phones read 2). */
  border: number;
  /** A white tile under the code; off: the model's surface is the white. */
  tile: boolean;
  /** How far the tile stands out of the surface, mm. */
  tileHeight: number;
  /** Raised: the modules stand on the tile (or surface) by `depth`; flush: they are inlaid `depth` deep, level with it. */
  style: 'raised' | 'flush';
}

export const QR_COLORS = { code: '#000000', tile: '#ffffff' } as const;
/** Modules smaller than this (mm) are hard to print sharply with a 0.4 mm nozzle. */
export const MIN_MODULE = 1;

export function newQrFeature(id: string, partial: Partial<QrFeature> = {}): QrFeature {
  return {
    id, enabled: true, name: 'QR code', kind: 'text', text: '', wifi: { ssid: '', password: '', security: 'WPA', hidden: false },
    ecc: 'M', size: 30, border: 2, tile: true, tileHeight: 1, style: 'raised', depth: 0.6, mode: 'emboss',
    face: 'top', anchor: [0.5, 0.5, 1], normal: [0, 0, 1], offset: [0, 0], rotation: 0, curve: 'none', wrapRadius: 0, ...partial,
  };
}

const num = (v: unknown, def: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);
const vec = <T extends number[]>(v: unknown, def: T): T => (Array.isArray(v) && v.length === def.length && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as T) : def);

/** Saved QR codes, checked: unknown values fall back to the defaults, numbers stay in range. */
export function parseQrFeatures(raw: unknown): QrFeature[] {
  if (typeof raw !== 'string' || !raw) return [];
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((o) => {
    if (!o || typeof o !== 'object') return [];
    const f = o as Record<string, any>;
    if (f.text != null && typeof f.text !== 'string') return [];
    const d = newQrFeature(String(f.id ?? ''));
    const w = (f.wifi && typeof f.wifi === 'object' ? f.wifi : {}) as Record<string, unknown>;
    return [{
      ...d,
      enabled: f.enabled !== false,
      name: typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 60) : d.name,
      kind: f.kind === 'wifi' ? 'wifi' : 'text',
      text: typeof f.text === 'string' ? f.text.slice(0, 4000) : '',
      wifi: {
        ssid: typeof w.ssid === 'string' ? w.ssid.slice(0, 64) : '', password: typeof w.password === 'string' ? w.password.slice(0, 128) : '',
        security: w.security === 'WEP' || w.security === 'nopass' ? w.security : 'WPA', hidden: w.hidden === true,
      },
      ecc: (['L', 'M', 'Q', 'H'] as const).includes(f.ecc) ? f.ecc : d.ecc,
      size: num(f.size, d.size, 5, 300), border: Math.round(num(f.border, d.border, 0, 4)),
      tile: f.tile !== false, tileHeight: num(f.tileHeight, d.tileHeight, 0.2, 10),
      style: f.style === 'flush' ? 'flush' : 'raised', depth: num(f.depth, d.depth, 0.2, 10),
      face: (['top', 'bottom', 'front', 'back', 'left', 'right', 'pick'] as const).includes(f.face) ? f.face : d.face,
      part: typeof f.part === 'string' ? f.part : undefined,
      anchor: vec(f.anchor, d.anchor), normal: vec(f.normal, d.normal), offset: vec(f.offset, d.offset),
      rotation: num(f.rotation, 0, -360, 360), curve: f.curve === 'wrap' ? 'wrap' : 'none', wrapRadius: num(f.wrapRadius, 0, 0, 1000),
    } satisfies QrFeature];
  });
}

/** Backslash before the characters the WIFI: format reserves. */
const wifiEscape = (s: string) => s.replace(/([\\;,:"])/g, '\\$1');

/** What the code holds: the trimmed text, or the standard WIFI: string; '' when there is nothing to encode. */
export function qrPayload(f: Pick<QrFeature, 'kind' | 'text' | 'wifi'>): string {
  if (f.kind !== 'wifi') return f.text.trim();
  const { ssid, password, security, hidden } = f.wifi;
  if (!ssid.trim()) return '';
  return `WIFI:T:${security};S:${wifiEscape(ssid)};${security !== 'nopass' ? `P:${wifiEscape(password)};` : ''}${hidden ? 'H:true;' : ''};`;
}

const matrices = new Map<string, boolean[][] | null>();
/** The modules (rows top to bottom, true = black), without the quiet zone; null when the payload doesn't fit a QR code. */
export function qrMatrix(payload: string, ecc: QrEcc): boolean[][] | null {
  const key = `${ecc}\n${payload}`;
  if (matrices.has(key)) return matrices.get(key)!;
  let m: boolean[][] | null;
  try { m = encode(payload, { ecc, border: 0 }).data; } catch { m = null; }
  matrices.set(key, m);
  if (matrices.size > 32) matrices.delete(matrices.keys().next().value!);
  return m;
}

/**
 * The tile (`size` square) and the modules as flat shapes, centred on (0, 0) with y up, and the
 * side of one module (mm). Modules grow by 1 % of a module so diagonal neighbours overlap and the
 * black stays one clean solid.
 */
export function qrSections(matrix: boolean[][], f: Pick<QrFeature, 'size' | 'border'>, C: typeof CrossSection): { tile: CrossSection; code: CrossSection; module: number } {
  const n = matrix.length;
  const m = f.size / (n + 2 * f.border);
  const e = m * 0.01;
  const rects: Vec2[][] = [];
  matrix.forEach((row, r) => {
    for (let c = 0; c < n; c++) {
      if (!row[c]) continue;
      const c0 = c;
      while (c + 1 < n && row[c + 1]) c++;
      const x0 = (c0 - n / 2) * m - e, x1 = (c + 1 - n / 2) * m + e, y0 = (n / 2 - r - 1) * m - e, y1 = (n / 2 - r) * m + e;
      rects.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    }
  });
  return { tile: C.square([f.size, f.size], true), code: new C(rects, 'NonZero'), module: m };
}

export interface QrPart { id: string; role: 'code' | 'tile'; name: string; color: string; shape: Manifold }

/**
 * The QR codes on one part: the part (with pockets when a flush code has no tile under it), the
 * tiles and modules as solids of their own that only touch it, and what went wrong. `base` is the
 * part's box before any text, SVG or QR code (picked points are measured against it).
 */
export function applyQrFeatures(host: Manifold, features: QrFeature[], C: typeof CrossSection, base = host.boundingBox()): { host: Manifold; parts: QrPart[]; warnings: string[] } {
  const parts: QrPart[] = [];
  const warnings: string[] = [];
  let out = host;
  for (const f of features) {
    const payload = f.enabled ? qrPayload(f) : '';
    if (!payload || !(f.size > 0) || !(f.depth > 0)) continue;
    const matrix = qrMatrix(payload, f.ecc);
    if (!matrix) { warnings.push(`QR code "${f.name}": the content is too long for a QR code with error correction ${f.ecc}; shorten it or pick a lower error correction.`); continue; }
    const { tile, code } = qrSections(matrix, f, C);
    const place = surfacePlacer(out, base, f);
    const tileOn = f.tile && f.tileHeight > 0;
    const tH = tileOn ? f.tileHeight : 0;
    let tileSolid = tileOn ? place(tile.extrude(tH + SINK).translate([0, 0, -SINK])).subtract(out) : null;
    let codeSolid: Manifold;
    if (f.style === 'flush') {
      codeSolid = place(code.extrude(f.depth).translate([0, 0, tH - f.depth]));
      if (tileSolid) tileSolid = tileSolid.subtract(codeSolid);
      if (!tileOn || f.depth > tH) out = out.subtract(codeSolid);
    } else {
      codeSolid = place(code.extrude(f.depth + (tileOn ? 0 : SINK)).translate([0, 0, tileOn ? tH : -SINK]));
      if (!tileOn) codeSolid = codeSolid.subtract(out);
    }
    if (tileSolid && !tileSolid.isEmpty()) parts.push({ id: f.id, role: 'tile', name: `${f.name} tile`, color: QR_COLORS.tile, shape: tileSolid });
    if (!codeSolid.isEmpty()) parts.push({ id: f.id, role: 'code', name: f.name, color: QR_COLORS.code, shape: codeSolid });
  }
  return { host: out, parts, warnings };
}
