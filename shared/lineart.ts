// Line art: wall cut-outs of a drawing (a car and a motorbike on a key holder, a figure in a frame),
// printed flat in one colour as one connected piece. H.lineart takes a drawing (an attached SVG, a
// traced picture or one the image model drew), redraws its lines at an even width at the final
// size, joins loose bits to the rest with short bridges, drops specks too small to print, and adds
// the style's bar, frame, hooks or stand.
import type { Brim } from './print';

export const LINE_ART_STYLES = ['outline', 'keyholder', 'framed', 'medallion', 'sign', 'stand'] as const;
export type LineArtStyle = (typeof LINE_ART_STYLES)[number];
export const DEFAULT_LINE_ART_STYLE: LineArtStyle = 'outline';

/** The styles as the user sees them (the Line art ▾ menu). */
export const LINE_ART_STYLE_INFO: Record<LineArtStyle, { label: string; desc: string }> = {
  outline: { label: 'Outline', desc: 'Just the drawing, cut out in one piece' },
  keyholder: { label: 'Key holder', desc: 'Standing on a bar with pegs for keys' },
  framed: { label: 'Framed', desc: 'Inside a rectangular frame' },
  medallion: { label: 'Medallion', desc: 'Inside a round or oval frame' },
  sign: { label: 'Name sign', desc: 'Standing on a bar with a name or label' },
  stand: { label: 'Desk stand', desc: 'Stands in a slotted base on a desk or shelf' },
};

export function isLineArtStyle(v: unknown): v is LineArtStyle {
  return typeof v === 'string' && (LINE_ART_STYLES as readonly string[]).includes(v);
}

/** Options of H.lineart(source, opts); lengths in mm. */
export interface LineArtOptions {
  style?: LineArtStyle;
  /** Width of the whole piece (frame or bar included), default 200. */
  width?: number;
  /** Optional most height of the whole piece: the drawing shrinks to fit both. */
  height?: number;
  /** Thickness of the drawing, default 2. */
  thickness?: number;
  /** The drawing's line width (with lines 'keep', the thinnest a line may be), default 1. */
  lineWidth?: number;
  /** 'keep' (default): the drawing's own line weights, only lines thinner than lineWidth thickened; 'even': every line redrawn at lineWidth. */
  lines?: 'even' | 'keep';
  /** lines 'even': areas of the drawing wider than this stay solid fills (tyres, hair, shadows), default 3 × lineWidth. */
  fill?: number;
  /** Loose bits smaller than this (mm²) are dropped rather than bridged, default 4 × lineWidth². */
  minIsland?: number;
  /** Space between several drawings side by side (negative overlaps them), default 0. */
  gap?: number;
  /** Fill colours of the drawing that are its lines (default: all but white-ish ones). */
  colors?: string[];
  /** Part colour, default near-black. */
  color?: string;

  /** Bar styles (keyholder, sign, stand): the bar's height in the picture plane (default 12 / 16 / 10). */
  barHeight?: number;
  /** Bar styles: its thickness (default 4 for a key holder, else the drawing's thickness + 1). */
  barThickness?: number;
  /** Bar styles: how far the bar reaches past the drawing on each side, default 6. */
  overhang?: number;

  /** Key holder: number of pegs (default one per ~60 mm, at least 2). */
  hooks?: number;
  /** Key holder: how far a peg sticks out of the bar, default 15. */
  hookLength?: number;
  /** Key holder: peg diameter, default 6 (the cap is 3 mm wider). */
  hookDiameter?: number;

  /** Name sign: the text raised on the bar. */
  text?: string;
  /** Name sign: font (as H.text), default Roboto Bold. */
  font?: string;
  /** Name sign: cap height of the text, default 60 % of the bar's height. */
  textHeight?: number;
  /** Name sign: how far the text stands out of the bar, default 1. */
  textDepth?: number;

  /** Framed / medallion: the frame's width in the picture plane, default 4. */
  frameWidth?: number;
  /** Framed / medallion: the frame's thickness, default the drawing's thickness + 1. */
  frameThickness?: number;
  /** Framed / medallion: space between the drawing and the frame, default 0 (the drawing touches it). */
  padding?: number;
  /** Medallion: 'circle' (default) or 'oval' (the drawing's proportions). */
  shape?: 'circle' | 'oval';

  /** Desk stand: depth of the base, default 30. */
  standDepth?: number;
  /** Desk stand: height of the base, default 12 (the slot is 2 mm less). */
  standHeight?: number;
}

