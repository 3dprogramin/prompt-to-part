// Splitting a flat piece bigger than the bed into pieces that each fit it (line art first; reliefs,
// signs and plaques can use it the same way). The model is cut along seams the app picks on a pixel
// grid of the piece: each seam is the cheapest path through a band around an ideal straight cut,
// where crossing a line costs a lot (more in fine detail), running close to one a little, and
// leaving the ideal cut a little too. Vertical seams run the whole height; the horizontal ones are
// found per column strip between them (they meet the vertical seams in T-joints, never cross them).
// Where a seam crosses a bar or frame it runs straight across it, so a dovetail fits there.
//
// Seams are data (polylines in mm): they could be stored and moved by hand later.
import { maxPiece as largestPiece } from './printer';

type Pt = [number, number];

/** A pixel grid: pixel (i, j) has its centre at (x0 + (i + ½)·px, y1 − (j + ½)·px) mm; row 0 is the top. */
export interface SplitGrid { w: number; h: number; px: number; x0: number; y1: number }

/** How to split: 'auto' (the fewest pieces that fit the bed), a number of pieces, or a grid [columns, rows]. */
export type SplitSpec = 'auto' | number | [number, number];

/** The most pieces of one split. */
export const MAX_PIECES = 100;

/**
 * A split choice from a script option or a design value: 'off', 'auto', a number of pieces (2–100)
 * or a grid ([3, 2], '3x2'); undefined when it isn't one (or isn't given).
 */
export function parseSplitSpec(raw: unknown): SplitSpec | 'off' | undefined {
  if (raw == null || raw === '') return undefined;
  if (raw === 'off' || raw === 'none' || raw === false || raw === 1) return 'off';
  if (raw === 'auto' || raw === true) return 'auto';
  const n = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v.trim())) ? Number(v) : NaN);
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw))) {
    const k = n(raw);
    return Number.isInteger(k) && k >= 2 && k <= MAX_PIECES ? k : k === 1 ? 'off' : undefined;
  }
  let grid: unknown[] | null = Array.isArray(raw) ? raw : null;
  if (typeof raw === 'string') { const m = /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i.exec(raw); if (m) grid = [m[1], m[2]]; }
  if (grid && grid.length === 2) {
    const [c, r] = grid.map(n);
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < 1 || r < 1 || c * r > MAX_PIECES) return undefined;
    return c * r === 1 ? 'off' : [c, r];
  }
  return undefined;
}

/** A split choice as text ('off', 'auto', '4', '3x2'): how a design value stores it. */
export function formatSplitSpec(s: SplitSpec | 'off'): string {
  return Array.isArray(s) ? `${s[0]}x${s[1]}` : String(s);
}

/** Columns × rows for a piece `w` × `h` mm: `reserve` mm of each piece's room is kept for seams that wander and dovetails. */
export function splitGrid(w: number, h: number, spec: SplitSpec, maxPiece = largestPiece(), reserve = 20): { cols: number; rows: number } {
  if (Array.isArray(spec)) return { cols: spec[0], rows: spec[1] };
  if (spec === 'auto') {
    // A direction that fits the bed needs no seam (and no room for one).
    const room = Math.max(maxPiece * 0.5, maxPiece - reserve);
    let cols = w <= maxPiece ? 1 : Math.ceil(w / room), rows = h <= maxPiece ? 1 : Math.ceil(h / room);
    while (cols * rows > MAX_PIECES) { if (cols >= rows) cols--; else rows--; }
    return { cols, rows };
  }
  // A number of pieces: the grid with that many whose biggest piece is smallest, then the squarest.
  let best = { cols: spec, rows: 1 }, score = Infinity;
  for (let c = 1; c <= spec; c++) {
    if (spec % c) continue;
    const r = spec / c, pw = w / c, ph = h / r;
    const s = Math.max(pw, ph) * 1000 + Math.abs(Math.log(pw / ph));
    if (s < score) { score = s; best = { cols: c, rows: r }; }
  }
  return best;
}

/** A piece's name: row letter(s) from the top + column number from the left, as seen from the front (A1, A2, B1…). */
export function pieceLabel(col: number, row: number): string {
  let s = '', r = row;
  do { s = String.fromCharCode(65 + (r % 26)) + s; r = Math.floor(r / 26) - 1; } while (r >= 0);
  return `${s}${col + 1}`;
}

/** What the model has at each pixel of a seam's band. */
export interface SeamSample {
  /** The model's lines or surface (crossing it cuts it). */
  ink: Uint8Array;
  /** A bar or frame: the seam crosses it straight, for a dovetail. */
  anchor?: Uint8Array | null;
  /** Never cut here (a peg). */
  avoid?: Uint8Array | null;
  /** Rather not cut here (raised text). */
  heavy?: Uint8Array | null;
}

