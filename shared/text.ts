// Font registry + text-to-polygon layout. Works in the browser worker and in Node.
// Fonts load asynchronously; evaluation is synchronous, so a missing font throws
// FontMissingError and the caller loads it and retries.
import opentype from 'opentype.js';
import type { Vec2 } from './types';

export const DEFAULT_FONT = 'std:roboto-700';

export class FontMissingError extends Error {
  constructor(public fontId: string) {
    super(`Font "${fontId}" is not loaded yet`);
  }
}

/** A font may be split into several subset files (e.g. latin + latin-ext); glyph lookup falls through them. */
interface LoadedFont { faces: opentype.Font[] }

const fonts = new Map<string, LoadedFont>();
const failed = new Map<string, string>();

export function registerFont(id: string, buffers: ArrayBuffer[]) {
  fonts.set(id, { faces: buffers.map((b) => opentype.parse(b)) });
}
export function markFontFailed(id: string, reason: string) { failed.set(id, reason); }
export function hasFont(id: string) { return fonts.has(id) || failed.has(id); }

function getFont(id: string | undefined): LoadedFont {
  const key = id || DEFAULT_FONT;
  const f = fonts.get(key);
  if (f) return f;
  if (failed.has(key)) {
    if (key !== DEFAULT_FONT) return getFont(DEFAULT_FONT);
    throw new Error(`Default font failed to load: ${failed.get(key)}`);
  }
  throw new FontMissingError(key);
}

export interface TextLayoutOptions {
  /** Height of capital letters in mm. */
  size?: number;
  font?: string;
  /** Extra space between letters, in mm. */
  letterSpacing?: number;
  /** Line spacing as a multiple of size. */
  lineHeight?: number;
  halign?: 'left' | 'center' | 'right';
  valign?: 'baseline' | 'bottom' | 'center' | 'top';
  /**
   * Bend the text along a circular arc of this radius (mm). Positive: letters stand on the
   * outside of the circle (text arches up, like a badge top). Negative: inside (smiles down).
   */
  arcRadius?: number;
  /** Curve flattening tolerance in mm. */
  tolerance?: number;
}

const flattenQuad = (p0: Vec2, p1: Vec2, p2: Vec2, n: number, out: Vec2[]) => {
  for (let i = 1; i <= n; i++) {
    const t = i / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]]);
  }
};
const flattenCubic = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, n: number, out: Vec2[]) => {
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
};
const segs = (len: number, tol: number) => Math.max(2, Math.min(24, Math.ceil(Math.sqrt(len / Math.max(tol, 1e-3)))));

/** Contours of one glyph path, flipped to Y-up (opentype paths are Y-down). */
function pathToContours(path: opentype.Path, tol: number): Vec2[][] {
  const contours: Vec2[][] = [];
  let cur: Vec2[] = [];
  let last: Vec2 = [0, 0];
  const close = () => { if (cur.length >= 3) contours.push(cur); cur = []; };
  for (const c of path.commands) {
    if (c.type === 'M') { close(); last = [c.x, -c.y]; cur.push(last); }
    else if (c.type === 'L') { last = [c.x, -c.y]; cur.push(last); }
    else if (c.type === 'Q') {
      const p1: Vec2 = [c.x1, -c.y1], p2: Vec2 = [c.x, -c.y];
      flattenQuad(last, p1, p2, segs(Math.hypot(p2[0] - last[0], p2[1] - last[1]), tol), cur);
      last = p2;
    } else if (c.type === 'C') {
      const p1: Vec2 = [c.x1, -c.y1], p2: Vec2 = [c.x2, -c.y2], p3: Vec2 = [c.x, -c.y];
      flattenCubic(last, p1, p2, p3, segs(Math.hypot(p3[0] - last[0], p3[1] - last[1]), tol), cur);
      last = p3;
    } else if (c.type === 'Z') close();
  }
  close();
  // drop duplicated closing point
  for (const ct of contours) {
    const a = ct[0], b = ct[ct.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) ct.pop();
  }
  return contours;
}

