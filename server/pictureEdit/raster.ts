// The raster core of a picture edit: crop around the mark, line the image model's answer up with
// what was sent (it often comes back slightly moved, rescaled or re-toned) using only the area
// outside the mark, and paste only the mark back into the original with a soft edge that lies
// inside the mark, so every pixel outside the mark stays byte-identical.
import type { Raster } from '../../shared/meshFormats';

/** A rectangle of a picture in whole pixels: its top-left corner and size. */
export interface PixelBox { x: number; y: number; w: number; h: number }

const ratioOf = (aspect: string) => {
  const [w, h] = aspect.split(':').map(Number);
  return w / h;
};

/**
 * The crop sent to the image model: the mark's box grown by `margin` x its size on each side,
 * shaped to the allowed aspect (`aspects`, width:height) nearest the mark's own shape, and kept
 * inside the picture. When the picture is too small for that, the margin shrinks (the aspect that
 * keeps the most margin wins, then the nearest shape); when even the mark alone fits no aspect, the
 * crop is the mark's box widened toward the aspect nearest to what fits, up to the whole picture on
 * that axis. Always integer pixels, always holding the whole (clipped) mark.
 */
export function chooseCrop(mark: PixelBox, picture: { width: number; height: number }, aspects: readonly string[], margin = 1): PixelBox & { aspect: string } {
  if (!aspects.length) throw new Error('chooseCrop needs at least one aspect');
  const pw = picture.width, ph = picture.height;
  let x0 = Math.max(0, Math.floor(mark.x)), x1 = Math.min(pw, Math.ceil(mark.x + mark.w));
  let y0 = Math.max(0, Math.floor(mark.y)), y1 = Math.min(ph, Math.ceil(mark.y + mark.h));
  if (x1 <= x0) { x1 = Math.min(pw, x0 + 1); x0 = x1 - 1; }
  if (y1 <= y0) { y1 = Math.min(ph, y0 + 1); y0 = y1 - 1; }
  const mw = x1 - x0, mh = y1 - y0, shape = Math.log(mw / mh);
  margin = Math.max(0, margin);

  // Each aspect's box: with the largest margin up to `margin` that fits, or none fits at all.
  const options = aspects.map((aspect) => {
    const a = ratioOf(aspect);
    const wMax = Math.min(pw, ph * a), hMax = wMax / a;
    const tMax = Math.min((wMax / mw - 1) / 2, (hMax / mh - 1) / 2);
    let w: number, h: number;
    if (tMax >= 0) {
      const t = Math.min(margin, tMax);
      const wf = Math.max(mw * (1 + 2 * t), mh * (1 + 2 * t) * a);
      w = Math.min(pw, Math.max(mw, Math.ceil(wf - 1e-9)));
      h = Math.min(ph, Math.max(mh, Math.round(w / a)));
      return { aspect, w, h, fits: true, t, off: Math.abs(Math.log(a) - shape) };
    }
    w = Math.min(pw, Math.max(mw, Math.round(mh * a)));
    h = Math.min(ph, Math.max(mh, Math.round(w / a)));
    return { aspect, w, h, fits: false, t: 0, off: Math.abs(Math.log(w / h) - Math.log(a)) };
  });
  const fitting = options.filter((o) => o.fits);
  let best;
  if (fitting.length) {
    // Margins within 2 % of the mark's size count as equal; then the shape nearest the mark's.
    const most = Math.max(...fitting.map((o) => o.t));
    best = fitting.filter((o) => o.t >= most - 0.02).reduce((p, o) => (o.off < p.off ? o : p));
  } else best = options.reduce((p, o) => (o.off < p.off ? o : p));

  const place = (lo: number, hi: number, size: number, total: number) => {
    const at = Math.round((lo + hi) / 2 - size / 2);
    return Math.min(Math.min(lo, total - size), Math.max(Math.max(0, hi - size), at));
  };
  return { x: place(x0, x1, best.w, pw), y: place(y0, y1, best.h, ph), w: best.w, h: best.h, aspect: best.aspect };
}

/** Halves a picture by averaging each 2 x 2 block (the last odd row or column is dropped). */
function halve(img: Raster): Raster {
  const w = img.width >> 1, h = img.height >> 1, s = img.data, sw = img.width;
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const a = ((2 * j) * sw + 2 * i) * 4, b = a + sw * 4, o = (j * w + i) * 4;
    for (let k = 0; k < 4; k++) data[o + k] = (s[a + k] + s[a + 4 + k] + s[b + k] + s[b + 4 + k] + 2) >> 2;
  }
  return { width: w, height: h, data };
}

