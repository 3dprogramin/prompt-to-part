// Shared model-script runtime. Runs in the browser worker (live preview) and in
// the Node worker (validation + rendering for the AI agent).
import type { ManifoldToplevel, Manifold, CrossSection } from 'manifold-3d';
import { parse } from 'acorn';
import { FontMissingError, layoutText, type TextLayoutOptions } from './text';
import { applyTextFeatures, parseTextFeatures, TEXT_KEY } from './textFeatures';
import { cleanProfile } from './print';
import type {
  AssemblyStep, Box3, DimensionAnnotation, EvalResult, ModelMeta, ParamDef, ParamValues,
  PartMesh, Quality, ScriptErrorInfo, Vec2, Vec3,
} from './types';

export class ScriptError extends Error {
  info: ScriptErrorInfo;
  constructor(info: ScriptErrorInfo) {
    super(info.message);
    this.info = info;
  }
}

export const SCALE_KEY = '$scale';

const PALETTE = ['#d9a441', '#5b9bd5', '#7fbf6a', '#d46a6a', '#9b7fd4', '#4fc1c1', '#e08a3c', '#b0b7c3'];
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Memory management: every Manifold / CrossSection created during an
// evaluation is tracked and deleted afterwards, so scripts never call delete().
// ---------------------------------------------------------------------------

const SKIP = new Set(['constructor', 'delete', 'isDeleted', 'clone', 'deleteLater', 'isAliasOf']);

interface Runtime {
  wasm: ManifoldToplevel;
  registry: Set<{ delete(): void; isDeleted?(): boolean }>;
  Manifold: typeof Manifold;
  CrossSection: typeof CrossSection;
}

let runtime: Runtime | null = null;

