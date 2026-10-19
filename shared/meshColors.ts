// Colour of AI figures (Meshy's textured models, "Colour" in 3D figure mode): the texture's colour
// per triangle is reduced to at most MAX_MESH_COLORS colours (k-means in OKLab, weighted by area,
// lightness counting less than hue so shading stays on its material), and each colour gets the
// closest filament (the user's own first, then Bambu Lab's PLA). Each triangle prints with its
// nearest colour, cleaned up over the surface: lone triangles and specks too small to print go to
// the colour around them. The stored mesh keeps its triangles' colours (shared/meshes.ts); the
// design's mesh entry keeps the palette and the filaments, which the user can change.
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
/**
 * How much lightness counts against hue and chroma when grouping a texture's colours and giving
 * triangles theirs: a texture's light and shadow on one material change mostly its lightness, so a
 * grey beard's highlights stay grey instead of going to a light skin colour. Greys that differ only
 * in lightness (dark and light grey) still come apart, being nothing else. Low enough that a pale
 * skin's light and shadow join each other before the pale skin joins a white beard.
 */
const LIGHTNESS_WEIGHT = 0.25;
/**
 * Below this OKLab chroma a triangle's colour is a grey: it takes one of the palette's greys when it
 * has one (a near-white highlight on a grey beard is still nearer a light skin colour in lightness).
 */
const GREY = 0.02;
/** OKLab with the lightness scaled by LIGHTNESS_WEIGHT. */
function shadeLab(r: number, g: number, b: number): Rgb {
  const lab = oklab(r, g, b);
  lab[0] *= LIGHTNESS_WEIGHT;
  return lab;
}
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
/** Colours closer than this (OKLab, lightness counted fully) are one colour (a grey beard and pale skin are about 0.04 apart). */
const MIN_DISTANCE = 0.03;

/**
 * At most `k` colours for triangles coloured `rgb` (3 bytes each) of these areas: area-weighted
 * k-means in OKLab (lightness weighted less, LIGHTNESS_WEIGHT), seeded with the most common colour
 * and then the farthest ones, so the result is the same every time. Tiny and near-identical colours
 * are merged. Sorted by share, largest first.
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
  const pts = [...bins.values()].map((b) => ({ w: b.w, rgb: b.sum.map((s) => s / b.w) as Rgb })).map((p) => ({ ...p, lab: shadeLab(...p.rgb) }));
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
      const d = d2(oklab(...groups[i].rgb), oklab(...groups[j].rgb));
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

/**
 * Each triangle's colour index: the nearest of `palette` (#rrggbb, OKLab distance with lightness
 * weighted less); a grey's nearest grey of the palette, when it has one.
 */
export function colorSlots(rgb: Uint8Array, palette: string[]): Uint8Array {
  const n = rgb.length / 3, out = new Uint8Array(n);
  if (palette.length < 2) return out;
  const labs = palette.map((c) => shadeLab(...hexRgb(c)));
  const greys = palette.map((c) => neutral(oklab(...hexRgb(c))));
  const anyGrey = greys.some(Boolean);
  const memo = new Map<number, number>();
  for (let t = 0; t < n; t++) {
    const key = (rgb[3 * t] << 16) | (rgb[3 * t + 1] << 8) | rgb[3 * t + 2];
    let s = memo.get(key);
    if (s === undefined) {
      const lab = shadeLab(rgb[3 * t], rgb[3 * t + 1], rgb[3 * t + 2]);
      const grey = anyGrey && chroma(lab) < GREY;
      s = -1;
      for (let i = 0; i < labs.length; i++) if ((!grey || greys[i]) && (s < 0 || d2(lab, labs[i]) < d2(lab, labs[s]))) s = i;
      memo.set(key, s);
    }
    out[t] = s;
  }
  return out;
}

/** Passes of the majority filter: each triangle takes the colour most of the area around it has. */
const SMOOTH_PASSES = 3;
/**
 * A patch of one colour smaller than this share of the surface (about 1.2 mm² on an 80 mm figure, as
 * Meshy's are stored) goes to the colour around it: specks too small to print well, each a filament
 * change. An eye on such a figure (1.5–2 mm²) stays.
 */
export const MIN_ISLAND_SHARE = 1e-4;
/** Most rounds of merging small patches. */
const MERGE_ROUNDS = 6;

/**
 * Each triangle's neighbour across each of its edges (3 per triangle, −1 for an open edge), found
 * through the triangles around each vertex.
 */
