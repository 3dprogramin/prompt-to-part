// A flat colour relief (a LayerTone picture, a flat lithophane) for the GLB: millions of tiny steps
// in their colours are far too heavy for a phone, so the part becomes a coarse relief with the
// picture as a texture and its fine steps as a normal map. Seen from its face the part is a height
// field: its front is a grid of a few tens of thousands of cells, its back and sides plain walls in
// their colours.
import type { PartMesh } from '../../shared/types';
import { toLinear } from '../../shared/layertone';

/** The texture's long side, pixels: finer than the pictures (at most 800 px, MAX_LAYERTONE_IMAGE_SIDE), so the edges between colours stay crisp when zoomed in. */
export const PICTURE_SIDE = 1536;
/** About this many cells in the front's grid: ~50k triangles, ~1 MB with its normals and texture coordinates. */
export const RELIEF_CELLS = 24_000;

export interface PictureRelief {
  /** The face, in model coordinates (mm): textured, smooth. */
  front: { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array };
  /** Sides and back, in model coordinates (mm), coloured per vertex (linear). */
  rest: { positions: Float32Array; colors: Float32Array; indices: Uint32Array };
  /** The face as it looks, sRGB; texture coordinates (0, 0) are its top left. */
  image: Picture;
  /** The fine relief the coarse one smooths over (the steps), as a tangent-space normal map of the same size. */
  normalMap: Picture;
}

export interface Picture { width: number; height: number; rgba: Uint8ClampedArray }

/** A LayerTone picture or a flat lithophane that lies in a plane (much thinner than it is wide), not painted. */
export function isFlatPicture(part: PartMesh): boolean {
  if (part.paint || !(part.layerColors?.length || part.lithophane?.options.shape === 'flat')) return false;
  const s = [0, 1, 2].map((k) => part.bbox.max[k] - part.bbox.min[k]).sort((a, b) => a - b);
  return s[0] < 0.25 * s[1];
}

type Frame = number[][];
/**
 * Rows u, v, w in model axes (a rotation): the picture lies in u (right) and v (up), w comes out of
 * its face. By the part's thinnest axis; a standing panel (thin in Y) reads from the front, -Y.
 */
