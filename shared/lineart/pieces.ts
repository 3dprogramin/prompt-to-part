// A line art too big for the bed, cut into pieces with dovetails, each piece cleaned up on its own,
// labelled and laid out.
import { maxPiece } from '../printer';
import { boxFitter, dovetail, formatSplitSpec, keepTogether, pieceLabel, routeSeam, type Seam, seamAt, seamGeometry, type SplitGrid, type SplitSpec } from '../split';
import type { LineArtDeps, LineArtPieceInfo, LineArtResult, LineArtSplitInfo, LineArtStyle } from './info';
import { band, lineArtMask } from './mask';
import { strokeOutlines } from './outlines';
import { handEdits, type HandOp } from './paint';
import { type LineArtGrid, MAX_PIXELS, type Pt, rasterize } from './raster';
import type { LineArtStroke } from './strokes';
import { traceMask } from './trace';

export const SPLIT_RESERVE = 24;
export const SPLIT_MIN_PART = 200;
/** A split's pieces together get at most this many times the pixels the whole would get unsplit (MAX_PIXELS). */
const SPLIT_PIXELS = 2;
/** How deep a piece's name is engraved in its back, mm. */
export const LABEL_DEPTH = 0.4;

export const anchorWord = (style: LineArtStyle) => (style === 'framed' || style === 'medallion' ? 'frame' : 'bar');

/** A split as cached: the seams, each piece's outline and cleaned-up drawing, the dovetails, where the names go. */
interface SplitCached {
  seams: Seam[];
  /** Each piece's outline (with its tabs, without its sockets), its place in the grid and what the clean-up drew. */
  pieces: { col: number; row: number; region: Pt[][]; loops: Pt[][]; paths: Pt[][]; bridges: number; longestBridge: number; dropped: number; closed: number; openings: number; endsJoined: number; endsFree: number; joins: Pt[][]; loose: Pt[] }[];
  joints: LineArtSplitInfo['joints'];
  /** Each joint's tab (as joints). */
  tabs: Pt[][];
  noJoint: LineArtSplitInfo['noJoint'];
  /** The seam (its index) each of noJoint is on. */
  noJointSeam: number[];
  /** Where each piece's name goes (found when first asked). */
  labels: ({ x: number; y: number; size: number; rot: boolean } | null | undefined)[];
}
/** Recent splits, like `cache`. */
const splitCache = new Map<string, SplitCached>();

export interface SplitResult {
  seams: Seam[];
  /** The pieces in label order; `region` is the cell's outline on the first piece of a cell (null on A2b…); the loose ends joined and left on it. */
  pieces: { info: LineArtPieceInfo; region: any; lineCs: any; anchor: any; closed: number; openings: number; joins: Pt[][]; loose: Pt[] }[];
  joints: LineArtSplitInfo['joints'];
  noJoint: LineArtSplitInfo['noJoint'];
  /** Each seam's stretches where two pieces really meet (as LineArtSplitInfo's seams' cuts). */
  cuts: Pt[][][];
  /** The piece (its index) a point is on, -1 for none. */
  pieceAt: (p: Pt) => number;
  /** Where a piece's name goes on its back. */
  label: (i: number) => { x: number; y: number; size: number; rot: boolean } | null;
  /** What each fill added, over the pieces, and the filled bits dropped as loose. */
  filled: Map<LineArtStroke, any>;
  fillsLoose: number;
}

interface SplitInput {
  d: LineArtDeps;
  key: string;
  art: any;
  anchor: any;
  /** What the user erased and filled by hand (mm), applied to each piece after the clean-up. */
  hand: HandOp[];
  ab: { min: number[]; max: number[] };
  cols: number;
  rows: number;
  lineWidth: number;
  fill: number;
  minIsland: number;
  lines: 'even' | 'keep';
  joinEnds: number;
  segs: number;
  clearance: number;
  /** Bits of a piece farther apart than maxBridge (mm) and at least minPart mm² each become pieces of their own. */
  maxBridge: number;
  minPart: number;
  /** Key holder pegs on the bar: a seam keeps clear of each one's foot (`pegZone` mm) and room for a dovetail. */
  pegAt: Pt[];
  pegZone: number;
  barHeight: number;
  signText: any;
}

/**
 * The piece cut into cols × rows pieces: the seams (vertical ones the whole height, horizontal ones
 * per column), each piece's outline with dovetails where a seam crosses the bar or frame, and each
 * piece's drawing cleaned up on its own (specks dropped, loose bits bridged, dangling lines joined),
 * so a piece holds together without its neighbours.
 */
