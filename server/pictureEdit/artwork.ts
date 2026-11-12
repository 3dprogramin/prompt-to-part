// A picture edit's result back into an AI-artwork drawing: the edited crop is traced in the
// drawing's own colours and joined to the old drawing so that outside the mark nothing changes
// (the owner fades between the two versions in a product video: anything that moves shows), the
// piece keeps its size and the colours still fit together.
import type { CrossSection } from 'manifold-3d';
import { TRACE_MAX_SIDE, traceArtwork } from '../artwork';
import type { Raster } from '../../shared/meshFormats';
import { drawingColors, drawingSection, MAX_SVG_POINTS, type SvgDrawing } from '../../shared/svgFeatures';
import { markContours, markMask, type PictureMark } from '../../shared/pictureEdit/mark';
import { renderDrawing, wholeWindow, type PictureWindow } from '../../shared/pictureEdit/render';
import type { Vec2 } from '../../shared/types';

type Shape = SvgDrawing['shapes'][number];
type Box = { min: Vec2; max: Vec2 };

function hexRgb(c: string): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) throw new Error(`Not a #rrggbb colour: ${c}`);
  const h = m[1].length === 3 ? m[1].replace(/./g, (x) => x + x) : m[1];
  const v = parseInt(h, 16);
  return [v >> 16, (v >> 8) & 255, v & 255];
}
const toHex = (c: number[]) => '#' + c.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('');

/**
 * The edited crop as a drawing in `colours` (the drawing's own; no k-means), in the WHOLE drawing's
 * units: the crop covers `win`, its pixels `win.h / crop.height` wide from the window's top-left
 * corner (as `renderDrawing` makes them). Background: where `background` is 1 (one byte per crop
 * pixel: where the original crop was background), plus the lightest colour connected to it; white
 * inside the subject stays that colour. At most `budget` points. `aspect` is the crop's.
 */
export function traceCrop(crop: Raster, colours: string[], win: PictureWindow, background: Uint8Array, name: string, budget: number): SvgDrawing {
  const hexes = colours.map((c) => toHex(hexRgb(c)));
  const { drawing } = traceArtwork(crop, hexes, colours.length, name, [], { background, budget });
  const original = new Map(hexes.map((h, i) => [h, colours[i]]));
  // The tracer's units: 1 = the height of the picture it traced, centred, y up, its top-left corner
  // the crop's. A crop over TRACE_MAX_SIDE is box-filtered down by a whole factor f first, keeping
  // only whole blocks, so a unit is (traced height x f) crop pixels.
  const f = Math.max(1, Math.ceil(Math.max(crop.width, crop.height) / TRACE_MAX_SIDE));
  const tracedH = f > 1 ? Math.floor(crop.height / f) : crop.height;
  const s = (win.h * tracedH * f) / crop.height, half = drawing.aspect / 2;
  const map = ([x, y]: Vec2): Vec2 => [win.x0 + (x + half) * s, win.y1 + (y - 0.5) * s];
  return {
    name, aspect: crop.width / crop.height,
    shapes: drawing.shapes.map((sh) => ({ ...sh, color: original.get(sh.color ?? '') ?? sh.color, contours: sh.contours.map((c) => c.map(map)) })),
  };
}

const overlaps = (a: Box, b: Box) => a.min[0] <= b.max[0] && b.min[0] <= a.max[0] && a.min[1] <= b.max[1] && b.min[1] <= a.max[1];
const boxOf = (cs: CrossSection): Box => { const b = cs.bounds(); return { min: [b.min[0], b.min[1]], max: [b.max[0], b.max[1]] }; };
const pointsOf = (shapes: Shape[]) => shapes.reduce((n, s) => n + s.contours.reduce((m, c) => m + c.length, 0), 0);
const polygons = (cs: CrossSection) => cs.toPolygons() as Vec2[][];

/** The mark as Manifold has it: its polygons (outers and holes, so EvenOdd parity holds) and box. */
interface MarkArea { M: CrossSection; polys: Vec2[][]; box: Box }

function insideMark(x: number, y: number, m: MarkArea): boolean {
  let inside = false;
  for (const c of m.polys) {
    for (let i = 0, k = c.length - 1; i < c.length; k = i++) {
      const [ax, ay] = c[i], [bx, by] = c[k];
      if ((ay > y) !== (by > y) && x < ax + ((y - ay) / (by - ay)) * (bx - ax)) inside = !inside;
    }
  }
  return inside;
}

const orient = (a: Vec2, b: Vec2, c: Vec2) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
/** Whether segments ab and cd meet (touching counts). */
function meet(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  const on = (p: Vec2, q: Vec2, r: Vec2) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (!o1 && on(a, b, c)) || (!o2 && on(a, b, d)) || (!o3 && on(c, d, a)) || (!o4 && on(c, d, b));
}