/**
 * Samples `img` bilinearly (edges clamped) into a width x height picture whose pixel (i, j) reads
 * source pixel (ax * i + bx, ay * j + by): a resize or a shift and scale, both separable, so the
 * column and row positions are worked out once.
 */
function sampleLinear(img: Raster, width: number, height: number, ax: number, bx: number, ay: number, by: number): Raster {
  const sw = img.width, sh = img.height, src = img.data, data = new Uint8Array(width * height * 4);
  const table = (n: number, size: number, a: number, b: number) => {
    const lo = new Int32Array(n), hi = new Int32Array(n), t = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = Math.min(size - 1, Math.max(0, a * i + b)), i0 = Math.floor(u);
      lo[i] = i0; hi[i] = Math.min(size - 1, i0 + 1); t[i] = u - i0;
    }
    return { lo, hi, t };
  };
  const cols = table(width, sw, ax, bx), rows = table(height, sh, ay, by);
  for (let j = 0; j < height; j++) {
    const r0 = rows.lo[j] * sw, r1 = rows.hi[j] * sw, fy = rows.t[j];
    for (let i = 0; i < width; i++) {
      const c0 = cols.lo[i], c1 = cols.hi[i], fx = cols.t[i], o = (j * width + i) * 4;
      const a = (r0 + c0) * 4, b = (r0 + c1) * 4, c = (r1 + c0) * 4, d = (r1 + c1) * 4;
      for (let k = 0; k < 4; k++) {
        const top = src[a + k] + (src[b + k] - src[a + k]) * fx, bottom = src[c + k] + (src[d + k] - src[c + k]) * fx;
        data[o + k] = (top + (bottom - top) * fy + 0.5) | 0;
      }
    }
  }
  return { width, height, data };
}

/**
 * Resizes a picture with bilinear sampling (pixel centres mapped onto pixel centres, edges clamped).
 * A picture more than twice the target size is first halved by block averaging, so a big answer
 * shrunk to a small crop does not alias.
 */
export function resizeTo(img: Raster, width: number, height: number): Raster {
  if (img.width === width && img.height === height) return { width, height, data: new Uint8Array(img.data) };
  while (img.width >= 2 * width && img.height >= 2 * height && img.width >= 2 && img.height >= 2) img = halve(img);
  const kx = img.width / width, ky = img.height / height;
  return sampleLinear(img, width, height, kx, 0.5 * kx - 0.5, ky, 0.5 * ky - 0.5);
}

/**
 * The most a lined-up answer may still differ from what was sent over the area outside the mark:
 * the mean absolute difference per RGB channel (0..255) after the shift, scale and (with `tones`)
 * the tone match. This is a "same picture" test, not an alignment check: on flat-colour art most
 * outside pixels are flat, so the error barely rises with a misalignment (clean art held 6 to 8 px
 * off still scores about 9 to 10). That the answer lines up within a pixel comes from the search
 * (exhaustive at the coarsest level, then refined to half pixels) and from following a fit held at
 * the range's edge on past it; a sharper check here would reject answers that are right but redrawn.
 * Tuned on the synthetic pictures of test/pictureRaster.test.ts (colour gradients, soft edged discs
 * and boxes, a smooth texture; 400 x 300). Measured: a copy moved 7 px and scaled 2 % lines up to
 * 0.9 (1.1 when it came back at 512 x 512); re-toned (x 0.9 + 20) to 0.7 with `tones` (6.5
 * without); with noise of sd 4 and sent back at 600 x 400, 2.0; noise of sd 8, 4.6; posterized
 * flat-colour versions at other sizes and aspects, at most 4.1. A different picture of the same kind
 * stays at 67 to 73 (42 to 46 with `tones`) and pure noise at 59 (43). 12 leaves room for the image
 * model's own small redraws outside the mark while staying far below a different picture.
 */
export const ALIGN_MAX_ERROR = 12;

/** The least part of the crop that must be outside the mark (after shrinking it) to line anything up. */
const MIN_OUTSIDE = 0.05;
/** The most of the mark whose source may lie off the answer (filled with the answer's edge instead). */
const MAX_OFF_MARK = 0.005;

/** Why an answer cannot be pasted. */
export type AlignFailure = 'too little outside the mark' | 'moved past the range' | 'different picture' | 'mark leaves the answer';

