// Pixels back to polygons: outlines of a mask or a field, simplified.
import type { LineArtGrid, Pt } from './raster';

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