export function splitPieces(o: SplitInput): SplitResult {
  const { d, art, anchor, ab, cols, rows, lineWidth } = o;
  const { C } = d;
  const x0 = ab.min[0], x1 = ab.max[0], y0 = ab.min[1], y1 = ab.max[1], W = x1 - x0, H = y1 - y0;
  const Wc = W / cols, Hr = H / rows;
  // How far a seam may wander from the ideal cut: the pieces must still fit the bed.
  const bandFor = (cell: number) => Math.max(3, Math.min(40, 0.3 * cell, (maxPiece() - 10 - cell) / 2));
  const Bv = bandFor(Wc), Bh = bandFor(Hr), margin = 3;
  const Yt = y1 + 2 * margin + 1, Yb = y0 - 2 * margin - 1, Xl = x0 - 2 * margin - 1, Xr = x1 + 2 * margin + 1;
  let c = splitCache.get(o.key);
  // Each piece's outline and drawing as just cut (not cached: Manifold's objects), so they aren't cut twice.
  const fresh: { region: any; pan: any; pa: any }[] = [];
  if (!c) {
    const artPolys = art.toPolygons(), anchorPolys = anchor ? anchor.toPolygons() : null;
    const textPolys = o.signText ? o.signText.offset(0.5, 'Round').toPolygons() : null;
    const pxFor = (area: number) => Math.max(lineWidth / 4, Math.sqrt(area / 3e6));
    // What a seam's band holds; `rowSpan` (horizontal seams) keeps only what is in the seam's column.
    const sample = (g: SplitGrid, rowSpan?: (y: number) => [number, number]) => {
      const ink = rasterize(artPolys, g), anc = anchorPolys ? rasterize(anchorPolys, g) : null;
      const heavy = textPolys ? rasterize(textPolys, g) : null;
      // A peg's foot, and room beside it for a dovetail's tab and socket.
      const zone = o.pegZone + 12;
      const avoid = o.pegAt.length ? new Uint8Array(g.w * g.h) : null;
      if (avoid) for (const [x, y] of o.pegAt) rasterize([[[x - zone, y - o.barHeight], [x + zone, y - o.barHeight], [x + zone, y + o.barHeight], [x - zone, y + o.barHeight]]], g, avoid);
      if (rowSpan) for (let j = 0; j < g.h; j++) {
        const [a, b] = rowSpan(g.y1 - (j + 0.5) * g.px);
        for (let i = 0; i < g.w; i++) {
          const x = g.x0 + (i + 0.5) * g.px;
          if (x >= a && x <= b) continue;
          const k = j * g.w + i;
          ink[k] = 0; if (anc) anc[k] = 0; if (heavy) heavy[k] = 0; if (avoid) avoid[k] = 0;
        }
      }
      return { ink, anchor: anc, heavy, avoid };
    };
    let seams: Seam[] = [];
    for (let k = 1; k < cols; k++) {
      const xi = x0 + k * Wc, px = pxFor(2 * Bv * (H + 2 * margin));
      const g: SplitGrid = { px, x0: xi - Bv, y1: y1 + margin, w: Math.ceil((2 * Bv) / px) + 1, h: Math.ceil((H + 2 * margin) / px) };
      seams.push({ ...routeSeam(g, sample(g), 'v', xi, Bv, lineWidth), col: k, row: 0 });
    }
    const vg = seamGeometry(seams, cols, rows, Xl, Xr, Yt, Yb);
    for (let col = 0; col < cols; col++) {
      const left = vg.vLine(col), right = vg.vLine(col + 1);
      const xl = Math.min(...left.map((p) => p[0])) - 1, xr = Math.max(...right.map((p) => p[0])) + 1;
      for (let r = 1; r < rows; r++) {
        const yi = y1 - r * Hr, px = pxFor((xr - xl) * 2 * Bh);
        const g: SplitGrid = { px, x0: xl, y1: yi + Bh, w: Math.ceil((xr - xl) / px), h: Math.ceil((2 * Bh) / px) + 1 };
        seams.push({ ...routeSeam(g, sample(g, (y) => [seamAt(left, y, 1), seamAt(right, y, 1)]), 'h', yi, Bh, lineWidth), col, row: r });
      }
    }
    // A bit of the drawing a seam leaves on its own in a piece goes to the piece it carries on into.
    const pa = Math.max(lineWidth / 2, Math.sqrt(((Xr - Xl) * (Yt - Yb)) / 4e6));
    const ga: SplitGrid = { px: pa, x0: Xl, y1: Yt, w: Math.ceil((Xr - Xl) / pa), h: Math.ceil((Yt - Yb) / pa) };
    const kept = keepTogether({ g: ga, ink: rasterize(artPolys, ga), anchor: anchorPolys ? rasterize(anchorPolys, ga) : null, seams, cols, rows, box: [Xl, Xr, Yt, Yb], maxBridge: o.maxBridge, minPart: o.minPart, maxPiece: maxPiece() - 2 });
    seams = kept.seams;
    const geo = seamGeometry(seams, cols, rows, Xl, Xr, Yt, Yb);
    // Each piece's outline: its column's strip ∩ its row's strip in that column.
    const strip = (a: Pt[], b: Pt[]) => new C([[...a, ...[...b].reverse()]], 'EvenOdd');
    const regions: any[] = [];
    for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) regions.push(strip(geo.vLine(col), geo.vLine(col + 1)).intersect(strip(geo.hLine(col, r), geo.hLine(col, r + 1))));
    // Dovetails where a seam runs straight across the bar or frame: a tab on the piece before the
    // seam, its socket (with clearance) in the next one.
    const joints: LineArtSplitInfo['joints'] = [], noJoint: LineArtSplitInfo['noJoint'] = [], noJointSeam: number[] = [], tabs: Pt[][] = [];
    for (const [si, m] of seams.entries()) for (const run of m.runs) {
      const mid: Pt = [(run.a[0] + run.b[0]) / 2, (run.a[1] + run.b[1]) / 2];
      const n = m.dir === 'v' ? [1, 0] : [0, -1];
      const owner = geo.pieceAt([mid[0] - n[0], mid[1] - n[1]]), other = geo.pieceAt([mid[0] + n[0], mid[1] + n[1]]);
      if (owner === other) continue;
      const across = Math.hypot(run.b[0] - run.a[0], run.b[1] - run.a[1]);
      let made: { tab: Pt[]; head: number } | null = null, r2 = run, why = '';
      for (let k = 0; k < 4 && !made; k++) {
        const t = dovetail(r2, m.dir, o.clearance);
        if (!t) { why = k ? 'no room for a dovetail inside it here' : `only ${across.toFixed(1)} mm across here, too narrow for a dovetail (needs about ${(3 + 2.4 + 2 * o.clearance).toFixed(1)} mm)`; break; }
        // Its socket and a wall around it must stay inside the bar or frame.
        if (new C([t.tab], 'EvenOdd').offset(o.clearance + 0.6, 'Miter').subtract(anchor).area() < 0.01) { made = t; break; }
        why = 'no room for a dovetail inside it here';
        const sh = 0.85, cxm = (r2.a[0] + r2.b[0]) / 2, cym = (r2.a[1] + r2.b[1]) / 2;
        r2 = { a: [cxm + (r2.a[0] - cxm) * sh, cym + (r2.a[1] - cym) * sh], b: [cxm + (r2.b[0] - cxm) * sh, cym + (r2.b[1] - cym) * sh] };
      }
      if (!made) { noJoint.push({ at: mid, why }); noJointSeam.push(si); continue; }
      const tab = new C([made.tab], 'EvenOdd');
      regions[owner] = regions[owner].add(tab);
      regions[other] = regions[other].subtract(tab.offset(o.clearance, 'Miter'));
      joints.push({ at: mid, tab: pieceLabel(owner % cols, Math.floor(owner / cols)), socket: pieceLabel(other % cols, Math.floor(other / cols)), width: made.head });
      tabs.push(made.tab);
    }
    // Each piece cleaned up on its own, its pixels as fine as for a piece this size, but all of them
    // together no more than twice the pixels the whole would get unsplit (a wall-sized piece).
    const pieces: SplitCached['pieces'] = [];
    const pxMin = Math.max(lineWidth / (d.quality === 'draft' ? 3 : d.quality === 'high' ? 6 : 5), Math.sqrt((W * H) / (SPLIT_PIXELS * MAX_PIXELS[d.quality])));
    regions.forEach((region, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const pan = anchor ? anchor.intersect(region) : null;
      const pa = dropSpecks(C, art.intersect(region), pan, o.minIsland);
      if (pa.cs.isEmpty() && (!pan || pan.isEmpty())) return;
      const b = (pan && !pan.isEmpty() ? pa.cs.add(pan) : pa.cs).bounds();
      let px = pxMin;
      px = Math.max(px, Math.sqrt(((b.max[0] - b.min[0] + 8 * px) * (b.max[1] - b.min[1] + 8 * px)) / MAX_PIXELS[d.quality]));
      const g: LineArtGrid = { px, x0: b.min[0] - 4 * px, y1: b.max[1] + 4 * px, w: Math.ceil((b.max[0] - b.min[0]) / px) + 8, h: Math.ceil((b.max[1] - b.min[1]) / px) + 8 };
      const m = lineArtMask(rasterize(pa.cs.toPolygons(), g), pan && !pan.isEmpty() ? rasterize(pan.toPolygons(), g) : null, g, { lineWidth, fill: o.fill, minIsland: o.minIsland, lines: o.lines, keepSpecks: o.lines === 'keep', joinEnds: o.joinEnds, maxBridge: o.maxBridge, minPart: o.minPart, inside: rasterize(region.toPolygons(), g) });
      const mm = ([x, y]: Pt): Pt => [g.x0 + (x + 0.5) * px, g.y1 - (y + 0.5) * px];
      fresh.push({ region, pan, pa: pa.cs });
      pieces.push({
        col, row, region: region.toPolygons(),
        loops: o.lines === 'keep' ? [] : traceMask(m.mask, g, px * 0.35), paths: o.lines === 'keep' ? m.paths.map((p) => p.map(mm)) : [],
        bridges: m.bridges, longestBridge: m.longestBridge, dropped: m.dropped + pa.dropped, closed: m.closed, openings: m.openings, endsJoined: m.endsJoined, endsFree: m.endsFree, joins: m.joins.map((j) => j.map(mm)), loose: m.loose.map(mm),
      });
    });
    c = { seams, pieces, joints, tabs, noJoint, noJointSeam, labels: [] };
    splitCache.set(o.key, c);
    if (splitCache.size > 2) splitCache.delete(splitCache.keys().next().value!);
  }
  const cached = c;
  const geo = seamGeometry(cached.seams, cols, rows, Xl, Xr, Yt, Yb);
  // Each cell's parts: its main one (`mains`: the cells whose main part it is) and bits too far to bridge.
  interface Part { cell: number; lc: any; an: any; region: any; stats: SplitCached['pieces'][number][]; mains: number[] }
  const parts: Part[] = [];
  const filled = new Map<LineArtStroke, any>();
  let fillsLoose = 0;
  for (const [i, p] of cached.pieces.entries()) {
    const f = fresh[i];
    const region = f ? f.region : new C(p.region, 'EvenOdd');
    const pan = f ? f.pan : anchor ? anchor.intersect(region) : null;
    const pa = f ? f.pa : dropSpecks(C, art.intersect(region), pan, o.minIsland).cs;
    let lineCs = o.lines === 'keep' ? (p.paths.length ? pa.add(new C(strokeOutlines(p.paths, lineWidth / 2, o.segs / 4), 'NonZero')) : pa) : new C(p.loops, 'EvenOdd');
    // What the app drew stays on the piece: a bridge or a thickened line ends at the seam.
    lineCs = lineCs.intersect(region);
    const anc = pan && !pan.isEmpty() ? pan : null;
    // Erased and filled by hand, on this piece (a fill too, so what it holds on to is on it).
    if (o.hand.length) {
      const h = handEdits(C, lineCs, anc, o.hand, region);
      lineCs = h.lineCs;
      fillsLoose += h.loose;
      for (const [st, x] of h.filled) filled.set(st, filled.has(st) ? filled.get(st).add(x) : x);
    }
    // Bits too far apart to bridge become pieces of their own (A2, A2b…): the one on the bar or frame,
    // or the biggest, first – every part one piece, nothing loose in it. Specks too small to print
    // on their own (cut apart by an erase) go.
    const comps = (anc ? lineCs.add(anc) : lineCs).decompose().map((cs: any) => ({ cs, area: cs.area(), onAnchor: !!anc && !cs.intersect(anc).isEmpty() }))
      // (and slivers thinner than a line, where a seam ran along a line's edge)
      .filter((q: { cs: any; area: number; onAnchor: boolean }) => {
        if (q.onAnchor) return true;
        const b = q.cs.bounds();
        return q.area >= o.minIsland && Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]) >= 0.8 * lineWidth;
      })
      .sort((a: { onAnchor: boolean; area: number }, b: { onAnchor: boolean; area: number }) => +b.onAnchor - +a.onAnchor || b.area - a.area);
    const groups = comps.length ? comps.map((q: { cs: any }) => q.cs) : [null];
    const cell = p.row * cols + p.col;
    groups.forEach((g: any, k: number) => {
      const lc = g ? lineCs.intersect(g) : lineCs, an = anc && g ? anc.intersect(g) : anc;
      parts.push({ cell, lc, an: an && !an.isEmpty() ? an : null, region: k ? null : region, stats: k ? [] : [p], mains: k ? [] : [cell] });
    });
  }
  // A strip of the bar or frame with nothing else on it joins the strip it meets in the next piece
  // when the two still fit the bed (the dovetail between them filled in): no short sliver of frame
  // is a piece of its own.
  const boxOf = (q: Part) => (q.an ? q.lc.add(q.an) : q.lc).bounds();
  const alive = parts.map(() => true), tabs = cached.tabs.map((t) => new C([t], 'EvenOdd'));
  const jointLive = cached.joints.map(() => true);
  const bare = (q: Part) => !!q.an && q.lc.isEmpty();
  for (;;) {
    let best: [number, number] | null = null, bestSize = Infinity;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j];
      if (!alive[i] || !alive[j] || !bare(a) || !bare(b)) continue;
      const ba = boxOf(a), bb = boxOf(b);
      const size = Math.max(Math.max(ba.max[0], bb.max[0]) - Math.min(ba.min[0], bb.min[0]), Math.max(ba.max[1], bb.max[1]) - Math.min(ba.min[1], bb.min[1]));
      if (size > maxPiece() || size >= bestSize) continue;
      // They meet (across a seam, or a dovetail's clearance).
      if (ba.min[0] > bb.max[0] + 1 || bb.min[0] > ba.max[0] + 1 || ba.min[1] > bb.max[1] + 1 || bb.min[1] > ba.max[1] + 1) continue;
      if (a.an.offset(o.clearance + 0.05, 'Miter').intersect(b.an).isEmpty()) continue;
      best = [i, j]; bestSize = size;
    }
    if (!best) break;
    const [i, j] = best, a = parts[i], b = parts[j];
    let an = a.an.add(b.an);
    // A dovetail between them: its clearance filled.
    tabs.forEach((t: any, k: number) => {
      if (!jointLive[k]) return;
      const around = t.offset(o.clearance + 0.05, 'Miter');
      if (around.intersect(a.an).isEmpty() || around.intersect(b.an).isEmpty()) return;
      an = an.add(anchor.intersect(around));
      jointLive[k] = false;
    });
    parts[i] = { cell: a.cell, lc: a.lc, an, region: a.region && b.region ? a.region.add(b.region) : a.region ?? b.region, stats: [...a.stats, ...b.stats], mains: [...a.mains, ...b.mains] };
    alive[j] = false;
  }
  // Names: each piece's cell, then b, c… for more parts of that cell.
  const pieces: SplitResult['pieces'] = [];
  const mainOf = new Map<number, number>(), count = new Map<number, number>();
  // The pieces each cell's drawing and frame ended up in.
  const cellPieces = new Map<number, Set<number>>();
  parts.forEach((q, i) => {
    if (!alive[i]) return;
    const k = count.get(q.cell) ?? 0;
    count.set(q.cell, k + 1);
    for (const m of q.mains) mainOf.set(m, pieces.length);
    for (const c of [q.cell, ...q.mains]) (cellPieces.get(c) ?? cellPieces.set(c, new Set()).get(c)!).add(pieces.length);
    const label = `${pieceLabel(q.cell % cols, Math.floor(q.cell / cols))}${k ? String.fromCharCode(97 + k) : ''}`;
    const bb = boxOf(q), sum = (f: (s: SplitCached['pieces'][number]) => number) => q.stats.reduce((n, s) => n + f(s), 0);
    const info: LineArtPieceInfo = {
      label, col: q.cell % cols, row: Math.floor(q.cell / cols), size: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]], box: [bb.min[0], bb.min[1], bb.max[0], bb.max[1]],
      bridges: sum((s) => s.bridges), longestBridge: Math.max(0, ...q.stats.map((s) => s.longestBridge)), dropped: sum((s) => s.dropped), endsJoined: sum((s) => s.endsJoined), endsFree: sum((s) => s.endsFree),
      joints: 0, labelSize: 0,
    };
    pieces.push({ info, region: q.region, lineCs: q.lc, anchor: q.an, closed: sum((s) => s.closed), openings: sum((s) => s.openings), joins: [], loose: [] });
  });
  // The dovetails left, named by the pieces they join: the tab's piece holds it, the socket's piece meets it.
  const joints: LineArtSplitInfo['joints'] = [];
  cached.joints.forEach((jt, k) => {
    if (!jointLive[k]) return;
    const t = tabs[k], around = t.offset(o.clearance + 0.3, 'Miter');
    const tab = pieces.findIndex((q) => q.anchor && !q.anchor.intersect(t).isEmpty());
    const socket = pieces.findIndex((q, i) => i !== tab && q.anchor && !q.anchor.intersect(around).isEmpty());
    const named = { ...jt, tab: tab >= 0 ? pieces[tab].info.label : jt.tab, socket: socket >= 0 ? pieces[socket].info.label : jt.socket };
    joints.push(named);
    for (const q of pieces) if (q.info.label === named.tab || q.info.label === named.socket) q.info.joints++;
  });
  // Where pieces really meet: on each side of a seam, the pieces of that side's cell there (whose
  // box holds the point; all of the cell's away from them). No cut where both sides are one piece
  // (two strips of frame joined), beside an empty cell, outside the whole piece, or where a
  // horizontal seam runs on past its column.
  const vl = Array.from({ length: cols + 1 }, (_, k) => geo.vLine(k));
  const hl = Array.from({ length: cols }, (_, col) => Array.from({ length: rows + 1 }, (_, r) => geo.hLine(col, r)));
  const rowIn = (col: number, [x, y]: Pt) => {
    let row = 0;
    for (let r = 1; r < rows; r++) if (y < seamAt(hl[col][r], x, 0)) row = r;
    return row;
  };
  const near = 0.01;
  const holds = (b: LineArtPieceInfo['box'], [x, y]: Pt, e: number) => x >= b[0] - e && x <= b[2] + e && y >= b[1] - e && y <= b[3] + e;
  const whole: LineArtPieceInfo['box'] = [Math.min(...pieces.map((q) => q.info.box[0])), Math.min(...pieces.map((q) => q.info.box[1])), Math.max(...pieces.map((q) => q.info.box[2])), Math.max(...pieces.map((q) => q.info.box[3]))];
  const sideAt = (cell: number, p: Pt) => {
    const all = [...(cellPieces.get(cell) ?? [])], here = all.filter((i) => holds(pieces[i].info.box, p, near));
    return here.length ? here : all;
  };
  const meets = (m: Seam, p: Pt): boolean => {
    if (!holds(whole, p, 0)) return false;
    let a: number, b: number;
    if (m.dir === 'h') {
      if (p[0] < seamAt(vl[m.col], p[1], 1) - 1e-6 || p[0] > seamAt(vl[m.col + 1], p[1], 1) + 1e-6) return false;
      a = (m.row - 1) * cols + m.col; b = m.row * cols + m.col;
    } else {
      a = rowIn(m.col - 1, p) * cols + m.col - 1; b = rowIn(m.col, p) * cols + m.col;
    }
    const pa = sideAt(a, p), pb = sideAt(b, p);
    return pa.length > 0 && pb.length > 0 && new Set([...pa, ...pb]).size > 1;
  };
  const cuts = cached.seams.map((m) => seamCuts(m.points, (p) => meets(m, p)));
  // Each cell's joins and loose ends go on the piece of the cell they are on (A2b…), else its main piece.
  for (const s of cached.pieces) {
    const cell = s.row * cols + s.col, mine = pieces.flatMap((q, i) => (q.info.col === s.col && q.info.row === s.row ? [i] : []));
    const pieceOf = (p: Pt) => (mine.length > 1 ? mine.find((i) => !pieces[i].lineCs.intersect(new C([band(p, p, 0.05)], 'NonZero')).isEmpty()) : undefined) ?? mainOf.get(cell);
    for (const j of s.joins) { const i = pieceOf(j[0]); if (i != null) pieces[i].joins.push(j); }
    for (const p of s.loose) { const i = pieceOf(p); if (i != null) pieces[i].loose.push(p); }
  }
  return {
    seams: cached.seams, pieces, joints, cuts, filled, fillsLoose,
    // (A crossing of the frame where two strips were joined needs no dovetail.)
    noJoint: cached.noJoint.filter((j, k) => meets(cached.seams[cached.noJointSeam[k]], j.at)),
    pieceAt: (q) => mainOf.get(geo.pieceAt(q)) ?? -1,
    label: (i) => {
      if (cached.labels[i] === undefined) cached.labels[i] = placeLabel(d, pieces[i]);
      return cached.labels[i] ?? null;
    },
  };
}

