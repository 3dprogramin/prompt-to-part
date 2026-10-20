// The helper library model scripts get as `H` (sweeps, threads, lofts, text, arrays…).
import type { ManifoldToplevel, Manifold, CrossSection } from 'manifold-3d';
import { layoutText, type TextLayoutOptions } from './text';
import { add, cross, dist3, dot, norm, scale, sub } from './vec3';
import type { Quality, Vec2, Vec3 } from './types';
import { defaultColors, drawingSection, type SvgDrawing } from './svgFeatures';
import { layerToneLayers, layerToneMesh, resolveLayerToneOptions, type LayerToneImage, type LayerToneOptions, type LayerTonePart, type LayerToneSetup } from './layertone';
import { buildLineArt, type LineArtOptions, type LineArtResult } from './lineart';
import { lithoPrint, lithophaneMesh, resolveLithoOptions, type LithophaneOptions, type LithophanePart } from './lithophane';
import { getMeshData, type MeshEntry } from './meshes';

const DEG = Math.PI / 180;

/** What the helpers build with: the wasm module and the (tracked) Manifold and CrossSection classes. */
export interface HelperRuntime {
  wasm: ManifoldToplevel;
  Manifold: typeof Manifold;
  CrossSection: typeof CrossSection;
  /** Keeps a handle across evaluations (see initRuntime); without it nothing is cached. */
  keep?: (h: object) => void;
}

/**
 * Imported meshes as Manifolds, kept across evaluations by URL (the files never change): building
 * one from 300k triangles takes about half a second, moving the kept one a few milliseconds.
 */
const meshCache = new Map<string, Manifold>();
/**
 * The mesh ID of each coloured mesh in meshCache (by URL): its triangles carry it, and their index in
 * the stored mesh as faceID, through every boolean, so the runtime finds each output triangle's colour.
 */
const colorIds = new Map<string, number>();
/** Most triangles kept in meshCache. */
const MESH_CACHE_TRIANGLES = 1_500_000;
const gone = (m: Manifold) => (m as unknown as { isDeleted(): boolean }).isDeleted();

export interface MeshOptions {
  /** Scale to this height (Z), width (X), depth (Y) or longest side in mm; at most one. Default: as stored. */
  height?: number;
  width?: number;
  depth?: number;
  size?: number;
  /** Uniform scale factor (instead of a size). */
  scale?: number;
  /** Rotation in degrees about X, Y, Z (applied first), e.g. [90, 0, 0] to stand up a model lying on its back. */
  rotate?: Vec3;
  /** Stand it on z = 0, centred in X and Y, after rotating (default true). */
  center?: boolean;
}

function signedArea(pts: Vec2[]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
const ccw = (pts: Vec2[]) => (signedArea(pts) < 0 ? [...pts].reverse() : [...pts]);

function checkPoints(pts: unknown, what: string, min = 3): Vec2[] {
  if (!Array.isArray(pts) || pts.length < min) throw new Error(`${what}: expected an array of at least ${min} [x, y] points`);
  for (const p of pts) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error(`${what}: invalid point ${JSON.stringify(p)}`);
  }
  return pts as Vec2[];
}

/** LayerTone input from the design's values: its pictures and the user's filament setup. */
export interface LayerToneInput {
  images: Record<string, LayerToneImage>;
  setup: LayerToneSetup;
}

/** A coloured mesh an evaluation used: its triangles in the output have this mesh ID (MeshGL.runOriginalID). */
export interface PaintedMesh { id: number; name: string; url: string }

