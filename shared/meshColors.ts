// Colour of AI figures (Meshy's textured models, "Colour" in 3D figure mode): the texture's colour
// per triangle is reduced to at most MAX_MESH_COLORS colours (k-means in OKLab, weighted by area),
// and each colour gets the closest filament (the user's own first, then Bambu Lab's PLA). The
// stored mesh keeps its triangles' colours (shared/meshes.ts); the design's mesh entry keeps the
// palette and the filaments, which the user can change.
import { FILAMENT_LIBRARY } from './filaments';
import type { LayerToneFilament } from './layertone';

/** Filaments a coloured figure prints with at most: the A1's AMS lite holds 4. */
export const MAX_MESH_COLORS = 4;

/** A filament a part's triangles print with (the 3MF's paint), as the filament picker gives it. */
export interface PaintFilament {
  /** #rrggbb */
  color: string;
  name?: string;
  brand?: string;
}

/** One colour of a coloured mesh. */
export interface MeshColor {
  /** The model's own colour (the cluster's centre), #rrggbb: its triangles nearest to it get this filament. */
  color: string;
  /** Share of the surface, 0–1. */
  share: number;
  /** The filament it prints with. */
  filament: PaintFilament;
}

export type Rgb = [number, number, number];

export const rgbHex = (c: readonly number[]) => '#' + c.slice(0, 3).map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('');
export function hexRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0x808080;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** OKLab (L 0–1) of an sRGB colour (0–255): distances in it follow how different colours look. */
export function oklab(r: number, g: number, b: number): Rgb {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const d2 = (a: readonly number[], b: readonly number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
/** How different two colours look (OKLab distance; about 0.02 is just visible, 0.1 clearly another colour). */
export const colorDistance = (a: string, b: string) => Math.sqrt(d2(oklab(...hexRgb(a)), oklab(...hexRgb(b))));

/** Each triangle's area. */
export function triangleAreas(positions: Float32Array, indices: Uint32Array): Float32Array {
  const out = new Float32Array(indices.length / 3);
  for (let t = 0; t < out.length; t++) {
    const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    out[t] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return out;
}

/** A colour smaller than this share of the surface is merged into the nearest other one. */
const MIN_SHARE = 0.02;
/** Colours closer than this (OKLab) are one colour. */
const MIN_DISTANCE = 0.06;

/**
 * At most `k` colours for triangles coloured `rgb` (3 bytes each) of these areas: area-weighted
 * k-means in OKLab, seeded with the most common colour and then the farthest ones, so the result
 * is the same every time. Tiny and near-identical colours are merged. Sorted by share, largest first.
 */
export function clusterColors(rgb: Uint8Array, areas: ArrayLike<number>, k = MAX_MESH_COLORS): { color: string; share: number }[] {
  const n = areas.length;
  if (!n) return [];
  // Colours quantised to 5 bits a channel: k-means over the few thousand distinct ones, not every triangle.
  const bins = new Map<number, { w: number; sum: [number, number, number] }>();
  let total = 0;
  for (let t = 0; t < n; t++) {
    const w = Math.max(0, areas[t]);
    if (!w) continue;
    const r = rgb[3 * t], g = rgb[3 * t + 1], b = rgb[3 * t + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bin = bins.get(key) ?? { w: 0, sum: [0, 0, 0] as [number, number, number] };
    bin.w += w; bin.sum[0] += r * w; bin.sum[1] += g * w; bin.sum[2] += b * w;
    bins.set(key, bin);
    total += w;
  }
  if (!total) return [];
  const pts = [...bins.values()].map((b) => ({ w: b.w, rgb: b.sum.map((s) => s / b.w) as Rgb })).map((p) => ({ ...p, lab: oklab(...p.rgb) }));
  // Seeds: the heaviest colour, then each time the one farthest (weighted) from the seeds so far.
  const seeds: Rgb[] = [pts.reduce((a, b) => (b.w > a.w ? b : a)).lab];
  while (seeds.length < Math.min(k, pts.length)) {
    let best = -1, far = 0;
    pts.forEach((p, i) => { const s = Math.min(...seeds.map((c) => d2(p.lab, c))) * Math.sqrt(p.w); if (s > far) { far = s; best = i; } });
    if (best < 0 || far < 1e-12) break;
    seeds.push(pts[best].lab);
  }
  let centres = seeds;
  const assign = (cs: Rgb[]) => pts.map((p) => { let bi = 0, bd = Infinity; cs.forEach((c, i) => { const d = d2(p.lab, c); if (d < bd) { bd = d; bi = i; } }); return bi; });
  const update = (cs: Rgb[], of: number[]) => {
    const acc = cs.map(() => ({ w: 0, lab: [0, 0, 0] as Rgb, rgb: [0, 0, 0] as Rgb }));
    pts.forEach((p, i) => { const a = acc[of[i]]; a.w += p.w; for (let c = 0; c < 3; c++) { a.lab[c] += p.lab[c] * p.w; a.rgb[c] += p.rgb[c] * p.w; } });
    return acc.map((a) => ({ w: a.w, lab: a.lab.map((x) => x / (a.w || 1)) as Rgb, rgb: a.rgb.map((x) => x / (a.w || 1)) as Rgb }));
  };
  let groups = update(centres, assign(centres));
  for (let it = 0; it < 30; it++) {
    const next = groups.filter((g) => g.w > 0).map((g) => g.lab);
    const moved = next.length !== centres.length || next.some((c, i) => d2(c, centres[i]) > 1e-10);
    centres = next;
    groups = update(centres, assign(centres));
    if (!moved) break;
  }
  // Merge the smallest colour into its nearest while one is tiny or two look the same.
  for (;;) {
    groups = groups.filter((g) => g.w > 0);
    if (groups.length < 2) break;
    let pair: [number, number] | null = null, closest = Infinity;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const d = d2(groups[i].lab, groups[j].lab);
      if (d < closest) { closest = d; pair = [i, j]; }
    }
    // The smaller of the two that look the same, else a tiny one (re-assigning sends its colours to the nearest).
    const small = groups.reduce((a, g, i) => (g.w < groups[a].w ? i : a), 0);
    let from: number;
    if (Math.sqrt(closest) < MIN_DISTANCE) from = groups[pair![0]].w < groups[pair![1]].w ? pair![0] : pair![1];
    else if (groups[small].w / total < MIN_SHARE) from = small;
    else break;
    centres = groups.filter((_, i) => i !== from).map((g) => g.lab);
    groups = update(centres, assign(centres));
  }
  return groups.sort((a, b) => b.w - a.w).map((g) => ({ color: rgbHex(g.rgb), share: g.w / total }));
}

/** Each triangle's colour index: the nearest of `palette` (#rrggbb, OKLab distance). */
export function colorSlots(rgb: Uint8Array, palette: string[]): Uint8Array {
  const n = rgb.length / 3, out = new Uint8Array(n);
  if (palette.length < 2) return out;
  const labs = palette.map((c) => oklab(...hexRgb(c)));
  const memo = new Map<number, number>();
  for (let t = 0; t < n; t++) {
    const key = (rgb[3 * t] << 16) | (rgb[3 * t + 1] << 8) | rgb[3 * t + 2];
    let s = memo.get(key);
    if (s === undefined) {
      const lab = oklab(rgb[3 * t], rgb[3 * t + 1], rgb[3 * t + 2]);
      s = 0;
      for (let i = 1; i < labs.length; i++) if (d2(lab, labs[i]) < d2(lab, labs[s])) s = i;
      memo.set(key, s);
    }
    out[t] = s;
  }
  return out;
}

/** The PLA filaments a colour is matched to when the user has none close: Bambu Lab PLA Basic and Matte. */
export const PAINT_LIBRARY = FILAMENT_LIBRARY.filter((f) => f.brand === 'Bambu Lab' && (f.line === 'PLA Basic' || f.line === 'PLA Matte'));
/** How much closer one of the user's own filaments counts (they have it on the shelf). */
const MINE_BONUS = 0.04;

const asPaint = (f: { color: string; name?: string; brand?: string }): PaintFilament => ({ color: f.color.toLowerCase(), ...(f.name ? { name: f.name } : {}), ...(f.brand ? { brand: f.brand } : {}) });
export const sameFilament = (a: PaintFilament, b: PaintFilament) => a.color.toLowerCase() === b.color.toLowerCase() && (a.name ?? '') === (b.name ?? '') && (a.brand ?? '') === (b.brand ?? '');

/** Below this OKLab chroma a colour is a grey (black, white): it gets a grey filament, not a dark blue or a cream. */
const NEUTRAL = 0.035;
const chroma = (lab: Rgb) => Math.hypot(lab[1], lab[2]);

/**
 * The filament for each colour (largest share first): the closest of the user's own (counted a
 * little closer) and Bambu Lab's PLA, each filament used once while others are left; a grey gets
 * a grey filament.
 */
export function matchFilaments(colors: string[], mine: LayerToneFilament[] = [], library = PAINT_LIBRARY): PaintFilament[] {
  const options = [...mine.map((f) => ({ f: asPaint(f), bonus: MINE_BONUS })), ...library.map((f) => ({ f: asPaint(f), bonus: 0 }))].map((o) => ({ ...o, lab: oklab(...hexRgb(o.f.color)) }));
  const used: PaintFilament[] = [];
  return colors.map((c) => {
    const lab = oklab(...hexRgb(c));
    const score = (o: (typeof options)[number]) => Math.sqrt(d2(lab, o.lab)) - o.bonus;
    let pool = options.filter((o) => !used.some((u) => sameFilament(u, o.f)));
    if (!pool.length) pool = options;
    if (chroma(lab) < NEUTRAL && pool.some((o) => chroma(o.lab) < NEUTRAL)) pool = pool.filter((o) => chroma(o.lab) < NEUTRAL);
    const pick = pool.length ? pool.reduce((a, b) => (score(b) < score(a) ? b : a)) : null;
    const f = pick ? pick.f : { color: c };
    used.push(f);
    return f;
  });
}

/** A palette for a coloured mesh: at most `k` colours of its triangles, each with its filament. */
export function meshPalette(rgb: Uint8Array, areas: ArrayLike<number>, k = MAX_MESH_COLORS, mine: LayerToneFilament[] = []): MeshColor[] {
  const clusters = clusterColors(rgb, areas, Math.max(1, Math.min(MAX_MESH_COLORS, k)));
  const filaments = matchFilaments(clusters.map((c) => c.color), mine);
  return clusters.map((c, i) => ({ color: c.color, share: +c.share.toFixed(4), filament: filaments[i] }));
}

/** A palette as stored in a mesh entry: valid colours only, at most MAX_MESH_COLORS. */
export function cleanPalette(raw: unknown): MeshColor[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const hex = (s: unknown) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
  const text = (s: unknown, n: number) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : undefined);
  const out = raw.slice(0, MAX_MESH_COLORS).flatMap((c): MeshColor[] => {
    const f = c?.filament;
    if (!hex(c?.color) || !hex(f?.color)) return [];
    const name = text(f.name, 120), brand = text(f.brand, 60);
    return [{ color: c.color.toLowerCase(), share: Math.min(1, Math.max(0, Number(c.share) || 0)), filament: { color: f.color.toLowerCase(), ...(name ? { name } : {}), ...(brand ? { brand } : {}) } }];
  });
  return out.length ? out : undefined;
}

/** "PLA Basic Red (Bambu Lab)" or the colour. */
export const filamentLabel = (f: PaintFilament) => (f.name ? `${f.name}${f.brand ? ` (${f.brand})` : ''}` : f.color);