/** What a line-art part was made from and what Jig fixed, for the Print tab and Claude's report (PartMesh.lineArt). */
export interface LineArtInfo {
  style: LineArtStyle;
  /** The drawings, left to right. */
  sources: string[];
  /** Size of the whole piece [width, height] in the picture plane, mm. */
  size: [number, number];
  thickness: number;
  lineWidth: number;
  lines: 'even' | 'keep';
  /** Bridges Jig added to join loose bits, and the longest one, mm. */
  bridges: number;
  longestBridge: number;
  /** Loose bits too small to print that were dropped. */
  dropped: number;
  /** Openings of the drawing (spaces between its lines) that closed up because the lines are too close at this size: detail lost. */
  closed: number;
  /** Openings of the drawing at all (at least minIsland big), to judge `closed` by. */
  openings: number;
  /** Key holder pegs. */
  hooks: number;
}

/** What H.lineart returns; a script returns it as it is (or adds to its parts). */
export interface LineArtResult {
  /** The piece (lineArt on it), plus the base for a desk stand. */
  parts: { name: string; shape: unknown; color: string; lineArt?: LineArtInfo }[];
  print: { layerHeight: number; walls: number; infill: number; infillPattern: string; brim: Brim };
  lineArt: LineArtInfo;
  /** How to print and hang it. */
  note: string;
}

/** Whether a model script builds line art (H.lineart): its follow-ups stay line art. */
export function isLineArt(code: string | undefined): boolean {
  return !!code && /\bH\.lineart\s*\(/.test(code);
}

/** A part's line-art info from a script's output, checked, lengths scaled with the part. */
export function cleanLineArtInfo(raw: unknown, scale = 1): LineArtInfo | undefined {
  const o = raw as LineArtInfo | null;
  if (!o || typeof o !== 'object' || !isLineArtStyle(o.style) || !Array.isArray(o.sources) || !Array.isArray(o.size)) return undefined;
  const len = [o.size[0], o.size[1], o.thickness, o.lineWidth, o.longestBridge].map(Number);
  if (!len.every((v) => Number.isFinite(v) && v >= 0)) return undefined;
  const [w, h, thickness, lineWidth, longestBridge] = len.map((v) => v * scale);
  const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
  return {
    style: o.style, sources: o.sources.filter((s) => typeof s === 'string').slice(0, 8).map((s) => s.slice(0, 120)),
    size: [w, h], thickness, lineWidth, lines: o.lines === 'even' ? 'even' : 'keep',
    bridges: count(o.bridges), longestBridge, dropped: count(o.dropped), closed: count(o.closed), openings: count(o.openings), hooks: count(o.hooks),
  };
}

/** Print settings for line art: flat, one colour, solid (2 mm is all top and bottom layers anyway), no brim to pick out of the lines. */
export function lineArtPrint(): LineArtResult['print'] {
  return { layerHeight: 0.2, walls: 2, infill: 100, infillPattern: 'zig-zag', brim: 'none' };
}

// ---------------------------------------------------------------------------
// The drawing on a pixel grid
// ---------------------------------------------------------------------------
//
// The drawing is rasterized at its final size (about 5 pixels per line width), and the work is done
// on pixels, where widths and gaps are easy to measure: the lines' centre lines (a thinned
// skeleton) are drawn again at an even width, areas much wider than a line stay solid, loose bits
// are joined to the rest along the shortest gaps (a minimum spanning tree) or dropped when too
// small to print, and the result is traced back into smooth polygons.

/** A pixel grid over the piece: pixel (i, j) has its centre at (x0 + (i + ½)·px, y1 − (j + ½)·px) mm; row 0 is the top. */
export interface LineArtGrid { w: number; h: number; px: number; x0: number; y1: number }

type Pt = [number, number];

/** Even-odd fill of `contours` (mm) on the grid. */
export function rasterize(contours: Pt[][], g: LineArtGrid, out = new Uint8Array(g.w * g.h)): Uint8Array {
  // Edges bucketed by the first row they cross, so each row only looks at its own edges.
  const rows: number[][] = Array.from({ length: g.h }, () => []);
  const edges: number[] = [];
  for (const c of contours) {
    for (let k = 0; k < c.length; k++) {
      const [ax, ay] = c[k], [bx, by] = c[(k + 1) % c.length];
      if (ay === by) continue;
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      // Rows whose centre Y lies in [lo, hi).
      const jTop = Math.max(0, Math.ceil((g.y1 - hi) / g.px - 0.5)), jBot = Math.min(g.h - 1, Math.floor((g.y1 - lo) / g.px - 0.5));
      if (jTop > jBot) continue;
      const e = edges.length;
      edges.push(ax, ay, bx, by, jBot);
      rows[jTop].push(e);
    }
  }
  let active: number[] = [];
  const xs: number[] = [];
  for (let j = 0; j < g.h; j++) {
    active = active.filter((e) => edges[e + 4] >= j);
    for (const e of rows[j]) active.push(e);
    const y = g.y1 - (j + 0.5) * g.px;
    xs.length = 0;
    for (const e of active) {
      const ax = edges[e], ay = edges[e + 1], bx = edges[e + 2], by = edges[e + 3];
      if ((ay <= y) === (by <= y)) continue;
      xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.px - 0.5)), i1 = Math.min(g.w - 1, Math.floor((xs[k + 1] - g.x0) / g.px - 0.5));
      if (i1 >= i0) out.fill(1, j * g.w + i0, j * g.w + i1 + 1);
    }
  }
  return out;
}