export interface Alignment {
  /** The answer at the sent picture's size, moved (and toned) onto it. */
  image: Raster;
  shift: [number, number];
  /** The scale on x and on y (they differ when the model kept its own picture's proportions). */
  scale: [number, number];
  /** Mean absolute RGB difference outside the mark (0..255), pixels off the answer left out. */
  error: number;
  /** Mark pixels whose source lies off the answer (0 without `mark`). */
  offMark: number;
  ok: boolean;
  /** Set when not ok. */
  reason?: AlignFailure;
}

/** The contrast change a tone match may apply; outside it a match is not the same picture. */
const GAIN_MIN = 0.5, GAIN_MAX = 2;

/** Luminance (0..255) of every pixel. */
function luminance(img: Raster): Float32Array {
  const n = img.width * img.height, out = new Float32Array(n), d = img.data;
  for (let p = 0; p < n; p++) out[p] = 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
  return out;
}

/** Shrinks the 1s of a mask by `r` pixels (a square neighbourhood); the picture's edge does not shrink it. */
function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let cur = mask;
  for (let step = 0; step < r; step++) {
    const across = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = j * w + i;
      across[p] = cur[p] && (i === 0 || cur[p - 1]) && (i === w - 1 || cur[p + 1]) ? 1 : 0;
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = j * w + i;
      out[p] = across[p] && (j === 0 || across[p - w]) && (j === h - 1 || across[p + w]) ? 1 : 0;
    }
    cur = out;
  }
  return cur;
}

/**
 * One level of the search pyramid: the returned picture's luminance, and the outside pixels compared
 * (their positions and the sent picture's luminance there).
 */
interface Level { f: number; w: number; h: number; ret: Float32Array; xs: Float32Array; ys: Float32Array; ts: Float32Array; buf: Float32Array }

/** The most outside pixels one comparison reads; more are thinned to a regular grid. */
const MAX_SAMPLES = 40_000;

function level(f: number, w: number, h: number, sent: Float32Array, ret: Float32Array, outside: Uint8Array): Level {
  let count = 0;
  for (let p = 0; p < w * h; p++) count += outside[p];
  const stride = Math.max(1, Math.ceil(Math.sqrt(count / MAX_SAMPLES)));
  const pick: number[] = [];
  for (let j = 0; j < h; j += stride) for (let i = 0; i < w; i += stride) if (outside[j * w + i]) pick.push(j * w + i);
  const n = pick.length, xs = new Float32Array(n), ys = new Float32Array(n), ts = new Float32Array(n);
  for (let k = 0; k < n; k++) { xs[k] = pick[k] % w; ys[k] = Math.floor(pick[k] / w); ts[k] = sent[pick[k]]; }
  return { f, w, h, ret, xs, ys, ts, buf: new Float32Array(n) };
}

function halveLum(a: Float32Array, w: number, h: number): Float32Array {
  const hw = w >> 1, hh = h >> 1, out = new Float32Array(hw * hh);
  for (let j = 0; j < hh; j++) for (let i = 0; i < hw; i++) {
    const p = 2 * j * w + 2 * i;
    out[j * hw + i] = (a[p] + a[p + 1] + a[p + w] + a[p + w + 1]) / 4;
  }
  return out;
}

function halveMask(m: Uint8Array, w: number, h: number): Uint8Array {
  const hw = w >> 1, hh = h >> 1, out = new Uint8Array(hw * hh);
  for (let j = 0; j < hh; j++) for (let i = 0; i < hw; i++) {
    const p = 2 * j * w + 2 * i;
    out[j * hw + i] = m[p] & m[p + 1] & m[p + w] & m[p + w + 1];
  }
  return out;
}

/** A transform: the content at sent pixel p is at returned pixel c + scale * (p - c) + shift, scaled `sx` on x and `sy` on y. */
interface Fit { dx: number; dy: number; sx: number; sy: number; err: number }

/** Least-squares gain and offset taking `a` to `b`, the gain kept within GAIN_MIN..GAIN_MAX. */
function toneFit(n: number, sa: number, sb: number, saa: number, sab: number): [number, number] {
  const ma = sa / n, mb = sb / n, va = saa / n - ma * ma, cov = sab / n - ma * mb;
  const g = Math.min(GAIN_MAX, Math.max(GAIN_MIN, va > 1e-6 ? cov / va : 1));
  return [g, mb - g * ma];
}

/**
 * Mean absolute luminance difference at one level over its outside samples, the returned picture
 * moved by the transform (given in full-size pixels) and, with `tones`, matched by a least-squares
 * gain and offset. Samples whose source falls off the returned picture are left out.
 */
