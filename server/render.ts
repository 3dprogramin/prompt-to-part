// Tiny software rasterizer so the AI agent can *see* the model it built.
// Produces a 2x2 sheet: ISO | FRONT / RIGHT | TOP, with a mm grid on ortho views.
import { deflateSync } from 'node:zlib';
import type { PartMesh, Vec3 } from '../shared/types';
import { cross, dot, norm } from '../shared/vec3';

const VIEW = 560;

interface View {
  name: string;
  right: Vec3;
  up: Vec3;
  dir: Vec3; // camera looks along dir
  grid: boolean;
}


function isoView(): View {
  const dir = norm([-1, 1, -0.75]); // from front-right-above looking toward origin
  const right = norm(cross(dir, [0, 0, 1]));
  const up = cross(right, dir);
  return { name: 'ISO', right, up, dir, grid: false };
}

const VIEWS: View[] = [
  isoView(),
  { name: 'FRONT', right: [1, 0, 0], up: [0, 0, 1], dir: [0, 1, 0], grid: true },
  { name: 'RIGHT', right: [0, 1, 0], up: [0, 0, 1], dir: [-1, 0, 0], grid: true },
  { name: 'TOP', right: [1, 0, 0], up: [0, 1, 0], dir: [0, 0, -1], grid: true },
];