/** A straight stretch of a seam across a bar or frame, from a to b (mm). */
export interface SeamRun { a: Pt; b: Pt }

/** A seam: a polyline (mm) from top to bottom ('v') or left to right ('h'). */
export interface Seam {
  dir: 'v' | 'h';
  /** 'v': between columns col − 1 and col; 'h': in column col, between rows row − 1 and row. */
  col: number;
  row: number;
  points: Pt[];
  /** Lines of the model it cuts through. */
  crossings: number;
  /** Where it runs straight across a bar or frame. */
  runs: SeamRun[];
}

/** Costs per mm of seam. */
const COST = { base: 1, ink: 60, near: 10, detail: 3, anchor: 5, heavy: 200, avoid: 1e6, leave: 2 };

/** Distance (pixels) from every pixel to the nearest set one, a two-pass chamfer (3–4) approximation. */
function chamfer(src: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  const BIG = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : BIG;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 3);
    if (y > 0) { v = Math.min(v, d[i - w] + 3); if (x > 0) v = Math.min(v, d[i - w - 1] + 4); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4); }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
    if (y < h - 1) { v = Math.min(v, d[i + w] + 3); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4); if (x > 0) v = Math.min(v, d[i + w - 1] + 4); }
    d[i] = v;
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

/** Share of set pixels in the (2r+1)² box around each pixel (a summed-area table). */
function density(src: Uint8Array, w: number, h: number, r: number): Float32Array {
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += src[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    out[y * w + x] = (S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  }
  return out;
}

/**
 * The cheapest seam through band grid `g` (dir 'v': top to bottom, any column of the grid; 'h':
 * left to right), the ideal cut at `ideal` mm (x for 'v', y for 'h'), `band` mm either side.
 * `lineWidth` (mm) scales what counts as near a line and as detail.
 */
export function routeSeam(g: SplitGrid, sample: SeamSample, dir: 'v' | 'h', ideal: number, band: number, lineWidth: number): Omit<Seam, 'col' | 'row'> {
  const { w, h, px } = g;
  const { ink, anchor, avoid, heavy } = sample;
  const dist = chamfer(ink, w, h);
  const dens = density(ink, w, h, Math.max(2, Math.round(Math.max(2, 3 * lineWidth) / px)));
  // Along the seam (t) and across it (s).
  const n = dir === 'v' ? h : w, m = dir === 'v' ? w : h;
  const idx = dir === 'v' ? (t: number, s: number) => t * w + s : (t: number, s: number) => s * w + t;
  const across = (s: number) => (dir === 'v' ? g.x0 + (s + 0.5) * px : g.y1 - (s + 0.5) * px);
  const nearMm = Math.max(1.5, 2 * lineWidth);
  const cost = new Float32Array(n * m);
  for (let t = 0; t < n; t++) for (let s = 0; s < m; s++) {
    const i = idx(t, s);
    const off = Math.min(1, Math.abs(across(s) - ideal) / Math.max(band, 1e-6));
    let c = COST.base + COST.leave * off * off;
    const dd = dens[i];
    if (avoid?.[i]) c += COST.avoid;
    if (anchor?.[i]) c += COST.anchor;
    else if (ink[i]) c += COST.ink * (1 + COST.detail * dd);
    else { const k = Math.max(0, 1 - (dist[i] * px) / nearMm); c += COST.near * k * k * (1 + COST.detail * dd); }
    if (heavy?.[i]) c += COST.heavy;
    cost[t * m + s] = c * px;
  }
  // Straight across a bar or frame (and a little either side of it): no sideways steps there.
  const zone = new Uint8Array(n * m);
  if (anchor) {
    const ext = Math.ceil(1.5 / px);
    for (let s = 0; s < m; s++) {
      let last = -1e9;
      for (let t = 0; t < n; t++) if (anchor[idx(t, s)]) last = t; else if (t - last <= ext) zone[t * m + s] = 1;
      last = 1e9;
      for (let t = n - 1; t >= 0; t--) if (anchor[idx(t, s)]) { last = t; zone[t * m + s] = 1; } else if (last - t <= ext) zone[t * m + s] = 1;
    }
  }
  // Dynamic programming, one step along at a time, at most one pixel sideways.
  const acc = new Float64Array(n * m), from = new Int8Array(n * m);
  for (let s = 0; s < m; s++) acc[s] = cost[s];
  for (let t = 1; t < n; t++) {
    for (let s = 0; s < m; s++) {
      let best = Infinity, bd = 0;
      for (let ds = -1; ds <= 1; ds++) {
        const p = s + ds;
        if (p < 0 || p >= m) continue;
        if (ds && (zone[t * m + s] || zone[(t - 1) * m + p])) continue;
        const v = acc[(t - 1) * m + p] + cost[t * m + s] * (ds ? Math.SQRT2 : 1);
        if (v < best) { best = v; bd = ds; }
      }
      acc[t * m + s] = best; from[t * m + s] = bd;
    }
  }
  let s = 0;
  for (let k = 1; k < m; k++) if (acc[(n - 1) * m + k] < acc[(n - 1) * m + s]) s = k;
  const path = new Int32Array(n);
  for (let t = n - 1; t >= 0; t--) { path[t] = s; s += from[t * m + s]; }

  const at = (t: number, s: number): Pt => (dir === 'v' ? [g.x0 + (s + 0.5) * px, g.y1 - (t + 0.5) * px] : [g.x0 + (t + 0.5) * px, g.y1 - (s + 0.5) * px]);
  const along = (t: number, s: number, k: number): Pt => (dir === 'v' ? [g.x0 + (s + 0.5) * px, g.y1 - (t + k) * px] : [g.x0 + (t + k) * px, g.y1 - (s + 0.5) * px]);
  // Straight runs across the bar or frame, and the lines cut.
  const runs: SeamRun[] = [];
  let crossings = 0;
  const keep = new Set<number>([0, n - 1]);
  for (let t = 0; t < n; t++) {
    const i = idx(t, path[t]);
    if (anchor?.[i] && !(t > 0 && anchor[idx(t - 1, path[t - 1])])) {
      let e = t;
      while (e + 1 < n && anchor[idx(e + 1, path[e + 1])] && path[e + 1] === path[t]) e++;
      runs.push({ a: along(t, path[t], 0), b: along(e, path[e], 1) });
      // The straight stretch stays exactly straight when the path is simplified.
      for (let k = t; k <= e; k++) if (k === t || k === e) keep.add(k);
    }
    if (ink[i] && !anchor?.[i] && !(t > 0 && ink[idx(t - 1, path[t - 1])])) crossings++;
  }
  // Simplified between the kept points (half a pixel off at most).
  const pts: Pt[] = [];
  const cuts = [...keep].sort((a, b) => a - b);
  for (let k = 0; k + 1 < cuts.length; k++) {
    const seg: Pt[] = [];
    for (let t = cuts[k]; t <= cuts[k + 1]; t++) seg.push(at(t, path[t]));
    const simp = rdp(seg, px * 0.5);
    pts.push(...(k ? simp.slice(1) : simp));
  }
  return { dir, points: pts, crossings, runs };
}

/** Ramer–Douglas–Peucker on an open polyline. */
function rdp(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
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

/** Where polyline `pts` (monotone along `axis`: 1 = y for a vertical seam, 0 = x for a horizontal one) is at `v` on that axis. */
export function seamAt(pts: Pt[], v: number, axis: 0 | 1): number {
  const o = 1 - axis;
  const first = pts[0], last = pts[pts.length - 1];
  const dec = first[axis] > last[axis];
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1];
    const lo = Math.min(a[axis], b[axis]), hi = Math.max(a[axis], b[axis]);
    if (v >= lo && v <= hi) return hi > lo ? a[o] + ((v - a[axis]) / (b[axis] - a[axis])) * (b[o] - a[o]) : a[o];
  }
  return (dec ? v > first[axis] : v < first[axis]) ? first[o] : last[o];
}

