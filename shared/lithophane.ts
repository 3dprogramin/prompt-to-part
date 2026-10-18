// Lithophanes: a photo printed in white PLA as a panel of varying thickness – thick where the
// photo is dark, thin where it is bright – that shows the picture when lit from behind (night
// lights, lamp shades, window panels, frames). The panel is flat, an arc of a lamp shade or a full
// cylinder, built straight from the picture as one closed mesh (like hueforgeMesh), standing up
// as it prints best. Pictures are the design's HfImages ($images), shared with H.hueforge.
import { hfLuma, pictureSampler, toLinear, toSrgb, type HfImage } from './layertone';
import type { Brim, Seam } from './print';
import type { Quality } from './types';

export type LithophaneShape = 'flat' | 'curved' | 'cylinder';

/** H.lithophane options (sliders in the script); all lengths in mm. */
export interface LithophaneOptions {
  /** Width of the picture (flat: straight across; curved: along the arc; cylinder: the circumference). */
  width: number;
  /** Thickness at the brightest points (default 0.8). */
  minThickness?: number;
  /** Thickness at the darkest points, and of the frame (default 3). */
  maxThickness?: number;
  /** Solid frame around the picture at maxThickness (default 3; a cylinder has it top and bottom only). */
  border?: number;
  /** Default 'flat'. */
  shape?: LithophaneShape;
  /** curved: the angle the panel spans, degrees (default 120). */
  angle?: number;
  /** flat: stand up on its bottom edge (default true); false lies it flat, relief up. */
  upright?: boolean;
  /** A foot along the bottom so it stands on a shelf: its depth in mm (0 = none, the default; true = 20). */
  stand?: number | boolean;
  /** Height of the foot (default 4). */
  standHeight?: number;
  /** Brightness curve before mapping to thickness (default 1; < 1 lifts the shadows). */
  gamma?: number;
  /** Bright areas thick instead of dark ones (default false). */
  invert?: boolean;
  /** Grid spacing, mm (default by quality: draft 0.5, normal 0.3, high 0.2). */
  resolution?: number;
}

/** Options with defaults filled in. */
export interface LithoResolved extends Required<Omit<LithophaneOptions, 'stand'>> {
  /** Depth of the foot, 0 = none. */
  stand: number;
}

/** The picture (key in HF_IMAGES_KEY) and the options a lithophane part was built with, defaults filled in. */
export interface LithophaneSource {
  image: string;
  options: LithoResolved;
}

/** What H.lithophane returns; a script returns it as a part: { name, ...litho } (shape, print, lithophane). */
export interface LithophanePart {
  shape: unknown; // Manifold
  /** Print settings a lithophane needs (fine layers, 100 % infill, walls that fill the thin areas). */
  print: { layerHeight: number; infill: number; infillPattern: string; walls: number; brim: Brim; seam?: Seam };
  /** What the panel was made from, for the side panel's preview (PartMesh.lithophane). */
  lithophane: LithophaneSource;
  /** How to print it. */
  note: string;
}