const FAR = 1e20;

/** Squared distance (pixels²) from every pixel to the nearest pixel where `src` is set (Felzenszwalb–Huttenlocher). */
export function sqDistance(src: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : FAR;
  const n = Math.max(w, h), f = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) ** 2 + f[v[k]]; }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) d[y * w + x] = out[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) d[y * w + x] = out[x];
  }
  return d;
}

/** Zhang–Suen thinning: the one-pixel centre lines of `img` (changed in place). The border pixels must be empty. */
function thin(img: Uint8Array, w: number) {
  let fg: number[] = [];
  for (let i = 0; i < img.length; i++) if (img[i]) fg.push(i);
  const del: number[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (const i of fg) {
        const p2 = img[i - w], p3 = img[i - w + 1], p4 = img[i + 1], p5 = img[i + w + 1], p6 = img[i + w], p7 = img[i + w - 1], p8 = img[i - 1], p9 = img[i - w - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const a = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) + (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
        if (a !== 1) continue;
        if (step === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
        del.push(i);
      }
      for (const i of del) img[i] = 0;
      if (del.length) { changed = true; fg = fg.filter((i) => img[i]); }
    }
  }
  return fg;
}

const N8 = (w: number) => [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];

/**
 * Removes the spurs thinning leaves at a thick line's corners (branches up to `k` pixels long):
 * every loose end is cut back `k` pixels, then the ends that are left grow back along the skeleton
 * (real line ends get their length back, spurs don't), and a short line or dot that would vanish
 * altogether is kept.
 */
function prune(img: Uint8Array, fg: number[], w: number, k: number) {
  const nb = N8(w);
  const orig = img.slice();
  const count = (a: Uint8Array, i: number) => nb.reduce((n, o) => n + a[i + o], 0);
  for (let it = 0; it < k; it++) {
    const ends = fg.filter((i) => img[i] && count(img, i) === 1);
    if (!ends.length) break;
    for (const i of ends) img[i] = 0;
  }
  let ends = fg.filter((i) => img[i] && count(img, i) <= 1);
  for (let it = 0; it < k && ends.length; it++) {
    const next: number[] = [];
    for (const i of ends) for (const o of nb) if (orig[i + o] && !img[i + o]) { img[i + o] = 1; next.push(i + o); }
    ends = next;
  }
  // Skeleton pieces with nothing left (isolated pixels were never cut, so these are short lines).
  const seen = new Uint8Array(img.length);
  for (const s of fg) {
    if (seen[s] || !orig[s]) continue;
    const comp = [s];
    seen[s] = 1;
    let kept = false;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q];
      if (img[i]) kept = true;
      for (const o of nb) if (orig[i + o] && !seen[i + o]) { seen[i + o] = 1; comp.push(i + o); }
    }
    if (!kept) for (const i of comp) img[i] = 1;
  }
}

/** Removes the corner pixels of a skeleton's staircases (an L of two neighbours that touch each other anyway), so a line's pixels form a simple chain. */
function unstair(img: Uint8Array, fg: number[], w: number) {
  for (const i of fg) {
    if (!img[i]) continue;
    const n = img[i - w], e = img[i + 1], s = img[i + w], wv = img[i - 1];
    if ((n && e && !s && !wv && !img[i + w - 1]) || (e && s && !n && !wv && !img[i - w - 1]) || (s && wv && !n && !e && !img[i - w + 1]) || (wv && n && !s && !e && !img[i + w + 1])) img[i] = 0;
  }
}

/** The skeleton as chains of pixels from one end or junction to the next (closed loops too; a lone pixel is a chain of one). */
function skeletonChains(img: Uint8Array, fg: number[], w: number): number[][] {
  unstair(img, fg, w);
  const nb = N8(w);
  const nbrs = (i: number) => nb.map((k) => i + k).filter((j) => img[j]);
  const node = (i: number) => nbrs(i).length !== 2;
  const used = new Uint8Array(img.length), pairs = new Set<number>(), chains: number[][] = [];
  for (const s of fg) {
    if (!img[s] || !node(s)) continue;
    const ns = nbrs(s);
    if (!ns.length) { chains.push([s]); continue; }
    for (const first of ns) {
      if (used[first]) continue;
      const chain = [s];
      let prev = s, cur = first;
      for (;;) {
        chain.push(cur);
        if (node(cur)) break;
        used[cur] = 1;
        const next = nbrs(cur).find((j) => j !== prev)!;
        prev = cur; cur = next;
      }
      // Two junctions side by side: the same chain from both ends.
      if (chain.length === 2) {
        const key = Math.min(s, cur) * img.length + Math.max(s, cur);
        if (pairs.has(key)) continue;
        pairs.add(key);
      }
      chains.push(chain);
    }
  }
  // Closed loops (no end or junction on them).
  for (const s of fg) {
    if (!img[s] || used[s] || node(s)) continue;
    const chain = [s];
    used[s] = 1;
    let prev = s, cur = nbrs(s)[0];
    while (cur !== s && !used[cur]) {
      chain.push(cur); used[cur] = 1;
      const next = nbrs(cur).find((j) => j !== prev)!;
      prev = cur; cur = next;
    }
    chain.push(s);
    chains.push(chain);
  }
  return chains;
}