/**
 * The stretches of polyline `pts` where `on` holds (sampled every half millimetre, each end found
 * exactly by bisection), as polylines.
 */
export function seamCuts(pts: Pt[], on: (p: Pt) => boolean): Pt[][] {
  const out: Pt[][] = [];
  if (!pts.length) return out;
  const at = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let was = on(pts[0]), run: Pt[] | null = was ? [pts[0]] : null;
  for (let k = 0; k + 1 < pts.length; k++) {
    const A = pts[k], B = pts[k + 1], n = Math.max(1, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1]) / 0.5));
    for (let s = 1; s <= n; s++) {
      if (on(at(A, B, s / n)) === was) continue;
      let lo = (s - 1) / n, hi = s / n;
      for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (on(at(A, B, mid)) === was) lo = mid; else hi = mid; }
      const X = at(A, B, (lo + hi) / 2);
      if (run) { run.push(X); out.push(run); run = null; } else run = [X];
      was = !was;
    }
    if (run) run.push(B);
  }
  if (run) out.push(run);
  // (Not a stretch too short to see.)
  return out.filter((r) => r.reduce((n, p, k) => (k ? n + Math.hypot(p[0] - r[k - 1][0], p[1] - r[k - 1][1]) : 0), 0) > 0.05);
}

/** `cs` without its loose bits smaller than `minIsland` mm² (those touching `anchor` aren't loose), and how many went. */
function dropSpecks(C: any, cs: any, anchor: any, minIsland: number): { cs: any; dropped: number } {
  const comps = cs.decompose();
  if (comps.length < 2) return { cs, dropped: 0 };
  const kept = comps.filter((p: any) => p.area() >= minIsland || (anchor && !p.intersect(anchor).isEmpty()));
  return kept.length === comps.length ? { cs, dropped: 0 } : { cs: C.compose(kept), dropped: comps.length - kept.length };
}

