// The drawing's lines cleaned up on the pixel grid: redrawn at an even width, loose bits bridged
// or dropped, loose ends joined to the nearest line.
import { capsuleXY, type LineArtGrid, N8, prune, type Pt, skeletonChains, sqDistance, strokePolyline, thin } from './raster';

export interface LineArtMaskOptions {
  lineWidth: number;
  /** Bridge every loose bit, however small (they were dropped beforehand, from the drawing itself). */
  keepSpecks?: boolean;
  /** Join loose line ends to the nearest line within this many mm (0: leave them, only counted). */
  joinEnds?: number;
  /**
   * No bridge longer than this (mm) between two bits that are both at least `minPart` mm² (a big
   * piece split into pieces: such bits become pieces of their own rather than get a long strut).
   */
  maxBridge?: number;
  minPart?: number;
  /** Where bridges and joins may go (a piece of a split: its outline); default anywhere. */
  inside?: Uint8Array | null;
  fill: number;
  minIsland: number;
  lines: 'even' | 'keep';
}

/**
 * The drawing `art` made printable as one piece, on grid `g`: lines redrawn at an even width (or
 * only thin ones thickened), specks dropped, and loose bits bridged to the rest and to `anchor`
 * (the bar or frame, which is not part of the result). `mask` is the whole result; `paths` the
 * centre lines of what Jig drew (thickened lines and bridges, `lineWidth` wide, in pixels), which
 * lines 'keep' adds to the drawing as it was.
 */
