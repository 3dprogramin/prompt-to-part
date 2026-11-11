// SVG drawings (logos, icons, artwork) placed with the UI's SVG tool, applied on top of the model
// script's output exactly like text-tool text: raised or engraved, on a face or a picked point.
import type { CrossSection, Manifold } from 'manifold-3d';
import { placeOnSurface, type SurfacePlacement } from './textFeatures';
import type { Vec2 } from './types';
import { strokePieces, type ArtworkEdits, type ArtworkStroke } from './artworkEdits';
import { drawingFingerprint } from './lineart/strokes';

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
    edit?: 'paint' | 'erase';
    /** The brush stroke a hand-edit shape was made from (its contours are the stroke's). */
    stroke?: ArtworkStroke }[];
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

type Shape = SvgDrawing['shapes'][number];
type Box = { min: Vec2; max: Vec2 };

/** Pieces painted in order: the chosen colours (null = all) add, any other colour cuts. */
function paintShapes<T extends { color?: string }>(items: T[], chosen: Set<string> | null, part: (x: T) => CrossSection): CrossSection | null {
  let cs: CrossSection | null = null, shared = false;
  for (const x of items) {
    const p = part(x);
    if (!chosen || chosen.has(x.color ?? '')) { shared = !cs; cs = cs ? cs.add(p) : p; }
    else if (cs) { shared = false; cs = cs.subtract(p); }
  }
  // Never hand out a piece itself (it may be cached).
  return cs && shared ? cs.translate([0, 0]) : cs;
}

const scaled = (sh: Shape, k: number, C: typeof CrossSection) => new C(sh.contours.map((c) => c.map(([x, y]) => [x * k, y * k] as Vec2)), sh.rule);
const deleted = (x: CrossSection) => (x as unknown as { isDeleted?: () => boolean }).isDeleted?.() === true;

/**
 * A drawing shape as a CrossSection at `height`, made once per build: building it is most of the
 * time a drawing takes, and a script reads the same drawing several times (a few heights kept).
 */
const shapeCache = new WeakMap<Shape, Map<number, CrossSection>>();
function shapeSection(sh: Shape, height: number, C: typeof CrossSection): CrossSection {
  let byHeight = shapeCache.get(sh);
  if (!byHeight) shapeCache.set(sh, (byHeight = new Map()));
  const hit = byHeight.get(height);
  if (hit && !deleted(hit)) return hit;
  const cs = scaled(sh, height, C);
  if (byHeight.size >= 4) byHeight.delete(byHeight.keys().next().value!);
  byHeight.set(height, cs);
  return cs;
}

const overlaps = (a: Box, b: Box) => a.min[0] <= b.max[0] && b.min[0] <= a.max[0] && a.min[1] <= b.max[1] && b.min[1] <= a.max[1];
const inside = (a: Box, b: Box) => a.min[0] >= b.min[0] && a.max[0] <= b.max[0] && a.min[1] >= b.min[1] && a.max[1] <= b.max[1];

function shapeBounds(sh: Shape, k: number): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of sh.contours) for (const [x, y] of c) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { min: [x0 * k, y0 * k], max: [x1 * k, y1 * k] };
}

/**
 * The paint box of an edited drawing, in drawing units: the bounds of its shapes without edits, in
 * the colours raised by default. Worked out once per drawing, at the height first asked for.
 */
const paintBoxes = new WeakMap<SvgDrawing, Box | null>();
function paintBox(d: SvgDrawing, height: number, C: typeof CrossSection): Box | null {
  if (paintBoxes.has(d)) return paintBoxes.get(d)!;
  const colors = defaultColors(d);
  const base = paintShapes(d.shapes.filter((s) => !s.edit), colors ? new Set(colors) : null, (sh) => shapeSection(sh, height, C));
  const b = base && !base.isEmpty() ? base.bounds() : null;
  const box: Box | null = b ? { min: [b.min[0] / height, b.min[1] / height], max: [b.max[0] / height, b.max[1] / height] } : null;
  paintBoxes.set(d, box);
  return box;
}

/**
 * What the hand edits do, at one height: S, the union of the strokes (paint clipped to the paint
 * box), and for each colour where it shows inside S after the strokes (`after`) and whether it
 * showed there before (`before`). Every edit stays inside S, and a colour shows where the last
 * thing painted there has that colour, so a build's section is the section without edits outside
 * S and the chosen colours' `after` inside it.
 */