// A WebAssembly trap (out-of-bounds access, unreachable, abort) can leave the wasm heap
// corrupted, so after one the worker should be replaced rather than reused.
const TRAP = /memory access out of bounds|^unreachable|table index is out of bounds|function signature mismatch|^Aborted\(/;
let trapped = false;
function noteTrap(e: unknown) {
  if (e instanceof WebAssembly.RuntimeError || TRAP.test((e as Error)?.message ?? '')) trapped = true;
}
/** True once any evaluation hit a WebAssembly trap; the instance should not be trusted after that. */
export function runtimeTrapped(): boolean { return trapped; }

export function initRuntime(wasm: ManifoldToplevel): void {
  if (runtime) return;
  wasm.setup();
  const registry: Runtime['registry'] = new Set();
  const M = wasm.Manifold as any;
  const C = wasm.CrossSection as any;
  // embind's ClassHandle prototype: every wasm object (Manifold, CrossSection, std::vector…) inherits it.
  let handleProto = M.prototype;
  while (handleProto && !Object.prototype.hasOwnProperty.call(handleProto, 'isDeleted')) handleProto = Object.getPrototypeOf(handleProto);
  const isHandle = (x: unknown): x is { delete(): void } => typeof x === 'object' && x !== null && handleProto.isPrototypeOf(x);
  const track = (r: any) => {
    if (isHandle(r)) registry.add(r);
    else if (Array.isArray(r)) for (const x of r) if (isHandle(x)) registry.add(x);
    return r;
  };
  // manifold-3d's JS layer drops temporaries without deleting them (the per-contour vectors
  // built from polygons, the _ToPolygons() result in extrude/revolve, get() copies in
  // toPolygons, the un-centred solid of extrude(center)). Tracking the receiver and handle
  // arguments of every wrapped call, not just the result, catches those too.
  const wrapAll = (obj: any) => {
    for (const name of Object.getOwnPropertyNames(obj)) {
      if (SKIP.has(name)) continue;
      const desc = Object.getOwnPropertyDescriptor(obj, name);
      if (!desc || typeof desc.value !== 'function' || !desc.writable) continue;
      const orig = desc.value;
      obj[name] = function (this: unknown, ...args: unknown[]) {
        if (isHandle(this)) registry.add(this);
        for (const a of args) if (isHandle(a)) registry.add(a);
        return track(orig.apply(this, args));
      };
    }
  };
  // Methods like translate/subtract live on parent prototypes, so wrap the whole chain
  // (each prototype once; embind's delete/clone/isDeleted are skipped). The std::vector
  // classes are wrapped as well so their temporaries are tracked.
  const classes = [M, C, ...Object.values(wasm).filter((v: any) => typeof v === 'function' && v.prototype && handleProto.isPrototypeOf(v.prototype))];
  const seen = new Set<object>([handleProto]);
  for (const cls of new Set(classes)) {
    if (cls === M || cls === C) wrapAll(cls);
    for (let proto = cls.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      if (seen.has(proto)) continue;
      seen.add(proto);
      wrapAll(proto);
    }
  }
  const proxied = (cls: any) => new Proxy(cls, {
    construct(target, args) { return track(Reflect.construct(target, args)); },
  });
  // Every script in this worker gets the same classes, so freeze what a script can reach from them:
  // otherwise one design could patch e.g. Manifold.prototype.scale for every later design. embind's
  // per-class records come from sample objects (deleted before freezing, as delete() writes to them).
  const samples = [M.cube([1, 1, 1]), C.square([1, 1])];
  for (const c of classes) if (c !== M && c !== C) try { samples.push(new c()); } catch { /* needs arguments */ }
  const records = samples.map((s) => s.$$?.ptrType);
  for (const s of samples) s.delete();
  freezeReachable([M, C, handleProto, wasm.Mesh, ...classes, ...records]);
  runtime = { wasm, registry, Manifold: proxied(M), CrossSection: proxied(C) };
}

/** Object.freeze everything reachable through own properties and prototypes (not the wasm heap). */
function freezeReachable(roots: unknown[]) {
  // The shared intrinsics are already frozen by lockdown(); stop there.
  const seen = new Set<object>([Object.prototype, Function.prototype]);
  const stack = [...roots];
  while (stack.length) {
    const o = stack.pop();
    if ((typeof o !== 'object' && typeof o !== 'function') || o === null || seen.has(o)) continue;
    seen.add(o);
    if (ArrayBuffer.isView(o) || o instanceof ArrayBuffer || o instanceof WebAssembly.Memory || 'HEAPU8' in o) continue;
    Object.freeze(o);
    stack.push(Object.getPrototypeOf(o));
    for (const k of Reflect.ownKeys(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k)!;
      stack.push(d.value, d.get, d.set);
    }
  }
}

function cleanup(rt: Runtime) {
  for (const obj of rt.registry) {
    try {
      if (!obj.isDeleted || !obj.isDeleted()) obj.delete();
    } catch (e) { noteTrap(e); }
  }
  rt.registry.clear();
}

function applyQuality(wasm: ManifoldToplevel, q: Quality) {
  wasm.resetToCircularDefaults();
  if (q === 'draft') { wasm.setMinCircularAngle(12); wasm.setMinCircularEdgeLength(1.0); }
  else if (q === 'normal') { wasm.setMinCircularAngle(6); wasm.setMinCircularEdgeLength(0.5); }
  else { wasm.setMinCircularAngle(3); wasm.setMinCircularEdgeLength(0.2); }
}

// ---------------------------------------------------------------------------
// Helper library exposed to scripts as `H`.
// ---------------------------------------------------------------------------

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

function makeHelpers(rt: Runtime, quality: Quality) {
  const { wasm } = rt;
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

    clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); },
    lerp(a: number, b: number, t: number): number { return a + (b - a) * t; },
  };
  return H;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
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

// ---------------------------------------------------------------------------
// Script compilation & evaluation
// ---------------------------------------------------------------------------

const PRELUDE_LINES = 2; // "(function (...) {" + '"use strict";'

function locate(err: unknown): { line?: number; column?: number } {
  const stack = (err as Error)?.stack ?? '';
  const m = /model\.js:(\d+):(\d+)/.exec(stack);
  if (!m) return {};
  return { line: Number(m[1]) - PRELUDE_LINES, column: Number(m[2]) };
}

type Compiled = (...args: unknown[]) => { meta: unknown; params: unknown; build: unknown };
const compileCache = new Map<string, Compiled>();

