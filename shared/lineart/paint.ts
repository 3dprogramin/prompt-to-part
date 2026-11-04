// Line art's colours: erasing and filling by hand, and the lines split into the filaments they
// are painted in.
import type { PartFilament } from '../params';
import type { Pt } from './raster';
import type { LineArtStroke } from './strokes';

export interface Coloured { name: string; shape: any; filament: PartFilament }

/** Paint narrower than this (mm) would print as junk: it goes to the filament around it. */
export const MIN_PAINT = 0.4;
/** A colour this close to a line's edge (mm) reaches it exactly, so no skin of the piece's own filament is left on its walls. */
const PAINT_SNAP = 0.05;
/** Bits of a part smaller than this (mm³) are skins left by cutting the colours out: dropped. */
export const MIN_BODY = 0.01;
/** How far past its brush (mm) a colour takes in the colour's share of the lines, so the bits the clean-up left go to it. */
export const PAINT_REACH = 0.1;
/** Slivers of the piece's own filament or of a colour narrower than twice this (mm) are cleaned away when the lines are split. */
export const PAINT_CLEAN = 0.005;
/** How far a colour's slot in the piece's own filament reaches past the piece (mm). */
export const SLOT_OUT = 0.01;
/** Narrower than this (mm), a spike of the piece's own filament against a colour goes. */
export const SPIKE = 5e-4;
/** A colour's steps and points closer than this (mm) go before it is made solid: needle-thin triangles shade wrong. */
export const LAYER_TIDY = 1e-3;
/** How far a corner may reach when closing slits a hair wide (× the hair): square corners stay square, no arcs. */
export const TIDY_MITER = 1000;

/** An erase or fill stroke and its brush on the piece (mm). */
export interface HandOp { st: LineArtStroke; cs: any }
/** A filled bit no bigger than this (mm²) of the piece's own lines: nothing of the piece holds it. */
const FILL_HELD = 0.05;
/** How far a fill reaches over the lines it ends on (mm), so it meets them with no crack. */
const FILL_SEAL = 0.0002;

/**
 * Erasing and filling by hand on the lines `lineCs` (mm, after the clean-up), in stroke order:
 * an erase takes away everything under it; a fill adds what under it is still empty (off the lines,
 * what was filled before and the bar or frame `anchor`; inside `region`, a split piece's), without
 * bits narrower than MIN_PAINT, so it never covers a line. Filled material that ends up touching
 * nothing else of the piece would fall off: it goes (`loose` counts it). `filled`: what each fill
 * added and kept, for its colour.
 */
export function handEdits(C: any, lineCs: any, anchor: any, ops: HandOp[], region?: any): { lineCs: any; filled: Map<LineArtStroke, any>; loose: number } {
  const filled = new Map<LineArtStroke, any>();
  const r = MIN_PAINT / 2;
  for (const { st, cs } of ops) {
    if (st.mode === 'erase') { lineCs = lineCs.subtract(cs); continue; }
    let add = region ? cs.intersect(region) : cs;
    add = add.subtract(lineCs);
    if (anchor && !add.isEmpty()) add = add.subtract(anchor);
    if (add.isEmpty()) continue;
    // (Opened, then out to its own edges again, and a hair over the lines' edges: where it ends on
    // a line a rounding's difference would leave a crack, a skin of the piece's walls in it.)
    const open = add.offset(-r, 'Round').offset(r, 'Round');
    if (open.isEmpty()) continue;
    add = open.offset(PAINT_SNAP, 'Miter').intersect(add);
    if (add.isEmpty() || add.area() <= 1e-4) continue;
    // What the opening took that the piece now closes in all round (a corner of an outline, a
    // crack along a fill before): filled too, or it prints as a pinhole.
    const shut = pockets(C, anchor ? lineCs.add(add).add(anchor) : lineCs.add(add), cs, add, r);
    if (shut) add = add.add(shut);
    add = add.offset(FILL_SEAL, 'Miter');
    lineCs = lineCs.add(add);
    filled.set(st, add);
  }
  if (!filled.size) return { lineCs, filled, loose: 0 };
  // A body of the piece that is all fill holds on to nothing.
  const all = [...filled.values()].reduce((u: any, x) => u.add(x));
  const bodies = (anchor && !anchor.isEmpty() ? lineCs.add(anchor) : lineCs).decompose();
  const loose = bodies.length > 1 ? bodies.filter((b: any) => b.subtract(all).area() <= FILL_HELD) : [];
  if (loose.length) {
    const gone = loose.reduce((u: any, x: any) => u.add(x));
    lineCs = lineCs.subtract(gone);
    for (const [st, x] of filled) filled.set(st, x.subtract(gone));
  }
  return { lineCs, filled, loose: loose.length };
}

