// SVG drawings (logos, icons, artwork) placed with the UI's SVG tool, applied on top of the model
// script's output exactly like text-tool text: raised or engraved, on a face or a picked point.
import type { CrossSection, Manifold } from 'manifold-3d';
import { placeOnSurface, type SurfacePlacement } from './textFeatures';
import type { Vec2 } from './types';

export const SVG_KEY = '$svg';

/** Filled shapes of an imported SVG, flattened to polygons: centred on (0, 0), y up, 1 unit high. */
export interface SvgDrawing {
  /** File name, shown in the list. */
  name: string;
  /** Width ÷ height. */
  aspect: number;
  /** One entry per SVG element, each with its own fill rule. */
  shapes: { rule: 'NonZero' | 'EvenOdd'; contours: Vec2[][] }[];
}

export interface SvgFeature extends SurfacePlacement {
  /** Height of the drawing, mm (its width follows from the aspect ratio). */
  size: number;
  drawing: SvgDrawing;
}

/** The most polygon points one drawing may have (it is stored in the design's values). */
export const MAX_SVG_POINTS = 40000;

export function newSvgFeature(id: string, drawing: SvgDrawing, partial: Partial<SvgFeature> = {}): SvgFeature {
  return {
    id, enabled: true, size: 20, depth: 0.8, mode: 'emboss', face: 'top', anchor: [0.5, 0.5, 1], normal: [0, 0, 1],
    offset: [0, 0], rotation: 0, curve: 'none', wrapRadius: 0, drawing, ...partial,
  };
}

/** A drawing from saved JSON, checked (finite numbers, a bounded number of points), or null. */
export function cleanDrawing(raw: unknown): SvgDrawing | null {
  const o = raw as SvgDrawing | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.shapes) || !(Number(o.aspect) > 0)) return null;
  let points = 0;
  const shapes: SvgDrawing['shapes'] = [];
  for (const sh of o.shapes) {
    if (!sh || !Array.isArray(sh.contours)) continue;
    const contours = sh.contours.filter((c) => Array.isArray(c) && c.length >= 3 && c.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])))
      .map((c) => c.map((p) => [p[0], p[1]] as Vec2));
    points += contours.reduce((n, c) => n + c.length, 0);
    if (points > MAX_SVG_POINTS) return null;
    if (contours.length) shapes.push({ rule: sh.rule === 'EvenOdd' ? 'EvenOdd' : 'NonZero', contours });
  }
  return shapes.length ? { name: String(o.name ?? 'drawing.svg').slice(0, 120), aspect: Number(o.aspect), shapes } : null;
}

export function parseSvgFeatures(raw: unknown): SvgFeature[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.flatMap((f) => {
      const drawing = f && cleanDrawing(f.drawing);
      return drawing ? [newSvgFeature(String(f.id), drawing, { ...f, drawing, curve: f.curve === 'wrap' ? 'wrap' : 'none' })] : [];
    });
  } catch {
    return [];
  }
}

/** Applies the SVG features to `shape` (one part); `base` is the part's box before any text or SVG. */
export function applySvgFeatures(shape: Manifold, features: SvgFeature[], C: typeof CrossSection, base = shape.boundingBox()): Manifold {
  let out = shape;
  for (const f of features) {
    if (!f.enabled || !(f.size > 0) || !(f.depth > 0)) continue;
    const k = f.size;
    // Each SVG element keeps its own fill rule; together they make one flat shape.
    let cs: CrossSection | null = null;
    for (const sh of f.drawing.shapes) {
      const part = new C(sh.contours.map((c) => c.map(([x, y]) => [x * k, y * k] as Vec2)), sh.rule);
      cs = cs ? cs.add(part) : part;
    }
    if (cs && !cs.isEmpty()) out = placeOnSurface(out, base, f, cs);
  }
  return out;
}