function levelError(L: Level, cx: number, cy: number, dx: number, dy: number, sx: number, sy: number, tones: boolean): number {
  const { f, w, h, ret, xs, ys, ts, buf } = L, count = ts.length, wEnd = w - 1, hEnd = h - 1;
  // A level pixel x is full-size pixel (x + 0.5) / f - 0.5; carry the transform through to the level.
  const bx = sx * 0.5 - 0.5 * f * sx + f * (cx * (1 - sx) + dx + 0.5) - 0.5;
  const by = sy * 0.5 - 0.5 * f * sy + f * (cy * (1 - sy) + dy + 0.5) - 0.5;
  let n = 0, sa = 0, sb = 0, saa = 0, sab = 0, sum = 0;
  for (let k = 0; k < count; k++) {
    const u = sx * xs[k] + bx, v = sy * ys[k] + by;
    if (!(u >= 0 && v >= 0 && u < wEnd && v < hEnd)) { buf[k] = -1; continue; }
    const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, p = y0 * w + x0;
    const top = ret[p] + (ret[p + 1] - ret[p]) * fx, bottom = ret[p + w] + (ret[p + w + 1] - ret[p + w]) * fx;
    const r = top + (bottom - top) * fy, t = ts[k];
    n++;
    if (tones) { buf[k] = r; sa += r; sb += t; saa += r * r; sab += r * t; } else sum += Math.abs(r - t);
  }
  if (n < count / 4 || n === 0) return Infinity;
  if (!tones) return sum / n;
  const [g, o] = toneFit(n, sa, sb, saa, sab);
  for (let k = 0; k < count; k++) if (buf[k] >= 0) sum += Math.abs(g * buf[k] + o - ts[k]);
  return sum / n;
}

/**
 * Lines the image model's answer up with the picture that was sent, using only `outside` (1 = a
 * pixel of `sent` outside the mark). The answer is first resized to `sent`'s size (which also undoes
 * a different aspect), then a residual shift (up to `maxShift` x the size, default 3 %) and a scale
 * about the centre, on x and on y apart (each up to `maxScale`, default 3 %: the model may keep its
 * own picture's proportions, a few percent off the aspect asked for, so the answer resized back is
 * stretched on one axis), are searched coarse to fine on luminance:
 * every candidate on the smallest halved copy (down to 1/16, its smaller side at least 48 pixels),
 * the best few refined by hill climbing on each larger copy up to full size, then by half pixels.
 * The outside area is shrunk by 2 pixels first, so an edit spilling just past the mark does not pull
 * the match. `tones` also fits a gain and offset (least squares, during the
 * search on luminance, for the result per RGB channel; the gain within 0.5..2) for answers with
 * shifted brightness and contrast. `shift` and `scale` say where the sent content sits in the
 * resized answer (content at sent pixel p is at c + scale * (p - c) + shift, c the centre, `scale`
 * [x, y]);
 * `error` is the mean absolute RGB difference over the outside area after all this (pixels whose
 * source lies off the answer left out). Not ok, with its `reason`, when: the shrunk outside area is
 * under 5 % of the crop ('too little outside the mark'); the error is over ALIGN_MAX_ERROR
 * ('different picture'); the answer was moved past the allowed range ('moved past the range': a
 * fit held at the range's edge is followed on past it, and one that keeps improving there fails);
 * or, given the `mark` (1 = inside, in `sent`'s grid), over 0.5 % of its pixels have their source
 * off the answer, so the paste would fill them with the answer's edge ('mark leaves the answer').
 */