interface EditRegions { S: CrossSection; shown: Map<string, { before: boolean; after: CrossSection }> }
/** The same as plain polygons, kept between builds (by the shapes and height): a rebuild with the same edits only remakes these. */
type KeptRegions = { S: Vec2[][]; shown: [string, boolean, Vec2[][]][] } | null;
const keptRegions = new Map<string, KeptRegions>();
const KEEP_REGIONS = 6;
const editRegionsCache = new WeakMap<SvgDrawing, Map<number, EditRegions | null>>();

/** A hash of shapes (points, rules, colours, edits), for keys of things kept between builds. */
function shapesHash(shapes: Shape[]): string {
  const f = new Float64Array(1), u = new Uint32Array(f.buffer);
  let a = 0, b = 0x9e3779b9, n = 0;
  const mix = (v: number) => { a = (Math.imul(a, 31) + v) | 0; b = Math.imul(b ^ v, 0x01000193); n++; };
  const num = (x: number) => { f[0] = x; mix(u[0]); mix(u[1]); };
  const str = (t: string) => { mix(t.length); for (let i = 0; i < t.length; i++) mix(t.charCodeAt(i)); };
  for (const sh of shapes) {
    str(sh.rule); str(sh.color ?? '\u0000'); str(sh.edit ?? '');
    for (const c of sh.contours) { mix(c.length); for (const [x, y] of c) { num(x); num(y); } }
  }
  return `${n}:${a}:${b}`;
}

const fromPolygons = (polys: Vec2[][], C: typeof CrossSection) => (polys.length ? new C(polys) : C.compose([]));

/**
 * A hand-edit shape at `height`: from its stroke when it has one, the circles as moved copies of
 * one (handing the points over to Manifold is most of what building a stroke takes).
 */
function strokeSection(sh: Shape, height: number, C: typeof CrossSection): CrossSection {
  if (!sh.stroke) return scaled(sh, height, C);
  const { circle, centres, polys } = strokePieces(sh.stroke);
  const parts: CrossSection[] = [];
  if (centres.length) {
    const one = new C([circle.map(([x, y]) => [x * height, y * height] as Vec2)]);
    for (const [x, y] of centres) parts.push(one.translate([x * height, y * height]));
  }
  if (polys.length) parts.push(new C(polys.map((c) => c.map(([x, y]) => [x * height, y * height] as Vec2)), 'NonZero'));
  return parts.length > 1 ? C.union(parts) : parts[0];
}

function editRegions(d: SvgDrawing, height: number, C: typeof CrossSection): EditRegions | null {
  let byHeight = editRegionsCache.get(d);
  if (!byHeight) editRegionsCache.set(d, (byHeight = new Map()));
  const hit = byHeight.get(height);
  if (hit === null || (hit && !deleted(hit.S))) return hit;
  const make = (polys: Vec2[][]) => fromPolygons(polys, C);
  const key = `${height}:${d.aspect}:${shapesHash(d.shapes)}`;
  let out: EditRegions | null;
  if (keptRegions.has(key)) {
    const kept = keptRegions.get(key)!;
    keptRegions.delete(key);
    keptRegions.set(key, kept);
    out = kept && { S: make(kept.S), shown: new Map(kept.shown.map(([col, before, after]) => [col, { before, after: make(after) }])) };
  } else {
    out = workOutEdits(d, height, C);
    keptRegions.set(key, out && { S: out.S.toPolygons() as Vec2[][], shown: [...out.shown].map(([col, v]) => [col, v.before, v.after.toPolygons() as Vec2[][]]) });
    if (keptRegions.size > KEEP_REGIONS) keptRegions.delete(keptRegions.keys().next().value!);
  }
  byHeight.set(height, out);
  return out;
}