export function lineArtMask(art: Uint8Array, anchor: Uint8Array | null, g: LineArtGrid, o: LineArtMaskOptions): { mask: Uint8Array; paths: Pt[][]; bridges: number; longestBridge: number; dropped: number; closed: number; openings: number; endsJoined: number; endsFree: number; joins: Pt[][]; loose: Pt[] } {
  const { w, h, px } = g, N = w * h;
  const r = o.lineWidth / px / 2;
  // Keep the outermost pixels empty (thinning and tracing rely on it).
  for (let x = 0; x < w; x++) { art[x] = 0; art[N - w + x] = 0; }
  for (let y = 0; y < h; y++) { art[y * w] = 0; art[y * w + w - 1] = 0; }

  const nb = N8(w);
  const stack: number[] = [];
  // Loose bits of the drawing too small to print on their own are dropped (pieces touching the bar
  // or frame are never loose).
  const minPx = o.minIsland / (px * px);
  let dropped = 0;
  {
    const seen = new Uint8Array(N), comp: number[] = [];
    for (let s = 0; s < N; s++) {
      if (seen[s] || !art[s]) continue;
      comp.length = 0; comp.push(s); seen[s] = 1;
      let anchored = false;
      for (let q = 0; q < comp.length; q++) {
        const i = comp[q];
        if (anchor?.[i]) anchored = true;
        for (const k of nb) { const j = i + k; if (!seen[j] && (art[j] || anchor?.[j])) { seen[j] = 1; comp.push(j); } }
      }
      if (!o.keepSpecks && !anchored && comp.length < minPx) { for (const i of comp) art[i] = 0; dropped++; }
    }
  }

  // Solid areas: what an opening by a disc as wide as `fill` keeps.
  const bg = new Uint8Array(N);
  for (let i = 0; i < N; i++) bg[i] = art[i] ? 0 : 1;
  const inside = sqDistance(bg, w, h);
  // A piece of a split: a sliver a seam cut off along a line's edge (thinner than half a line and
  // touching the piece's edge) goes before anything is joined to it.
  if (o.inside) {
    const seen = new Uint8Array(N), comp: number[] = [];
    for (let s0 = 0; s0 < N; s0++) {
      if (!art[s0] || seen[s0]) continue;
      comp.length = 0; comp.push(s0); seen[s0] = 1;
      let deepest = 0, edge = false, anchored = false;
      for (let q = 0; q < comp.length; q++) {
        const i = comp[q];
        deepest = Math.max(deepest, inside[i]);
        if (anchor?.[i]) anchored = true;
        for (const k of nb) {
          const j = i + k;
          if (!o.inside[j]) edge = true;
          if (art[j] && !seen[j]) { seen[j] = 1; comp.push(j); }
        }
      }
      if (edge && !anchored && (2 * Math.sqrt(deepest) - 1) * px < 0.5 * o.lineWidth) {
        for (const i of comp) { art[i] = 0; bg[i] = 1; inside[i] = 0; }
        dropped++;
      }
    }
  }
  const R = Math.max(r + 1, (o.fill / px + 1) / 2);
  const core = new Uint8Array(N);
  let anyCore = false;
  for (let i = 0; i < N; i++) if (inside[i] >= R * R) { core[i] = 1; anyCore = true; }
  const solid = new Uint8Array(N);
  if (anyCore) {
    const near = sqDistance(core, w, h);
    for (let i = 0; i < N; i++) if (art[i] && near[i] <= R * R) solid[i] = 1;
  }

  // Lines: the skeleton, followed as smoothed polylines and drawn `lineWidth` wide – every line
  // ('even'), or ('keep') only where the drawing's own line is thinner than that, so lines thick
  // enough stay exactly as drawn.
  const skel = art.slice();
  const fg = thin(skel, w);
  if (o.lines === 'even') prune(skel, fg, w, Math.ceil(r) + 1);
  // Thinning can wipe out a small blob (a dot, an eye) altogether: it keeps its middle pixel.
  const seen = new Uint8Array(N), comp: number[] = [];
  for (let s = 0; s < N; s++) {
    if (!art[s] || seen[s]) continue;
    comp.length = 0; comp.push(s); seen[s] = 1;
    let has = false, mid = s;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q];
      if (skel[i]) has = true;
      if (inside[i] > inside[mid]) mid = i;
      for (const k of nb) if (art[i + k] && !seen[i + k]) { seen[i + k] = 1; comp.push(i + k); }
    }
    if (!has) { skel[mid] = 1; fg.push(mid); }
  }
  const strokes = new Uint8Array(N);
  // The centre lines drawn (pixel coordinates), each `r` px wide: lines 'keep' builds them as exact shapes.
  const paths: Pt[][] = [];
  // A thin stretch shorter than this at a free end, joined to a thick line, is a corner's tip or a
  // thinning spur, not a line of its own: it keeps its drawn shape.
  const tip = Math.ceil(4 * r);
  // Thin: clearly under lineWidth (a line drawn at exactly lineWidth measures a little under it at its bends and on the pixel grid).
  const thinAt = (i: number) => inside[i] < (r - 0.25) ** 2;
  for (const chain of skeletonChains(skel, fg, w)) {
    if (o.lines === 'even') { paths.push(strokePolyline(strokes, w, h, chain, r)); continue; }
    const deg = (i: number) => nb.reduce((n, k) => n + skel[i + k], 0);
    for (let k = 0; k < chain.length;) {
      if (!thinAt(chain[k])) { k++; continue; }
      // One stretch, through short thick bits (a line about as wide as lineWidth flickers between
      // the two): one stroke, not several with jogs between them.
      let e = k;
      for (let j = k + 1; j < chain.length && j - e <= tip; j++) if (thinAt(chain[j])) e = j;
      const atStart = k === 0, atEnd = e === chain.length - 1;
      const freeTip = (atStart && deg(chain[0]) <= 1 && !atEnd) || (atEnd && deg(chain[chain.length - 1]) <= 1 && !atStart);
      // A thin run between two thick stretches or reaching a junction is a line; one alone at a
      // free end of a thick line is a tip.
      if (!(freeTip && e - k + 1 < tip)) paths.push(strokePolyline(strokes, w, h, chain.slice(Math.max(0, k - 1), e + 2), r));
      k = e + 1;
    }
  }
  const out = o.lines === 'keep' ? art.slice() : solid;
  for (let i = 0; i < N; i++) if (strokes[i]) out[i] = 1;
  // Detail lost: openings between the lines that were there and aren't any more.
  const openings = countOpenings(art, w, h, minPx), closed = Math.max(0, openings - countOpenings(out, w, h, minPx));

  // Pieces (8-connected), with the bar or frame.
  const label = new Int32Array(N);
  const sizes = [0];
  for (let s = 0; s < N; s++) {
    if (label[s] || !(out[s] || anchor?.[s])) continue;
    const l = sizes.length;
    let n = 0;
    label[s] = l; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      for (const k of nb) { const j = i + k; if (j >= 0 && j < N && !label[j] && (out[j] || anchor?.[j])) { label[j] = l; stack.push(j); } }
    }
    sizes.push(n);
  }
  // Bridges: grow every piece across the empty pixels at once; where two meet, the nearest points
  // of the two pieces are a candidate bridge. The shortest bridges that join everything (Kruskal).
  let bridges = 0, longest = 0;
  if (sizes.length > 2) {
    const src = new Int32Array(N).fill(-1);
    let queue: number[] = [];
    for (let i = 0; i < N; i++) if (label[i]) { src[i] = i; queue.push(i); }
    const best = new Map<number, [number, number, number, number]>(), more = new Map<number, [number, number, number, number][]>();
    const L = sizes.length;
    const dist = (a: number, b: number) => Math.hypot((a % w) - (b % w), ((a / w) | 0) - ((b / w) | 0));
    const meet = (i: number, j: number) => {
      const a = label[i], b = label[j];
      if (!b || a === b) return;
      const key = a < b ? a * L + b : b * L + a, d = dist(src[i], src[j]);
      const cur = best.get(key);
      if (!cur || d < cur[0]) best.set(key, [d, src[i], src[j], i]);
      // Kept inside the piece, the nearest points may not do: a few more of the nearest pairs.
      if (o.inside) {
        // (Spread out: one per line width along the two.)
        const list = more.get(key) ?? more.set(key, []).get(key)!, si = src[i], sj = src[j];
        if (list.length < 24 || d < list[list.length - 1][0]) {
          const near = list.findIndex((c) => dist(c[1], si) < 2 * r && dist(c[2], sj) < 2 * r);
          if (near < 0 || d < list[near][0]) {
            if (near >= 0) list.splice(near, 1);
            list.push([d, si, sj, i]);
            list.sort((x, y) => x[0] - y[0]);
            if (list.length > 24) list.pop();
          }
        }
      }
    };
    while (queue.length) {
      const next: number[] = [];
      for (const i of queue) {
        for (const k of nb) {
          const j = i + k;
          if (j < 0 || j >= N || (o.inside && !o.inside[j])) continue;
          if (!label[j]) { label[j] = label[i]; src[j] = src[i]; next.push(j); } else meet(i, j);
        }
      }
      queue = next;
    }
    const parent = Array.from({ length: L }, (_, l) => l);
    const find = (l: number): number => (parent[l] === l ? l : (parent[l] = find(parent[l])));
    const size = sizes.slice(), minPart = (o.minPart ?? 0) / (px * px);
    for (const [key, [d0, a0, b0, m0]] of [...best].sort((x, y) => x[1][0] - y[1][0])) {
      const ra = find(Math.floor(key / L)), rb = find(key % L);
      if (ra === rb) continue;
      const xy = (i: number): Pt => [i % w, (i / w) | 0];
      // Kept inside the piece: the nearest points straight, else the next nearest, else bent where the two grew together.
      let path: Pt[] | null = [xy(a0), xy(b0)], d = d0;
      if (o.inside && !within(o.inside, w, path[0], path[1])) {
        const cands = more.get(key) ?? [[d0, a0, b0, m0]];
        const ok = cands.find(([, a, b]) => within(o.inside!, w, xy(a), xy(b))) ?? cands.find(([, a, b, m]) => within(o.inside!, w, xy(a), xy(m)) && within(o.inside!, w, xy(m), xy(b)));
        path = !ok ? null : within(o.inside, w, xy(ok[1]), xy(ok[2])) ? [xy(ok[1]), xy(ok[2])] : [xy(ok[1]), xy(ok[3]), xy(ok[2])];
        if (path) d = path.reduce((n, p, k) => (k ? n + Math.hypot(p[0] - path![k - 1][0], p[1] - path![k - 1][1]) : 0), 0);
      }
      if (!path) continue;
      // Big bits farther apart than maxBridge aren't bridged (they become pieces of their own); a
      // small bit (a detail) may be joined a little farther, 60 mm at most unless maxBridge is more.
      if (o.maxBridge != null && d * px - o.lineWidth > (size[ra] >= minPart && size[rb] >= minPart ? o.maxBridge : Math.max(o.maxBridge, 60))) continue;
      parent[ra] = rb;
      size[rb] += size[ra];
      for (let k = 0; k + 1 < path.length; k++) capsuleXY(out, w, h, path[k], path[k + 1], r);
      paths.push(path);
      bridges++;
      longest = Math.max(longest, Math.max(0, d * px - o.lineWidth));
    }
  }
  const ends = o.joinEnds != null ? joinLooseEnds(out, anchor, g, o.lineWidth, o.joinEnds, paths, o.inside) : { joined: 0, free: 0, joins: [], loose: [] };
  return { mask: out, paths, bridges, longestBridge: longest, dropped, closed, openings, endsJoined: ends.joined, endsFree: ends.free, joins: ends.joins, loose: ends.loose };
}