/** Whether a model script builds a lithophane (H.lithophane): its follow-ups stay lithophanes. */
export function isLithophane(code: string | undefined): boolean {
  return !!code && /\bH\.lithophane\s*\(/.test(code);
}

// ---------------------------------------------------------------------------
// Light model
// ---------------------------------------------------------------------------
//
// Light from behind falls off exponentially with the thickness it passes through (Beer–Lambert,
// T = e^(-μ·t)). In white PLA that is mostly scattering by the white pigment rather than
// absorption, lumped into one effective coefficient μ. About 1/mm is typical for white PLA (light
// roughly halves every 0.7 mm: 0.8 mm lets about 45 % through, 3 mm about 5 %), so a 0.8–3 mm panel
// spans a contrast of about 9:1; brands differ, which only shifts the overall brightness. Blue
// scatters a little more than red, which is why the thick parts of a lit lithophane glow warm.
//
// The picture is mapped perceptually: the lit panel's brightness relative to its thinnest point,
// taken through the sRGB curve (close to perceived lightness), is spread evenly from the darkest
// the panel can be (maxThickness) to the brightest (minThickness), as the picture's tones are.
// Thickness then follows by inverting Beer–Lambert: t = minThickness − ln(T_rel) / μ. A linear
// brightness → thickness ramp instead makes the mid-tones too dark, as the first extra millimetre
// dims the light far more than the last.

/** Effective attenuation of white PLA for luminance (green), 1/mm. */
export const LITHO_MU = 1;
/** Per channel (red, green, blue): blue is scattered a little more. */
const MU_RGB = [0.85, LITHO_MU, 1.25];
/** The lamp behind it, linear RGB: a warm white (#fff0d8), as the thinnest areas look. */
const LAMP = [1, toLinear(0xf0 / 255), toLinear(0xd8 / 255)];

/** Panel thickness (mm) for a picture brightness b (0–1), after gamma and invert: dark → maxThickness, bright → minThickness. */
export function lithoThickness(b: number, r: Pick<LithoResolved, 'minThickness' | 'maxThickness' | 'gamma' | 'invert'>): number {
  const g = Math.min(1, Math.max(0, b)) ** r.gamma;
  const v = r.invert ? 1 - g : g;
  const black = toSrgb(Math.exp(-LITHO_MU * (r.maxThickness - r.minThickness)));
  return Math.min(r.maxThickness, Math.max(r.minThickness, r.minThickness - Math.log(toLinear(black + v * (1 - black))) / LITHO_MU));
}

/** How a point `t` mm thick looks lit from behind, as sRGB 0–1 (the panel's thinnest point, `tMin`, shows the lamp's colour). */
export function backlitRgb(t: number, tMin: number): [number, number, number] {
  const d = Math.max(0, t - tMin);
  return [toSrgb(LAMP[0] * Math.exp(-MU_RGB[0] * d)), toSrgb(LAMP[1] * Math.exp(-MU_RGB[1] * d)), toSrgb(LAMP[2] * Math.exp(-MU_RGB[2] * d))];
}

/** Solid PLA that isn't part of the picture (a foot, text added on it) is this much thicker than the frame. */
const SOLID_EXTRA = 3;

/**
 * RGB 0–1 (sRGB) per vertex, for PartMesh.vertexColors: the panel lit from behind, from each
 * vertex's thickness in mm (the lithophane mesh's fourth property; 0 = solid PLA, e.g. the foot).
 */
export function lithoVertexColors(thickness: ArrayLike<number>, r: { minThickness: number; maxThickness: number }): Float32Array {
  const out = new Float32Array(thickness.length * 3);
  const cache = new Map<number, [number, number, number]>();
  for (let v = 0; v < thickness.length; v++) {
    const key = Math.round(thickness[v] * 1000);
    let c = cache.get(key);
    if (!c) cache.set(key, c = backlitRgb(key > 0 ? key / 1000 : r.maxThickness + SOLID_EXTRA, r.minThickness));
    out[v * 3] = c[0]; out[v * 3 + 1] = c[1]; out[v * 3 + 2] = c[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const RESOLUTION: Record<Quality, number> = { draft: 0.5, normal: 0.3, high: 0.2 };
const SHAPES: LithophaneShape[] = ['flat', 'curved', 'cylinder'];

export function resolveLithoOptions(o: LithophaneOptions, quality: Quality = 'normal'): LithoResolved {
  const num = (v: unknown, def: number, lo: number, hi: number) => { const n = Number(v); return v == null || !Number.isFinite(n) ? def : Math.min(hi, Math.max(lo, n)); };
  const width = Number(o?.width);
  if (!(width > 0) || !Number.isFinite(width)) throw new Error('H.lithophane: width must be > 0 (mm)');
  const shape = SHAPES.includes(o.shape as LithophaneShape) ? o.shape! : 'flat';
  const minThickness = num(o.minThickness, 0.8, 0.3, 10);
  const maxThickness = num(o.maxThickness, 3, minThickness + 0.2, 20);
  const rawStand = o.stand === true ? 20 : o.stand === false ? 0 : num(o.stand, 0, 0, 200);
  // Curved panels and cylinders always stand: their axis is vertical.
  const upright = shape !== 'flat' || o.upright !== false;
  return {
    width, minThickness, maxThickness, border: num(o.border, 3, 0, width / 2), shape,
    angle: num(o.angle, 120, 10, 350), upright,
    // Deep enough to hold the panel with a margin on each side.
    stand: upright && rawStand > 0 ? Math.max(rawStand, maxThickness + 4) : 0, standHeight: num(o.standHeight, 4, 1, 30),
    gamma: num(o.gamma, 1, 0.1, 10), invert: !!o.invert,
    resolution: num(o.resolution, RESOLUTION[quality] ?? RESOLUTION.normal, 0.05, 10),
  };
}

/** A part's lithophane source returned by a script, checked and scaled by the runtime's uniform scale; undefined if unusable. */
export function cleanLithophaneSource(raw: unknown, scale = 1): LithophaneSource | undefined {
  const o = raw as LithophaneSource | null;
  if (!o || typeof o !== 'object' || typeof o.image !== 'string' || !o.options || typeof o.options !== 'object') return undefined;
  const n = (k: keyof LithoResolved) => Number(o.options[k]);
  const lengths = (['width', 'minThickness', 'maxThickness', 'border', 'stand', 'standHeight', 'resolution'] as const).map(n);
  if (!lengths.every((v) => v >= 0 && Number.isFinite(v)) || !(lengths[0] > 0) || !(lengths[2] > lengths[1]) || !(n('gamma') > 0) || !(n('angle') > 0)) return undefined;
  const [width, minThickness, maxThickness, border, stand, standHeight, resolution] = lengths.map((v) => v * scale);
  return {
    image: o.image.slice(0, 120),
    options: {
      width, minThickness, maxThickness, border, stand, standHeight, resolution,
      shape: SHAPES.includes(o.options.shape) ? o.options.shape : 'flat', angle: n('angle'), upright: o.options.upright !== false,
      gamma: n('gamma'), invert: !!o.options.invert,
    },
  };
}

/** Lines of a nozzle-wide perimeter (the A1's 0.4 mm nozzle prints 0.42 mm lines). */
const LINE_WIDTH = 0.42;

/** Print settings and advice for a lithophane. */
export function lithoPrint(r: LithoResolved): { print: LithophanePart['print']; note: string } {
  // Standing up, each layer is a thin strip whose walls follow the thickness in X/Y, which the
  // printer places finely; lying flat, the thickness could only change in whole layers (visible
  // steps). Walls from both sides meet in the middle, so the panel is solid plastic everywhere: gaps
  // or infill patterns would show as lines in the light.
  const walls = Math.min(10, Math.max(2, Math.ceil(r.maxThickness / (2 * LINE_WIDTH))));
  return {
    print: {
      layerHeight: r.upright ? 0.12 : 0.08, infill: 100, infillPattern: 'zig-zag', walls,
      // A tall thin panel needs a brim on a moving bed; a foot stands on its own.
      brim: r.stand > 0 ? 'auto' : 5,
      // A cylinder has no corner to hide the seam in: put it where the picture's edges meet.
      ...(r.shape === 'cylinder' ? { seam: 'back' as const } : {}),
    },
    note: r.upright
      ? `Print it in white PLA, standing up as it is (picture vertical): the walls then trace the thickness smoothly. ${r.stand > 0 ? 'The foot keeps it steady' : 'Use a brim'}, 100 % infill, ${walls} walls, 0.12 mm layers.`
      : 'Print it in white PLA lying flat, relief up, at 0.08 mm layers and 100 % infill (standing up gives finer tones).',
  };
}

// ---------------------------------------------------------------------------
// Mesh
// ---------------------------------------------------------------------------

/** The most grid points in one panel (the resolution is coarsened past it). */
export const MAX_LITHO_POINTS = 1_500_000;
/** Levels of the brightness → thickness table. */
const LEVELS = 1024;
const DEG = Math.PI / 180;

/**
 * The panel as a closed triangle mesh with four properties per vertex (x, y, z, thickness in mm;
 * 0 on the foot), vertices shared, outward-facing: ready for a Manifold Mesh. The picture faces −Y
 * (the FRONT view reads it unmirrored) with a smooth back; it stands on z = 0, or on its foot,
 * centred on XY. A curved panel or cylinder bends around the Z axis with the relief outside, the
 * light inside. The foot is part of the same mesh, so no boolean is needed.
 */
export function lithophaneMesh(image: HfImage, r: LithoResolved): { vertProperties: Float32Array; triVerts: Uint32Array } {
  const iw = image.width, ih = image.height;
  const W = r.width, Hh = (W * ih) / iw, B = r.border;
  const cyl = r.shape === 'cylinder', flat = r.shape === 'flat';
  // The cylinder's picture closes on itself: its frame runs only along the top and bottom.
  const Bu = cyl ? 0 : B;
  let res = Math.max(r.resolution, W / iw / 2); // finer than half a pixel adds nothing
  const points = (W / res + 1) * (Hh / res + 1);
  if (points > MAX_LITHO_POINTS) res *= Math.sqrt(points / MAX_LITHO_POINTS);
  const nx = Math.max(cyl ? 12 : 1, Math.round(W / res)), ny = Math.max(1, Math.round(Hh / res));
  // Radius of the back (the light side): the panel's full width, frame included, spans the angle.
  const R = cyl ? W / (2 * Math.PI) : flat ? 0 : (W + 2 * B) / (r.angle * DEG);

  // Grid lines: the picture's, plus one just outside it, so the frame rises steeply at the
  // picture's edge, and the frame's outer edge (on a curve, lines every ≤ 1 mm so it stays round).
  const axis = (size: number, n: number, frame: number, step: number) => {
    const pic = Array.from({ length: n + 1 }, (_, i) => (i / n - 0.5) * size);
    if (!(frame > 0)) return pic;
    const e = Math.min(0.05, frame / 2);
    const k = Math.max(1, Math.ceil((frame - e) / step));
    const lo = Array.from({ length: k }, (_, i) => -(size / 2 + frame) + (i * (frame - e)) / k);
    return [...lo, -(size / 2 + e), ...pic, size / 2 + e, ...lo.map((x) => -x).reverse()];
  };
  const us = cyl ? Array.from({ length: nx }, (_, i) => (i / nx - 0.5) * W) : axis(W, nx, Bu, flat ? Infinity : 1);
  const vs = axis(Hh, ny, B, Infinity);
  const NX = us.length, NY = vs.length, NT = NX * NY;

  const table = Float32Array.from({ length: LEVELS }, (_, q) => lithoThickness(q / (LEVELS - 1), r));
  const sample = pictureSampler(image, (res * iw) / W);
  const foot = r.stand > 0;
  const z0 = foot ? r.standHeight : 0;
  // Where the point `w` mm out from the back surface (along its normal, towards the front) at
  // `u` across the panel's centre and height `z` ends up.
  const place = (u: number, z: number, w: number, out: Float32Array, o: number) => {
    if (flat) { out[o] = u; out[o + 1] = -w; out[o + 2] = z; return; }
    const a = u / R, rr = R + w;
    out[o] = rr * Math.sin(a); out[o + 1] = -rr * Math.cos(a); out[o + 2] = z;
  };
  // Lying flat: u across, v up the picture, the thickness up from the bed.
  const at = r.upright
    ? (u: number, v: number, t: number, out: Float32Array, o: number) => place(u, z0 + v + Hh / 2 + B, t, out, o)
    : (u: number, v: number, t: number, out: Float32Array, o: number) => { out[o] = u; out[o + 1] = v; out[o + 2] = t; };

  // The back only needs the outline (the walls meet it there), which also gives a curved back its
  // vertical lines; it carries the frame's thickness as its colour.
  const back = new Int32Array(NT).fill(-1);
  let nBack = 0;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) if (j === 0 || j === NY - 1 || (!cyl && (i === 0 || i === NX - 1))) back[j * NX + i] = NT + nBack++;
  // The foot: four lines along the panel's bottom edge (top front, bottom front, bottom back, top
  // back), `stand` deep, centred under the panel's thickness (kept inside a curve's axis).
  const F0 = NT + nBack;
  const verts = new Float32Array((F0 + (foot ? 4 * NX : 0)) * 4);
  for (let j = 0; j < NY; j++) {
    const v = vs[j];
    const py = ((Hh / 2 - v) / Hh) * ih; // picture rows run from the top
    const frameRow = Math.abs(v) > Hh / 2 + 1e-9;
    for (let i = 0; i < NX; i++) {
      const u = us[i];
      const t = frameRow || Math.abs(u) > W / 2 + 1e-9 ? r.maxThickness : table[Math.round((sample(((u + W / 2) / W) * iw, py) / 255) * (LEVELS - 1))];
      const f = j * NX + i;
      at(u, v, t, verts, f * 4); verts[f * 4 + 3] = t;
      const b = back[f];
      if (b >= 0) { at(u, v, 0, verts, b * 4); verts[b * 4 + 3] = r.maxThickness; }
    }
  }
  if (foot) {
    const wf = r.maxThickness / 2 + r.stand / 2, wb = Math.max(r.maxThickness / 2 - r.stand / 2, flat ? -Infinity : -0.8 * R);
    [[wf, z0], [wf, 0], [wb, 0], [wb, z0]].forEach(([w, z], k) => {
      for (let i = 0; i < NX; i++) place(us[i], z, w, verts, (F0 + k * NX + i) * 4); // thickness 0: solid
    });
  }

  // Front, cell by cell, counter-clockwise in (u, v), which faces outward (−Y, up or away from the axis).
  const cols = cyl ? NX : NX - 1;
  const front = new Uint32Array(cols * (NY - 1) * 6);
  let t = 0;
  const thick = (k: number) => verts[k * 4 + 3];
  for (let j = 0; j < NY - 1; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * NX + i, b = j * NX + ((i + 1) % NX), c = b + NX, d = a + NX;
      // Split each cell along the diagonal with the smaller thickness change, so edges follow the relief.
      if (Math.abs(thick(a) - thick(c)) <= Math.abs(thick(b) - thick(d))) {
        front[t++] = a; front[t++] = b; front[t++] = c; front[t++] = a; front[t++] = c; front[t++] = d;
      } else {
        front[t++] = a; front[t++] = b; front[t++] = d; front[t++] = b; front[t++] = c; front[t++] = d;
      }
    }
  }
  const rest: number[] = [];
  // Back, clockwise: a ladder between neighbouring columns of back vertices.
  const column = (i: number) => { const c: number[] = []; for (let j = 0; j < NY; j++) if (back[j * NX + i] >= 0) c.push(j); return c; };
  for (let k = 0; k < cols; k++) {
    const il = k, ir = (k + 1) % NX;
    const L = column(il), Rc = column(ir);
    let pl = 0, pr = 0;
    while (pl < L.length - 1 || pr < Rc.length - 1) {
      const l = back[L[pl] * NX + il], r0 = back[Rc[pr] * NX + ir];
      if (pr >= Rc.length - 1 || (pl < L.length - 1 && L[pl + 1] <= Rc[pr + 1])) {
        rest.push(l, back[L[++pl] * NX + il], r0);
      } else {
        rest.push(r0, l, back[Rc[++pr] * NX + ir]);
      }
    }
  }
  // Walls: strips between the front's outline and the back's, around the panel or (cylinder) along
  // its top and bottom. With a foot the bottom one goes the long way: out to the foot's front, down,
  // under, up its back and in to the panel's back.
  const strip = (ap: number, aq: number, bp: number, bq: number) => rest.push(aq, ap, bp, aq, bp, bq);
  const wall = (p: number, q: number) => strip(p, q, back[p], back[q]);
  const rings = [(i: number) => i, ...[0, 1, 2, 3].map((k) => (i: number) => F0 + k * NX + i), (i: number) => back[i]];
  const bottom = (i: number, i2: number) => {
    if (!foot) return wall(i, i2);
    for (let k = 0; k + 1 < rings.length; k++) strip(rings[k](i), rings[k](i2), rings[k + 1](i), rings[k + 1](i2));
  };
  if (cyl) {
    for (let i = 0; i < NX; i++) bottom(i, (i + 1) % NX);
    for (let i = NX; i > 0; i--) wall((NY - 1) * NX + (i % NX), (NY - 1) * NX + i - 1);
  } else {
    for (let i = 0; i < NX - 1; i++) bottom(i, i + 1);
    const ring: number[] = [];
    for (let j = 0; j < NY; j++) ring.push(j * NX + NX - 1);
    for (let i = NX - 2; i >= 0; i--) ring.push((NY - 1) * NX + i);
    for (let j = NY - 2; j >= 0; j--) ring.push(j * NX);
    for (let k = 0; k + 1 < ring.length; k++) wall(ring[k], ring[k + 1]);
    // The foot's ends, in the panel's end planes: fans from the bottom back corner.
    if (foot) {
      const [f, fT, fB, bB, bT, b] = rings;
      const c = NX - 1;
      rest.push(bB(0), fB(0), fT(0), bB(0), fT(0), f(0), bB(0), f(0), b(0), bB(0), b(0), bT(0));
      rest.push(bB(c), bT(c), b(c), bB(c), b(c), f(c), bB(c), f(c), fT(c), bB(c), fT(c), fB(c));
    }
  }
  const tris = new Uint32Array(front.length + rest.length);
  tris.set(front);
  tris.set(rest, front.length);

  // Centre the panel's depth on Y = 0 (the cylinder stays on its axis).
  if (r.upright && !cyl) {
    let lo = Infinity, hi = -Infinity;
    for (let k = 1; k < verts.length; k += 4) { lo = Math.min(lo, verts[k]); hi = Math.max(hi, verts[k]); }
    const dy = -(lo + hi) / 2;
    for (let k = 1; k < verts.length; k += 4) verts[k] += dy;
  }
  return { vertProperties: verts, triVerts: tris };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** The lithophane lit from behind, as RGBA pixels (for the side panel's preview); a cylinder shows unrolled. */
export function simulateLithophane(image: HfImage, o: LithophaneOptions): { width: number; height: number; rgba: Uint8ClampedArray } {
  const r = resolveLithoOptions(o);
  const lum = hfLuma(image);
  const colours = Array.from({ length: 256 }, (_, b) => backlitRgb(lithoThickness(b / 255, r), r.minThickness).map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)));
  const frame = backlitRgb(r.maxThickness, r.minThickness).map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255));
  const bp = Math.round((r.border / r.width) * image.width);
  const bx = r.shape === 'cylinder' ? 0 : bp;
  const width = image.width + 2 * bx, height = image.height + 2 * bp;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ix = x - bx, iy = y - bp;
      const inside = ix >= 0 && iy >= 0 && ix < image.width && iy < image.height;
      const c = inside ? colours[lum[iy * image.width + ix]] : frame;
      const p = (y * width + x) * 4;
      rgba[p] = c[0]; rgba[p + 1] = c[1]; rgba[p + 2] = c[2]; rgba[p + 3] = 255;
    }
  }
  return { width, height, rgba };
}