function workOutEdits(d: SvgDrawing, height: number, C: typeof CrossSection): EditRegions | null {
  const ub = paintBox(d, height, C);
  const hb: Box | null = ub ? { min: [ub.min[0] * height, ub.min[1] * height], max: [ub.max[0] * height, ub.max[1] * height] } : null;
  const box = hb ? C.square([hb.max[0] - hb.min[0], hb.max[1] - hb.min[1]]).translate(hb.min) : null;
  const edits: { color: string; erase: boolean; part: CrossSection; b: Box }[] = [];
  for (const sh of d.shapes) {
    if (!sh.edit) continue;
    // (A paint stroke wholly inside the box needs no cut.)
    const part = sh.edit === 'erase' || (hb && inside(shapeBounds(sh, height), hb)) ? strokeSection(sh, height, C) : hb ? strokeSection(sh, height, C).intersect(box!) : null;
    if (part && !part.isEmpty()) edits.push({ color: sh.color ?? '', erase: sh.edit === 'erase', part, b: part.bounds() });
  }
  if (!edits.length) return null;
  const S = C.union(edits.map((e) => e.part));
  const sb = S.bounds();
  // The drawing's own shapes, cut to S (those that reach it).
  const clipped = d.shapes.filter((sh) => !sh.edit && overlaps(shapeBounds(sh, height), sb))
    .map((sh) => ({ color: sh.color ?? '', part: shapeSection(sh, height, C).intersect(S) }));
  const shown = new Map<string, { before: boolean; after: CrossSection }>();
  for (const col of drawingColors(d)) {
    const before = paintShapes(clipped, new Set([col]), (x) => x.part) ?? C.compose([]);
    // Paint shows its colour (+1) and hides the others (-1); erase hides its own colour. Strokes in
    // a row with the same effect go on together.
    let after = before, run: { part: CrossSection; b: Box }[] = [], sign = 0;
    const flush = () => {
      if (sign < 0 && !after.isEmpty()) { const ab = after.bounds(); run = run.filter((e) => overlaps(ab, e.b)); }
      else if (sign < 0) run = [];
      if (run.length) { const u = run.length > 1 ? C.union(run.map((e) => e.part)) : run[0].part; after = sign > 0 ? after.add(u) : after.subtract(u); }
      run = [];
    };
    for (const e of edits) {
      const effect = !e.erase && e.color === col ? 1 : !e.erase || e.color === col ? -1 : 0;
      if (!effect) continue;
      if (effect !== sign) { flush(); sign = effect; }
      run.push(e);
    }
    flush();
    shown.set(col, { before: !before.isEmpty(), after });
  }
  return { S, shown };
}

/**
 * A drawing as one flat shape, `height` units high, centred on the origin with y up. Painted in
 * order, each element with its own fill rule: the chosen colours (undefined = all) add to the
 * shape, any other colour painted on top cuts it away. Null if nothing is left.
 */
export function drawingSection(d: SvgDrawing, height: number, colors: string[] | undefined, C: typeof CrossSection): CrossSection | null {
  const chosen = colors ? new Set(colors) : null;
  const original = d.shapes.filter((s) => !s.edit);
  const cs = paintShapes(original, chosen, (sh) => shapeSection(sh, height, C));
  // Hand edits: paint stays inside the picture's box (the section of the shapes without edits, in
  // the colours raised by default), erase cuts only its own colour where that colour shows.
  const r = original.length < d.shapes.length ? editRegions(d, height, C) : null;
  const mine = r ? [...r.shown].filter(([col]) => !chosen || chosen.has(col)).map(([, v]) => v) : [];
  // A colour no stroke reaches keeps its polygons as they are without edits.
  if (!r || mine.every((v) => !v.before && v.after.isEmpty())) return cs && !cs.isEmpty() ? cs : null;
  const inS = C.union(mine.map((v) => v.after));
  const out = cs ? (overlaps(cs.bounds(), r.S.bounds()) ? cs.subtract(r.S) : cs).add(inS) : inS;
  return out.isEmpty() ? null : out;
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
export function describeDrawings(drawings: Record<string, SvgDrawing>, artworkEdits: ArtworkEdits = {}): string {
  return Object.entries(drawings).map(([key, d]) => {
    const e = artworkEdits[key];
    const n = e && e.fp === drawingFingerprint(d) ? e.strokes.length : 0;
    const edited = n ? `; ${n} hand edit${n > 1 ? 's' : ''} by the user (paint / erase with the brush in the 3D view): they belong to this drawing, so a new picture leaves them behind; say so before drawing a new one, and suggest the brush for small fixes` : '';
    const colours = drawingColors(d).map((c) => `${c || 'unset'} (${d.shapes.filter((s) => (s.color ?? '') === c).length} shape${d.shapes.filter((s) => (s.color ?? '') === c).length > 1 ? 's' : ''})`);
    return `"${d.name}": width/height ${d.aspect.toFixed(2)}, colours in paint order: ${colours.join(', ')}; raised by default: ${(defaultColors(d) ?? drawingColors(d)).join(', ') || 'all'}${edited}`;
  }).join('\n');
}