/** A thin rectangle around the segment from a to b, `e` past it on every side (a point: a small square). */
export function band([ax, ay]: Pt, [bx, by]: Pt, e: number): Pt[] {
  const l = Math.hypot(bx - ax, by - ay), ux = l ? ((bx - ax) / l) * e : e, uy = l ? ((by - ay) / l) * e : 0;
  return [[ax - ux + uy, ay - uy - ux], [bx + ux + uy, by + uy - ux], [bx + ux - uy, by + uy + ux], [ax - ux - uy, ay - uy + ux]];
}

/** Whether the straight line from pixel a to pixel b stays on set pixels of `mask` (w wide). */
function within(mask: Uint8Array, w: number, [ax, ay]: Pt, [bx, by]: Pt): boolean {
  const n = Math.ceil(2 * Math.hypot(bx - ax, by - ay)) + 1;
  for (let k = 0; k <= n; k++) if (!mask[Math.round(ay + ((by - ay) * k) / n) * w + Math.round(ax + ((bx - ax) * k) / n)]) return false;
  return true;
}

/**
 * Joins what hangs loose: a line or a branch of lines (a bracket with a plate on it) attached to
 * the rest at one point only lifts off the wall, as only the tape behind the rest holds it. The
 * skeleton's loose ends are peeled off again and again, which leaves what is held at two or more
 * points; each hanging branch longer than max(3 mm, 3 line widths) gets a bridge from its farthest
 * end to the nearest other line within `reach` mm, preferring the way that line was going. Thick
 * shapes (windows, tyres) hold themselves and are never peeled. Bridges are drawn into `out`, and
 * their centre lines added to `paths`; `joins` has each from the loose end to the point it joined,
 * `loose` the farthest end of each branch left loose (pixels).
 */