const FRAMES: Frame[] = [
  [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
];
/** The same plane seen from the other side (turned half round u). */
const flip = (f: Frame): Frame => [f[0], f[1].map((x) => -x), f[2].map((x) => -x)];

interface Raster {
  frame: Frame;
  u0: number; u1: number; v0: number; v1: number;
  /** Pixel size, mm. */
  s: number;
  W: number; H: number;
  /** Front (largest w) and back (smallest w) per pixel; -Infinity where nothing covers it. */
  fw: Float32Array; bw: Float32Array;
  /** sRGB bytes of the front and back, 3 per pixel. */
  fc: Uint8ClampedArray; bc: Uint8ClampedArray;
}

/** Every triangle drawn onto the plane of `frame`: what covers each pixel nearest and farthest along w. */
function rasterise(pos: Float32Array, idx: Uint32Array, srgb: Float32Array, frame: Frame): Raster {
  const n = pos.length / 3;
  const U = new Float32Array(n), V = new Float32Array(n), Wd = new Float32Array(n);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const [fu, fv, fwr] = frame;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const u = fu[0] * x + fu[1] * y + fu[2] * z, v = fv[0] * x + fv[1] * y + fv[2] * z;
    U[i] = u; V[i] = v; Wd[i] = fwr[0] * x + fwr[1] * y + fwr[2] * z;
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const s = Math.max(u1 - u0, v1 - v0) / PICTURE_SIDE;
  const W = Math.max(1, Math.ceil((u1 - u0) / s - 1e-6)), H = Math.max(1, Math.ceil((v1 - v0) / s - 1e-6));
  const fw = new Float32Array(W * H).fill(-Infinity), bw = new Float32Array(W * H).fill(Infinity);
  const fc = new Uint8ClampedArray(W * H * 3), bc = new Uint8ClampedArray(W * H * 3);
  const e = 1e-6;
  // Where row y crosses the edge P-Q, widening `span` (an edge along the row counts whole).
  const span = new Float64Array(2);
  function cross(Xp: number, Yp: number, Xq: number, Yq: number, y: number) {
    const lo = Yp < Yq ? Yp : Yq, hi = Yp < Yq ? Yq : Yp;
    if (y < lo - e || y > hi + e) return;
    let a: number, b: number;
    if (hi - lo < 1e-12) { a = Xp; b = Xq; } else { a = b = Xp + (((y < lo ? lo : y > hi ? hi : y) - Yp) * (Xq - Xp)) / (Yq - Yp); }
    if (a < span[0]) span[0] = a;
    if (b < span[0]) span[0] = b;
    if (a > span[1]) span[1] = a;
    if (b > span[1]) span[1] = b;
  }
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    // Pixel coordinates: pixel (col, row) has its centre at (col, row); rows run down from the top.
    const X0 = (U[a] - u0) / s - 0.5, Y0 = (v1 - V[a]) / s - 0.5;
    const X1 = (U[b] - u0) / s - 0.5, Y1 = (v1 - V[b]) / s - 0.5;
    const X2 = (U[c] - u0) / s - 0.5, Y2 = (v1 - V[c]) / s - 0.5;
    const area = (X1 - X0) * (Y2 - Y0) - (X2 - X0) * (Y1 - Y0);
    if (Math.abs(area) < 1e-12) continue; // a wall, edge on
    const rMin = Math.max(0, Math.ceil(Math.min(Y0, Y1, Y2) - e)), rMax = Math.min(H - 1, Math.floor(Math.max(Y0, Y1, Y2) + e));
    for (let r = rMin; r <= rMax; r++) {
      // The row's span across the triangle (long slivers, e.g. a bottom fanned from its centre, stay cheap).
      span[0] = Infinity; span[1] = -Infinity;
      cross(X0, Y0, X1, Y1, r); cross(X1, Y1, X2, Y2, r); cross(X2, Y2, X0, Y0, r);
      const xl = span[0], xr = span[1];
      const cMin = Math.max(0, Math.ceil(xl - e)), cMax = Math.min(W - 1, Math.floor(xr + e));
      for (let col = cMin; col <= cMax; col++) {
        const l1 = ((col - X0) * (Y2 - Y0) - (X2 - X0) * (r - Y0)) / area;
        const l2 = ((X1 - X0) * (r - Y0) - (col - X0) * (Y1 - Y0)) / area;
        const l0 = 1 - l1 - l2;
        if (l0 < -e || l1 < -e || l2 < -e) continue;
        const w = l0 * Wd[a] + l1 * Wd[b] + l2 * Wd[c];
        const p = r * W + col;
        if (w > fw[p]) {
          fw[p] = w;
          for (let k = 0; k < 3; k++) fc[p * 3 + k] = (l0 * srgb[a * 3 + k] + l1 * srgb[b * 3 + k] + l2 * srgb[c * 3 + k]) * 255 + 0.5;
        }
        if (w < bw[p]) {
          bw[p] = w;
          for (let k = 0; k < 3; k++) bc[p * 3 + k] = (l0 * srgb[a * 3 + k] + l1 * srgb[b * 3 + k] + l2 * srgb[c * 3 + k]) * 255 + 0.5;
        }
      }
    }
  }
  return { frame, u0, u1, v0, v1, s, W, H, fw, bw, fc, bc };
}

/** How much the colours vary over the covered pixels (the picture's side varies, a plain back doesn't). */
function variance(r: Raster, c: Uint8ClampedArray): number {
  let n = 0, sum = 0, sq = 0;
  for (let p = 0; p < r.fw.length; p++) {
    if (r.fw[p] === -Infinity) continue;
    const l = 0.2126 * c[p * 3] + 0.7152 * c[p * 3 + 1] + 0.0722 * c[p * 3 + 2];
    n++; sum += l; sq += l * l;
  }
  return n ? sq / n - (sum / n) ** 2 : 0;
}