export function alignTo(returned: Raster, sent: Raster, outside: Uint8Array, opts: { maxShift?: number; maxScale?: number; tones?: boolean; mark?: Uint8Array } = {}): Alignment {
  const W = sent.width, H = sent.height, tones = !!opts.tones;
  const maxShift = opts.maxShift ?? 0.03, maxScale = opts.maxScale ?? 0.03;
  if (outside.length !== W * H || (opts.mark && opts.mark.length !== W * H)) throw new Error('alignTo: a mask is not the size of the sent picture');
  const resized = resizeTo(returned, W, H);
  let use = erode(outside, W, H, 2);
  if (!use.some((v) => v)) use = outside;
  let used = 0;
  for (let p = 0; p < W * H; p++) used += use[p];
  if (!used) return { image: resized, shift: [0, 0], scale: [1, 1], error: 0, offMark: 0, ok: false, reason: 'too little outside the mark' };

  // The pyramid: full size, then halved while the smaller side stays at least 48 pixels (at most 1/16).
  const levels: Level[] = [];
  let ls = luminance(sent), lr = luminance(resized), lm = use, lw = W, lh = H, f = 1;
  levels.push(level(f, lw, lh, ls, lr, lm));
  while (levels.length < 5 && Math.min(lw >> 1, lh >> 1) >= 48) {
    ls = halveLum(ls, lw, lh); lr = halveLum(lr, lw, lh); lm = halveMask(lm, lw, lh);
    lw >>= 1; lh >>= 1; f /= 2;
    // Bilinear sampling near the mark reads the edited pixels; keep a pixel's distance from it.
    levels.push(level(f, lw, lh, ls, lr, erode(lm, lw, lh, 1)));
  }
  const cx = (W - 1) / 2, cy = (H - 1) / 2, maxDim = Math.max(W, H);
  const rangeX = maxShift * W, rangeY = maxShift * H;
  const clampScale = (s: number, wide: number) => Math.max(1 - maxScale * wide, Math.min(1 + maxScale * wide, s));
  const clampFit = (dx: number, dy: number, sx: number, sy: number, wide = 1): [number, number, number, number] => [
    Math.max(-rangeX * wide, Math.min(rangeX * wide, dx)), Math.max(-rangeY * wide, Math.min(rangeY * wide, dy)),
    clampScale(sx, wide), clampScale(sy, wide),
  ];

  // Every candidate at the coarsest level, a level pixel apart (half a level pixel at the edges for
  // each scale), the two scales searched on their own.
  const top = levels[levels.length - 1];
  const step = 1 / top.f, ds = 1 / (top.f * maxDim);
  const nx = Math.max(1, Math.round(rangeX * top.f)), ny = Math.max(1, Math.round(rangeY * top.f)), ns = Math.max(1, Math.ceil(maxScale / ds));
  const scales = Array.from({ length: 2 * ns + 1 }, (_, a) => 1 + Math.max(-maxScale, Math.min(maxScale, (a - ns) * ds)));
  const all: Fit[] = [];
  for (const sx of scales) for (const sy of scales) for (let j = -ny; j <= ny; j++) for (let i = -nx; i <= nx; i++) {
    const [dx, dy] = clampFit(i * step, j * step, sx, sy);
    all.push({ dx, dy, sx, sy, err: levelError(top, cx, cy, dx, dy, sx, sy, tones) });
  }
  all.sort((p, q) => p.err - q.err);
  // The best few distinct basins (not each other's neighbours) go on to the finer levels.
  let fits: Fit[] = [];
  for (const c of all) {
    if (fits.length >= 4 || !Number.isFinite(c.err)) break;
    if (fits.every((o) => Math.abs(o.dx - c.dx) > step * 1.01 || Math.abs(o.dy - c.dy) > step * 1.01 || Math.abs(o.sx - c.sx) > ds * 1.01 || Math.abs(o.sy - c.sy) > ds * 1.01)) fits.push(c);
  }
  if (!fits.length) fits = [{ dx: 0, dy: 0, sx: 1, sy: 1, err: Infinity }];

  // Hill climbing on level L from `start` (its error already measured on L): steps of `st` pixels
  // (the 8 neighbours) and `sd` in scale (each axis, and both together), while one improves, within
  // `wide` x the allowed range.
  const climb = (L: Level, start: Fit, st: number, sd: number, wide = 1): Fit => {
    let cur = start;
    for (let round = 0; round < 40; round++) {
      let best = cur;
      const { dx: x, dy: y, sx, sy } = cur;
      const tries: [number, number, number, number][] = [];
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (i || j) tries.push([x + i * st, y + j * st, sx, sy]);
      tries.push([x, y, sx + sd, sy], [x, y, sx - sd, sy], [x, y, sx, sy + sd], [x, y, sx, sy - sd], [x, y, sx + sd, sy + sd], [x, y, sx - sd, sy - sd]);
      for (const t of tries) {
        const [dx, dy, tx, ty] = clampFit(...t, wide);
        if (dx === x && dy === y && tx === sx && ty === sy) continue;
        const err = levelError(L, cx, cy, dx, dy, tx, ty, tones);
        if (err < best.err) best = { dx, dy, sx: tx, sy: ty, err };
      }
      if (best === cur) break;
      cur = best;
    }
    return cur;
  };
  // Each finer level ranks the candidates again (it sees more detail) and climbs from the best two,
  // the best one only at full size.
  for (let k = levels.length - 2; k >= 0; k--) {
    const L = levels[k];
    fits = fits.map((c) => ({ ...c, err: levelError(L, cx, cy, c.dx, c.dy, c.sx, c.sy, tones) })).sort((p, q) => p.err - q.err);
    fits = fits.slice(0, k === 0 ? 1 : 2).map((c) => climb(L, c, 1 / L.f, 1 / (L.f * maxDim))).sort((p, q) => p.err - q.err);
  }
  if (levels.length === 1) fits = [climb(levels[0], fits[0], 1, 1 / maxDim)];
  let best = climb(levels[0], fits[0], 0.5, 0.5 / maxDim);

  // A fit held at the edge of the range (on any axis) may be an answer moved further, which would
  // paste a few pixels off with a small error: climb on past the edge (up to half the range again),
  // and if the match keeps improving out there, the answer is not ok.
  const tolerance = 0.5;
  const beyond = (c: Fit, by: number) => Math.abs(c.dx) > rangeX + by || Math.abs(c.dy) > rangeY + by
    || Math.abs(c.sx - 1) > maxScale + by / maxDim || Math.abs(c.sy - 1) > maxScale + by / maxDim;
  let outOfRange = false;
  if (beyond(best, -tolerance)) {
    const past = climb(levels[0], best, 1, 1 / maxDim, 1.5);
    if (beyond(past, tolerance)) { best = past; outOfRange = true; }
  }

  const image = warp(resized, best.dx, best.dy, best.sx, best.sy);
  // Which columns and rows read inside the answer (its pixels cover -0.5 .. size - 0.5).
  const onAnswer = (n: number, c: number, s: number, d: number) => Uint8Array.from({ length: n }, (_, i) => {
    const u = c + s * (i - c) + d;
    return u >= -0.5 && u <= n - 0.5 ? 1 : 0;
  });
  const cols = onAnswer(W, cx, best.sx, best.dx), rows = onAnswer(H, cy, best.sy, best.dy);
  const error = finish(image, sent, use, cols, rows, tones);
  let offMark = 0, marked = 0;
  if (opts.mark) for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!opts.mark[j * W + i]) continue;
    marked++;
    if (!(cols[i] && rows[j])) offMark++;
  }
  const reason: AlignFailure | undefined = used < MIN_OUTSIDE * W * H ? 'too little outside the mark'
    : !(error <= ALIGN_MAX_ERROR) ? 'different picture'
    : outOfRange ? 'moved past the range'
    : offMark > MAX_OFF_MARK * marked ? 'mark leaves the answer'
    : undefined;
  return { image, shift: [best.dx, best.dy], scale: [best.sx, best.sy], error, offMark, ok: !reason, ...(reason ? { reason } : {}) };
}