export function triangleNeighbours(indices: Uint32Array): Int32Array {
  let nv = 0;
  for (let i = 0; i < indices.length; i++) if (indices[i] >= nv) nv = indices[i] + 1;
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv), around = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) around[fill[indices[i]]++] = (i / 3) | 0;
  const out = new Int32Array(indices.length).fill(-1);
  for (let t = 0; t < indices.length / 3; t++) {
    for (let e = 0; e < 3; e++) {
      if (out[3 * t + e] >= 0) continue;
      const a = indices[3 * t + e], b = indices[3 * t + ((e + 1) % 3)];
      search: for (let i = start[a]; i < start[a + 1]; i++) {
        const o = around[i];
        if (o === t) continue;
        for (let f = 0; f < 3; f++) {
          const x = indices[3 * o + f], y = indices[3 * o + ((f + 1) % 3)];
          if ((x === b && y === a) || (x === a && y === b)) {
            out[3 * t + e] = o;
            if (out[3 * o + f] < 0) out[3 * o + f] = t;
            break search;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Per-triangle colour indices `slots` cleaned up over the surface: a few passes of an area-weighted
 * majority filter (lone triangles and ragged borders go), then each connected patch of one
 * colour smaller than `minShare` of the surface takes the colour it borders most.
 */
export function cleanSlots(positions: Float32Array, indices: Uint32Array, slots: Uint8Array, minShare = MIN_ISLAND_SHARE): Uint8Array {
  const nt = slots.length;
  let k = 0;
  for (let t = 0; t < nt; t++) if (slots[t] >= k) k = slots[t] + 1;
  if (k < 2 || indices.length !== nt * 3) return slots;
  const areas = triangleAreas(positions, indices);
  const nb = triangleNeighbours(indices);
  let cur = slots.slice();
  const votes = new Float64Array(k);
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = cur.slice();
    let changed = 0;
    for (let t = 0; t < nt; t++) {
      const own = cur[t];
      votes.fill(0);
      votes[own] = areas[t];
      for (let e = 0; e < 3; e++) { const o = nb[3 * t + e]; if (o >= 0) votes[cur[o]] += areas[o]; }
      let best = own;
      for (let s = 0; s < k; s++) if (votes[s] > votes[best]) best = s;
      if (best !== own) { next[t] = best; changed++; }
    }
    cur = next;
    if (!changed) break;
  }
  // Patches of one colour (flood fill over shared edges), the small ones into the colour they border
  // most; again while any merged (a patch that took a smaller one's colour may itself be small).
  let total = 0;
  for (let t = 0; t < nt; t++) total += areas[t];
  const minArea = total * minShare;
  const seen = new Uint8Array(nt), members = new Uint32Array(nt), border = new Float64Array(k);
  for (let round = 0; round < MERGE_ROUNDS; round++) {
    seen.fill(0);
    const small: { from: number; to: number; area: number }[] = [];
    let n = 0;
    for (let s = 0; s < nt; s++) {
      if (seen[s]) continue;
      const from = n;
      let area = 0, head = n;
      seen[s] = 1;
      members[n++] = s;
      // members[from..n) is the patch so far, and doubles as the queue.
      while (head < n) {
        const t = members[head++];
        area += areas[t];
        for (let e = 0; e < 3; e++) {
          const o = nb[3 * t + e];
          if (o >= 0 && !seen[o] && cur[o] === cur[t]) { seen[o] = 1; members[n++] = o; }
        }
      }
      if (area < minArea) small.push({ from, to: n, area });
    }
    small.sort((a, b) => a.area - b.area);
    let merged = 0;
    for (const p of small) {
      const own = cur[members[p.from]];
      border.fill(0);
      for (let i = p.from; i < p.to; i++) {
        const t = members[i];
        for (let e = 0; e < 3; e++) {
          const o = nb[3 * t + e];
          if (o < 0 || cur[o] === own) continue;
          const a = indices[3 * t + e] * 3, b = indices[3 * t + ((e + 1) % 3)] * 3;
          border[cur[o]] += Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]);
        }
      }
      let best = own;
      for (let s = 0; s < k; s++) if (border[s] > (best === own ? 0 : border[best])) best = s;
      if (best !== own) { for (let i = p.from; i < p.to; i++) cur[members[i]] = best; merged++; }
    }
    if (!merged) break;
  }
  return cur;
}

/** Each triangle's colour index of a coloured mesh: its nearest of `palette`, cleaned up (cleanSlots). */
export function meshSlots(mesh: { positions: Float32Array; indices: Uint32Array; colors: Uint8Array }, palette: string[]): Uint8Array {
  return cleanSlots(mesh.positions, mesh.indices, colorSlots(mesh.colors, palette));
}

/** The PLA filaments a colour is matched to when the user has none close: Bambu Lab PLA Basic and Matte. */
export const PAINT_LIBRARY = FILAMENT_LIBRARY.filter((f) => f.brand === 'Bambu Lab' && (f.line === 'PLA Basic' || f.line === 'PLA Matte'));
/** How much closer one of the user's own filaments counts (they have it on the shelf). */
const MINE_BONUS = 0.04;

const asPaint = (f: { color: string; name?: string; brand?: string }): PaintFilament => ({ color: f.color.toLowerCase(), ...(f.name ? { name: f.name } : {}), ...(f.brand ? { brand: f.brand } : {}) });
export const sameFilament = (a: PaintFilament, b: PaintFilament) => a.color.toLowerCase() === b.color.toLowerCase() && (a.name ?? '') === (b.name ?? '') && (a.brand ?? '') === (b.brand ?? '');

/**
 * Below this OKLab chroma a colour is a grey (black, white): it gets a grey filament, not a dark blue
 * or a cream. Dark colours have less chroma to show, so below NEUTRAL_LIGHTNESS the limit shrinks
 * with the lightness: a dark brown glove is brown, not dark grey.
 */
const NEUTRAL = 0.035;
const NEUTRAL_LIGHTNESS = 0.6;
const chroma = (lab: Rgb) => Math.hypot(lab[1], lab[2]);
const neutral = (lab: Rgb) => chroma(lab) < NEUTRAL * Math.min(1, Math.max(0.2, lab[0] / NEUTRAL_LIGHTNESS));

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
    if (neutral(lab) && pool.some((o) => neutral(o.lab))) pool = pool.filter((o) => neutral(o.lab));
    const pick = pool.length ? pool.reduce((a, b) => (score(b) < score(a) ? b : a)) : null;
    const f = pick ? pick.f : { color: c };
    used.push(f);
    return f;
  });
}