/**
 * Where a piece's name fits on its back: on the bar or frame if it can, else on the drawing's
 * solid areas – the biggest size that fits (8 mm cap height down to 3 mm, lying or standing; then
 * 2.5 mm, for a narrow frame, bar or line), as near the piece's middle as it can; null when it fits
 * nowhere.
 */
function placeLabel(d: LineArtDeps, p: { info: LineArtPieceInfo; lineCs: any; anchor: any }): { x: number; y: number; size: number; rot: boolean } | null {
  const [bx0, by0, bx1, by1] = p.info.box, prefer: Pt = [(bx0 + bx1) / 2, (by0 + by1) / 2];
  // A little of the piece all round the letters (they are only engraved 0.4 mm into its back).
  const lp = 0.25;
  const texts = [8, 6, 5, 4, 3, 2.5].map((size) => {
    const b = d.text(p.info.label, { size, halign: 'center', valign: 'center' }).bounds(), margin = size < 3 ? 0.4 : 0.6;
    return { size, w: b.max[0] - b.min[0] + 2 * margin, h: b.max[1] - b.min[1] + 2 * margin };
  });
  const fitters = new Map<any, { g: LineArtGrid; fit: ReturnType<typeof boxFitter> }>();
  const fitter = (cs: any) => {
    if (!fitters.has(cs)) {
      const b = cs.bounds();
      const g: LineArtGrid = { px: lp, x0: b.min[0] - lp, y1: b.max[1] + lp, w: Math.ceil((b.max[0] - b.min[0]) / lp) + 3, h: Math.ceil((b.max[1] - b.min[1]) / lp) + 3 };
      fitters.set(cs, { g, fit: boxFitter(rasterize(cs.toPolygons(), g), g.w, g.h) });
    }
    return fitters.get(cs)!;
  };
  for (const [cs, small] of [[p.anchor, false], [p.lineCs, false], [p.anchor, true], [p.lineCs, true]] as const) {
    if (!cs || cs.isEmpty()) continue;
    const { g, fit: fitBox } = fitter(cs);
    for (const t of texts) for (const rot of [false, true]) {
      if (t.size < 3 !== small) continue;
      const fit = fitBox(Math.ceil((rot ? t.h : t.w) / lp), Math.ceil((rot ? t.w : t.h) / lp), (prefer[0] - g.x0) / lp, (g.y1 - prefer[1]) / lp);
      if (fit) return { x: g.x0 + fit.x * lp, y: g.y1 - fit.y * lp, size: t.size, rot };
    }
  }
  return null;
}