/** The resized answer moved back onto the sent picture's pixels (bilinear, edges clamped). */
function warp(img: Raster, dx: number, dy: number, sx: number, sy: number): Raster {
  const cx = (img.width - 1) / 2, cy = (img.height - 1) / 2;
  return sampleLinear(img, img.width, img.height, sx, cx * (1 - sx) + dx, sy, cy * (1 - sy) + dy);
}

/**
 * With `tones`, matches each RGB channel of the lined-up answer to the sent picture over `use`
 * (least-squares gain and offset, in place); then the mean absolute RGB difference over `use`.
 * Both leave out pixels whose source is off the answer (column `cols[i]` or row `rows[j]` is 0).
 */
function finish(image: Raster, sent: Raster, use: Uint8Array, cols: Uint8Array, rows: Uint8Array, tones: boolean): number {
  const w = image.width, n = w * image.height, a = image.data, b = sent.data;
  const on = new Uint8Array(n);
  let count = 0;
  for (let p = 0; p < n; p++) if (use[p] && cols[p % w] && rows[(p / w) | 0]) { on[p] = 1; count++; }
  if (!count) return Infinity;
  if (tones) {
    for (let k = 0; k < 3; k++) {
      let sa = 0, sb = 0, saa = 0, sab = 0;
      for (let p = 0; p < n; p++) if (on[p]) { const x = a[p * 4 + k], y = b[p * 4 + k]; sa += x; sb += y; saa += x * x; sab += x * y; }
      const [g, o] = toneFit(count, sa, sb, saa, sab);
      for (let p = 0; p < n; p++) a[p * 4 + k] = Math.max(0, Math.min(255, Math.round(g * a[p * 4 + k] + o)));
    }
  }
  let sum = 0;
  for (let p = 0; p < n; p++) if (on[p]) sum += Math.abs(a[p * 4] - b[p * 4]) + Math.abs(a[p * 4 + 1] - b[p * 4 + 1]) + Math.abs(a[p * 4 + 2] - b[p * 4 + 2]);
  return sum / (3 * count);
}