/** What scripts get besides the compartment's globals (see the wrapper in compile()). */
const SCRIPT_ARGS = ['Manifold', 'CrossSection', 'H', 'quality', 'console'];
let knownGlobals: Set<string> | null = null;

type Node = { type: string; [k: string]: unknown };
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && typeof (v as Node).type === 'string';

/**
 * Finds the first identifier the script reads without declaring it. Inside the compartment such a
 * name silently evaluates to undefined (SES never throws a ReferenceError for it), so a typo like
 * `chamfr` would quietly drop a feature instead of failing with a line number. Scopes are ignored:
 * a name declared anywhere counts as declared, which can only miss a typo, never flag valid code.
 */
function findUndeclared(ast: Node): { name: string; line: number; column: number } | null {
  knownGlobals ??= new Set([...Object.getOwnPropertyNames(new Compartment().globalThis), ...SCRIPT_ARGS, 'arguments']);
  const declared = new Set<string>();
  const refs: Node[] = [];
  const pattern = (p: unknown): void => {
    if (!isNode(p)) return;
    if (p.type === 'Identifier') declared.add(p.name as string);
    else if (p.type === 'ObjectPattern') for (const prop of p.properties as Node[]) {
      if (prop.type === 'RestElement') pattern(prop.argument);
      else { if (prop.computed) visit(prop.key); pattern(prop.value); }
    }
    else if (p.type === 'ArrayPattern') (p.elements as unknown[]).forEach(pattern);
    else if (p.type === 'RestElement') pattern(p.argument);
    else if (p.type === 'AssignmentPattern') { pattern(p.left); visit(p.right); }
    else visit(p); // a member expression as a destructuring target
  };
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (!isNode(n)) return;
    switch (n.type) {
      case 'Identifier': refs.push(n); return;
      case 'VariableDeclarator': pattern(n.id); visit(n.init); return;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        if (n.id) pattern(n.id);
        (n.params as unknown[]).forEach(pattern);
        visit(n.body);
        return;
      case 'ClassDeclaration': case 'ClassExpression': if (n.id) pattern(n.id); visit(n.superClass); visit(n.body); return;
      case 'CatchClause': pattern(n.param); visit(n.body); return;
      case 'UnaryExpression': if (n.operator === 'typeof' && isNode(n.argument) && n.argument.type === 'Identifier') return; break;
      case 'MemberExpression': visit(n.object); if (n.computed) visit(n.property); return;
      case 'Property': case 'MethodDefinition': case 'PropertyDefinition': if (n.computed) visit(n.key); visit(n.value); return;
      case 'LabeledStatement': visit(n.body); return;
      case 'BreakStatement': case 'ContinueStatement': case 'MetaProperty': return;
    }
    for (const [k, v] of Object.entries(n)) if (k !== 'loc') visit(v);
  };
  visit(ast);
  const bad = refs.find((r) => !declared.has(r.name as string) && !knownGlobals!.has(r.name as string));
  if (!bad) return null;
  const loc = bad.loc as { start: { line: number; column: number } };
  return { name: bad.name as string, line: loc.start.line, column: loc.start.column + 1 };
}

/** Compiles a model script inside an SES Compartment (see shared/sandbox.ts); never outside one. */
function compile(code: string): Compiled {
  const hit = compileCache.get(code);
  if (hit) return hit;
  if (typeof Compartment === 'undefined') throw new Error('Model sandbox is not active: import shared/sandbox.ts first');
  let ast: Node;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true }) as unknown as Node;
  } catch (e) {
    const loc = (e as { loc?: { line: number; column: number } }).loc;
    throw new ScriptError({ message: `Syntax error: ${(e as Error).message.replace(/ \(\d+:\d+\)$/, '')}`, stage: 'compile', line: loc?.line, column: loc ? loc.column + 1 : undefined });
  }
  const undeclared = findUndeclared(ast);
  if (undeclared) {
    throw new ScriptError({ message: `"${undeclared.name}" is not defined – check the spelling, or declare it with const/let`, stage: 'compile', line: undeclared.line, column: undeclared.column });
  }
  let fn: Compiled;
  try {
    const src = `(function (Manifold, CrossSection, H, quality, console) {\n"use strict";\n${code}\n;return { meta: typeof meta !== "undefined" ? meta : {}, params: typeof params !== "undefined" ? params : {}, build: typeof build === "function" ? build : undefined };\n})\n//# sourceURL=model.js\n`;
    fn = new Compartment({ __options__: true, name: 'model.js' }).evaluate(src) as Compiled;
  } catch (e) {
    throw new ScriptError({ message: `Syntax error: ${(e as Error).message}`, stage: 'compile' });
  }
  if (compileCache.size > 20) compileCache.clear();
  compileCache.set(code, fn);
  return fn;
}