/** The face as RGBA; pixels off the part take the nearest covered pixel's colour, so its edges don't darken when filtered. */
function pictureImage(r: Raster): Picture {
  const { W, H, fw, fc } = r;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const from = new Int32Array(W * H).fill(-1);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (let p = 0; p < W * H; p++) if (fw[p] !== -Infinity) { from[p] = p; queue[tail++] = p; }
  while (head < tail) {
    const p = queue[head++], x = p % W, y = (p - x) / W;
    if (x > 0 && from[p - 1] < 0) { from[p - 1] = from[p]; queue[tail++] = p - 1; }
    if (x < W - 1 && from[p + 1] < 0) { from[p + 1] = from[p]; queue[tail++] = p + 1; }
    if (y > 0 && from[p - W] < 0) { from[p - W] = from[p]; queue[tail++] = p - W; }
    if (y < H - 1 && from[p + W] < 0) { from[p + W] = from[p]; queue[tail++] = p + W; }
  }
  for (let p = 0; p < W * H; p++) {
    const q = from[p];
    for (let k = 0; k < 3; k++) rgba[p * 4 + k] = q < 0 ? 128 : fc[q * 3 + k];
    rgba[p * 4 + 3] = 255;
  }
  return { width: W, height: H, rgba };
}

/** Growable arrays for the sides and back. */
class Soup {
  pos: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** A flat quad p0..p3 (local u, v, w) facing `out`; `top`/`bottom` colours for p2, p3 / p0, p1 (linear). */
  quad(p: number[][], out: number[], bottom: number[], top: number[]) {
    const e1 = p[1].map((x, k) => x - p[0][k]), e2 = p[2].map((x, k) => x - p[0][k]);
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const base = this.pos.length / 3;
    p.forEach((q, i) => { this.pos.push(...q); this.col.push(...(i < 2 ? bottom : top)); });
    const forward = nrm[0] * out[0] + nrm[1] * out[1] + nrm[2] * out[2] >= 0;
    if (forward) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
}

/** The part as a coarse relief with its face as a picture; undefined when nothing of it faces a plane. */
export function pictureRelief(part: PartMesh, srgb: Float32Array): PictureRelief | undefined {
  const s = [0, 1, 2].map((k) => part.bbox.max[k] - part.bbox.min[k]);
  const thin = s.indexOf(Math.min(...s));
  let r = rasterise(part.positions, part.indices, srgb, FRAMES[thin]);
  // The picture is on the side whose colours vary (LayerTone's back is its first filament, a
  // lithophane's its frame): turn round if that is the far side.
  if (variance(r, r.bc) > variance(r, r.fc)) r = rasterise(part.positions, part.indices, srgb, flip(r.frame));
  const { W, H, s: px, u0, u1, v0, v1, fw, bw, fc, bc, frame } = r;

  // Cells of k × k pixels; a cell is part of the relief when at least half of it is covered.
  const k = Math.max(1, Math.ceil(Math.sqrt((W * H) / RELIEF_CELLS)));
  const NX = Math.ceil(W / k), NY = Math.ceil(H / k);
  const nc = NX * NY;
  const covered = new Uint8Array(nc);
  const cf = new Float32Array(nc), cb = new Float32Array(nc), cfc = new Float32Array(nc * 3), cbc = new Float32Array(nc * 3);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      let n = 0, total = 0;
      const c = j * NX + i, sum = [0, 0, 0, 0, 0, 0, 0, 0];
      for (let y = j * k; y < Math.min(H, (j + 1) * k); y++) {
        for (let x = i * k; x < Math.min(W, (i + 1) * k); x++) {
          total++;
          const p = y * W + x;
          if (fw[p] === -Infinity) continue;
          n++; sum[0] += fw[p]; sum[1] += bw[p];
          for (let q = 0; q < 3; q++) { sum[2 + q] += fc[p * 3 + q]; sum[5 + q] += bc[p * 3 + q]; }
        }
      }
      if (!n || n * 2 < total) continue;
      covered[c] = 1;
      cf[c] = sum[0] / n;
      // Backs are mostly one plane: rounded, so equal ones merge into long strips.
      cb[c] = Math.round((sum[1] / n) * 1000) / 1000;
      for (let q = 0; q < 3; q++) { cfc[c * 3 + q] = toLinear(sum[2 + q] / n / 255); cbc[c * 3 + q] = toLinear(Math.round(sum[5 + q] / n) / 255); }
    }
  }
  const isCov = (i: number, j: number) => i >= 0 && j >= 0 && i < NX && j < NY && covered[j * NX + i] === 1;

  // Grid nodes: column i at u, row j at v (rows run down from the top, as the picture's).
  const nu = (i: number) => Math.min(u1, u0 + Math.min(i * k, W) * px);
  const nv = (j: number) => Math.max(v0, v1 - Math.min(j * k, H) * px);
  const NN = (NX + 1) * (NY + 1);
  const node = new Int32Array(NN).fill(-1);
  const depth = new Float32Array(NN);
  let count = 0;
  for (let j = 0; j <= NY; j++) {
    for (let i = 0; i <= NX; i++) {
      let n = 0, d = 0;
      for (const [ci, cj] of [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]]) if (isCov(ci, cj)) { n++; d += cf[cj * NX + ci]; }
      if (!n) continue;
      node[j * (NX + 1) + i] = count++;
      depth[j * (NX + 1) + i] = d / n;
    }
  }
  if (!count) return undefined;

  const toModel = (u: number, v: number, w: number, out: Float32Array | number[], o: number) => {
    for (let a = 0; a < 3; a++) out[o + a] = frame[0][a] * u + frame[1][a] * v + frame[2][a] * w;
  };
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), uvs = new Float32Array(count * 2);
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i <= NX && j <= NY && node[j * (NX + 1) + i] >= 0 ? j * (NX + 1) + i : -1);
  for (let j = 0; j <= NY; j++) {
    for (let i = 0; i <= NX; i++) {
      const g = j * (NX + 1) + i, id = node[g];
      if (id < 0) continue;
      const u = nu(i), v = nv(j);
      toModel(u, v, depth[g], positions, id * 3);
      uvs[id * 2] = (u - u0) / (W * px); uvs[id * 2 + 1] = (v1 - v) / (H * px);
      // Slopes from the neighbours on either side (one side at an edge).
      const L = at(i - 1, j), R = at(i + 1, j), D = at(i, j + 1), T = at(i, j - 1);
      const gu = L >= 0 || R >= 0 ? (depth[R >= 0 ? R : g] - depth[L >= 0 ? L : g]) / (nu(R >= 0 ? i + 1 : i) - nu(L >= 0 ? i - 1 : i) || 1) : 0;
      const gv = D >= 0 || T >= 0 ? (depth[T >= 0 ? T : g] - depth[D >= 0 ? D : g]) / (nv(T >= 0 ? j - 1 : j) - nv(D >= 0 ? j + 1 : j) || 1) : 0;
      const l = Math.hypot(gu, gv, 1);
      toModel(-gu / l, -gv / l, 1 / l, normals, id * 3);
    }
  }
  const tri: number[] = [];
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      if (!covered[j * NX + i]) continue;
      // Counter-clockwise seen from the face: bottom left, bottom right, top right, top left.
      const ga = (j + 1) * (NX + 1) + i, gb = ga + 1, gc = j * (NX + 1) + i + 1, gd = gc - 1;
      const [a, b, c, d] = [node[ga], node[gb], node[gc], node[gd]];
      if (Math.abs(depth[ga] - depth[gc]) <= Math.abs(depth[gb] - depth[gd])) tri.push(a, b, c, a, c, d);
      else tri.push(a, b, d, b, c, d);
    }
  }

  // Sides: where a cell has no neighbour, a wall from its back up to the face; where neighbours'
  // backs differ, a step. The back: strips of cells along a row on the same plane.
  const soup = new Soup();
  const cellCol = (arr: Float32Array, c: number) => [arr[c * 3], arr[c * 3 + 1], arr[c * 3 + 2]];
  // Each cell's four edges: neighbour offset, the edge's two nodes (as [i, j]) and the outward direction.
  const edges: [number, number, number[], number[], number[]][] = [
    [-1, 0, [0, 1], [0, 0], [-1, 0, 0]],
    [1, 0, [1, 0], [1, 1], [1, 0, 0]],
    [0, -1, [0, 0], [1, 0], [0, 1, 0]],
    [0, 1, [1, 1], [0, 1], [0, -1, 0]],
  ];
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const c = j * NX + i;
      if (!covered[c]) continue;
      for (const [di, dj, A, B, out] of edges) {
        const [ai, aj] = [i + A[0], j + A[1]], [bi, bj] = [i + B[0], j + B[1]];
        const pa = [nu(ai), nv(aj)], pb = [nu(bi), nv(bj)];
        if (!isCov(i + di, j + dj)) {
          const da = depth[aj * (NX + 1) + ai], db = depth[bj * (NX + 1) + bi];
          if (Math.max(da, db) - cb[c] > 1e-6) soup.quad([[...pa, cb[c]], [...pb, cb[c]], [...pb, db], [...pa, da]], out, cellCol(cbc, c), cellCol(cfc, c));
        } else {
          const n = (j + dj) * NX + i + di;
          if (cb[c] < cb[n] - 1e-6) soup.quad([[...pa, cb[c]], [...pb, cb[c]], [...pb, cb[n]], [...pa, cb[n]]], out, cellCol(cbc, c), cellCol(cbc, n));
        }
      }
    }
  }
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX;) {
      const c = j * NX + i;
      if (!covered[c]) { i++; continue; }
      let e = i + 1;
      const same = (d: number) => covered[d] && cb[d] === cb[c] && cbc[d * 3] === cbc[c * 3] && cbc[d * 3 + 1] === cbc[c * 3 + 1] && cbc[d * 3 + 2] === cbc[c * 3 + 2];
      while (e < NX && same(j * NX + e)) e++;
      const col = cellCol(cbc, c);
      soup.quad([[nu(i), nv(j + 1), cb[c]], [nu(e), nv(j + 1), cb[c]], [nu(e), nv(j), cb[c]], [nu(i), nv(j), cb[c]]], [0, 0, -1], col, col);
      i = e;
    }
  }
  // The fine relief, less the coarse one, as normals (glTF: red to the right, +u; green up, +v).
  const coarse = (x: number, y: number) => {
    const fx = (x + 0.5) / k, fy = (y + 0.5) / k;
    const i = Math.min(NX - 1, Math.floor(fx)), j = Math.min(NY - 1, Math.floor(fy));
    const tx = fx - i, ty = fy - j;
    let sum = 0, wsum = 0;
    for (const [di, dj, wt] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
      const g = (j + dj) * (NX + 1) + i + di;
      if (node[g] >= 0) { sum += depth[g] * wt; wsum += wt; }
    }
    return wsum > 0 ? sum / wsum : fw[y * W + x];
  };
  const detail = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = y * W + x; if (fw[p] !== -Infinity) detail[p] = fw[p] - coarse(x, y); }
  const nrgba = new Uint8ClampedArray(W * H * 4);
  const has = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && fw[y * W + x] !== -Infinity;
  const MAX_SLOPE = 3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      let du = 0, dv = 0;
      if (has(x, y)) {
        const xl = has(x - 1, y) ? x - 1 : x, xr = has(x + 1, y) ? x + 1 : x;
        const yu = has(x, y - 1) ? y - 1 : y, yd = has(x, y + 1) ? y + 1 : y;
        if (xr > xl) du = (detail[y * W + xr] - detail[y * W + xl]) / ((xr - xl) * px);
        if (yd > yu) dv = (detail[yu * W + x] - detail[yd * W + x]) / ((yd - yu) * px);
        du = Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, du)); dv = Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, dv));
      }
      const l = Math.hypot(du, dv, 1);
      nrgba[p * 4] = Math.round((-du / l * 0.5 + 0.5) * 255);
      nrgba[p * 4 + 1] = Math.round((-dv / l * 0.5 + 0.5) * 255);
      nrgba[p * 4 + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      nrgba[p * 4 + 3] = 255;
    }
  }

  const restPos = new Float32Array(soup.pos.length);
  for (let p = 0; p < soup.pos.length; p += 3) toModel(soup.pos[p], soup.pos[p + 1], soup.pos[p + 2], restPos, p);

  return {
    front: { positions, normals, uvs, indices: Uint32Array.from(tri) },
    rest: { positions: restPos, colors: Float32Array.from(soup.col), indices: Uint32Array.from(soup.idx) },
    image: pictureImage(r),
    normalMap: { width: W, height: H, rgba: nrgba },
  };
}