/**
 * A palette for a coloured mesh: at most `k` colours of its triangles, each with its filament and
 * its share of the surface as the triangles print (meshSlots).
 */
export function meshPalette(mesh: { positions: Float32Array; indices: Uint32Array; colors: Uint8Array }, k = MAX_MESH_COLORS, mine: LayerToneFilament[] = []): MeshColor[] {
  const areas = triangleAreas(mesh.positions, mesh.indices);
  const clusters = clusterColors(mesh.colors, areas, Math.max(1, Math.min(MAX_MESH_COLORS, k)));
  const filaments = matchFilaments(clusters.map((c) => c.color), mine);
  const slots = meshSlots(mesh, clusters.map((c) => c.color));
  const sums = clusters.map(() => 0);
  let total = 0;
  for (let t = 0; t < slots.length; t++) { sums[slots[t]] += areas[t]; total += areas[t]; }
  return clusters.map((c, i) => ({ color: c.color, share: +(total ? sums[i] / total : c.share).toFixed(4), filament: filaments[i] }));
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

// ---------------------------------------------------------------------------- repaints
// Meshy guesses colours where its picture showed nothing (between the legs, under the arms): the user
// repaints such patches by hand (the Object tab's Repaint). Each repaint is a set of the stored
// mesh's triangles and the palette colour they take, applied in order over the cleaned-up slots. The
// colour maps to the nearest of the current palette, so repaints survive a change of colour count.

/** Triangles of the stored mesh repainted in one go (a patch or a brush stroke). */
export interface Repaint {
  /** The palette colour (MeshColor.color, #rrggbb) they print in: the nearest of the current palette. */
  color: string;
  /** The stored mesh's triangle indices (encodeTris). */
  tris: string;
}

/** Most repaints a mesh keeps. */
export const MAX_REPAINTS = 200;
/** Longest encoded triangle list of one repaint (a patch of tens of thousands of scattered triangles). */
export const MAX_REPAINT_CHARS = 100_000;

/**
 * Triangle indices as a short string: sorted, in runs of consecutive ones, each run its gap from the
 * end of the previous one in base 36 and, for more than one, "+" and the count after the first
 * ("0+3,5" is 0–3 and 9).
 */
export function encodeTris(tris: ArrayLike<number>): string {
  const s = Uint32Array.from(tris).sort();
  const out: string[] = [];
  let end = 0;
  for (let i = 0; i < s.length;) {
    const start = s[i];
    let j = i + 1;
    while (j < s.length && s[j] <= s[j - 1] + 1) j++;
    const last = s[j - 1];
    out.push((start - end).toString(36) + (last > start ? '+' + (last - start).toString(36) : ''));
    end = last + 1;
    i = j;
  }
  return out.join(',');
}

/** The triangle indices of encodeTris, those below `limit` only (the mesh's triangle count). */
export function decodeTris(s: string, limit = 2 ** 31): Uint32Array {
  const out: number[] = [];
  let end = 0;
  for (const run of s ? s.split(',') : []) {
    const [a, b] = run.split('+');
    const start = end + parseInt(a, 36), more = b === undefined ? 0 : parseInt(b, 36);
    if (!Number.isFinite(start) || !Number.isFinite(more) || start >= limit) break;
    const last = Math.min(limit - 1, start + more);
    for (let t = start; t <= last; t++) out.push(t);
    end = last + 1;
  }
  return Uint32Array.from(out);
}

const TRIS = /^[0-9a-z]+(\+[0-9a-z]+)?(,[0-9a-z]+(\+[0-9a-z]+)?)*$/;
/** Repaints as stored in a mesh entry: valid ones only, at most MAX_REPAINTS. */
export function cleanRepaint(raw: unknown): Repaint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.slice(0, MAX_REPAINTS).flatMap((r): Repaint[] =>
    typeof r?.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) && typeof r.tris === 'string' && r.tris.length <= MAX_REPAINT_CHARS && TRIS.test(r.tris)
      ? [{ color: r.color.toLowerCase(), tris: r.tris }] : []);
  return out.length ? out : undefined;
}