/** The split for the Print tab, the app's report and the editor, moved by (dx, dy) like the piece. */
export function splitInfo(sp: SplitResult, spec: SplitSpec, grid: { cols: number; rows: number }, dx: number, dy: number, anchor: any, layout: LineArtSplitInfo['layout']): LineArtSplitInfo {
  const mv = ([x, y]: Pt): [number, number] => [x + dx, y + dy];
  return {
    spec: formatSplitSpec(spec), cols: grid.cols, rows: grid.rows, layout,
    pieces: sp.pieces.map((p) => ({ ...p.info, box: [p.info.box[0] + dx, p.info.box[1] + dy, p.info.box[2] + dx, p.info.box[3] + dy] })),
    seams: sp.seams.map((m, i) => ({ dir: m.dir, points: m.points.map(mv), crossings: m.crossings, cuts: sp.cuts[i].map((c) => c.map(mv)) })),
    joints: sp.joints.map((j) => ({ ...j, at: mv(j.at) })),
    noJoint: sp.noJoint.map((j) => ({ ...j, at: mv(j.at) })),
    anchor: anchor ? anchor.simplify(0.1).toPolygons().slice(0, 8).map((c: Pt[]) => c.map(mv)) : [],
  };
}

/**
 * How far the layout moves each part from its place on the wall: 'assembled' leaves hairline gaps
 * between the pieces, 'exploded' pulls them apart, 'print' sets the pieces (and a stand's base
 * pieces, below them) in a grid with room between them, centred on the origin.
 */