/** A chain of pixels drawn `r` px wide around its smoothed path, so a line drawn again doesn't follow the pixel steps of its skeleton; returns that path. */
function strokePolyline(img: Uint8Array, w: number, h: number, chain: number[], r: number): Pt[] {
  const raw: Pt[] = chain.map((i) => [i % w, (i / w) | 0]);
  // A running average over about half a line width takes out the skeleton's pixel zigzag; the
  // ends stay where they are (they meet other lines there).
  const m = Math.max(2, Math.round(r));
  const pts = raw.map((p, k): Pt => {
    if (k === 0 || k === raw.length - 1) return p;
    const a = Math.max(0, k - m), b = Math.min(raw.length - 1, k + m), c = Math.min(k - a, b - k);
    let x = 0, y = 0;
    for (let j = k - c; j <= k + c; j++) { x += raw[j][0]; y += raw[j][1]; }
    return [x / (2 * c + 1), y / (2 * c + 1)];
  });
  const path = pts.length > 2 ? simplifyOpen(pts, 0.4) : pts;
  if (path.length === 1) capsuleXY(img, w, h, path[0], path[0], r);
  for (let k = 0; k + 1 < path.length; k++) capsuleXY(img, w, h, path[k], path[k + 1], r);
  return path;
}

/** Ramer–Douglas–Peucker on an open polyline. */
function simplifyOpen(pts: Pt[], tol: number): Pt[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const A = pts[s], B = pts[e], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy || 1e-12;
    let worst = -1, wd = tol * tol;
    for (let k = s + 1; k < e; k++) {
      const P = pts[k], t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2));
      const d = (P[0] - A[0] - t * dx) ** 2 + (P[1] - A[1] - t * dy) ** 2;
      if (d > wd) { wd = d; worst = k; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([s, worst], [worst, e]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Draws a round-capped line of radius `r` px from point a to point b (pixel coordinates). */
function capsuleXY(img: Uint8Array, w: number, h: number, [ax, ay]: Pt, [bx, by]: Pt, r: number) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= r * r) img[y * w + x] = 1;
  }
}

/** Draws a round-capped line of radius `r` px from pixel a to pixel b. */
function capsule(img: Uint8Array, w: number, h: number, a: number, b: number, r: number) {
  capsuleXY(img, w, h, [a % w, (a / w) | 0], [b % w, (b / w) | 0], r);
}

export interface LineArtMaskOptions {
  lineWidth: number;
  /** Bridge every loose bit, however small (they were dropped beforehand, from the drawing itself). */
  keepSpecks?: boolean;
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
export function lineArtMask(art: Uint8Array, anchor: Uint8Array | null, g: LineArtGrid, o: LineArtMaskOptions): { mask: Uint8Array; paths: Pt[][]; bridges: number; longestBridge: number; dropped: number; closed: number; openings: number } {
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
  const thinAt = (i: number) => inside[i] < r * r;
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
    const best = new Map<number, [number, number, number]>();
    const L = sizes.length;
    const dist = (a: number, b: number) => Math.hypot((a % w) - (b % w), ((a / w) | 0) - ((b / w) | 0));
    const meet = (i: number, j: number) => {
      const a = label[i], b = label[j];
      if (!b || a === b) return;
      const key = a < b ? a * L + b : b * L + a, d = dist(src[i], src[j]);
      const cur = best.get(key);
      if (!cur || d < cur[0]) best.set(key, [d, src[i], src[j]]);
    };
    while (queue.length) {
      const next: number[] = [];
      for (const i of queue) {
        for (const k of nb) {
          const j = i + k;
          if (j < 0 || j >= N) continue;
          if (!label[j]) { label[j] = label[i]; src[j] = src[i]; next.push(j); } else meet(i, j);
        }
      }
      queue = next;
    }
    const parent = Array.from({ length: L }, (_, l) => l);
    const find = (l: number): number => (parent[l] === l ? l : (parent[l] = find(parent[l])));
    for (const [key, [d, a, b]] of [...best].sort((x, y) => x[1][0] - y[1][0])) {
      const ra = find(Math.floor(key / L)), rb = find(key % L);
      if (ra === rb) continue;
      parent[ra] = rb;
      capsule(out, w, h, a, b, r);
      paths.push([[a % w, (a / w) | 0], [b % w, (b / w) | 0]]);
      bridges++;
      longest = Math.max(longest, Math.max(0, d * px - o.lineWidth));
    }
  }
  return { mask: out, paths, bridges, longestBridge: longest, dropped, closed, openings };
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

/** The outlines of `mask` (lightly smoothed, then marching squares at half height), simplified to `tol` mm; mm coordinates, even-odd. */
export function traceMask(mask: Uint8Array, g: LineArtGrid, tol: number): Pt[][] {
  const { w, h } = g;
  // A 3×3 box blur rounds the pixel steps off.
  const v = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    v[i] = (mask[i - w - 1] + mask[i - w] + mask[i - w + 1] + mask[i - 1] + mask[i] + mask[i + 1] + mask[i + w - 1] + mask[i + w] + mask[i + w + 1]) / 9;
  }
  return traceField(v, g, 0.5, tol);
}