function findGlyph(font: LoadedFont, ch: string): { face: opentype.Font; glyph: opentype.Glyph } {
  for (const face of font.faces) {
    const g = face.charToGlyph(ch);
    if (g && g.index !== 0) return { face, glyph: g };
  }
  return { face: font.faces[0], glyph: font.faces[0].charToGlyph(ch) };
}

/**
 * Lays out text and returns closed contours (Y up, mm). Holes come back with opposite winding,
 * so build the CrossSection with fill rule 'NonZero'.
 */
export function layoutText(text: string, opts: TextLayoutOptions = {}): Vec2[][] {
  const font = getFont(opts.font);
  const primary = font.faces[0];
  const capUnits = primary.tables.os2?.sCapHeight || primary.ascender * 0.7;
  const size = opts.size ?? 8;
  const fontSize = (size * primary.unitsPerEm) / capUnits; // em size that gives the requested cap height
  const tol = opts.tolerance ?? 0.02;
  const spacing = opts.letterSpacing ?? 0;
  const lineH = (opts.lineHeight ?? 1.5) * size;
  const lines = String(text).split('\n');

  // Lay out each line: glyph contours at their pen position.
  type Placed = { contours: Vec2[][]; x0: number; x1: number };
  const laidLines: { glyphs: Placed[]; width: number }[] = lines.map((line) => {
    let x = 0;
    const glyphs: Placed[] = [];
    let prev: { face: opentype.Font; glyph: opentype.Glyph } | null = null;
    for (const ch of Array.from(line)) {
      const g = findGlyph(font, ch);
      if (prev && prev.face === g.face) {
        try { x += (g.face.getKerningValue(prev.glyph, g.glyph) * fontSize) / g.face.unitsPerEm; } catch { /* unsupported kerning table */ }
      }
      const scale = fontSize / g.face.unitsPerEm;
      const adv = (g.glyph.advanceWidth ?? g.face.unitsPerEm * 0.5) * scale;
      const contours = pathToContours(g.glyph.getPath(x, 0, fontSize), tol);
      glyphs.push({ contours, x0: x, x1: x + adv });
      x += adv + spacing;
      prev = g;
    }
    return { glyphs, width: Math.max(0, x - spacing) };
  });

  const halign = opts.halign ?? 'center';
  const out: Vec2[][] = [];
  laidLines.forEach((line, li) => {
    const dx = halign === 'left' ? 0 : halign === 'right' ? -line.width : -line.width / 2;
    const dy = -li * lineH;
    for (const g of line.glyphs) for (const c of g.contours) out.push(c.map(([x, y]) => [x + dx, y + dy] as Vec2));
  });

  // Vertical alignment of the block: first baseline at y=0, cap top at y=size.
  const n = lines.length;
  const valign = opts.valign ?? 'center';
  const vy = valign === 'baseline' ? 0 : valign === 'bottom' ? (n - 1) * lineH : valign === 'top' ? -size : -(size - (n - 1) * lineH) / 2;
  for (const c of out) for (const p of c) p[1] += vy;

  // Bend along an arc: x → angle, y → radial offset.
  const R = opts.arcRadius;
  if (R && Math.abs(R) > 1e-3) {
    const sign = Math.sign(R), r = Math.abs(R);
    return out.map((c) => densify(c, Math.max(0.3, r / 60)).map(([x, y]) => {
      const a = x / r;
      const rr = r + sign * y;
      return [rr * Math.sin(a), sign * (rr * Math.cos(a) - r)] as Vec2;
    }));
  }
  return out;
}

/** Insert points so long straight edges bend smoothly when warped. */
function densify(c: Vec2[], maxLen: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    out.push(a);
    const n = Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxLen);
    for (let k = 1; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Run `fn`, loading any font it asks for and retrying (evaluation itself is synchronous). */
export async function withFonts<T>(fn: () => T, load: (id: string) => Promise<ArrayBuffer[]>): Promise<T> {
  for (let i = 0; i < 12; i++) {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof FontMissingError)) throw e;
      try {
        registerFont(e.fontId, await load(e.fontId));
      } catch (err) {
        markFontFailed(e.fontId, (err as Error).message);
      }
    }
  }
  return fn();
}
