// Brush strokes as outlines (mm): round-capped or square-brushed, for the union to make solid.
import type { Pt } from './raster';

/** Round-capped strokes `r` mm wide along `paths` (mm) as counter-clockwise outlines – a quad per segment and a disc per point – whose union (NonZero) is the strokes. */
export function strokeOutlines(paths: Pt[][], r: number, n: number): Pt[][] {
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

/**
 * Square-brushed strokes `r` mm from their paths each way (upright squares 2r wide) as
 * counter-clockwise outlines, whose union (NonZero) is the strokes: a square swept along each
 * segment is the hull of the squares at its ends (a square alone for a single point).
 */
export function squareOutlines(paths: Pt[][], r: number): Pt[][] {
  const out: Pt[][] = [];
  const corners = ([x, y]: Pt): Pt[] => [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
  for (const p of paths) {
    if (p.length === 1) out.push(corners(p[0]));
    for (let k = 0; k + 1 < p.length; k++) out.push(hull([...corners(p[k]), ...corners(p[k + 1])]));
  }
  return out;
}

/** The convex hull of points, counter-clockwise (a monotone chain). */
function hull(pts: Pt[]): Pt[] {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Pt[]) => {
    const h: Pt[] = [];
    for (const p of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 1e-12) h.pop(); h.push(p); }
    return h.slice(0, -1);
  };
  return [...half(s), ...half(s.reverse())];
}
