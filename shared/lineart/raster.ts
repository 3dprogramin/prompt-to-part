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

export type Pt = [number, number];

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
      // Rows whose centre Y may lie in [lo, hi) – a row more each way, as rounding here may differ
      // from the crossing test below, which decides (a missed crossing would streak a whole row).
      const jTop = Math.max(0, Math.ceil((g.y1 - hi) / g.px - 0.5) - 1), jBot = Math.min(g.h - 1, Math.floor((g.y1 - lo) / g.px - 0.5) + 1);
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

/**
 * Zhang–Suen thinning: the one-pixel centre lines of `img` (changed in place), its pixels in
 * order. The border pixels must be empty. Only pixels on the edge (an empty neighbour) can go, so
 * each pass looks at those alone: thick areas cost their area once, not once per pass.
 */
export function thin(img: Uint8Array, w: number) {
  const nb = N8(w);
  const queued = new Uint8Array(img.length);
  let edge: number[] = [];
  for (let i = 0; i < img.length; i++) if (img[i] && nb.some((k) => !img[i + k])) { edge.push(i); queued[i] = 1; }
  const del: number[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (const i of edge) {
        const p2 = img[i - w], p3 = img[i - w + 1], p4 = img[i + 1], p5 = img[i + w + 1], p6 = img[i + w], p7 = img[i + w - 1], p8 = img[i - 1], p9 = img[i - w - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const a = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) + (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
        if (a !== 1) continue;
        if (step === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
        del.push(i);
      }
      for (const i of del) img[i] = 0;
      if (del.length) {
        changed = true;
        // What a deleted pixel uncovers is on the edge now.
        const next = edge.filter((i) => img[i]);
        for (const i of del) for (const k of nb) { const j = i + k; if (img[j] && !queued[j]) { queued[j] = 1; next.push(j); } }
        edge = next;
      }
    }
  }
  const fg: number[] = [];
  for (let i = 0; i < img.length; i++) if (img[i]) fg.push(i);
  return fg;
}

export const N8 = (w: number) => [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];

/**
 * Removes the spurs thinning leaves at a thick line's corners (branches up to `k` pixels long):
 * every loose end is cut back `k` pixels, then the ends that are left grow back along the skeleton
 * (real line ends get their length back, spurs don't), and a short line or dot that would vanish
 * altogether is kept.
 */
export function prune(img: Uint8Array, fg: number[], w: number, k: number) {
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
export function skeletonChains(img: Uint8Array, fg: number[], w: number): number[][] {
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
export function strokePolyline(img: Uint8Array, w: number, h: number, chain: number[], r: number): Pt[] {
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
export function capsuleXY(img: Uint8Array, w: number, h: number, [ax, ay]: Pt, [bx, by]: Pt, r: number) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= r * r) img[y * w + x] = 1;
  }
}

/** The most pixels of a grid (the pixels grow past it). */
export const MAX_PIXELS = { draft: 1_500_000, normal: 4_000_000, high: 8_000_000 };
