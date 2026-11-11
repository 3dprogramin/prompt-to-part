// SVG drawings (logos, icons, artwork) placed with the UI's SVG tool, applied on top of the model
// script's output exactly like text-tool text: raised or engraved, on a face or a picked point.
import type { CrossSection, Manifold } from 'manifold-3d';
import { placeOnSurface, type SurfacePlacement } from './textFeatures';
import type { Vec2 } from './types';

export const SVG_KEY = '$svg';
/** SVG drawings attached in the chat, by file name: model scripts use them with H.svg(name). */
export const DRAWINGS_KEY = '$drawings';
/** At most this many attached drawings per design. */
export const MAX_DRAWINGS = 12;

/** Filled shapes of an imported SVG, flattened to polygons: centred on (0, 0), y up, 1 unit high. */
export interface SvgDrawing {
  /** File name, shown in the list. */
  name: string;
  /** Width ÷ height. */
  aspect: number;
  /** One entry per SVG element in paint order (later ones are drawn on top), with its fill rule and colour. */
  shapes: { rule: 'NonZero' | 'EvenOdd'; contours: Vec2[][]; color?: string;
    /** Set only on hand-edit shapes (artwork brush strokes, never stored with the drawing): paint adds its colour, clipped to the picture's box; erase cuts only its own colour. */
    edit?: 'paint' | 'erase' }[];
}

export interface SvgFeature extends SurfacePlacement {
  /** Height of the drawing, mm (its width follows from the aspect ratio). */
  size: number;
  drawing: SvgDrawing;
  /**
   * The fill colours that make the raised (or engraved) shape; undefined = all. Shapes of other
   * colours painted on top cut through it, as they cover it in the drawing (white lettering on a
   * red disc becomes a disc with the lettering cut out).
   */
  colors?: string[];
}

/** The drawing's fill colours, in paint order. */
export function drawingColors(d: SvgDrawing): string[] {
  return [...new Set(d.shapes.map((s) => s.color ?? ''))];
}

/** Colours raised by default: all of them, except white-ish ones (usually the paper) when there are others. */
export function defaultColors(d: SvgDrawing): string[] | undefined {
  const all = drawingColors(d);
  if (all.length < 2) return undefined;
  const light = (c: string) => {
    const m = /^#([0-9a-f]{6})$/.exec(c);
    if (!m) return c === 'white';
    const v = parseInt(m[1], 16);
    return 0.2126 * (v >> 16) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255) > 235;
  };
  const dark = all.filter((c) => !light(c));
  return dark.length && dark.length < all.length ? dark : undefined;
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
    if (contours.length) shapes.push({ rule: sh.rule === 'EvenOdd' ? 'EvenOdd' : 'NonZero', contours, ...(typeof sh.color === 'string' ? { color: sh.color.slice(0, 40) } : {}) });
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
      const colors = Array.isArray(f.colors) ? f.colors.filter((c: unknown) => typeof c === 'string') : undefined;
      return drawing ? [newSvgFeature(String(f.id), drawing, { ...f, drawing, colors, curve: f.curve === 'wrap' ? 'wrap' : 'none' })] : [];
    });
  } catch {
    return [];
  }
}

/**
 * A drawing as one flat shape, `height` units high, centred on the origin with y up. Painted in
 * order, each element with its own fill rule: the chosen colours (undefined = all) add to the
 * shape, any other colour painted on top cuts it away. Null if nothing is left.
 */
export function drawingSection(d: SvgDrawing, height: number, colors: string[] | undefined, C: typeof CrossSection): CrossSection | null {
  const chosen = colors ? new Set(colors) : null;
  const poly = (sh: SvgDrawing['shapes'][number]) => new C(sh.contours.map((c) => c.map(([x, y]) => [x * height, y * height] as Vec2)), sh.rule);
  const original = d.shapes.filter((s) => !s.edit);
  if (original.length === d.shapes.length) {
    let cs: CrossSection | null = null;
    for (const sh of d.shapes) {
      const part = poly(sh);
      if (!chosen || chosen.has(sh.color ?? '')) cs = cs ? cs.add(part) : part;
      else if (cs) cs = cs.subtract(part);
    }
    return cs && !cs.isEmpty() ? cs : null;
  }
  // Hand edits: paint stays inside the picture's box (the section of the shapes without edits, in
  // the colours raised by default), erase cuts only its own colour where that colour shows.
  const base = drawingSection({ ...d, shapes: original }, height, defaultColors(d) ?? undefined, C);
  const b = base?.bounds();
  const box = b ? C.square([b.max[0] - b.min[0], b.max[1] - b.min[1]]).translate([b.min[0], b.min[1]]) : null;
  const track = new Map<string, CrossSection | null>();
  for (const sh of d.shapes) if (sh.edit === 'erase') track.set(sh.color ?? '', null);
  let cs: CrossSection | null = null;
  for (const sh of d.shapes) {
    const col = sh.color ?? '';
    let part = poly(sh);
    if (sh.edit === 'paint') part = box ? part.intersect(box) : new C([]);
    if (sh.edit === 'erase') {
      const seen = track.get(col) ?? null;
      if (cs && seen && (!chosen || chosen.has(col))) cs = cs.subtract(part.intersect(seen));
      if (seen) track.set(col, seen.subtract(part));
      continue;
    }
    if (!chosen || chosen.has(col)) cs = cs ? cs.add(part) : part;
    else if (cs) cs = cs.subtract(part);
    for (const [t, seen] of track) track.set(t, t === col ? (seen ? seen.add(part) : part) : seen ? seen.subtract(part) : null);
  }
  return cs && !cs.isEmpty() ? cs : null;
}

/** Applies the SVG features to `shape` (one part); `base` is the part's box before any text or SVG. */
export function applySvgFeatures(shape: Manifold, features: SvgFeature[], C: typeof CrossSection, base = shape.boundingBox()): Manifold {
  let out = shape;
  for (const f of features) {
    if (!f.enabled || !(f.size > 0) || !(f.depth > 0)) continue;
    const cs = drawingSection(f.drawing, f.size, f.colors, C);
    if (cs) out = placeOnSurface(out, base, f, cs);
  }
  return out;
}

/** Attached drawings from saved JSON (name → drawing), checked. */
export function parseDrawings(raw: unknown): Record<string, SvgDrawing> {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return {}; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: Record<string, SvgDrawing> = {};
  for (const [name, d] of Object.entries(o).slice(0, MAX_DRAWINGS)) {
    const clean = cleanDrawing(d);
    if (clean) out[name.slice(0, 120)] = { ...clean, name: name.slice(0, 120) };
  }
  return out;
}

/** One line per attached drawing for Claude: name, proportions and colours in paint order. */
export function describeDrawings(drawings: Record<string, SvgDrawing>): string {
  return Object.values(drawings).map((d) => {
    const colours = drawingColors(d).map((c) => `${c || 'unset'} (${d.shapes.filter((s) => (s.color ?? '') === c).length} shape${d.shapes.filter((s) => (s.color ?? '') === c).length > 1 ? 's' : ''})`);
    return `"${d.name}": width/height ${d.aspect.toFixed(2)}, colours in paint order: ${colours.join(', ')}; raised by default: ${(defaultColors(d) ?? drawingColors(d)).join(', ') || 'all'}`;
  }).join('\n');
}