/** Squared distance transform of one row or column (Felzenszwalb and Huttenlocher), `f` into `d`. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Each pixel's exact distance to the nearest pixel with mask 0 (Infinity when there is none). */
function distanceOutside(mask: Uint8Array, w: number, h: number): Float64Array {
  const BIG = 1e20, grid = new Float64Array(w * h), n = Math.max(w, h);
  for (let p = 0; p < w * h; p++) grid[p] = mask[p] ? BIG : 0;
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) f[j] = grid[j * w + i];
    edt1d(f, h, d, v, z);
    for (let j = 0; j < h; j++) grid[j * w + i] = d[j];
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) f[i] = grid[j * w + i];
    edt1d(f, w, d, v, z);
    for (let i = 0; i < w; i++) grid[j * w + i] = d[i] >= BIG / 2 ? Infinity : Math.sqrt(d[i]);
  }
  return grid;
}

/**
 * Pastes `edited` into `orig` only where `mask` is 1, blended by the distance to the mark's edge:
 * weight distance / featherPx (the distance to the nearest pixel with mask 0), so the edit fades in
 * from the edge and is whole from `featherPx` inside. The picture's own border is not an edge.
 * Every pixel with mask 0 is copied from `orig` untouched (all four bytes).
 */
export function featherPaste(orig: Raster, edited: Raster, mask: Uint8Array, featherPx: number): Raster {
  const w = orig.width, h = orig.height;
  if (edited.width !== w || edited.height !== h || mask.length !== w * h) throw new Error('featherPaste: the pictures and the mask differ in size');
  return blend(orig, edited, mask, featherPx, featherPx > 0 ? distanceOutside(mask, w, h) : null);
}

/** featherPaste's blend, given each pixel's distance to the mark's edge (null: no feather). */
function blend(orig: Raster, edited: Raster, mask: Uint8Array, featherPx: number, dist: Float64Array | null): Raster {
  const w = orig.width, h = orig.height, data = new Uint8Array(orig.data);
  const a = orig.data, b = edited.data;
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) continue;
    const t = dist ? Math.min(1, dist[p] / featherPx) : 1;
    for (let k = p * 4; k < p * 4 + 4; k++) data[k] = t === 1 ? b[k] : Math.round(a[k] + (b[k] - a[k]) * t);
  }
  return { width: w, height: h, data };
}

/**
 * One level of the membrane solve: each pixel's state (0 not in it, 1 solved for, 2 held at its
 * value) and value.
 */
interface Membrane { w: number; h: number; state: Uint8Array; val: Float32Array }

/** Gauss-Seidel steps per level going up from the coarsest, and on the coarsest level itself. */
const MEMBRANE_STEPS = 16, MEMBRANE_COARSEST_STEPS = 400;
/** Over-relaxation of each step (1 is plain Gauss-Seidel; below 2 always converges). */
const MEMBRANE_OMEGA = 1.7;

/**
 * Half the size: a 2 x 2 block is held (at its held pixels' mean) when any of its pixels is held,
 * else solved for when any is, else not in the membrane.
 */
function coarser(m: Membrane): Membrane {
  const w = (m.w + 1) >> 1, h = (m.h + 1) >> 1, state = new Uint8Array(w * h), val = new Float32Array(w * h), held = new Uint16Array(w * h);
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
    const p = j * m.w + i, s = m.state[p];
    if (!s) continue;
    const q = (j >> 1) * w + (i >> 1);
    if (s === 2) { state[q] = 2; val[q] += m.val[p]; held[q]++; } else if (!state[q]) state[q] = 1;
  }
  for (let q = 0; q < w * h; q++) if (held[q]) val[q] /= held[q];
  return { w, h, state, val };
}

/**
 * Over-relaxed Gauss-Seidel steps toward each solved pixel being the mean of its neighbours in the
 * membrane (a neighbour off the picture or not in the membrane is left out: no pull across it).
 */
