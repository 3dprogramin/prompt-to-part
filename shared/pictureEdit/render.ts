// A drawing as it prints, in its own colours, for any window at any pixel size: the picture sent to
// the image model for a picture edit. Same semantics as `drawingSection` (shared/svgFeatures.ts):
// shapes in paint order, each covering what is below; then the hand edits in order, paint setting
// its colour (inside the paint box) and erase clearing only its own colour; a stroke's cut exempts.
import { strokePieces, type ArtworkStroke } from '../artworkEdits';
import type { LineArtGrid, Pt } from '../lineart/raster';
import { rasterize } from '../lineart/raster';
import { defaultColors, drawingColors, type SvgDrawing } from '../svgFeatures';
import { fillConvex } from './mark';

/** A rectangle of the picture in picture units (1 = the picture's height, y up): its top-left corner and size. */
export interface PictureWindow { x0: number; y1: number; w: number; h: number }

export function wholeWindow(d: { aspect: number }): PictureWindow {
  return { x0: -d.aspect / 2, y1: 0.5, w: d.aspect, h: 1 };
}

/** NonZero fill of `contours` on the grid into `out`, rows `jLo..jHi` only (a pixel is in when its centre is). */
function fillWinding(contours: Pt[][], g: LineArtGrid, out: Uint8Array, jLo = 0, jHi = g.h - 1) {
  const rows: number[][] = Array.from({ length: jHi - jLo + 1 }, () => []);
  const edges: number[] = [];
  for (const c of contours) {
    for (let k = 0; k < c.length; k++) {
      const [ax, ay] = c[k], [bx, by] = c[(k + 1) % c.length];
      if (ay === by) continue;
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      const j0 = Math.max(jLo, Math.ceil((g.y1 - hi) / g.px - 0.5) - 1), j1 = Math.min(jHi, Math.floor((g.y1 - lo) / g.px - 0.5) + 1);
      if (j0 > j1) continue;
      const e = edges.length;
      edges.push(ax, ay, bx, by);
      for (let j = j0; j <= j1; j++) rows[j - jLo].push(e);
    }
  }
  const xs: [number, number][] = [];
  for (let j = jLo; j <= jHi; j++) {
    const y = g.y1 - (j + 0.5) * g.px;
    xs.length = 0;
    for (const e of rows[j - jLo]) {
      const ax = edges[e], ay = edges[e + 1], bx = edges[e + 2], by = edges[e + 3];
      if ((ay <= y) === (by <= y)) continue;
      xs.push([ax + ((y - ay) / (by - ay)) * (bx - ax), by > ay ? 1 : -1]);
    }
    xs.sort((a, b) => a[0] - b[0]);
    let wind = 0;
    for (let k = 0; k + 1 < xs.length; k++) {
      wind += xs[k][1];
      if (!wind) continue;
      const i0 = Math.max(0, Math.ceil((xs[k][0] - g.x0) / g.px - 0.5)), i1 = Math.min(g.w - 1, Math.floor((xs[k + 1][0] - g.x0) / g.px - 0.5));
      if (i1 >= i0) out.fill(1, j * g.w + i0, j * g.w + i1 + 1);
    }
  }
}

/** The bounds of the drawing's own shapes in the colours raised by default (picture units), as `paintBox` works them out. */
function paintBounds(d: SvgDrawing): { x0: number; y0: number; x1: number; y1: number } | null {
  const colours = defaultColors(d);
  const set = colours ? new Set(colours) : null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sh of d.shapes) {
    if (sh.edit || (set && !set.has(sh.color ?? ''))) continue;
    for (const c of sh.contours) for (const [x, y] of c) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}

const NAMED: Record<string, [number, number, number]> = { white: [255, 255, 255], black: [0, 0, 0] };
function rgb(c: string): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (m) {
    const h = m[1].length === 3 ? m[1].replace(/./g, (x) => x + x) : m[1];
    const v = parseInt(h, 16);
    return [v >> 16, (v >> 8) & 255, v & 255];
  }
  return NAMED[c.trim().toLowerCase()] ?? [0, 0, 0];
}

/**
 * The drawing with `strokes` as it prints, `heightPx` pixels per picture height over `win`: `data`
 * is RGBA on white, 2x supersampled; `labels` the colour (index into `drawingColors(d)`, -1 = none)
 * of each pixel by majority of its four samples.
 */