/**
 * The outlines where `v` crosses `iso` (marching squares, the crossing placed between pixels by
 * their values, so an anti-aliased picture gives sub-pixel edges), simplified to `tol`; mm
 * coordinates of grid `g`, even-odd. The outermost pixels must be below `iso`.
 */
export function traceField(v: ArrayLike<number>, g: LineArtGrid, iso: number, tol: number): Pt[][] {
  const { w, h, px } = g;
  // Crossing points on cell edges: horizontal edge (x, y)–(x+1, y) is 2·(y·w + x), vertical (x, y)–(x, y+1) is 2·(y·w + x) + 1.
  const pts = new Map<number, Pt>();
  const at = (e: number): Pt => {
    let p = pts.get(e);
    if (p) return p;
    const i = e >> 1, x = i % w, y = (i / w) | 0, j = e & 1 ? i + w : i + 1;
    const t = (iso - v[i]) / (v[j] - v[i]);
    const fx = e & 1 ? x : x + t, fy = e & 1 ? y + t : y;
    p = [g.x0 + (fx + 0.5) * px, g.y1 - (fy + 0.5) * px];
    pts.set(e, p);
    return p;
  };
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    const a = v[i] > iso, b = v[i + 1] > iso, c = v[i + w + 1] > iso, d = v[i + w] > iso;
    if (a === b && b === c && c === d) continue;
    const T = 2 * i, B = 2 * (i + w), Lf = 2 * i + 1, Rt = 2 * (i + 1) + 1;
    const cross = [a !== b && T, b !== c && Rt, d !== c && B, a !== d && Lf].filter((e) => e !== false) as number[];
    if (cross.length === 2) link(cross[0], cross[1]);
    else {
      // A saddle: the centre decides which corners are joined.
      const mid = (v[i] + v[i + 1] + v[i + w + 1] + v[i + w]) / 4 > iso;
      if (a === mid) { link(T, Rt); link(B, Lf); } else { link(T, Lf); link(Rt, B); }
    }
  }
  const seen = new Set<number>();
  const loops: Pt[][] = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop: Pt[] = [];
    let prev = -1, cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      loop.push(at(cur));
      const nx = links.get(cur)!;
      const next = nx[0] !== prev ? nx[0] : nx[1];
      prev = cur; cur = next;
      if (cur == null) break;
    }
    if (loop.length >= 3) loops.push(simplify(loop, tol));
  }
  return loops.filter((l) => l.length >= 3);
}

/** Ramer–Douglas–Peucker on a closed loop. */
function simplify(loop: Pt[], tol: number): Pt[] {
  if (loop.length < 8) return loop;
  // Split at the point farthest from the first, so both halves are open polylines.
  let far = 0, fd = -1;
  for (let k = 1; k < loop.length; k++) { const d = (loop[k][0] - loop[0][0]) ** 2 + (loop[k][1] - loop[0][1]) ** 2; if (d > fd) { fd = d; far = k; } }
  const keep = new Uint8Array(loop.length);
  keep[0] = keep[far] = 1;
  const t2 = tol * tol;
  const stack: [number, number][] = [[0, far], [far, loop.length]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const A = loop[s], Bp = loop[e % loop.length];
    const dx = Bp[0] - A[0], dy = Bp[1] - A[1], L2 = dx * dx + dy * dy || 1e-12;
    let worst = -1, wd = t2;
    for (let k = s + 1; k < e; k++) {
      const P = loop[k], t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2));
      const d = (P[0] - A[0] - t * dx) ** 2 + (P[1] - A[1] - t * dy) ** 2;
      if (d > wd) { wd = d; worst = k; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([s, worst], [worst, e]); }
  }
  return loop.filter((_, k) => keep[k]);
}

// ---------------------------------------------------------------------------
// The piece
// ---------------------------------------------------------------------------