function relax(m: Membrane, steps: number) {
  const { w, h, state, val } = m;
  let n = 0;
  for (let p = 0; p < w * h; p++) if (state[p] === 1) n++;
  const at = new Int32Array(n), nb = new Int32Array(4 * n), count = new Uint8Array(n);
  let k = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = j * w + i;
    if (state[p] !== 1) continue;
    at[k] = p;
    let c = 0;
    if (i > 0 && state[p - 1]) nb[4 * k + c++] = p - 1;
    if (i < w - 1 && state[p + 1]) nb[4 * k + c++] = p + 1;
    if (j > 0 && state[p - w]) nb[4 * k + c++] = p - w;
    if (j < h - 1 && state[p + w]) nb[4 * k + c++] = p + w;
    count[k++] = c;
  }
  for (let step = 0; step < steps; step++) {
    for (k = 0; k < n; k++) {
      const c = count[k];
      if (!c) continue;
      let s = 0;
      for (let e = 4 * k; e < 4 * k + c; e++) s += val[nb[e]];
      const p = at[k];
      val[p] += MEMBRANE_OMEGA * (s / c - val[p]);
    }
  }
}

/**
 * Solves the membrane in place: the solved pixels end up a smooth (harmonic) fill between the held
 * ones. Coarse to fine: the half-size membrane is solved first, its values start this level's solved
 * pixels, and a few relaxation steps take out what the coarse level could not see.
 */
function solveMembrane(m: Membrane) {
  if (Math.min(m.w, m.h) <= 8) { relax(m, MEMBRANE_COARSEST_STEPS); return; }
  const c = coarser(m);
  solveMembrane(c);
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
    const p = j * m.w + i;
    if (m.state[p] === 1) m.val[p] = c.val[(j >> 1) * c.w + (i >> 1)];
  }
  relax(m, MEMBRANE_STEPS);
}

/**
 * Pastes `edited` into `orig` inside `mask` so the mark's edge does not show (seamless cloning): the
 * edit is first corrected by a smooth field that makes it equal `orig` on the mark's edge pixels
 * (mark pixels next to a pixel outside it; the picture's own border is not an edge) and spreads
 * smoothly inward (a membrane: harmonic inside the mark), so a redraw whose tones differ from the
 * original, even differently along the edge, keeps its own detail but meets the original without a
 * step. The correction fades out linearly over `fadePx` from the edge (Infinity: never), so deeper
 * inside the edit keeps its own tones (a face asked darker stays darker in the middle; the change
 * ramps in over `fadePx` instead of a step). Then featherPaste with `featherPx`, at most half the
 * mark's deepest point so the middle of a small mark is wholly the edit. Each RGB channel is
 * corrected apart (once when the difference is grey); alpha is the edit's. Every pixel with mask 0
 * is copied from `orig` untouched.
 */
export function seamlessPaste(orig: Raster, edited: Raster, mask: Uint8Array, featherPx: number, fadePx = Infinity): Raster {
  const w = orig.width, h = orig.height;
  if (edited.width !== w || edited.height !== h || mask.length !== w * h) throw new Error('seamlessPaste: the pictures and the mask differ in size');
  const a = orig.data, b = edited.data, state = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = j * w + i;
    if (!mask[p]) continue;
    const edge = (i > 0 && !mask[p - 1]) || (i < w - 1 && !mask[p + 1]) || (j > 0 && !mask[p - w]) || (j < h - 1 && !mask[p + w]);
    state[p] = edge ? 2 : 1;
  }
  let grey = true;
  for (let p = 0; p < w * h && grey; p++) {
    if (state[p] !== 2) continue;
    const o = p * 4, d = a[o] - b[o];
    grey = a[o + 1] - b[o + 1] === d && a[o + 2] - b[o + 2] === d;
  }
  // Each mark pixel's distance to the edge: the edge pixels are 1 from a pixel outside.
  const dist = distanceOutside(mask, w, h);
  const corrected = new Uint8Array(b);
  let field: Float32Array | null = null;
  for (let k = 0; k < 3; k++) {
    if (!grey || !field) {
      const val = new Float32Array(w * h);
      for (let p = 0; p < w * h; p++) if (state[p] === 2) val[p] = a[p * 4 + k] - b[p * 4 + k];
      solveMembrane({ w, h, state, val });
      field = val;
    }
    for (let p = 0; p < w * h; p++) {
      if (!state[p]) continue;
      const keep = fadePx === Infinity ? 1 : Math.max(0, 1 - (dist[p] - 1) / fadePx);
      corrected[p * 4 + k] = Math.max(0, Math.min(255, Math.round(b[p * 4 + k] + keep * field[p])));
    }
  }
  let deepest = 0;
  for (let p = 0; p < w * h; p++) if (dist[p] !== Infinity && dist[p] > deepest) deepest = dist[p];
  const feather = Math.max(0, Math.min(featherPx, deepest / 2));
  return blend(orig, { width: w, height: h, data: corrected }, mask, feather, feather > 0 ? dist : null);
}