function joinLooseEnds(out: Uint8Array, anchor: Uint8Array | null, g: LineArtGrid, lineWidth: number, reach: number, paths: Pt[][], inside?: Uint8Array | null): { joined: number; free: number; joins: Pt[][]; loose: Pt[] } {
  const { w, h, px } = g, N = w * h;
  const r = lineWidth / px / 2, R = reach / px, minArm = Math.max(3, 3 * lineWidth) / px;
  const whole = new Uint8Array(N), bg = new Uint8Array(N);
  for (let i = 0; i < N; i++) { whole[i] = out[i] || anchor?.[i] ? 1 : 0; bg[i] = whole[i] ? 0 : 1; }
  const depth = sqDistance(bg, w, h);
  const skel = whole.slice();
  const chains = skeletonChains(skel, thin(skel, w), w);
  const nb = N8(w);
  const deg = (i: number) => nb.reduce((n, k) => n + skel[i + k], 0);
  // A line is about lineWidth wide; a chain mostly deeper than this runs through something solid.
  const lineDepth = (1.6 * r + 1) ** 2;
  const thick = chains.map((c) => c.filter((i) => depth[i] > lineDepth).length * 2 > c.length);

  // Peel: a chain with a loose end goes, and its other end may become loose in turn.
  const at = new Map<number, number[]>();
  chains.forEach((c, k) => { for (const e of [c[0], c[c.length - 1]]) (at.get(e) ?? at.set(e, []).get(e)!).push(k); });
  const alive = chains.map(() => true);
  const live = (node: number) => (at.get(node) ?? []).filter((k) => alive[k]).length;
  const queue = [...at.keys()].filter((n) => live(n) === 1);
  while (queue.length) {
    const n = queue.pop()!;
    if (live(n) !== 1) continue;
    const k = at.get(n)!.find((c) => alive[c])!;
    const c = chains[k];
    if (thick[k] || c[0] === c[c.length - 1]) continue;
    alive[k] = false;
    const other = c[0] === n ? c[c.length - 1] : c[0];
    if (live(other) === 1) queue.push(other);
  }

  // The hanging branches: peeled chains joined at their ends, each with the point it hangs from.
  const seenChain = chains.map(() => false);
  const stamp = new Int32Array(N), steps = new Int32Array(N);
  let joined = 0, free = 0, run = 0;
  const joins: Pt[][] = [], loose: Pt[] = [];
  for (let k0 = 0; k0 < chains.length; k0++) {
    if (alive[k0] || seenChain[k0]) continue;
    const tree: number[] = [], todo = [k0];
    seenChain[k0] = true;
    let hang = -1;
    while (todo.length) {
      const k = todo.pop()!;
      tree.push(k);
      for (const e of [chains[k][0], chains[k][chains[k].length - 1]]) {
        if (live(e) > 0) hang = e;
        for (const j of at.get(e) ?? []) if (!alive[j] && !seenChain[j]) { seenChain[j] = true; todo.push(j); }
      }
    }
    const length = tree.reduce((n, k) => n + chains[k].length, 0);
    // A whole piece without any loop has nothing to hang from: leave it.
    if (hang < 0 || length < minArm) continue;
    const hx = hang % w, hy = (hang / w) | 0;
    // Its loose ends, farthest from where it hangs first, each with the chain leading to it.
    const ends: { e: number; chain: number[] }[] = [];
    for (const k of tree) {
      const c = chains[k];
      if (deg(c[0]) <= 1) ends.push({ e: c[0], chain: c });
      if (deg(c[c.length - 1]) <= 1) ends.push({ e: c[c.length - 1], chain: [...c].reverse() });
    }
    ends.sort((a, b) => Math.hypot((b.e % w) - hx, ((b.e / w) | 0) - hy) - Math.hypot((a.e % w) - hx, ((a.e / w) | 0) - hy));
    let done = false;
    for (const { e, chain } of ends) {
      const ex = e % w, ey = (e / w) | 0;
      // What belongs to the branch itself: all within its length along the piece from this end.
      run++;
      const limit = length + 3 * r;
      let wave = [e];
      stamp[e] = run; steps[e] = 0;
      while (wave.length) {
        const next: number[] = [];
        for (const i of wave) for (const o of nb) {
          const j = i + o;
          if (whole[j] && stamp[j] !== run && steps[i] + 1 <= limit) { stamp[j] = run; steps[j] = steps[i] + 1; next.push(j); }
        }
        wave = next;
      }
      // The way the line was going at its end.
      const back = chain[Math.min(chain.length - 1, Math.round(3 * r))];
      let dx = ex - (back % w), dy = ey - ((back / w) | 0);
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl; dy /= dl;
      let best = -1, bestScore = Infinity;
      const x0 = Math.max(1, Math.floor(ex - R)), x1 = Math.min(w - 2, Math.ceil(ex + R)), y0 = Math.max(1, Math.floor(ey - R)), y1 = Math.min(h - 2, Math.ceil(ey + R));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (!whole[i] || stamp[i] === run) continue;
        const d = Math.hypot(x - ex, y - ey);
        if (d > R || d < 1) continue;
        const cos = ((x - ex) * dx + (y - ey) * dy) / d;
        if (cos < -0.2) continue;
        const score = d * (2 - cos);
        if (score < bestScore && (!inside || within(inside, w, [ex, ey], [x, y]))) { bestScore = score; best = i; }
      }
      if (best < 0) continue;
      const bx = best % w, by = (best / w) | 0;
      // Reach a little into the line it joins, so the two overlap.
      const d = Math.hypot(bx - ex, by - ey), tx = bx + ((bx - ex) / d) * Math.min(r, d) * 0.5, ty = by + ((by - ey) / d) * Math.min(r, d) * 0.5;
      capsuleXY(out, w, h, [ex, ey], [tx, ty], r);
      capsuleXY(whole, w, h, [ex, ey], [tx, ty], r);
      paths.push([[ex, ey], [tx, ty]]);
      joins.push([[ex, ey], [bx, by]]);
      joined++;
      done = true;
      break;
    }
    if (!done) { free++; if (ends.length) loose.push([ends[0].e % w, (ends[0].e / w) | 0]); }
  }
  return { joined, free, joins, loose };
}

/** Enclosed empty areas of `img` (4-connected, not touching the border) of at least `min` pixels. */
function countOpenings(img: Uint8Array, w: number, h: number, min: number): number {
  const seen = new Uint8Array(w * h), stack: number[] = [];
  let n = 0;
  for (let s = 0; s < w * h; s++) {
    if (img[s] || seen[s]) continue;
    let size = 0, edge = false;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i / w) | 0;
      size++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { edge = true; }
      if (x > 0 && !img[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && !img[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !img[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && !img[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (!edge && size >= min) n++;
  }
  return n;
}