/** Whether the contour comes into the mark: an edge of it ends inside the mark or meets the mark's outline. */
function crosses(c: Vec2[], m: MarkArea): boolean {
  const b = m.box;
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length];
    if (Math.max(p[0], q[0]) < b.min[0] || Math.min(p[0], q[0]) > b.max[0] || Math.max(p[1], q[1]) < b.min[1] || Math.min(p[1], q[1]) > b.max[1]) continue;
    if (insideMark(p[0], p[1], m)) return true;
    for (const mc of m.polys) for (let k = 0; k < mc.length; k++) if (meet(p, q, mc[k], mc[(k + 1) % mc.length])) return true;
  }
  return false;
}

/**
 * The polygons with each point that lies within 1e-7 of a point of `from` put back on it exactly:
 * Manifold rounds what it returns, and a traced outline's points can sit exactly on a render's
 * sample rows, so a rounded copy away from the mark could render a pixel differently.
 */
function snapTo(polys: Vec2[][], from: Vec2[][]): Vec2[][] {
  const CELL = 1e-6, NEAR = 1e-7, grid = new Map<string, Vec2[]>();
  for (const c of from) for (const p of c) {
    const k = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
    const list = grid.get(k);
    if (list) list.push(p); else grid.set(k, [p]);
  }
  return polys.map((c) => c.map((q) => {
    const i = Math.floor(q[0] / CELL), j = Math.floor(q[1] / CELL);
    let best = q, bd = NEAR;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const p of grid.get(`${i + di},${j + dj}`) ?? []) {
        const d = Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
        if (d <= bd) { bd = d; best = p; }
      }
    }
    return [best[0], best[1]] as Vec2;
  }));
}

/**
 * An old shape without the mark. Contours that do not come into the mark stay exactly as they are.
 * EvenOdd: the region is the parity of far contours F and crossing ones T, so with F kept, the
 * crossing ones become T' = (T - M) + (F & M): outside M as before, inside M it cancels F. No edge
 * of T' lies on an edge of F, so nothing has to cancel exactly (old contours plus their part in the
 * mark, as an XOR, leave hairline slivers in builds at most sizes, because Manifold rounds the two
 * copies of each shared edge differently). T' keeps the old points (snapped back after rounding).
 * NonZero (attached SVGs, not traced artwork): re-expressed whole.
 */
function withoutMark(sh: Shape, m: MarkArea, C: typeof CrossSection): Shape | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of sh.contours) for (const [x, y] of c) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (!overlaps({ min: [x0, y0], max: [x1, y1] }, m.box)) return sh;
  if (sh.rule === 'NonZero') {
    const left = new C(sh.contours, 'NonZero').subtract(m.M);
    return left.isEmpty() ? null : { ...sh, contours: snapTo(polygons(left), sh.contours) };
  }
  const crossing = sh.contours.map((c) => crosses(c, m));
  const near = sh.contours.filter((_, i) => crossing[i]), far = sh.contours.filter((_, i) => !crossing[i]);
  const kept = near.length ? new C(near, 'EvenOdd').subtract(m.M) : C.compose([]);
  // Far contours may still hold the mark (a silhouette around it).
  const held = far.length ? new C(far, 'EvenOdd').intersect(m.M) : C.compose([]);
  const tPrime = snapTo(polygons(kept.add(held)), near);
  if (!near.length && !tPrime.length) return sh;
  const contours = [...far, ...tPrime];
  return contours.length ? { ...sh, contours } : null;
}

/** How simplified the fresh outlines may get (picture units, 1 = the picture's height) before the edit gives up. */
const MAX_SIMPLIFY = 0.01;

/** The fresh drawing's colours inside `area`, one NonZero shape per colour of `colours` (disjoint: what is painted on top cuts), outlines simplified by `eps`. */
function freshShapes(fresh: SvgDrawing, area: CrossSection, colours: string[], eps: number, C: typeof CrossSection): Shape[] {
  let d = fresh;
  if (eps > 0) {
    const ab = area.bounds(), g = 4 * eps;
    const clip = C.square([ab.max[0] - ab.min[0] + 2 * g, ab.max[1] - ab.min[1] + 2 * g]).translate([ab.min[0] - g, ab.min[1] - g]);
    d = { ...fresh, shapes: fresh.shapes.map((sh) => ({ rule: 'NonZero' as const, contours: polygons(new C(sh.contours, sh.rule).intersect(clip).simplify(eps)), color: sh.color })) };
  }
  const out: Shape[] = [];
  for (const c of colours) {
    const cs = drawingSection(d, 1, [c], C);
    const inside = cs ? polygons(cs.intersect(area)) : [];
    if (inside.length) out.push({ rule: 'NonZero', contours: inside, color: c });
  }
  return out;
}

/**
 * How far inside the mark the old shapes are cut (picture units: 0.1 um on a 100 mm piece). Where
 * the old cut and the fresh shapes' clip met edge to edge on the mark's outline, Manifold rounds
 * the two copies differently at build size and leaves hairline slivers of the old colour; with the
 * old shapes reaching this far under the fresh ones, what is painted on top covers the seam, and
 * outside the mark the old shapes stay exactly as they were.
 */
const SEAM = 1e-6;