/** Each triangle's palette index with the repaints applied (later ones win); `slots` itself without any. */
export function applyRepaint(slots: Uint8Array, palette: string[], repaint?: Repaint[]): Uint8Array {
  if (!repaint?.length || !palette.length) return slots;
  const out = slots.slice();
  const labs = palette.map((c) => oklab(...hexRgb(c)));
  for (const r of repaint) {
    const lab = oklab(...hexRgb(r.color));
    let s = 0;
    for (let i = 1; i < labs.length; i++) if (d2(lab, labs[i]) < d2(lab, labs[s])) s = i;
    for (const t of decodeTris(r.tris, out.length)) out[t] = s;
  }
  return out;
}

/** The connected patch of triangle `start`'s slot (flood fill over shared edges, triangleNeighbours). */
export function slotPatch(neighbours: Int32Array, slots: Uint8Array, start: number): Uint32Array {
  const seen = new Uint8Array(slots.length), out: number[] = [start];
  seen[start] = 1;
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    for (let e = 0; e < 3; e++) {
      const o = neighbours[3 * t + e];
      if (o >= 0 && !seen[o] && slots[o] === slots[start]) { seen[o] = 1; out.push(o); }
    }
  }
  return Uint32Array.from(out);
}

/** A short hash of a mesh's repaints, for cache keys. */
export function repaintKey(repaint?: Repaint[]): string {
  if (!repaint?.length) return '';
  let h = 0x811c9dc5;
  for (const r of repaint) for (const s of [r.color, r.tris, ';']) for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${repaint.length}:${(h >>> 0).toString(36)}`;
}

/** Each stored triangle's palette index, per coloured mesh, palette and repaints (a few kept: meshes are big). */
const slotCache = new Map<string, Uint8Array>();
const remember = (key: string, slots: Uint8Array) => {
  slotCache.delete(key);
  slotCache.set(key, slots);
  while (slotCache.size > 8) slotCache.delete(slotCache.keys().next().value!);
  return slots;
};

/**
 * Each triangle's palette index of the coloured mesh stored at `url` (meshSlots, then its repaints),
 * cached: the evaluation asks again on every change of the design, and a new repaint only applies
 * the (cheap) repaints again, not the cleanup.
 */
export function storedSlots(url: string, mesh: { positions: Float32Array; indices: Uint32Array; colors: Uint8Array }, palette: MeshColor[], repaint?: Repaint[]): Uint8Array {
  const base = `${url}|${palette.map((c) => c.color).join()}`, key = `${base}|${repaintKey(repaint)}`;
  const hit = slotCache.get(key);
  if (hit) return remember(key, hit);
  const plain = slotCache.get(base) ?? meshSlots(mesh, palette.map((c) => c.color));
  remember(base, plain);
  return remember(key, applyRepaint(plain, palette.map((c) => c.color), repaint));
}