/** A seam's points stretched to `from`…`to` along its direction (so the pieces' outlines enclose everything). */
export function extendSeam(s: Seam, from: number, to: number): Pt[] {
  const p = s.points;
  if (s.dir === 'v') return [[p[0][0], from], ...p, [p[p.length - 1][0], to]];
  return [[from, p[0][1]], ...p, [to, p[p.length - 1][1]]];
}

/**
 * A dovetail across a straight stretch `run` of a seam: a tab (polygon, mm) on the piece before
 * the seam (left of a vertical seam, above a horizontal one) reaching into the next, as wide as
 * the bar or frame allows with `wall` mm left either side of its socket. Null when the stretch is
 * too short for one (`minHead` mm across its head).
 */
export function dovetail(run: SeamRun, dir: 'v' | 'h', clearance: number, minHead = 3): { tab: Pt[]; head: number; neck: number; length: number } | null {
  const [ax, ay] = run.a, [bx, by] = run.b;
  const L = Math.hypot(bx - ax, by - ay);
  const wall = Math.max(1.2, 0.15 * L);
  const head = L - 2 * wall - 2 * clearance;
  if (!(head >= minHead)) return null;
  const length = Math.min(10, Math.max(2.5, 0.8 * head));
  // Flanks about 14° off the seam's normal: the neck is narrower than the head, so it locks.
  const neck = Math.max(0.55 * head, head - 0.5 * length);
  const ux = (bx - ax) / L, uy = (by - ay) / L;
  // Into the next piece: right of a vertical seam, below a horizontal one.
  const [nx, ny] = dir === 'v' ? [1, 0] : [0, -1];
  const cx = (ax + bx) / 2, cy = (ay + by) / 2, back = 0.3;
  const p = (u: number, d: number): Pt => [cx + ux * u + nx * d, cy + uy * u + ny * d];
  const tab = [p(-neck / 2, -back), p(neck / 2, -back), p(head / 2, length), p(-head / 2, length)];
  // Counter-clockwise.
  let a2 = 0;
  for (let k = 0; k < tab.length; k++) { const [x0, y0] = tab[k], [x1, y1] = tab[(k + 1) % tab.length]; a2 += x0 * y1 - x1 * y0; }
  return { tab: a2 < 0 ? tab.reverse() : tab, head, neck, length };
}