function hexToRgb(hex: string): Vec3 {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [200, 170, 90];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function niceGridStep(span: number) {
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  return steps.find((s) => span / s <= 24) ?? 1000;
}

export interface RenderOutput {
  png: Buffer;
  gridStep: number;
}

export function renderSheet(parts: PartMesh[]): RenderOutput {
  return renderViews(parts, VIEWS, 2, VIEW);
}

/** A single large iso view (e.g. assembled / exploded pictures for the user). */
export function renderIso(parts: PartMesh[], size = 720): RenderOutput {
  return renderViews(parts, [isoView()], 1, size);
}

function renderViews(parts: PartMesh[], views: View[], cols: number, VIEW: number): RenderOutput {
  const rows = Math.ceil(views.length / cols);
  const W = VIEW * cols, Hh = VIEW * rows;
  const img = new Uint8Array(W * Hh * 3);
  // global bbox
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p.bbox.min[k]); max[k] = Math.max(max[k], p.bbox.max[k]); }
  const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
  const gridStep = niceGridStep(span * 1.15);

  // Ortho views share one scale so proportions compare across them.
  const orthoExtent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 1.15 + 1e-6;

  views.forEach((view, vi) => {
    const ox = (vi % cols) * VIEW, oy = Math.floor(vi / cols) * VIEW;
    // projected bbox of all corners
    let sMinX = Infinity, sMaxX = -Infinity, sMinY = Infinity, sMaxY = -Infinity;
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
      const p: Vec3 = [x, y, z];
      const sx = dot(p, view.right), sy = dot(p, view.up);
      sMinX = Math.min(sMinX, sx); sMaxX = Math.max(sMaxX, sx); sMinY = Math.min(sMinY, sy); sMaxY = Math.max(sMaxY, sy);
    }
    const cx = (sMinX + sMaxX) / 2, cy = (sMinY + sMaxY) / 2;
    const extent = view.grid ? orthoExtent : Math.max(sMaxX - sMinX, sMaxY - sMinY) * 1.12 + 1e-6;
    const k = VIEW / extent;
    const toScreen = (p: Vec3): [number, number, number] => [
      (dot(p, view.right) - cx) * k + VIEW / 2,
      VIEW / 2 - (dot(p, view.up) - cy) * k,
      dot(p, view.dir),
    ];

    const depth = new Float32Array(VIEW * VIEW).fill(Infinity);
    const nbuf = new Float32Array(VIEW * VIEW * 3);
    const col = new Uint8Array(VIEW * VIEW * 3);
    const pid = new Int16Array(VIEW * VIEW).fill(-1);
    // Parts drawn without crease lines: LayerTone reliefs (every layer step would draw one) and
    // sculpted meshes whose triangles are mostly smaller than a pixel here (a Meshy figure's noisy
    // surface would turn every pixel into a crease). Outlines and part borders are still drawn.
    const flatParts = new Set<number>();
    const light1 = norm([-view.dir[0] + view.up[0] * 0.6 - view.right[0] * 0.4, -view.dir[1] + view.up[1] * 0.6 - view.right[1] * 0.4, -view.dir[2] + view.up[2] * 0.6 - view.right[2] * 0.4]);
    const viewer: Vec3 = [-view.dir[0], -view.dir[1], -view.dir[2]];

    parts.forEach((part, partIdx) => {
      const base = hexToRgb(part.color);
      const P = part.positions, I = part.indices;
      // LayerTone parts: each vertex's simulated print colour (sRGB 0–1), blended across the triangle.
      const VC = part.vertexColors?.length === P.length ? part.vertexColors : undefined;
      // Mostly the colour itself (it is what the print looks like), with a little shading for the relief.
      const vc = (v: number, shade: number): Vec3 => { const s = 0.8 + 0.2 * Math.min(1, shade); return [VC![v * 3] * 255 * s, VC![v * 3 + 1] * 255 * s, VC![v * 3 + 2] * 255 * s]; };
      if (VC || sculpted(P, I, k)) flatParts.add(partIdx);
      // A coloured mesh: each triangle in its filament's colour.
      const paint = part.paint?.tri.length === I.length / 3 ? part.paint : undefined;
      const paintRgb = paint?.filaments.map((f) => hexToRgb(f.color));
      for (let t = 0; t < I.length; t += 3) {
        const tc = paintRgb ? paintRgb[paint!.tri[t / 3]] ?? base : base;
        const a: Vec3 = [P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]];
        const b: Vec3 = [P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2]];
        const c: Vec3 = [P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2]];
        const n = norm(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
        const facing = dot(n, viewer);
        const lam = Math.max(0, dot(n, light1)) * 0.6 + Math.max(0, facing) * 0.3 + 0.18;
        const shade = facing < 0 ? 0.35 : Math.min(1.1, lam);
        const r = Math.min(255, tc[0] * shade), g = Math.min(255, tc[1] * shade), bl = Math.min(255, tc[2] * shade);
        const ca = VC && vc(I[t], shade), cb = VC && vc(I[t + 1], shade), cc = VC && vc(I[t + 2], shade);
        const A = toScreen(a), B = toScreen(b), Cc = toScreen(c);
        const minX = Math.max(0, Math.floor(Math.min(A[0], B[0], Cc[0])));
        const maxX = Math.min(VIEW - 1, Math.ceil(Math.max(A[0], B[0], Cc[0])));
        const minY = Math.max(0, Math.floor(Math.min(A[1], B[1], Cc[1])));
        const maxY = Math.min(VIEW - 1, Math.ceil(Math.max(A[1], B[1], Cc[1])));
        const area = (B[0] - A[0]) * (Cc[1] - A[1]) - (B[1] - A[1]) * (Cc[0] - A[0]);
        if (Math.abs(area) < 1e-9) continue;
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((B[0] - px) * (Cc[1] - py) - (B[1] - py) * (Cc[0] - px)) / area;
            const w1 = ((Cc[0] - px) * (A[1] - py) - (Cc[1] - py) * (A[0] - px)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const z = w0 * A[2] + w1 * B[2] + w2 * Cc[2];
            const idx = y * VIEW + x;
            if (z < depth[idx]) {
              depth[idx] = z;
              if (ca && cb && cc) {
                for (let k = 0; k < 3; k++) col[idx * 3 + k] = Math.min(255, w0 * ca[k] + w1 * cb[k] + w2 * cc[k]);
              } else {
                col[idx * 3] = r; col[idx * 3 + 1] = g; col[idx * 3 + 2] = bl;
              }
              nbuf[idx * 3] = n[0]; nbuf[idx * 3 + 1] = n[1]; nbuf[idx * 3 + 2] = n[2];
              pid[idx] = partIdx;
            }
          }
        }
      }
    });

    // background + grid
    const gridPx = gridStep * k;
    for (let y = 0; y < VIEW; y++) {
      for (let x = 0; x < VIEW; x++) {
        const idx = y * VIEW + x;
        let r = 246, g = 246, b = 243;
        if (view.grid) {
          const wx = (x + 0.5 - VIEW / 2) / k + cx;
          const wy = (VIEW / 2 - (y + 0.5)) / k + cy;
          const onX = Math.abs(wx / gridStep - Math.round(wx / gridStep)) * gridPx < 0.6;
          const onY = Math.abs(wy / gridStep - Math.round(wy / gridStep)) * gridPx < 0.6;
          if (onX || onY) { r = 214; g = 216; b = 222; }
          const axisX = Math.abs(wx) * k < 0.8, axisY = Math.abs(wy) * k < 0.8;
          if (axisX || axisY) { r = 170; g = 175; b = 190; }
        }
        let out: Vec3 = [r, g, b];
        if (pid[idx] >= 0) {
          out = [col[idx * 3], col[idx * 3 + 1], col[idx * 3 + 2]];
          // edge detection: depth jumps / crease / part boundaries
          let edge = false;
          for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= VIEW || ny >= VIEW) continue;
            const j = ny * VIEW + nx;
            if (pid[j] !== pid[idx]) { edge = true; break; }
            if (Math.abs(depth[j] - depth[idx]) * k > 2.5) { edge = true; break; }
            const d = nbuf[idx * 3] * nbuf[j * 3] + nbuf[idx * 3 + 1] * nbuf[j * 3 + 1] + nbuf[idx * 3 + 2] * nbuf[j * 3 + 2];
            if (d < 0.82 && !flatParts.has(pid[idx])) { edge = true; break; }
          }
          if (edge) out = [out[0] * 0.35, out[1] * 0.35, out[2] * 0.35];
        }
        const o = ((oy + y) * W + ox + x) * 3;
        img[o] = out[0]; img[o + 1] = out[1]; img[o + 2] = out[2];
      }
    }
  });
  // separators between cells
  for (let r = 1; r < rows; r++) for (let i = 0; i < W; i++) for (let w = -1; w <= 0; w++) {
    const a = ((r * VIEW + w) * W + i) * 3; img[a] = img[a + 1] = img[a + 2] = 120;
  }
  for (let c = 1; c < cols; c++) for (let i = 0; i < Hh; i++) for (let w = -1; w <= 0; w++) {
    const b = (i * W + c * VIEW + w) * 3; img[b] = img[b + 1] = img[b + 2] = 120;
  }
  return { png: encodePng(img, W, Hh), gridStep };
}

// ---- minimal PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgb: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Whether a part's triangles average under ~2 pixels in area at `k` pixels per mm (a sculpted mesh, not CAD faces). */
function sculpted(P: ArrayLike<number>, I: ArrayLike<number>, k: number): boolean {
  const tris = I.length / 3;
  if (tris < 5000) return false;
  let area = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return (area / tris) * k * k < 2;
}