/** Round-capped strokes `r` mm wide along `paths` (mm) as counter-clockwise outlines – a quad per segment and a disc per point – whose union (NonZero) is the strokes. */
function strokeOutlines(paths: Pt[][], r: number, n: number): Pt[][] {
  const m = Math.max(8, Math.round(n));
  const disc: Pt[] = Array.from({ length: m }, (_, k) => [Math.cos((2 * Math.PI * k) / m) * r, Math.sin((2 * Math.PI * k) / m) * r]);
  const out: Pt[][] = [];
  for (const p of paths) {
    for (const [x, y] of p) out.push(disc.map(([dx, dy]) => [x + dx, y + dy]));
    for (let k = 0; k + 1 < p.length; k++) {
      const [ax, ay] = p[k], [bx, by] = p[k + 1], L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-9) continue;
      const nx = (-(by - ay) / L) * r, ny = ((bx - ax) / L) * r;
      out.push([[ax - nx, ay - ny], [bx - nx, by - ny], [bx + nx, by + ny], [ax + nx, ay + ny]]);
    }
  }
  return out;
}

/** What buildLineArt needs from the runtime (Manifold's classes, the text and drawing helpers). */
export interface LineArtDeps {
  M: any;
  C: any;
  quality: 'draft' | 'normal' | 'high';
  /** A drawing at unit height as a CrossSection (its lines), or an error. */
  section: (name: string, colors?: string[]) => any;
  /** A drawing's fingerprint, so a cached result is only reused for the same drawing. */
  fingerprint: (name: string) => string;
  text: (s: string, o: { size: number; font?: string; halign: 'center'; valign: 'center' }) => any;
}

/** Recent traced results: a live preview evaluates the same drawing on every slider move. */
const cache = new Map<string, { loops: Pt[][]; paths: Pt[][]; bridges: number; longestBridge: number; dropped: number; closed: number; openings: number }>();
const CACHE_SIZE = 6;
/** The most pixels of a grid (the pixels grow past it). */
const MAX_PIXELS = { draft: 1_500_000, normal: 4_000_000, high: 8_000_000 };
/** The A1's bed. */
const BED = 256;