/**
 * For `mask` (w × h): where a box `bw` × `bh` pixels fits entirely on its set pixels, the box's
 * centre nearest pixel (px, py); null when it fits nowhere. Ask as often as needed (one table).
 */
export function boxFitter(mask: Uint8Array, w: number, h: number): (bw: number, bh: number, px: number, py: number) => { x: number; y: number } | null {
  const S = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += mask[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; }
  }
  return (bw, bh, px, py) => {
    if (bw > w || bh > h) return null;
    const full = bw * bh;
    let best: { x: number; y: number } | null = null, bd = Infinity;
    for (let y = 0; y + bh <= h; y++) for (let x = 0; x + bw <= w; x++) {
      const sum = S[(y + bh) * (w + 1) + x + bw] - S[y * (w + 1) + x + bw] - S[(y + bh) * (w + 1) + x] + S[y * (w + 1) + x];
      if (sum !== full) continue;
      const cx = x + bw / 2, cy = y + bh / 2, d = (cx - px) ** 2 + (cy - py) ** 2;
      if (d < bd) { bd = d; best = { x: cx, y: cy }; }
    }
    return best;
  };
}

/** The seams' lines stretched over the whole piece (box Xl…Xr × Yb…Yt), and which piece (row-major index) a point is in. */
export function seamGeometry(seams: Seam[], cols: number, rows: number, Xl: number, Xr: number, Yt: number, Yb: number) {
  const vs = seams.filter((m) => m.dir === 'v').sort((a, b) => a.col - b.col);
  const vLine = (k: number): Pt[] => (k === 0 ? [[Xl, Yt], [Xl, Yb]] : k === cols ? [[Xr, Yt], [Xr, Yb]] : extendSeam(vs[k - 1], Yt, Yb));
  const hs = Array.from({ length: cols }, (_, col) => seams.filter((m) => m.dir === 'h' && m.col === col).sort((a, b) => a.row - b.row));
  const hLine = (col: number, r: number): Pt[] => (r === 0 ? [[Xl, Yt], [Xr, Yt]] : r === rows ? [[Xl, Yb], [Xr, Yb]] : extendSeam(hs[col][r - 1], Xl, Xr));
  const pieceAt = ([x, y]: Pt) => {
    let col = 0;
    for (let k = 1; k < cols; k++) if (x > seamAt(vLine(k), y, 1)) col = k;
    let row = 0;
    for (let r = 1; r < rows; r++) if (y < seamAt(hLine(col, r), x, 0)) row = r;
    return row * cols + col;
  };
  return { vLine, hLine, pieceAt };
}
type SeamGeometry = ReturnType<typeof seamGeometry>;

/** Which piece each pixel of `g` is in (as pieceAt), written into `out` for pixels i0…i1 × j0…j1. */
function pieceMap(g: SplitGrid, geo: SeamGeometry, cols: number, rows: number, out: Int32Array, [i0, j0, i1, j1] = [0, 0, g.w - 1, g.h - 1]) {
  const vl = Array.from({ length: cols + 1 }, (_, k) => geo.vLine(k));
  // Where each horizontal seam is, above each pixel column.
  const hy = Array.from({ length: cols }, (_, col) => Array.from({ length: rows + 1 }, (_, r) => {
    const line = geo.hLine(col, r), a = new Float64Array(i1 - i0 + 1);
    if (r > 0 && r < rows) for (let i = i0; i <= i1; i++) a[i - i0] = seamAt(line, g.x0 + (i + 0.5) * g.px, 0);
    return a;
  }));
  const vx = new Float64Array(cols + 1);
  for (let j = j0; j <= j1; j++) {
    const y = g.y1 - (j + 0.5) * g.px;
    for (let k = 1; k < cols; k++) vx[k] = seamAt(vl[k], y, 1);
    for (let i = i0; i <= i1; i++) {
      const x = g.x0 + (i + 0.5) * g.px;
      let col = 0;
      for (let k = 1; k < cols; k++) if (x > vx[k]) col = k;
      let row = 0;
      for (let r = 1; r < rows; r++) if (y < hy[col][r][i - i0]) row = r;
      out[j * g.w + i] = row * cols + col;
    }
  }
}

