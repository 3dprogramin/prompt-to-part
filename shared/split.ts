// Splitting a flat piece bigger than the bed into pieces that each fit it (line art first; reliefs,
// signs and plaques can use it the same way). The model is cut along seams Jig picks on a pixel
// grid of the piece: each seam is the cheapest path through a band around an ideal straight cut,
// where crossing a line costs a lot (more in fine detail), running close to one a little, and
// leaving the ideal cut a little too. Vertical seams run the whole height; the horizontal ones are
// found per column strip between them (they meet the vertical seams in T-joints, never cross them).
// Where a seam crosses a bar or frame it runs straight across it, so a dovetail fits there.
//
// Seams are data (polylines in mm): they could be stored and moved by hand later.

type Pt = [number, number];

/** A pixel grid: pixel (i, j) has its centre at (x0 + (i + ½)·px, y1 − (j + ½)·px) mm; row 0 is the top. */
export interface SplitGrid { w: number; h: number; px: number; x0: number; y1: number }

/** How to split: 'auto' (the fewest pieces that fit the bed), a number of pieces, or a grid [columns, rows]. */
export type SplitSpec = 'auto' | number | [number, number];

/** The largest a piece may be (mm): the A1's 256 mm bed less a margin. */
export const MAX_PIECE = 250;
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
export function splitGrid(w: number, h: number, spec: SplitSpec, maxPiece = MAX_PIECE, reserve = 20): { cols: number; rows: number } {
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
 * Where a box `bw` × `bh` pixels fits entirely on set pixels of `mask` (w × h), its centre nearest
 * pixel (px, py); null when it fits nowhere.
 */
export function fitBox(mask: Uint8Array, w: number, h: number, bw: number, bh: number, px: number, py: number): { x: number; y: number } | null {
  if (bw > w || bh > h) return null;
  const S = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += mask[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; }
  }
  const full = bw * bh;
  let best: { x: number; y: number } | null = null, bd = Infinity;
  for (let y = 0; y + bh <= h; y++) for (let x = 0; x + bw <= w; x++) {
    const sum = S[(y + bh) * (w + 1) + x + bw] - S[y * (w + 1) + x + bw] - S[(y + bh) * (w + 1) + x] + S[y * (w + 1) + x];
    if (sum !== full) continue;
    const cx = x + bw / 2, cy = y + bh / 2, d = (cx - px) ** 2 + (cy - py) ** 2;
    if (d < bd) { bd = d; best = { x: cx, y: cy }; }
  }
  return best;
}