export function buildLineArt(d: LineArtDeps, source: string | string[], opts: LineArtOptions = {}): LineArtResult {
  const { M, C } = d;
  const names = Array.isArray(source) ? source : [source];
  if (!names.length || names.length > 8 || !names.every((n) => typeof n === 'string')) throw new Error('H.lineart: give a drawing name or a list of 1–8 names');
  const style = opts.style ?? DEFAULT_LINE_ART_STYLE;
  if (!isLineArtStyle(style)) throw new Error(`H.lineart: style must be one of ${LINE_ART_STYLES.map((s) => `'${s}'`).join(', ')}`);
  const num = <K extends keyof LineArtOptions>(k: K, def: number, min: number, max: number): number => {
    const v = opts[k] ?? def;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`H.lineart: ${k} must be a number from ${min} to ${max}`);
    return v;
  };
  const bar = style === 'keyholder' || style === 'sign' || style === 'stand';
  const width = num('width', 200, 20, 1000);
  const thickness = num('thickness', 2, 0.6, 20);
  const lineWidth = num('lineWidth', 1, 0.4, 10);
  const lines = opts.lines === 'even' ? 'even' : 'keep';
  const fill = num('fill', 3 * lineWidth, lineWidth, 200);
  const minIsland = num('minIsland', 4 * lineWidth * lineWidth, 0, 10000);
  const gap = num('gap', 0, -500, 500);
  const barHeight = num('barHeight', style === 'sign' ? 16 : 12, 3, 200);
  const barThickness = num('barThickness', style === 'keyholder' ? 4 : style === 'stand' ? thickness : thickness + 1, 0.6, 30);
  const overhang = num('overhang', 6, 0, 200);
  const frameWidth = num('frameWidth', 4, 0.8, 100);
  const frameThickness = num('frameThickness', thickness + 1, 0.6, 30);
  const padding = num('padding', 0, 0, 200);
  const color = typeof opts.color === 'string' ? opts.color : '#1d1d1f';
  const segs = d.quality === 'draft' ? 48 : d.quality === 'normal' ? 96 : 160;

  // The drawings side by side at the same height (1 unit), bottoms on y = 0.
  const units = names.map((n) => {
    const cs = d.section(n, opts.colors);
    const b = cs.bounds();
    const h = b.max[1] - b.min[1];
    if (!(h > 0)) throw new Error(`H.lineart: drawing "${n}" is empty`);
    return { cs: cs.translate([-b.min[0], -b.min[1]]).scale(1 / h), w: (b.max[0] - b.min[0]) / h };
  });
  const sumW = units.reduce((a, u) => a + u.w, 0);
  // The art `s` mm high: its width, and the art placed with its box's bottom-left at the origin.
  const artWidth = (s: number) => s * sumW + gap * (names.length - 1);
  const placeArt = (s: number) => {
    let x = 0, art: any = null;
    for (const u of units) {
      const p = u.cs.scale(s).translate([x, 0]);
      art = art ? art.add(p) : p;
      x += u.w * s + gap;
    }
    return art;
  };
  const heightFor = (artW: number) => (artW - gap * (names.length - 1)) / sumW;

  // How far the art reaches into a bar or frame it touches.
  const overlap = Math.min(lineWidth, bar ? barHeight / 3 : frameWidth / 2);
  const ov = padding > 0 ? 0 : overlap;
  let s: number;
  if (style === 'outline') s = heightFor(width);
  else if (bar) s = heightFor(width - 2 * overhang);
  else if (style === 'framed') s = heightFor(width - 2 * (frameWidth + padding - ov));
  else s = heightFor(width - 2 * frameWidth); // medallion: refined below
  if (!(s > 0)) throw new Error('H.lineart: the drawing has no room – make width larger or gap, overhang or frameWidth smaller');
  // A height limit shrinks the art.
  if (opts.height != null) {
    const H = num('height', 0, 5, 1000);
    const room = style === 'outline' ? H : bar ? H - barHeight + overlap : style === 'framed' ? H - 2 * (frameWidth + padding - ov) : H - 2 * frameWidth;
    if (!(room > 0)) throw new Error('H.lineart: height leaves no room for the drawing');
    s = Math.min(s, room);
  }

  let art = placeArt(s);
  const aw = artWidth(s);
  let anchor: any = null, anchorThickness = 0;
  let pieceW = aw, pieceH = s;
  if (style === 'outline') art = art.translate([-aw / 2, 0]);
  else if (bar) {
    art = art.translate([-aw / 2, -overlap]);
    anchor = C.square([width, barHeight]).translate([-width / 2, -barHeight]);
    anchorThickness = barThickness;
    pieceW = width; pieceH = s - overlap + barHeight;
  } else if (style === 'framed') {
    art = art.translate([-aw / 2, -s / 2]);
    const hx = aw / 2 + padding - ov, hy = s / 2 + padding - ov;
    anchor = C.square([2 * (hx + frameWidth), 2 * (hy + frameWidth)], true).subtract(C.square([2 * hx, 2 * hy], true));
    anchorThickness = frameThickness;
    pieceW = 2 * (hx + frameWidth); pieceH = 2 * (hy + frameWidth);
  } else {
    // Medallion: the art as large as fits inside the ring (touching it, unless padding).
    const oval = opts.shape === 'oval';
    let a = width / 2, b = oval ? (width / 2) * (s / aw) : width / 2;
    if (opts.height != null && 2 * b > opts.height) { const k = opts.height / (2 * b); a *= k; b *= k; }
    const ia = a - frameWidth, ib = b - frameWidth;
    if (!(ia > 0 && ib > 0)) throw new Error('H.lineart: frameWidth leaves no room inside the medallion');
    const fa = ia + ov - padding, fb = ib + ov - padding;
    art = art.translate([-aw / 2, -s / 2]);
    let k = 0;
    for (const c of art.toPolygons()) for (const [x, y] of c) k = Math.max(k, Math.hypot(x / fa, y / fb));
    if (!(k > 0)) throw new Error('H.lineart: the drawing is empty');
    art = art.scale(1 / k);
    s /= k;
    const ring = (rx: number, ry: number) => C.circle(1, segs).scale([rx, ry]);
    anchor = ring(a, b).subtract(ring(ia, ib));
    anchorThickness = frameThickness;
    pieceW = 2 * a; pieceH = 2 * b;
  }

  // Loose bits too small to print on their own are dropped (those touching the bar or frame aren't loose).
  let vectorDropped = 0;
  const pieces = art.decompose();
  if (pieces.length > 1) {
    const kept = pieces.filter((p: any) => p.area() >= minIsland || (anchor && !p.intersect(anchor).isEmpty()));
    vectorDropped = pieces.length - kept.length;
    if (vectorDropped) art = C.compose(kept);
  }

  // The drawing made printable, on a pixel grid over the whole piece.
  const ab = (anchor ? art.add(anchor) : art).bounds();
  let px = lineWidth / (d.quality === 'draft' ? 3 : d.quality === 'high' ? 6 : 5);
  const area = (ab.max[0] - ab.min[0] + 8 * px) * (ab.max[1] - ab.min[1] + 8 * px);
  px = Math.max(px, Math.sqrt(area / MAX_PIXELS[d.quality]));
  const key = JSON.stringify([names.map((n) => d.fingerprint(n)), opts.colors ?? null, style, s, aw, gap, lineWidth, lines, fill, minIsland, pieceW, pieceH, barHeight, overhang, frameWidth, padding, opts.shape ?? '', px]);
  let res = cache.get(key);
  if (!res) {
    const g: LineArtGrid = { px, x0: ab.min[0] - 4 * px, y1: ab.max[1] + 4 * px, w: Math.ceil((ab.max[0] - ab.min[0]) / px) + 8, h: Math.ceil((ab.max[1] - ab.min[1]) / px) + 8 };
    const m = lineArtMask(rasterize(art.toPolygons(), g), anchor ? rasterize(anchor.toPolygons(), g) : null, g, { lineWidth, fill, minIsland, lines, keepSpecks: lines === 'keep' });
    const mm = ([x, y]: Pt): Pt => [g.x0 + (x + 0.5) * px, g.y1 - (y + 0.5) * px];
    res = { loops: lines === 'keep' ? [] : traceMask(m.mask, g, px * 0.35), paths: lines === 'keep' ? m.paths.map((p) => p.map(mm)) : [], bridges: m.bridges, longestBridge: m.longestBridge, dropped: m.dropped, closed: m.closed, openings: m.openings };
    cache.set(key, res);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  }
  // Lines kept as drawn: the drawing itself, exactly, with what Jig drew (thickened lines, bridges) added as exact shapes.
  const lineCs = lines === 'keep' ? (res.paths.length ? art.add(new C(strokeOutlines(res.paths, lineWidth / 2, segs / 4), 'NonZero')) : art) : new C(res.loops, 'EvenOdd');
  let shape = lineCs.extrude(thickness);
  if (anchor) shape = shape.add(anchor.extrude(anchorThickness));

  // Key holder: pegs out of the bar's front, printed standing up: a flared foot, the stem, and a
  // cap that keeps the keys on (its underside a 45° cone, no support).
  let hooks = 0;
  if (style === 'keyholder') {
    hooks = Math.round(num('hooks', Math.max(2, Math.round(width / 70)), 1, 20));
    const len = num('hookLength', 15, 6, 60), dia = num('hookDiameter', 6, 3, 20);
    const r = dia / 2, foot = 1, cap = 1.5, flare = 1.5;
    const peg = M.cylinder(foot, r + foot, r, segs / 2)
      .add(M.cylinder(len - cap - flare, r, r, segs / 2))
      .add(M.cylinder(flare, r, r + flare, segs / 2).translate([0, 0, len - cap - flare]))
      .add(M.cylinder(cap, r + flare, r + flare, segs / 2).translate([0, 0, len - cap]));
    const span = width - 2 * overhang;
    for (let i = 0; i < hooks; i++) shape = shape.add(peg.translate([-span / 2 + (span * (i + 0.5)) / hooks, -barHeight / 2, barThickness]));
  }
  // Name sign: the text raised on the bar, as large as fits.
  if (style === 'sign' && opts.text?.trim()) {
    const depth = num('textDepth', 1, 0.2, 10);
    let t = d.text(opts.text.trim(), { size: num('textHeight', barHeight * 0.6, 2, 200), font: opts.font, halign: 'center', valign: 'center' });
    const tb = t.bounds(), room = width - 2 * Math.max(overhang, barHeight * 0.3), tw = tb.max[0] - tb.min[0];
    if (tw > room) t = t.scale(room / tw);
    const cb = t.bounds();
    t = t.translate([-(cb.min[0] + cb.max[0]) / 2, -barHeight / 2 - (cb.min[1] + cb.max[1]) / 2]);
    shape = shape.add(t.extrude(depth).translate([0, 0, barThickness]));
  }
  const info: LineArtInfo = { style, sources: names, size: [pieceW, pieceH], thickness, lineWidth, lines, bridges: res.bridges, longestBridge: res.longestBridge, dropped: res.dropped + vectorDropped, closed: res.closed, openings: res.openings, hooks };
  const parts: LineArtResult['parts'] = [{ name: 'Line art', shape, color, lineArt: info }];
  // Desk stand: a base with a slot the bar pushes into, printed beside the piece.
  let slotNote = '';
  if (style === 'stand') {
    const depth = num('standDepth', 30, 10, 200), height = num('standHeight', 12, 4, 100);
    const slotDepth = Math.min(height - 2, barHeight - 2), slotW = barThickness + 0.3, len = width + 16;
    const base = M.cube([len, depth, height]).translate([-len / 2, 0, 0])
      .subtract(M.cube([width + 0.6, slotW, slotDepth + 1]).translate([-(width + 0.6) / 2, (depth - slotW) / 2, height - slotDepth]));
    parts.push({ name: 'Stand base', shape: base.translate([0, -barHeight - 10 - depth, 0]), color });
    slotNote = ` Print the base as well and push the bar into its slot (${slotW.toFixed(1)} mm wide, ${slotDepth.toFixed(0)} mm deep).`;
  }
  const big = pieceW > BED || pieceH > BED ? ` It is ${pieceW.toFixed(0)} × ${pieceH.toFixed(0)} mm, bigger than the A1's ${BED} mm bed: make it smaller.` : '';
  const note = `Print it flat, back on the bed, in one colour (black PLA): 0.2 mm layers, 100 % infill, no brim. ${style === 'keyholder' ? `The ${hooks} pegs print standing up. ` : ''}${style === 'stand' ? '' : 'Hang it with double-sided tape or Command strips.'}${slotNote}${big}`;
  return { parts, print: lineArtPrint(), lineArt: info, note };
}