/** A bit of the drawing a seam would have cut off on its own, moved to the piece it carries on into. */
export interface MovedBit { from: number; to: number; at: Pt; size: Pt }

/**
 * Keeps each piece in one: a bit of the drawing the seams leave on its own in a piece (nothing else
 * of that piece within `maxBridge` mm, so it would need a long strut or be a part of its own) that
 * carries on across a seam into the next piece's main part goes to that piece – the seam steps
 * round it through the empty space, clear of everything else – when that piece still fits the bed
 * (`maxPiece` mm). A bit that only reaches a main part through another such bit follows once that
 * one has moved. Works on pixel grid `g` over the whole piece (`box`: the seams' box Xl, Xr, Yt, Yb);
 * `ink` is the drawing, `anchor` the bar or frame (what holds a piece's main part; never moved).
 * Returns the seams (changed ones copied) and what moved.
 */
export function keepTogether(o: { g: SplitGrid; ink: Uint8Array; anchor: Uint8Array | null; seams: Seam[]; cols: number; rows: number; box: [number, number, number, number]; maxBridge: number; minPart: number; maxPiece: number }): { seams: Seam[]; moved: MovedBit[] } {
  const { g, ink, anchor, cols, rows } = o;
  const { w, h, px } = g, N = w * h;
  const [Xl, Xr, Yt, Yb] = o.box;
  const geoOf = (ss: Seam[]) => seamGeometry(ss, cols, rows, Xl, Xr, Yt, Yb);
  let seams = o.seams.slice();
  const cell = new Int32Array(N);
  pieceMap(g, geoOf(seams), cols, rows, cell);
  const solid = (i: number) => ink[i] || anchor?.[i];
  // The outermost pixels are left out (so every pixel looked at has all its neighbours).
  const rim = new Uint8Array(N);
  for (let x = 0; x < w; x++) rim[x] = rim[N - w + x] = 1;
  for (let y = 0; y < h; y++) rim[y * w] = rim[y * w + w - 1] = 1;
  const inner = (i: number) => !rim[i];
  const nb = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];

  // The drawing's bits in each piece (8-connected, not across a seam).
  const label = new Int32Array(N);
  const comps: { cell: number; pixels: number[]; anchored: boolean }[] = [{ cell: -1, pixels: [], anchored: false }];
  for (let s = 0; s < N; s++) {
    if (label[s] || !solid(s) || !inner(s)) continue;
    const c = { cell: cell[s], pixels: [s], anchored: false }, l = comps.length;
    comps.push(c);
    label[s] = l;
    for (let q = 0; q < c.pixels.length; q++) {
      const i = c.pixels[q];
      if (anchor?.[i]) c.anchored = true;
      for (const k of nb) { const j = i + k; if (!label[j] && solid(j) && inner(j) && cell[j] === c.cell) { label[j] = l; c.pixels.push(j); } }
    }
  }
  const L = comps.length;
  const parent = Array.from({ length: L }, (_, l) => l);
  const find = (l: number): number => (parent[l] === l ? l : (parent[l] = find(parent[l])));
  // Bits of a piece near enough to bridge count as one: every bit grows across its piece's empty
  // pixels (half the longest bridge); where two meet near enough, they join.
  {
    const src = new Int32Array(N).fill(-1), grown = label.slice();
    let wave: number[] = [];
    for (let i = 0; i < N; i++) if (label[i]) { src[i] = i; wave.push(i); }
    const R = Math.ceil(o.maxBridge / px / 2) + 1, max2 = (o.maxBridge / px + 1) ** 2;
    for (let step = 0; step < R && wave.length; step++) {
      const next: number[] = [];
      for (const i of wave) for (const k of nb) {
        const j = i + k;
        if (!inner(j) || cell[j] !== cell[i]) continue;
        if (!grown[j]) { grown[j] = grown[i]; src[j] = src[i]; next.push(j); continue; }
        const a = find(grown[i]), b = find(grown[j]);
        if (a === b) continue;
        const si = src[i], sj = src[j];
        if (((si % w) - (sj % w)) ** 2 + (((si / w) | 0) - ((sj / w) | 0)) ** 2 <= max2) parent[a] = b;
      }
      wave = next;
    }
  }
  // Groups (what would be one part), each with its piece, size (pixels) and box (mm).
  interface Group { cell: number; n: number; anchored: boolean; comps: number[]; box: [number, number, number, number] }
  const groups = new Map<number, Group>();
  for (let l = 1; l < L; l++) {
    const r = find(l), c = comps[l];
    let gr = groups.get(r);
    if (!gr) groups.set(r, gr = { cell: c.cell, n: 0, anchored: false, comps: [], box: [Infinity, Infinity, -Infinity, -Infinity] });
    gr.n += c.pixels.length; gr.anchored ||= c.anchored; gr.comps.push(l);
    let [i0, j0, i1, j1] = [w, h, -1, -1];
    for (const i of c.pixels) { const x = i % w, y = (i / w) | 0; if (x < i0) i0 = x; if (x > i1) i1 = x; if (y < j0) j0 = y; if (y > j1) j1 = y; }
    const b = gr.box;
    gr.box = [Math.min(b[0], g.x0 + i0 * px), Math.min(b[1], g.y1 - (j1 + 1) * px), Math.max(b[2], g.x0 + (i1 + 1) * px), Math.max(b[3], g.y1 - j0 * px)];
  }
  // Each piece's main part: the one on the bar or frame, else the biggest.
  const mains = new Map<number, number>();
  for (const [r, gr] of groups) {
    const m = mains.get(gr.cell), cur = m == null ? null : groups.get(m)!;
    if (!cur || (gr.anchored && !cur.anchored) || (gr.anchored === cur.anchored && gr.n > cur.n)) mains.set(gr.cell, r);
  }
  // Parts: groups that will be one part of a piece (a group that moves joins the part it carries on
  // into). A piece's main part is held; a part is big when it would be a part of its own anyway.
  const join = Array.from({ length: L }, (_, l) => l);
  const part = (l: number): number => (join[l] === l ? l : (join[l] = part(join[l])));
  const held = new Set(mains.values());
  const minPx = o.minPart / (px * px);
  const memberLists = new Map([...groups.keys()].map((r) => [r, [r]]));
  const members = (p: number) => memberLists.get(p) ?? [];
  const partBox = (p: number) => {
    let b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of members(p)) { const q = groups.get(r)!.box; b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]; }
    return b;
  };
  const partSize = (p: number) => members(p).reduce((n, r) => n + groups.get(r)!.n, 0);
  // Which groups touch across a seam (within 2 pixels), and how much.
  const touch = new Map<number, Map<number, number>>();
  const seen = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!inner(i) || (cell[i] === cell[i + 1] && cell[i] === cell[i + w])) continue;
    const x = i % w, y = (i / w) | 0;
    for (let y2 = Math.max(1, y - 2); y2 <= Math.min(h - 2, y + 2); y2++) for (let x2 = Math.max(1, x - 2); x2 <= Math.min(w - 2, x + 2); x2++) {
      const p = y2 * w + x2;
      if (!label[p] || seen[p]) continue;
      seen[p] = 1;
      for (let y3 = Math.max(1, y2 - 2); y3 <= Math.min(h - 2, y2 + 2); y3++) for (let x3 = Math.max(1, x2 - 2); x3 <= Math.min(w - 2, x2 + 2); x3++) {
        const q = y3 * w + x3;
        if (!label[q] || cell[q] === cell[p]) continue;
        const a = find(label[p]), b = find(label[q]);
        const m = touch.get(a) ?? touch.set(a, new Map()).get(a)!;
        m.set(b, (m.get(b) ?? 0) + 1);
      }
    }
  }
  const moved: MovedBit[] = [];
  const trial = new Int32Array(N);
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    // Loose parts (not held, not on the bar or frame), the smallest first.
    const loose = [...memberLists.keys()].filter((p) => !held.has(p) && !members(p).some((r) => groups.get(r)!.anchored)).map((p) => ({ p, n: partSize(p) })).sort((a, b) => a.n - b.n);
    for (const { p } of loose) {
      if (part(p) !== p) continue;
      const mine = members(p), from = groups.get(p)!.cell, fc = from % cols, fr = Math.floor(from / cols);
      // Where it carries on: a held part of a piece beside it first, else one that is a part of its own anyway; most contact first.
      const contact = new Map<number, number>();
      for (const r of mine) for (const [q, c] of touch.get(r) ?? []) { const t = part(q); if (t !== p && groups.get(q)!.cell !== from) contact.set(t, (contact.get(t) ?? 0) + c); }
      const cands = [...contact].filter(([t]) => held.has(t) || partSize(t) >= minPx).sort((a, b) => +held.has(b[0]) - +held.has(a[0]) || b[1] - a[1]);
      for (const [t] of cands) {
        const to = groups.get(t)!.cell, tc = to % cols, tr = Math.floor(to / cols);
        let seam: Seam | undefined;
        if (Math.abs(tc - fc) === 1) seam = seams.find((m) => m.dir === 'v' && m.col === Math.max(tc, fc));
        else if (tc === fc && Math.abs(tr - fr) === 1) seam = seams.find((m) => m.dir === 'h' && m.col === fc && m.row === Math.max(tr, fr));
        if (!seam) continue;
        const pb = partBox(p), tb = partBox(t);
        if (Math.max(pb[2], tb[2]) - Math.min(pb[0], tb[0]) > o.maxPiece || Math.max(pb[3], tb[3]) - Math.min(pb[1], tb[1]) > o.maxPiece) continue;
        const own = new Set(mine.flatMap((r) => groups.get(r)!.comps)), pixels = [...own].flatMap((l) => comps[l].pixels);
        // From before the seam (left of a vertical one, above a horizontal one) to after it, or back:
        // a pixel clear of the bit along the seam too, or (where another piece's line meets it right
        // there) not.
        let route: ReturnType<typeof stepRound> = null;
        for (const m of [1, 0]) {
          const r = stepRound(seam, pixels, g, seam.dir === 'v' ? fc < tc : fr < tr, m);
          if (!r) break;
          // Clear of the seams either side of it.
          const geo = geoOf(seams), k = seam.dir === 'v' ? seam.col : seam.row;
          const lo = seam.dir === 'v' ? geo.vLine(k - 1) : geo.hLine(seam.col, k - 1), hi = seam.dir === 'v' ? geo.vLine(k + 1) : geo.hLine(seam.col, k + 1);
          const ax = seam.dir === 'v' ? 1 : 0, room = 2 * g.px;
          // (Vertical: x grows from the seam before to the one after; horizontal: y falls.)
          const sgn = seam.dir === 'v' ? 1 : -1;
          if (r.seam.points.some((p) => sgn * (p[1 - ax] - seamAt(lo, p[ax], ax as 0 | 1)) < room || sgn * (seamAt(hi, p[ax], ax as 0 | 1) - p[1 - ax]) < room)) break;
          // Only the bit changes piece (and empty space round it, from its piece to the next: the
          // seam stays clear of the other seams).
          pieceMap(g, geoOf(seams.map((x) => (x === seam ? r.seam : x))), cols, rows, trial, r.zone);
          const [i0, j0, i1, j1] = r.zone;
          let ok = true;
          for (let j = j0; j <= j1 && ok; j++) for (let i = i0; i <= i1; i++) {
            const q = j * w + i;
            const want = !solid(q) || !label[q] ? cell[q] : own.has(label[q]) ? to : groups.get(find(label[q]))!.cell;
            if (trial[q] !== want && !(!solid(q) && cell[q] === from && trial[q] === to)) { ok = false; break; }
          }
          if (ok) { route = r; break; }
        }
        if (!route) continue;
        const trialSeams = seams.map((x) => (x === seam ? route.seam : x));
        const [i0, j0, i1, j1] = route.zone;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cell[j * w + i] = trial[j * w + i];
        route.seam.crossings = Math.max(0, seam.crossings + countCrossings(route.seam, ink, anchor, g) - countCrossings(seam, ink, anchor, g));
        seams = trialSeams;
        for (const r of mine) groups.get(r)!.cell = to;
        join[p] = t;
        memberLists.set(t, [...members(t), ...mine]);
        memberLists.delete(p);
        moved.push({ from, to, at: [(pb[0] + pb[2]) / 2, (pb[1] + pb[3]) / 2], size: [pb[2] - pb[0], pb[3] - pb[1]] });
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return { seams, moved };
}

/**
 * `seam` stepping round the pixels `bit` a pixel clear of it: the bit lies before the seam (left
 * of a vertical one, above a horizontal one) and goes after it when `forward`, else the other way.
 * Also the pixel box (i0, j0, i1, j1) where pixels may have changed piece. Null when the seam
 * needn't move.
 */
function stepRound(seam: Seam, bit: number[], g: SplitGrid, forward: boolean, m: number): { seam: Seam; zone: [number, number, number, number] } | null {
  const { w, px } = g, v = seam.dir === 'v';
  // t runs along the seam (pixel rows for a vertical seam, columns for a horizontal one); across
  // it, the bit's edge facing where the seam goes: its left edge (vertical, forward), right edge
  // (vertical, back), top edge (horizontal, forward) or bottom edge (horizontal, back), in mm.
  const toMin = v === forward;
  const n = v ? g.h : w;
  const edge = new Float64Array(n).fill(NaN);
  let t0 = Infinity, t1 = -Infinity;
  for (const i of bit) {
    const x = i % w, y = (i / w) | 0, t = v ? y : x;
    const e = v ? g.x0 + (forward ? x : x + 1) * px : g.y1 - (forward ? y : y + 1) * px;
    edge[t] = Number.isNaN(edge[t]) ? e : toMin ? Math.min(edge[t], e) : Math.max(edge[t], e);
    t0 = Math.min(t0, t); t1 = Math.max(t1, t);
  }
  if (!(t1 >= t0)) return null;
  // The new line keeps a pixel clear of the bit, and `m` pixels along the seam either side of it.
  const gap = px, axis: 0 | 1 = v ? 1 : 0;
  const lo = Math.max(0, t0 - m - 1), hi = Math.min(n - 1, t1 + m + 1);
  const along = (t: number) => (v ? g.y1 - (t + 0.5) * px : g.x0 + (t + 0.5) * px);
  const pts = seam.points;
  // u grows along the seam's points (top to bottom, left to right).
  const sign = pts[pts.length - 1][axis] >= pts[0][axis] ? 1 : -1;
  const runs: { uA: number; uB: number; samples: Pt[] }[] = [];
  let run: (typeof runs)[number] | null = null;
  let amin = Infinity, amax = -Infinity;
  for (let t = lo; t <= hi; t++) {
    let e = NaN;
    for (let k = Math.max(0, t - m); k <= Math.min(n - 1, t + m); k++) if (!Number.isNaN(edge[k])) e = Number.isNaN(e) ? edge[k] : toMin ? Math.min(e, edge[k]) : Math.max(e, edge[k]);
    const a = along(t), s = seamAt(pts, a, axis);
    const q = Number.isNaN(e) ? s : toMin ? Math.min(s, e - gap) : Math.max(s, e + gap);
    if (q === s) { run = null; continue; }
    if (!run) { run = { uA: Infinity, uB: -Infinity, samples: [] }; runs.push(run); }
    run.samples.push(v ? [q, a] : [a, q]);
    run.uA = Math.min(run.uA, (a - (sign * px) / 2) * sign); run.uB = Math.max(run.uB, (a + (sign * px) / 2) * sign);
    amin = Math.min(amin, q, s); amax = Math.max(amax, q, s);
  }
  if (!runs.length) return null;
  const u = (p: Pt) => p[axis] * sign;
  const on = (uu: number): Pt => { const a = uu * sign, c = seamAt(pts, a, axis); return v ? [c, a] : [a, c]; };
  const out: Pt[] = pts.filter((p) => !runs.some((r) => u(p) >= r.uA && u(p) <= r.uB));
  for (const r of runs) out.push(on(r.uA), ...rdp(r.samples, px * 0.1), on(r.uB));
  out.sort((a, b) => u(a) - u(b));
  // The pixels that may have changed piece.
  const tA = Math.max(0, lo - 2), tB = Math.min(n - 1, hi + 2);
  const c0 = v ? Math.floor((amin - g.x0) / px) - 2 : Math.floor((g.y1 - amax) / px) - 2;
  const c1 = v ? Math.ceil((amax - g.x0) / px) + 2 : Math.ceil((g.y1 - amin) / px) + 2;
  const a0 = Math.max(0, c0), a1 = Math.min((v ? w : g.h) - 1, c1);
  return { seam: { ...seam, points: out }, zone: v ? [a0, tA, a1, tB] : [tA, a0, tB, a1] };
}

/** How many lines of `ink` (not the bar or frame) a seam's polyline crosses, on grid g. */
function countCrossings(seam: Seam, ink: Uint8Array, anchor: Uint8Array | null, g: SplitGrid): number {
  let n = 0, was = false;
  const p = seam.points;
  for (let k = 0; k + 1 < p.length; k++) {
    const [ax, ay] = p[k], [bx, by] = p[k + 1], steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (g.px / 2)));
    for (let s = k ? 1 : 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
      const i = Math.floor((x - g.x0) / g.px), j = Math.floor((g.y1 - y) / g.px), q = j * g.w + i;
      const hit = i >= 0 && j >= 0 && i < g.w && j < g.h && !!ink[q] && !anchor?.[q];
      if (hit && !was) n++;
      was = hit;
    }
  }
  return n;
}