/**
 * The holes of `solid` near the brush `cs` that the fill `add` meets and that are narrower than
 * 2 × `r` (a fill's opening left them, along a line it ends on or in a corner), as one
 * CrossSection, or null.
 */
function pockets(C: any, solid: any, cs: any, add: any, r: number): any {
  const near = solid.intersect(cs.offset(1 + 2 * r, 'Round'));
  const by = add.offset(2 * FILL_SEAL + 1e-4, 'Miter');
  const holes = near.toPolygons().filter((c: Pt[]) => c.length > 2 && ringArea(c) < 0)
    .map((c: Pt[]) => new C([c], 'NonZero'))
    .filter((h: any) => h.offset(-r, 'Round').isEmpty() && !h.intersect(by).isEmpty());
  return holes.length ? holes.reduce((u: any, h: any) => u.add(h)) : null;
}

/** A ring's signed area (mm², counter-clockwise positive). */
function ringArea(c: Pt[]): number {
  let a = 0;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) a += (c[j][0] - c[i][0]) * (c[j][1] + c[i][1]);
  return a / 2;
}

/**
 * The lines `lineCs` coloured by `areas` (which don't overlap): each filament's part of them, off
 * the bar or frame (`anchor`) and without slivers narrower than MIN_PAINT; a sliver of the piece's
 * own filament left between a colour and the edge of a line (a stroke that just missed it) takes
 * that colour (not beside a fill: the lines it was filled up to are the drawing's own). The rest of
 * the lines stays in the piece's own filament.
 */
export function colourLines(lineCs: any, anchor: any, areas: { filament: PartFilament; area: any; fill?: any }[]): { filament: PartFilament; cs: any }[] {
  if (!areas.length || lineCs.isEmpty()) return [];
  const r = MIN_PAINT / 2;
  const open = (cs: any) => cs.offset(-r, 'Round').offset(r, 'Round');
  const colours: { filament: PartFilament; cs: any; fill?: any }[] = [];
  for (const a of areas) {
    let cs = lineCs.intersect(a.area);
    if (anchor && !cs.isEmpty()) cs = cs.subtract(anchor);
    if (cs.isEmpty()) continue;
    cs = open(cs).intersect(cs);
    if (cs.isEmpty() || cs.area() <= 1e-4) continue;
    // Out to the line's own edge (the opening rounds it a hair inside), not over the colours before
    // it (nor, filled, over the lines it was filled up to).
    cs = cs.offset(PAINT_SNAP, 'Miter').intersect(lineCs);
    if (a.fill && !a.fill.isEmpty()) cs = cs.subtract(lineCs.subtract(a.area).intersect(a.fill.offset(2 * PAINT_SNAP, 'Miter')));
    if (anchor) cs = cs.subtract(anchor);
    for (const c of colours) cs = cs.subtract(c.cs);
    if (!cs.isEmpty() && cs.area() > 1e-4) colours.push({ filament: a.filament, cs, fill: a.fill && !a.fill.isEmpty() ? a.fill : undefined });
  }
  if (!colours.length) return colours;
  // The piece's own filament near the colours, and its slivers there.
  const all = colours.reduce((u: any, c) => (u ? u.add(c.cs) : c.cs), null);
  let own = lineCs.subtract(all).intersect(all.offset(3 * r, 'Round'));
  if (anchor && !own.isEmpty()) own = own.subtract(anchor);
  if (own.isEmpty()) return colours;
  let thin = own.subtract(open(own));
  // (What of it was filled goes back to its fill's colour; the lines a fill met stay as they are.)
  for (const c of colours) if (c.fill && !thin.isEmpty()) {
    const f = thin.intersect(c.fill);
    if (!f.isEmpty()) { c.cs = c.cs.add(f); thin = thin.subtract(c.fill); }
  }
  if (thin.isEmpty()) return colours;
  const grown = colours.map((c) => { const p = c.fill ? c.cs.subtract(c.fill.offset(PAINT_SNAP, 'Miter')) : c.cs; return p.area() > 1e-4 ? p.offset(0.02, 'Miter') : null; });
  if (grown.every((g) => !g)) return colours;
  for (const bit of thin.decompose()) {
    let best = -1, most = 1e-6;
    grown.forEach((g, k) => { const t = g ? bit.intersect(g).area() : 0; if (t > most) { most = t; best = k; } });
    if (best >= 0) colours[best].cs = colours[best].cs.add(bit);
  }
  return colours;
}

/** Room kept in each piece for seams that wander and for dovetails (mm): Auto picks enough pieces for it. */