export function renderDrawing(d: SvgDrawing, strokes: ArtworkStroke[], win: PictureWindow, heightPx: number):
  { width: number; height: number; data: Uint8Array; labels: Int16Array } {
  const px = win.h / heightPx;
  const width = Math.max(1, Math.round(win.w / px)), height = Math.max(1, Math.round(heightPx));
  const g: LineArtGrid = { w: width * 2, h: height * 2, px: px / 2, x0: win.x0, y1: win.y1 };
  const colours = drawingColors(d);
  const index = new Map(colours.map((c, i) => [c, i]));
  const L = new Int16Array(g.w * g.h).fill(-1);
  const mask = new Uint8Array(g.w * g.h), cutMask = new Uint8Array(g.w * g.h);

  for (const sh of d.shapes) {
    if (sh.edit) continue;
    mask.fill(0);
    if (sh.rule === 'EvenOdd') rasterize(sh.contours, g, mask); else fillWinding(sh.contours, g, mask);
    const col = index.get(sh.color ?? '')!;
    for (let p = 0; p < L.length; p++) if (mask[p]) L[p] = col;
  }

  const pb = paintBounds(d);
  // The pixels whose centres lie inside the paint box.
  const boxPx = pb && {
    i0: Math.max(0, Math.ceil((pb.x0 - g.x0) / g.px - 0.5)), i1: Math.min(g.w - 1, Math.floor((pb.x1 - g.x0) / g.px - 0.5)),
    j0: Math.max(0, Math.ceil((g.y1 - pb.y1) / g.px - 0.5)), j1: Math.min(g.h - 1, Math.floor((g.y1 - pb.y0) / g.px - 0.5)),
  };
  for (const st of strokes) {
    const col = index.get(st.color);
    if (col === undefined || (st.mode === 'paint' && !boxPx)) continue;
    // The rows and columns the stroke can reach.
    const r = st.width / 2;
    let ya = Infinity, yb = -Infinity, xa = Infinity, xb = -Infinity;
    for (const [x, y] of st.points) { ya = Math.min(ya, y - r); yb = Math.max(yb, y + r); xa = Math.min(xa, x - r); xb = Math.max(xb, x + r); }
    let j0 = Math.max(0, Math.ceil((g.y1 - yb) / g.px - 0.5) - 1), j1 = Math.min(g.h - 1, Math.floor((g.y1 - ya) / g.px - 0.5) + 1);
    let i0 = Math.max(0, Math.ceil((xa - g.x0) / g.px - 0.5) - 1), i1 = Math.min(g.w - 1, Math.floor((xb - g.x0) / g.px - 0.5) + 1);
    if (j0 > j1 || i0 > i1) continue;
    const clear = (m: Uint8Array) => { for (let j = j0; j <= j1; j++) m.fill(0, j * g.w, (j + 1) * g.w); };
    clear(mask);
    const { circle, centres, polys } = strokePieces(st);
    for (const [cx, cy] of centres) fillConvex(circle.map(([x, y]) => [x + cx, y + cy] as Pt), g, mask);
    for (const c of polys) fillConvex(c, g, mask);
    const cut = !!st.cut?.length;
    if (cut) { clear(cutMask); fillWinding(st.cut!, g, cutMask, j0, j1); }
    // Paint stays inside the paint box.
    if (st.mode === 'paint') { i0 = Math.max(i0, boxPx!.i0); i1 = Math.min(i1, boxPx!.i1); j0 = Math.max(j0, boxPx!.j0); j1 = Math.min(j1, boxPx!.j1); }
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const p = j * g.w + i;
        if (!mask[p] || (cut && cutMask[p])) continue;
        if (st.mode === 'paint') L[p] = col; else if (L[p] === col) L[p] = -1;
      }
    }
  }

  const labels = new Int16Array(width * height);
  const data = new Uint8Array(width * height * 4);
  const rgbs = colours.map(rgb);
  const votes = new Map<number, number>();
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      let r = 0, gg = 0, b = 0;
      votes.clear();
      for (let k = 0; k < 4; k++) {
        const l = L[(2 * j + (k >> 1)) * g.w + 2 * i + (k & 1)];
        votes.set(l, (votes.get(l) ?? 0) + 1);
        const c = l < 0 ? [255, 255, 255] : rgbs[l];
        r += c[0]; gg += c[1]; b += c[2];
      }
      let best = -1, n = 0;
      for (const [l, v] of votes) if (v > n) { n = v; best = l; }
      const o = j * width + i;
      labels[o] = best;
      data[o * 4] = Math.round(r / 4); data[o * 4 + 1] = Math.round(gg / 4); data[o * 4 + 2] = Math.round(b / 4); data[o * 4 + 3] = 255;
    }
  }
  return { width, height, data, labels };
}