/**
 * The old drawing with the fresh one inside the mark: old shapes first, same order, each without
 * the mark (contours away from it byte-identical), then per colour of the old drawing (in its
 * paint order) the fresh colour inside the mark and the old drawing's extent box, so the piece keeps
 * its size. Same name and aspect as old. At most MAX_SVG_POINTS points: the old shapes are never
 * simplified; the fresh ones are, harder, until they fit (`simplified`). `outsideSame`: renders of
 * both at 2400 px high have the same colour at every pixel outside the mark grown by 1 px.
 */
export function combineDrawing(old: SvgDrawing, fresh: SvgDrawing, mark: PictureMark, C: typeof CrossSection):
  { drawing: SvgDrawing; outsideSame: boolean; simplified: boolean } {
  const M = new C(markContours(mark), 'NonZero');
  if (M.isEmpty()) throw new Error('The mark is empty');
  // The old shapes lose the mark shrunk by SEAM, so the fresh shapes painted on top overlap them.
  const cut = M.offset(-SEAM, 'Miter');
  const kept = cut.isEmpty() ? old.shapes : old.shapes.map((sh) => withoutMark(sh, { M: cut, polys: polygons(cut), box: boxOf(cut) }, C)).filter((sh): sh is Shape => !!sh);
  const used = pointsOf(kept);
  if (used > MAX_SVG_POINTS) throw new Error(`The drawing is too detailed to edit: ${used} points`);
  const all = drawingSection(old, 1, undefined, C);
  if (!all) throw new Error('The drawing is empty');
  const eb = all.bounds();
  const area = M.intersect(C.square([eb.max[0] - eb.min[0], eb.max[1] - eb.min[1]]).translate([eb.min[0], eb.min[1]]));
  const colours = drawingColors(old);
  let eps = 0, added = freshShapes(fresh, area, colours, 0, C);
  while (used + pointsOf(added) > MAX_SVG_POINTS) {
    eps = eps ? eps * 2 : 1e-4;
    if (eps > MAX_SIMPLIFY) throw new Error(`The drawing is too detailed to edit: ${used + pointsOf(added)} points`);
    added = freshShapes(fresh, area, colours, eps, C);
  }
  const drawing: SvgDrawing = { name: old.name, aspect: old.aspect, shapes: [...kept, ...added] };
  return { drawing, outsideSame: sameOutside(old, drawing, mark), simplified: eps > 0 };
}

/** Whether two drawings render the same colour at every pixel outside the mark grown by 1 px, at 2400 px high. */
function sameOutside(a: SvgDrawing, b: SvgDrawing, mark: PictureMark): boolean {
  const H = 2400, win = wholeWindow(a);
  const ra = renderDrawing(a, [], win, H), rb = renderDrawing(b, [], win, H);
  if (ra.width !== rb.width || ra.height !== rb.height) return false;
  const ca = drawingColors(a), toA = drawingColors(b).map((c) => ca.indexOf(c));
  const W = ra.width, mask = markMask(mark, { w: W, h: ra.height, px: win.h / H, x0: win.x0, y1: win.y1 });
  for (let j = 0; j < ra.height; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      const lb = rb.labels[p] < 0 ? -1 : toA[rb.labels[p]];
      if (ra.labels[p] === lb) continue;
      // Different here: fine only next to (or in) the mark.
      let near = false;
      for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1 && !near; di++) {
        const y = j + dj, x = i + di;
        near = y >= 0 && y < ra.height && x >= 0 && x < W && mask[y * W + x] === 1;
      }
      if (!near) return false;
    }
  }
  return true;
}

/**
 * How far a returned colour may be from every filament colour (RGB, Euclidean) and still count as
 * that colour. Above image-model noise and the slight tints of flat areas (about 20-40), below the
 * gap to a new tone the design cannot print: a mid brown (#8b5a2b) is 93 from the nearest Santa
 * colour (red), a dark tan (#a0703c) 96 from skin.
 */
export const OFF_PALETTE_DISTANCE = 70;

/**
 * The share of the mark's pixels (`mask` 1, one byte per pixel of `returned`) farther than
 * OFF_PALETTE_DISTANCE from every colour of `colours` and from white (the paper is never off the
 * palette), and those pixels' mean colour as #rrggbb (null when there are none).
 */
export function offPalette(returned: Raster, mask: Uint8Array, colours: string[]): { share: number; colour: string | null } {
  const pal = [...colours.map(hexRgb), [255, 255, 255]];
  const d2 = OFF_PALETTE_DISTANCE ** 2, d = returned.data;
  let n = 0, off = 0, r = 0, g = 0, b = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    n++;
    const R = d[p * 4], G = d[p * 4 + 1], B = d[p * 4 + 2];
    if (pal.every(([pr, pg, pb]) => (R - pr) ** 2 + (G - pg) ** 2 + (B - pb) ** 2 > d2)) { off++; r += R; g += G; b += B; }
  }
  return { share: n ? off / n : 0, colour: off ? toHex([r / off, g / off, b / off]) : null };
}