/** `painted` collects the coloured meshes H.mesh gave out (see PaintedMesh). */
export function makeHelpers(rt: HelperRuntime, quality: Quality, drawings: Record<string, SvgDrawing> = {}, layerToneInput: LayerToneInput = { images: {}, setup: {} }, meshes: Record<string, MeshEntry> = {}, painted?: PaintedMesh[]) {
  const { wasm } = rt;
  // Meshes this evaluation uses: they stay in meshCache until it is over.
  const meshesInUse = new Set<string>();
  const M = rt.Manifold as any;
  const C = rt.CrossSection as any;
  const sptDefault = quality === 'draft' ? 24 : quality === 'normal' ? 48 : 96;

  /** Build a Manifold from raw triangles; fixes global orientation automatically. */
  function fromTriangles(verts: Float32Array, tris: number[]): Manifold {
    let vol = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const ax = verts[a], ay = verts[a + 1], az = verts[a + 2];
      const bx = verts[b], by = verts[b + 1], bz = verts[b + 2];
      const cx = verts[c], cy = verts[c + 1], cz = verts[c + 2];
      vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    const triVerts = new Uint32Array(tris);
    if (vol < 0) for (let t = 0; t < triVerts.length; t += 3) { const s = triVerts[t + 1]; triVerts[t + 1] = triVerts[t + 2]; triVerts[t + 2] = s; }
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: verts, triVerts });
    mesh.merge();
    const m = new M(mesh) as Manifold;
    const st = m.status();
    if (st !== 'NoError') throw new Error(`Generated mesh is invalid (${st}) – check that the profile/path does not self-intersect`);
    return m;
  }

  /** Connect rings of equal size into a closed solid (caps at both ends unless closed). */
  function ringsToSolid(rings: Vec3[][], profile2d: Vec2[], closed: boolean): Manifold {
    const m = rings[0].length;
    const n = rings.length;
    const verts = new Float32Array(n * m * 3);
    rings.forEach((ring, k) => ring.forEach((p, i) => verts.set(p, (k * m + i) * 3)));
    const tris: number[] = [];
    const segs = closed ? n : n - 1;
    for (let k = 0; k < segs; k++) {
      const k2 = (k + 1) % n;
      for (let i = 0; i < m; i++) {
        const i2 = (i + 1) % m;
        const a = k * m + i, b = k * m + i2, c = k2 * m + i2, d = k2 * m + i;
        tris.push(a, b, c, a, c, d);
      }
    }
    if (!closed) {
      const capTris = wasm.triangulate([profile2d]);
      for (const [i, j, l] of capTris) tris.push(j, i, l); // start cap, faces backwards
      const off = (n - 1) * m;
      for (const [i, j, l] of capTris) tris.push(off + i, off + j, off + l);
    }
    return fromTriangles(verts, tris);
  }

  /** Stack rings (each CCW around +Z, equal size, increasing z) into a solid with flat caps. */
  function stackRings(rings: Vec3[][]): Manifold {
    const m = rings[0].length;
    const verts = new Float32Array(rings.length * m * 3);
    rings.forEach((ring, k) => ring.forEach((p, i) => verts.set(p, (k * m + i) * 3)));
    const tris: number[] = [];
    for (let k = 0; k < rings.length - 1; k++) {
      for (let i = 0; i < m; i++) {
        const i2 = (i + 1) % m;
        const a = k * m + i, b = k * m + i2, c = (k + 1) * m + i2, d = (k + 1) * m + i;
        tris.push(a, b, c, a, c, d);
      }
    }
    const to2d = (r: Vec3[]) => r.map((p) => [p[0], p[1]] as Vec2);
    for (const [i, j, l] of wasm.triangulate([to2d(rings[0])])) tris.push(j, i, l);
    const off = (rings.length - 1) * m;
    for (const [i, j, l] of wasm.triangulate([to2d(rings[rings.length - 1])])) tris.push(off + i, off + j, off + l);
    return fromTriangles(verts, tris);
  }

  /** The stored mesh at `url` as a kept Manifold (MeshMissingError while it still has to be loaded). */
  function meshSolid(url: string): { solid: Manifold; colorId?: number } {
    meshesInUse.add(url);
    const hit = meshCache.get(url);
    if (hit && !gone(hit)) {
      meshCache.delete(url);
      meshCache.set(url, hit);
      return { solid: hit, colorId: colorIds.get(url) };
    }
    const data = getMeshData(url);
    // The untracked constructor: this one outlives the evaluation (when it can be kept).
    const make = rt.keep ? wasm.Manifold : M;
    // A coloured mesh gets an ID of its own and its triangles' indices as faceIDs (see colorIds).
    const n = data.indices.length / 3;
    const colorId = data.colors ? wasm.Manifold.reserveIDs(1) : undefined;
    const ids = colorId != null ? { faceID: Uint32Array.from({ length: n }, (_, i) => i), runIndex: new Uint32Array([0, n * 3]), runOriginalID: new Uint32Array([colorId]) } : {};
    const m = new make(new wasm.Mesh({ numProp: 3, vertProperties: data.positions, triVerts: data.indices, ...ids })) as Manifold;
    // Kept before its first method call, which would otherwise put it in this evaluation's registry.
    rt.keep?.(m);
    const st = m.status();
    if (st !== 'NoError') { if (rt.keep) m.delete(); throw new Error(`H.mesh: the stored mesh is not a valid solid (${st})`); }
    if (!rt.keep) return { solid: m, colorId };
    // Shared with later evaluations; scripts only ever get copies of it, and it can't be changed either.
    Object.freeze(m);
    meshCache.set(url, m);
    if (colorId != null) colorIds.set(url, colorId); else colorIds.delete(url);
    // Over budget: drop the least recently used meshes this evaluation doesn't use.
    let total = [...meshCache.values()].reduce((s, x) => s + (gone(x) ? 0 : x.numTri()), 0);
    for (const [u, x] of meshCache) {
      if (total <= MESH_CACHE_TRIANGLES) break;
      if (meshesInUse.has(u)) continue;
      total -= gone(x) ? 0 : x.numTri();
      if (!gone(x)) x.delete();
      meshCache.delete(u);
      colorIds.delete(u);
    }
    return { solid: m, colorId };
  }

  const H = {
    segments(radius: number): number { return wasm.getCircularSegments(radius); },

    circlePoints(r: number, n?: number, phaseDeg = 0): Vec2[] {
      const k = n ?? Math.max(8, wasm.getCircularSegments(r));
      return Array.from({ length: k }, (_, i) => {
        const a = phaseDeg * DEG + (i / k) * 2 * Math.PI;
        return [r * Math.cos(a), r * Math.sin(a)] as Vec2;
      });
    },

    ellipsePoints(rx: number, ry: number, n?: number): Vec2[] {
      const k = n ?? Math.max(12, wasm.getCircularSegments(Math.max(rx, ry)));
      return Array.from({ length: k }, (_, i) => {
        const a = (i / k) * 2 * Math.PI;
        return [rx * Math.cos(a), ry * Math.sin(a)] as Vec2;
      });
    },

    rectPoints(w: number, h: number): Vec2[] {
      return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    },

    roundedRectPoints(w: number, h: number, r: number, segPerCorner = 8): Vec2[] {
      r = Math.max(0, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4));
      if (r <= 1e-6) return H.rectPoints(w, h);
      const pts: Vec2[] = [];
      const corners: [number, number, number][] = [
        [w / 2 - r, -h / 2 + r, -90], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180],
      ];
      for (const [cx, cy, a0] of corners) {
        for (let i = 0; i <= segPerCorner; i++) {
          const a = (a0 + (90 * i) / segPerCorner) * DEG;
          pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
      }
      return pts;
    },

    /** Resample a closed polygon to exactly n points, evenly spaced by arc length. */
    resample(points: Vec2[], n: number): Vec2[] {
      const pts = checkPoints(points, 'H.resample');
      const L: number[] = [0];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        L.push(L[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
      }
      const total = L[L.length - 1];
      const out: Vec2[] = [];
      let seg = 0;
      for (let k = 0; k < n; k++) {
        const d = (k / n) * total;
        while (seg < pts.length - 1 && L[seg + 1] < d) seg++;
        const a = pts[seg], b = pts[(seg + 1) % pts.length];
        const t = (d - L[seg]) / Math.max(1e-12, L[seg + 1] - L[seg]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
      return out;
    },

    polygon(points: Vec2[] | Vec2[][]): CrossSection {
      return new C(points);
    },

    roundedRect(w: number, h: number, r: number): CrossSection {
      r = Math.max(0, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4));
      if (r <= 1e-6) return C.square([w, h], true);
      return C.square([w - 2 * r, h - 2 * r], true).offset(r, 'Round');
    },

    roundedBox(size: Vec3, radius: number, center = false): Manifold {
      const [x, y, z] = size;
      const r = Math.max(0, Math.min(radius, x / 2 - 1e-3, y / 2 - 1e-3, z / 2 - 1e-3));
      let m: Manifold;
      if (r <= 1e-4) m = M.cube(size, true);
      else {
        const s = M.sphere(r);
        const pts: Manifold[] = [];
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
          pts.push(s.translate([sx * (x / 2 - r), sy * (y / 2 - r), sz * (z / 2 - r)]));
        }
        m = M.hull(pts);
      }
      return center ? m : m.translate([x / 2, y / 2, z / 2]);
    },

    /**
     * Sweep a closed 2D profile given in the (r, z) half-plane around the Z axis
     * while rising `pitch` per turn. Ideal for threads, springs, corkscrews, coils.
     */
    helicalSweep(profile: Vec2[], opts: {
      pitch: number; turns: number; segmentsPerTurn?: number; startAngle?: number; z0?: number;
      leftHanded?: boolean; radiusFn?: (t: number) => number; scaleFn?: (t: number) => number;
    }): Manifold {
      const prof = ccw(checkPoints(profile, 'H.helicalSweep profile'));
      const { pitch, turns } = opts;
      if (!(turns > 0) || !Number.isFinite(turns)) throw new Error('H.helicalSweep: turns must be > 0');
      if (!(pitch > 0)) throw new Error('H.helicalSweep: pitch must be > 0');
      const zs = prof.map((p) => p[1]);
      const hProf = Math.max(...zs) - Math.min(...zs);
      if (hProf >= pitch) throw new Error(`H.helicalSweep: profile height (${hProf.toFixed(3)}) must be smaller than the pitch (${pitch}) or adjacent turns overlap`);
      const cr = prof.reduce((s, p) => s + p[0], 0) / prof.length;
      const cz = prof.reduce((s, p) => s + p[1], 0) / prof.length;
      const spt = opts.segmentsPerTurn ?? sptDefault;
      const nSeg = Math.max(3, Math.ceil(turns * spt));
      const dir = opts.leftHanded ? -1 : 1;
      const start = (opts.startAngle ?? 0) * DEG;
      const z0 = opts.z0 ?? 0;
      const rings: Vec3[][] = [];
      for (let k = 0; k <= nSeg; k++) {
        const t = k / nSeg;
        const th = start + dir * t * turns * 2 * Math.PI;
        const zoff = z0 + t * turns * pitch;
        const rOff = opts.radiusFn ? opts.radiusFn(t) : 0;
        const s = opts.scaleFn ? Math.max(1e-3, opts.scaleFn(t)) : 1;
        const cos = Math.cos(th), sin = Math.sin(th);
        rings.push(prof.map(([r, z]) => {
          const rr = cr + (r - cr) * s + rOff;
          if (rr <= 0) throw new Error('H.helicalSweep: profile crosses the Z axis (radius <= 0)');
          return [rr * cos, rr * sin, cz + (z - cz) * s + zoff] as Vec3;
        }));
      }
      return ringsToSolid(rings, prof, false);
    },

    /** Sweep a closed 2D profile (x, y) along a 3D polyline path using rotation-minimizing frames. */
    sweep(profile: Vec2[], path: Vec3[], opts: { closed?: boolean; twist?: number; scaleFn?: (t: number) => number; up?: Vec3 } = {}): Manifold {
      const prof = ccw(checkPoints(profile, 'H.sweep profile'));
      if (!Array.isArray(path) || path.length < 2) throw new Error('H.sweep: path needs at least 2 points');
      const closed = !!opts.closed;
      let pts = path.map((p) => [p[0], p[1], p[2] ?? 0] as Vec3);
      if (closed && dist3(pts[0], pts[pts.length - 1]) < 1e-9) pts = pts.slice(0, -1);
      const n = pts.length;
      const T: Vec3[] = pts.map((_, i) => {
        const prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
        const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
        return norm(sub(next, prev));
      });
      const ref: Vec3 = opts.up ?? (Math.abs(T[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
      const N: Vec3[] = [norm(sub(ref, scale(T[0], dot(ref, T[0]))))];
      for (let i = 1; i < n; i++) N.push(transport(N[i - 1], T[i - 1], T[i]));
      let correction = 0;
      if (closed) {
        const nEnd = transport(N[n - 1], T[n - 1], T[0]);
        const b0 = cross(T[0], N[0]);
        correction = Math.atan2(dot(nEnd, b0), dot(nEnd, N[0]));
      }
      const twist = (opts.twist ?? 0) * DEG;
      const rings: Vec3[][] = pts.map((P, i) => {
        const t = closed ? i / n : i / (n - 1);
        const ang = -correction * t + twist * t;
        const n0 = N[i], b0 = cross(T[i], n0);
        const nn = add(scale(n0, Math.cos(ang)), scale(b0, Math.sin(ang)));
        const bb = cross(T[i], nn);
        const s = opts.scaleFn ? opts.scaleFn(t) : 1;
        return prof.map(([x, y]) => add(P, add(scale(nn, x * s), scale(bb, y * s))));
      });
      return ringsToSolid(rings, prof, closed);
    },

    /** Round tube along a path. */
    tube(path: Vec3[], radius: number, opts: { closed?: boolean; segments?: number } = {}): Manifold {
      return H.sweep(H.circlePoints(radius, opts.segments ?? Math.max(8, Math.min(48, wasm.getCircularSegments(radius)))), path, { closed: opts.closed });
    },

    /** Points along a helix around Z (useful as a sweep path). */
    helixPath(radius: number, pitch: number, turns: number, segmentsPerTurn?: number, z0 = 0): Vec3[] {
      const spt = segmentsPerTurn ?? sptDefault;
      const n = Math.max(2, Math.ceil(turns * spt));
      return Array.from({ length: n + 1 }, (_, k) => {
        const t = k / n, a = t * turns * 2 * Math.PI;
        return [radius * Math.cos(a), radius * Math.sin(a), z0 + t * turns * pitch] as Vec3;
      });
    },

    /** Loft through stacked closed sections ({ z, points }), bottom to top. Point counts are resampled to match. */
    loft(sections: { z: number; points: Vec2[] }[]): Manifold {
      if (!Array.isArray(sections) || sections.length < 2) throw new Error('H.loft: needs at least 2 sections');
      const sorted = [...sections].sort((a, b) => a.z - b.z);
      const m = Math.max(...sorted.map((s) => checkPoints(s.points, 'H.loft section').length));
      const profs = sorted.map((s) => (s.points.length === m ? ccw(s.points) : H.resample(ccw(s.points), m)));
      for (let k = 1; k < profs.length; k++) {
        const prev = profs[k - 1], cur = profs[k];
        let best = 0, bestD = Infinity;
        for (let off = 0; off < m; off++) {
          let d = 0;
          for (let i = 0; i < m; i += Math.max(1, Math.floor(m / 32))) {
            const a = prev[i], b = cur[(i + off) % m];
            d += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
          }
          if (d < bestD) { bestD = d; best = off; }
        }
        profs[k] = cur.map((_, i) => cur[(i + best) % m]);
      }
      return stackRings(profs.map((p, k) => p.map(([x, y]) => [x, y, sorted[k].z] as Vec3)));
    },

    /**
     * Solid of revolution-like surface where the radius is any function of angle (degrees) and z.
     * Great for threads, knurling, ribbed grips, bottles. fn must return r > 0.
     */
    radialSurface(fn: (thetaDeg: number, z: number) => number, opts: { height: number; z0?: number; angularSegments?: number; zSegments?: number }): Manifold {
      const nA = Math.max(8, Math.round(opts.angularSegments ?? (quality === 'draft' ? 48 : quality === 'normal' ? 72 : 128)));
      const nZ = Math.max(1, Math.round(opts.zSegments ?? Math.max(1, Math.ceil(opts.height / (quality === 'draft' ? 1 : quality === 'normal' ? 0.5 : 0.25)))));
      const z0 = opts.z0 ?? 0;
      const rings: Vec3[][] = [];
      for (let j = 0; j <= nZ; j++) {
        const z = z0 + (opts.height * j) / nZ;
        const ring: Vec3[] = [];
        for (let i = 0; i < nA; i++) {
          const th = (360 * i) / nA;
          const r = fn(th, z);
          if (!(r > 0) || !Number.isFinite(r)) throw new Error(`H.radialSurface: radius must be > 0 (got ${r} at theta=${th.toFixed(1)}, z=${z.toFixed(2)})`);
          ring.push([r * Math.cos(th * DEG), r * Math.sin(th * DEG), z]);
        }
        rings.push(ring);
      }
      return stackRings(rings);
    },

    /**
     * ISO-style 60° screw thread, built directly as a mesh (fast, no booleans).
     * external=true (default): threaded rod from z=0 to length, ends chamfered.
     * external=false: a cutter for a threaded hole (subtract it), enlarged by `clearance` (default 0.3 mm)
     * and extended 0.5 mm beyond both ends.
     */
    thread(opts: { diameter: number; pitch: number; length: number; external?: boolean; clearance?: number; depth?: number; leftHanded?: boolean; chamfer?: boolean }): Manifold {
      const { pitch, length } = opts;
      if (!(pitch > 0) || !(length > 0)) throw new Error('H.thread: pitch and length must be > 0');
      const external = opts.external !== false;
      const clearance = opts.clearance ?? (external ? 0 : 0.3);
      const rMaj = opts.diameter / 2 + (external ? -clearance / 2 : clearance / 2);
      const depth = opts.depth ?? 0.6134 * pitch;
      const rMin = rMaj - depth;
      if (rMin <= 0.2) throw new Error('H.thread: diameter too small for this pitch');
      const crest = pitch / 8;
      const flank = Math.min(depth * Math.tan(30 * DEG), (pitch - crest) / 2 - 1e-3);
      const root = pitch - crest - 2 * flank;
      const dir = opts.leftHanded ? 1 : -1;
      const ext = external ? 0 : 0.5;
      const c = opts.chamfer === false || !external ? 0 : Math.min(depth, length / 4);
      const profile = (u: number) => {
        u = ((u % pitch) + pitch) % pitch;
        if (u < root / 2) return rMin;
        u -= root / 2;
        if (u < flank) return rMin + depth * (u / flank);
        u -= flank;
        if (u < crest) return rMaj;
        u -= crest;
        if (u < flank) return rMaj - depth * (u / flank);
        return rMin;
      };
      const zStep = pitch / (quality === 'draft' ? 8 : quality === 'normal' ? 14 : 24);
      return H.radialSurface((th, z) => {
        let r = profile(z + (dir * pitch * th) / 360);
        if (c > 0) r = Math.min(r, rMaj - c + z, rMaj - c + (length - z));
        return Math.max(r, rMin - c);
      }, { height: length + 2 * ext, z0: -ext, zSegments: Math.ceil((length + 2 * ext) / zStep) });
    },

    /** count copies rotated around Z. */
    polarArray(shape: Manifold, count: number, totalDeg = 360): Manifold {
      const step = totalDeg >= 360 ? 360 / count : totalDeg / Math.max(1, count - 1);
      return M.union(Array.from({ length: count }, (_, i) => shape.rotate([0, 0, step * i])));
    },

    /** count copies offset by `delta` each. */
    linearArray(shape: Manifold, count: number, delta: Vec3): Manifold {
      return M.union(Array.from({ length: count }, (_, i) => shape.translate([delta[0] * i, delta[1] * i, delta[2] * i])));
    },

    /** Moves a shape so it rests on z=0 and (optionally) is centered on XY. */
    placeOnBed(shape: Manifold, centerXY = true): Manifold {
      const b = shape.boundingBox();
      const dx = centerXY ? -(b.min[0] + b.max[0]) / 2 : 0;
      const dy = centerXY ? -(b.min[1] + b.max[1]) / 2 : 0;
      return shape.translate([dx, dy, -b.min[2]]);
    },

    /** 2D text as a CrossSection in the XY plane (size = capital-letter height in mm). */
    text(str: string, opts: TextLayoutOptions = {}): CrossSection {
      const contours = layoutText(String(str ?? ''), opts);
      return contours.length ? new C(contours, 'NonZero') : C.square([0, 0]);
    },

    /** Text extruded upward from z=0 by `depth` mm. */
    textSolid(str: string, opts: TextLayoutOptions & { depth?: number } = {}): Manifold {
      return H.text(str, opts).extrude(opts.depth ?? 1);
    },

    /**
     * Bend a shape modelled flat onto a vertical cylinder (axis = Z through the origin).
     * Flat convention: x = distance along the surface (0 = front centre), z = height,
     * -y = outward from the surface (so text standing in the XZ plane, extruded toward -y, reads from the front).
     */
    wrapAroundZ(shape: Manifold, radius: number): Manifold {
      if (!(radius > 0)) throw new Error('H.wrapAroundZ: radius must be > 0');
      return shape.refineToLength(Math.max(0.3, radius / 60)).warp((v) => {
        const th = -Math.PI / 2 + v[0] / radius;
        const r = radius - v[1];
        v[0] = r * Math.cos(th);
        v[1] = r * Math.sin(th);
      });
    },

    /**
     * An SVG drawing the user attached in the chat, as a flat CrossSection centred on the origin
     * (y up), `height` mm high (default 20; the width keeps the proportions). `colors`: the fill
     * colours that make the shape (default: all but white-ish ones); colours painted on top of
     * them cut through, as in the drawing.
     */
    svg(name: string, opts: { height?: number; colors?: string[] } = {}): CrossSection {
      const d = drawings[name];
      if (!d) throw new Error(`H.svg: no attached drawing named "${name}" (attached: ${Object.keys(drawings).map((n) => `"${n}"`).join(', ') || 'none'})`);
      const height = opts.height ?? 20;
      if (!(height > 0)) throw new Error('H.svg: height must be > 0');
      const cs = drawingSection(d, height, opts.colors ?? defaultColors(d), C);
      if (!cs) throw new Error(`H.svg: "${name}" has no shape in the colours ${JSON.stringify(opts.colors ?? defaultColors(d))}`);
      return cs;
    },

    /**
     * A LayerTone filament painting of a picture the user attached: a flat relief `width` mm
     * wide (bottom at z = 0, centred), whose height at each point sets how much light filament
     * covers the dark ones below. Filaments and swap layers come from the user's side panel, else
     * `opts.filaments` (default black and white) with automatic swaps. Return it as a part,
     * `{ name: 'Picture', ...H.layertone(...) }`: its layerColors colour the preview, its print
     * settings (0.08 mm layers, 100 % infill) go with it, and `layerTone` (picture and options)
     * lets the side panel show the print as it will look.
     */
    layertone(imageName: string, opts: LayerToneOptions): LayerTonePart {
      const image = layerToneInput.images[imageName];
      if (!image) throw new Error(`H.layertone: no picture named "${imageName}" (pictures: ${Object.keys(layerToneInput.images).map((n) => `"${n}"`).join(', ') || 'none'})`);
      const r = resolveLayerToneOptions(opts, quality);
      const layerColors = layerToneLayers(image, opts, layerToneInput.setup, quality);
      const { vertProperties, triVerts } = layerToneMesh(image, layerColors, r);
      const shape = new M(new wasm.Mesh({ numProp: 3, vertProperties, triVerts })) as Manifold;
      const st = shape.status();
      if (st !== 'NoError') throw new Error(`H.layertone: the relief mesh is invalid (${st})`);
      const { nBase: _b, nMax: _m, ...options } = r;
      return {
        shape, layerColors, print: { layerHeight: r.layerHeight, firstLayerHeight: r.firstLayerHeight, infill: 100, infillPattern: 'zig-zag' },
        layerTone: { image: imageName, options },
      };
    },

    /**
     * A lithophane of a picture the user attached: a white-PLA panel `width` mm wide, thick where
     * the picture is dark and thin where it is bright, that shows it lit from behind. Flat (standing
     * on z = 0, the picture facing −Y), curved (an arc of `angle` degrees around the Z axis) or a
     * full cylinder, with an optional foot (`stand`). Return it as a part,
     * `{ name: 'Lithophane', ...H.lithophane(...) }`: its print settings (0.12 mm layers, 100 %
     * infill, walls that fill it) go with it, and `lithophane` (picture and options) lets the
     * viewer and the side panel show it lit.
     */
    lithophane(imageName: string, opts: LithophaneOptions): LithophanePart {
      const image = layerToneInput.images[imageName];
      if (!image) throw new Error(`H.lithophane: no picture named "${imageName}" (pictures: ${Object.keys(layerToneInput.images).map((n) => `"${n}"`).join(', ') || 'none'})`);
      const r = resolveLithoOptions(opts, quality);
      const { vertProperties, triVerts } = lithophaneMesh(image, r);
      // The fourth property is the thickness, which colours the panel lit from behind; Manifold
      // keeps it through moves and booleans.
      const shape = new M(new wasm.Mesh({ numProp: 4, vertProperties, triVerts })) as Manifold;
      const st = shape.status();
      if (st !== 'NoError') throw new Error(`H.lithophane: the panel mesh is invalid (${st})`);
      const { print, note } = lithoPrint(r);
      return { shape, print, lithophane: { image: imageName, options: r }, note };
    },

    /**
     * Line art: a one-piece wall cut-out of one or more drawings (attached SVGs, traced pictures;
     * several stand side by side at the same height), lying flat with its back on z = 0. Its lines
     * are redrawn `lineWidth` wide at the final size, loose bits are bridged to the rest and specks
     * dropped, and the style adds a bar (with pegs for keys, or a name), a frame or a stand. Return
     * it as it is: `return H.lineart('car', { style: 'keyholder', width: 220 })` – parts, print
     * settings and what was fixed (lineArt) go with it.
     */
    lineart(source: string | string[], opts: LineArtOptions = {}): LineArtResult {
      const known = (n: string) => {
        const d = drawings[n];
        if (!d) throw new Error(`H.lineart: no drawing named "${n}" (drawings: ${Object.keys(drawings).map((k) => `"${k}"`).join(', ') || 'none'})`);
        return d;
      };
      return buildLineArt({
        M, C, quality,
        section: (n, colors) => {
          const d = known(n);
          const cs = drawingSection(d, 1, colors ?? defaultColors(d), C);
          if (!cs) throw new Error(`H.lineart: "${n}" has no shape in the colours ${JSON.stringify(colors ?? defaultColors(d))}`);
          return cs;
        },
        fingerprint: (n) => {
          const d = known(n);
          let h = 0, pts = 0;
          for (const sh of d.shapes) for (const c of sh.contours) for (const [x, y] of c) { h = (h * 31 + Math.round(x * 1e5) * 7 + Math.round(y * 1e5)) | 0; pts++; }
          return `${n}:${d.aspect}:${pts}:${h}`;
        },
        text: (str, o) => H.text(str, o),
      }, source, opts);
    },

    /**
     * A mesh the user imported (STL, OBJ, GLB, 3MF in the chat) or Claude generated (generate_3d),
     * as a watertight Manifold: Z up, standing on z = 0, centred in X and Y, in mm. Options scale
     * it to a height/width/depth/size (or by `scale`) and rotate it (degrees, then stood on the bed
     * again unless center is false).
     */
    mesh(name: string, opts: MeshOptions = {}): Manifold {
      const entry = meshes[name];
      if (!entry) throw new Error(`H.mesh: no mesh named "${name}" (meshes: ${Object.keys(meshes).map((n) => `"${n}"`).join(', ') || 'none'})`);
      const sizes = (['height', 'width', 'depth', 'size', 'scale'] as const).filter((k) => opts[k] != null);
      if (sizes.length > 1) throw new Error(`H.mesh: give one of height, width, depth, size or scale (got ${sizes.join(', ')})`);
      for (const k of sizes) if (!(Number(opts[k]) > 0)) throw new Error(`H.mesh: ${k} must be > 0`);
      const { solid, colorId } = meshSolid(entry.file);
      // Its colours follow its triangles through the script (the runtime looks them up).
      if (colorId != null && entry.palette?.length && painted && !painted.some((x) => x.id === colorId)) painted.push({ id: colorId, name, url: entry.file });
      let m = solid.translate([0, 0, 0]);
      const rot = opts.rotate;
      if (rot != null) {
        if (!Array.isArray(rot) || rot.length !== 3 || !rot.every((x) => Number.isFinite(x))) throw new Error('H.mesh: rotate must be [x, y, z] in degrees');
        if (rot.some((x) => x !== 0)) m = m.rotate(rot);
      }
      const b = m.boundingBox();
      const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      const k = opts.scale ?? (opts.height != null ? opts.height / ext[2] : opts.width != null ? opts.width / ext[0] : opts.depth != null ? opts.depth / ext[1] : opts.size != null ? opts.size / Math.max(...ext) : 1);
      if (opts.center !== false) m = m.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]);
      return k !== 1 ? m.scale(k) : m;
    },

    clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); },
    lerp(a: number, b: number, t: number): number { return a + (b - a) * t; },
  };
  return H;
}

function transport(n: Vec3, t0: Vec3, t1: Vec3): Vec3 {
  const axis = cross(t0, t1);
  const s = Math.hypot(axis[0], axis[1], axis[2]);
  let out = n;
  if (s > 1e-9) {
    const k = scale(axis, 1 / s);
    const c = Math.max(-1, Math.min(1, dot(t0, t1)));
    const ang = Math.atan2(s, c);
    // Rodrigues rotation
    out = add(add(scale(n, Math.cos(ang)), scale(cross(k, n), Math.sin(ang))), scale(k, dot(k, n) * (1 - Math.cos(ang))));
  }
  return norm(sub(out, scale(t1, dot(out, t1))));
}