function niceStep(range: number) {
  const raw = range / 200;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

export function normalizeParams(raw: unknown): Record<string, ParamDef> {
  const out: Record<string, ParamDef> = {};
  if (!raw || typeof raw !== 'object') return out;
  const entries: [string, any][] = Array.isArray(raw)
    ? raw.map((p: any) => [String(p?.key ?? p?.name), p])
    : Object.entries(raw as object);
  for (const [key, p] of entries) {
    if (!key || !p || typeof p !== 'object') continue;
    const label = typeof p.label === 'string' ? p.label : key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const value = p.value ?? p.default;
    const common = { label, group: typeof p.group === 'string' ? p.group : undefined, description: typeof p.description === 'string' ? p.description : undefined };
    let type = p.type;
    // The script's own objects are read, never written: they may be frozen.
    const font = type === 'font' || !!p.font;
    if (type === 'int') type = 'integer';
    if (type === 'bool') type = 'boolean';
    if (type === 'string' || type === 'font') type = 'text';
    if (!type) type = typeof value === 'boolean' ? 'boolean' : Array.isArray(p.options) ? 'select' : typeof value === 'string' ? 'text' : 'number';
    if (type === 'boolean') out[key] = { ...common, type, value: !!value };
    else if (type === 'text') out[key] = { ...common, type, value: String(value ?? ''), font };
    else if (type === 'select') {
      const options = (Array.isArray(p.options) ? p.options : []).map((o: any) =>
        typeof o === 'object' && o ? { value: String(o.value), label: String(o.label ?? o.value) } : { value: String(o), label: String(o) });
      if (!options.length) continue;
      const v = options.some((o: any) => o.value === String(value)) ? String(value) : options[0].value;
      out[key] = { ...common, type, options, value: v };
    } else {
      const v = Number(value);
      const val = Number.isFinite(v) ? v : 0;
      // Without bounds, a slider runs from 0 to twice the default; a negative default gets the
      // same span on its own side of zero (-10 → -20…0), so the default is never at an edge.
      const span = Math.max(Math.abs(val), 1);
      let min = Number.isFinite(Number(p.min)) ? Number(p.min) : val >= 0 ? 0 : val - span;
      let max = Number.isFinite(Number(p.max)) ? Number(p.max) : Math.max(val >= 0 ? val * 2 : val + span, min + 1);
      if (max < min) [min, max] = [max, min];
      const isInt = type === 'integer';
      const step = Number(p.step) > 0 ? Number(p.step) : isInt ? 1 : niceStep(max - min || 1);
      const drives = ['x', 'y', 'z'].includes(p.drives) ? p.drives : undefined;
      out[key] = { ...common, type: isInt ? 'integer' : 'number', min, max, step, value: isInt ? Math.round(val) : val, unit: typeof p.unit === 'string' ? p.unit : isInt ? undefined : 'mm', drives };
    }
  }
  return out;
}

export function resolveValues(params: Record<string, ParamDef>, input: ParamValues | undefined): ParamValues {
  const out: ParamValues = {};
  for (const [k, def] of Object.entries(params)) {
    const v = input?.[k];
    if (def.type === 'boolean') out[k] = typeof v === 'boolean' ? v : def.value;
    else if (def.type === 'text') out[k] = typeof v === 'string' ? v : def.value;
    else if (def.type === 'select') out[k] = typeof v === 'string' && def.options.some((o) => o.value === v) ? v : def.value;
    else {
      const n = typeof v === 'number' && Number.isFinite(v) ? v : def.value;
      out[k] = def.type === 'integer' ? Math.round(n) : n;
    }
  }
  return out;
}

/** Only read params/meta (no geometry build). */
export function inspectScript(code: string): { meta: ModelMeta; params: Record<string, ParamDef> } {
  if (!runtime) throw new Error('runtime not initialised');
  const rt = runtime;
  try {
    const r = compile(code)(rt.Manifold, rt.CrossSection, makeHelpers(rt, 'draft'), 'draft', makeConsole([]));
    return { meta: normalizeMeta(r.meta), params: normalizeParams(r.params) };
  } catch (e) {
    noteTrap(e);
    if (e instanceof ScriptError || e instanceof FontMissingError) throw e;
    throw new ScriptError({ message: (e as Error)?.message ?? String(e), stage: 'params', ...locate(e) });
  } finally {
    cleanup(rt);
  }
}

function normalizeMeta(m: unknown): ModelMeta {
  const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
  return { name: typeof o.name === 'string' ? o.name.slice(0, 200) : undefined, description: typeof o.description === 'string' ? o.description.slice(0, 2000) : undefined };
}

// Logs and errors go into Claude's tool results: one console.log of a 50k-point array must not
// produce megabytes of text.
const MAX_LOG_LINE = 500;
const MAX_LOG_TOTAL = 8000;
const MAX_ERROR = 2000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

function makeConsole(logs: string[]) {
  const fmt = (args: unknown[]) => args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ');
  let total = 0;
  const push = (lvl: string) => (...args: unknown[]) => {
    if (logs.length >= 200 || total >= MAX_LOG_TOTAL) return;
    const line = clip((lvl ? lvl + ': ' : '') + fmt(args), MAX_LOG_LINE);
    total += line.length;
    logs.push(total >= MAX_LOG_TOTAL ? `${line}\n… further console output dropped` : line);
  };
  return { log: push(''), info: push(''), warn: push('warn'), error: push('error'), debug: push('') };
}
function safeJson(a: unknown) {
  try { return JSON.stringify(a); } catch { return String(a); }
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => Number.isFinite(x));
}