export function layoutOffsets(parts: LineArtResult['parts'], n: number, split: LineArtSplitInfo, layout: string, size: number): [number, number][] {
  const pieces = split.pieces;
  if (layout !== 'print') {
    const g = layout === 'assembled' ? 0.6 : Math.max(15, 0.06 * size);
    return parts.map((_, i): [number, number] => (i < n ? [(pieces[i].col - (split.cols - 1) / 2) * g, -(pieces[i].row - (split.rows - 1) / 2) * g] : [0, 0]));
  }
  const gap = 10;
  // A cell's pieces (A2, A2b…) side by side.
  const cells = new Map<number, number[]>();
  pieces.forEach((p, i) => { const k = p.row * split.cols + p.col; (cells.get(k) ?? cells.set(k, []).get(k)!).push(i); });
  const cellW = (k: number) => (cells.get(k) ?? []).reduce((a, i, j) => a + pieces[i].size[0] + (j ? gap : 0), 0);
  const colW: number[] = Array(split.cols).fill(0), rowH: number[] = Array(split.rows).fill(0);
  for (const [k, list] of cells) {
    const col = k % split.cols, row = Math.floor(k / split.cols);
    colW[col] = Math.max(colW[col], cellW(k));
    for (const i of list) rowH[row] = Math.max(rowH[row], pieces[i].size[1]);
  }
  const X = colW.map((_, c) => colW.slice(0, c).reduce((a, b) => a + b + gap, 0)), Y = rowH.map((_, r) => -rowH.slice(0, r).reduce((a, b) => a + b + gap, 0));
  const out: [number, number][] = pieces.map(() => [0, 0]);
  for (const [k, list] of cells) {
    const col = k % split.cols, row = Math.floor(k / split.cols);
    let x = X[col] + (colW[col] - cellW(k)) / 2;
    for (const i of list) {
      const p = pieces[i];
      out[i] = [x - p.box[0], Y[row] - (rowH[row] - p.size[1]) / 2 - p.box[3]];
      x += p.size[0] + gap;
    }
  }
  // A stand's base pieces in a row under the pieces.
  let bx = 0;
  const by = Y[split.rows - 1] - rowH[split.rows - 1] - gap;
  for (const p of parts.slice(n)) {
    const b = (p.shape as any).boundingBox();
    out.push([bx - b.min[0], by - b.max[1]]);
    bx += b.max[0] - b.min[0] + gap;
  }
  // Centred on the origin.
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  parts.forEach((p, i) => {
    const b = i < n ? { min: [pieces[i].box[0], pieces[i].box[1]], max: [pieces[i].box[2], pieces[i].box[3]] } : (p.shape as any).boundingBox();
    lo = [Math.min(lo[0], b.min[0] + out[i][0]), Math.min(lo[1], b.min[1] + out[i][1])]; hi = [Math.max(hi[0], b.max[0] + out[i][0]), Math.max(hi[1], b.max[1] + out[i][1])];
  });
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
  return out.map(([x, y]) => [x - cx, y - cy]);
}