export function evaluateScript(code: string, inputValues: ParamValues | undefined, quality: Quality = 'normal', opts: { lite?: boolean } = {}): EvalResult {
  if (!runtime) throw new Error('runtime not initialised');
  const rt = runtime;
  const t0 = performance.now();
  // Uniform scale applied after build (reserved value key "$scale", not a script parameter).
  const rawScale = Number(inputValues?.[SCALE_KEY]);
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const logs: string[] = [];
  const warnings: string[] = [];
  applyQuality(rt.wasm, quality);
  try {
    const H = makeHelpers(rt, quality);
    let scope;
    try {
      scope = compile(code)(rt.Manifold, rt.CrossSection, H, quality, makeConsole(logs));
    } catch (e) {
      // A font used at the top level (outside build) is loaded and the script run again.
      if (e instanceof ScriptError || e instanceof FontMissingError) throw e;
      throw new ScriptError({ message: (e as Error)?.message ?? String(e), stage: 'params', ...locate(e) });
    }
    const meta = normalizeMeta(scope.meta);
    const params = normalizeParams(scope.params);
    if (typeof scope.build !== 'function') throw new ScriptError({ message: 'Script must define `function build(p) { ... }`', stage: 'compile' });
    const values = resolveValues(params, inputValues);
    let out: unknown;
    try {
      out = (scope.build as (p: ParamValues, lib: unknown) => unknown)(Object.freeze({ ...values }), { Manifold: rt.Manifold, CrossSection: rt.CrossSection, H, quality });
    } catch (e) {
      if (e instanceof FontMissingError) throw e;
      throw new ScriptError({ message: (e as Error)?.message ?? String(e), stage: 'build', ...locate(e) });
    }
    if (out && typeof (out as any).then === 'function') throw new ScriptError({ message: 'build() must be synchronous (no async/await)', stage: 'output' });

    // Normalise output
    let rawParts: unknown[] = [];
    let rawDims: unknown[] = [];
    let rawAssembly: unknown[] = [];
    let rawPrint: unknown;
    const M = rt.wasm.Manifold as any;
    const C = rt.wasm.CrossSection as any;
    if (out instanceof M) rawParts = [out];
    else if (Array.isArray(out)) rawParts = out;
    else if (out && typeof out === 'object') {
      const o = out as Record<string, unknown>;
      if (Array.isArray(o.parts)) rawParts = o.parts;
      else if (o.shape) rawParts = [o];
      if (Array.isArray(o.dimensions)) rawDims = o.dimensions;
      if (Array.isArray(o.assembly)) rawAssembly = o.assembly;
      if (o.print && typeof o.print === 'object') rawPrint = o.print;
    }
    if (out instanceof C) throw new ScriptError({ message: 'build() returned a 2D CrossSection – extrude or revolve it into a Manifold', stage: 'output' });
    if (!rawParts.length) throw new ScriptError({ message: 'build() must return a Manifold, an array of parts, or { parts: [...], dimensions: [...] }', stage: 'output' });

    const parts: PartMesh[] = [];
    const textFeatures = parseTextFeatures(inputValues?.[TEXT_KEY]);
    const partNames = rawParts.map((rp, i) => {
      const n = rp && typeof rp === 'object' && !(rp instanceof M) && typeof (rp as { name?: unknown }).name === 'string' ? (rp as { name: string }).name.slice(0, 120) : '';
      return n || (rawParts.length === 1 ? meta.name || 'Model' : `Part ${i + 1}`);
    });
    rawParts.forEach((rp, i) => {
      let shape: any, name = '', color = '';
      if (rp instanceof M) shape = rp;
      else if (rp && typeof rp === 'object') {
        const o = rp as Record<string, unknown>;
        shape = o.shape ?? o.manifold;
        name = typeof o.name === 'string' ? o.name : '';
        color = typeof o.color === 'string' ? o.color : '';
      }
      if (!(shape instanceof M)) throw new ScriptError({ message: `Part ${i + 1} is not a Manifold (got ${shape instanceof C ? 'CrossSection' : typeof shape})`, stage: 'output' });
      if (scale !== 1) shape = shape.scale(scale);
      name = partNames[i];
      const mine = textFeatures.filter((f) => (f.part && partNames.includes(f.part) ? f.part === name : i === 0));
      if (mine.length) {
        try {
          shape = applyTextFeatures(shape, mine, rt.Manifold, rt.CrossSection);
        } catch (e) {
          if (e instanceof FontMissingError) throw e;
          warnings.push(`Text feature failed: ${(e as Error).message}`);
        }
      }
      color ||= PALETTE[i % PALETTE.length];
      const st = shape.status();
      if (st !== 'NoError') warnings.push(`Part "${name}" has status ${st}`);
      if (shape.isEmpty()) { warnings.push(`Part "${name}" is empty`); return; }
      if (opts.lite) {
        const bb = shape.boundingBox();
        parts.push({ name, color, positions: new Float32Array(0), indices: new Uint32Array(0), bbox: { min: [bb.min[0], bb.min[1], bb.min[2]], max: [bb.max[0], bb.max[1], bb.max[2]] }, volume: 0, surfaceArea: 0, triCount: 0, genus: 0, components: 1 });
        return;
      }
      const mesh = shape.getMesh();
      const np = mesh.numProp;
      const vp = mesh.vertProperties;
      const nv = vp.length / np;
      const positions = new Float32Array(nv * 3);
      for (let v = 0; v < nv; v++) { positions[v * 3] = vp[v * np]; positions[v * 3 + 1] = vp[v * np + 1]; positions[v * 3 + 2] = vp[v * np + 2]; }
      const bb = shape.boundingBox();
      parts.push({
        name, color, positions, indices: new Uint32Array(mesh.triVerts),
        bbox: { min: [bb.min[0], bb.min[1], bb.min[2]], max: [bb.max[0], bb.max[1], bb.max[2]] },
        volume: shape.volume(), surfaceArea: shape.surfaceArea(), triCount: shape.numTri(), genus: shape.genus(),
        components: shape.decompose().length,
      });
    });

    const dimensions: DimensionAnnotation[] = [];
    for (const d of rawDims) {
      if (!d || typeof d !== 'object') continue;
      const o = d as Record<string, unknown>;
      if (!isVec3(o.from) || !isVec3(o.to)) { warnings.push(`Ignored dimension "${o.label ?? '?'}": from/to must be [x, y, z]`); continue; }
      const sc = (v: number[]) => v.slice(0, 3).map((x) => x * scale) as Vec3;
      dimensions.push({ label: typeof o.label === 'string' ? o.label : undefined, from: sc(o.from), to: sc(o.to), offset: isVec3(o.offset) ? sc(o.offset) : undefined, param: typeof o.param === 'string' && o.param in params ? o.param : undefined });
    }

    let bbox: Box3 | null = null;
    for (const p of parts) {
      if (!bbox) bbox = { min: [...p.bbox.min] as Vec3, max: [...p.bbox.max] as Vec3 };
      else for (let k = 0; k < 3; k++) { bbox.min[k] = Math.min(bbox.min[k], p.bbox.min[k]); bbox.max[k] = Math.max(bbox.max[k], p.bbox.max[k]); }
    }
    const names = new Set(parts.map((p) => p.name));
    const assembly: AssemblyStep[] = [];
    rawAssembly.forEach((st, i) => {
      if (!st || typeof st !== 'object') return;
      const o = st as Record<string, unknown>;
      const stepParts = (Array.isArray(o.parts) ? o.parts : typeof o.part === 'string' ? [o.part] : []).filter((n): n is string => typeof n === 'string');
      const unknown = stepParts.filter((n) => !names.has(n));
      if (unknown.length) warnings.push(`Assembly step ${i + 1}: unknown part(s) ${unknown.map((n) => `"${n}"`).join(', ')}`);
      const known = stepParts.filter((n) => names.has(n));
      if (!known.length) return;
      const step: AssemblyStep = { label: typeof o.label === 'string' ? o.label : `Step ${i + 1}`, parts: known };
      if (isVec3(o.from)) step.from = o.from.slice(0, 3).map((x) => x * scale) as Vec3;
      const rot = o.rotate as Record<string, unknown> | undefined;
      if (rot && isVec3(rot.axis) && Number.isFinite(rot.degrees)) {
        step.rotate = { axis: rot.axis.slice(0, 3) as Vec3, degrees: Number(rot.degrees), center: isVec3(rot.center) ? rot.center.slice(0, 3).map((x) => x * scale) as Vec3 : undefined };
      }
      assembly.push(step);
    });
    const print = cleanProfile(rawPrint, parts.map((p) => p.name));
    return { meta, params, values, parts, dimensions, assembly, print, bbox, timeMs: performance.now() - t0, warnings, logs, quality };
  } catch (e) {
    noteTrap(e);
    if (e instanceof ScriptError || e instanceof FontMissingError) throw e;
    throw new ScriptError({ message: (e as Error)?.message ?? String(e), stage: 'build', ...locate(e) });
  } finally {
    cleanup(rt);
  }
}

/** Volume (mm³) where two part meshes intersect. */
export function overlapVolume(a: PartMesh, b: PartMesh): number {
  if (!runtime) throw new Error('runtime not initialised');
  const rt = runtime;
  try {
    const make = (p: PartMesh) => {
      const mesh = new rt.wasm.Mesh({ numProp: 3, vertProperties: p.positions, triVerts: p.indices });
      mesh.merge();
      return new rt.Manifold(mesh) as Manifold;
    };
    return make(a).intersect(make(b)).volume();
  } catch (e) {
    noteTrap(e);
    return 0;
  } finally {
    cleanup(rt);
  }
}

export function formatScriptError(e: unknown): ScriptErrorInfo {
  const info: ScriptErrorInfo = e instanceof ScriptError ? e.info : { message: (e as Error)?.message ?? String(e), stage: 'build' };
  return { ...info, message: clip(String(info.message), MAX_ERROR) };
}
