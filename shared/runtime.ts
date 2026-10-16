// Shared model-script runtime. Runs in the browser worker (live preview) and in
// the Node worker (validation + rendering for the AI agent).
import type { ManifoldToplevel, Manifold, CrossSection } from 'manifold-3d';
import { FontMissingError, takeFontSubstitutions } from './text';
import { compile, locate, ScriptError } from './compile';
import { makeHelpers } from './helpers';
import { normalizeParams, resolveValues } from './params';
import { applyTextFeatures, parseTextFeatures, TEXT_KEY } from './textFeatures';
import { cleanProfile } from './print';
import type {
  AssemblyStep, Box3, DimensionAnnotation, EvalResult, ModelMeta, ParamDef, ParamValues,
  PartMesh, Quality, ScriptErrorInfo, Vec3,
} from './types';

export { ScriptError } from './compile';
export { normalizeParams, resolveValues } from './params';

export const SCALE_KEY = '$scale';

const PALETTE = ['#d9a441', '#5b9bd5', '#7fbf6a', '#d46a6a', '#9b7fd4', '#4fc1c1', '#e08a3c', '#b0b7c3'];

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

// The wasm heap can grow to 4 GB; a trap with it this large means the model ran out of memory,
// which a retry would only repeat.
const OUT_OF_MEMORY_BYTES = 2 ** 31;
let memory: WebAssembly.Memory | null = null;
/** True if the last trap came from running out of wasm memory. */
export function runtimeOutOfMemory(): boolean { return trapped && (memory?.buffer.byteLength ?? 0) >= OUT_OF_MEMORY_BYTES; }

/**
 * manifold-3d Module() option that instantiates the wasm with `load`, keeping a handle on its
 * memory (to recognise running out of it). `onError` gets a failed load: emscripten would
 * otherwise wait forever.
 */
export function instantiateWith(load: (imports: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource>, onError: (e: unknown) => void) {
  return (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
    load(imports).then(({ instance, module }) => {
      memory = Object.values(instance.exports).find((x): x is WebAssembly.Memory => x instanceof WebAssembly.Memory) ?? null;
      receive(instance, module);
    }, onError);
    return {};
  };
}

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
  takeFontSubstitutions();
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
      let textBase: Box3 | undefined;
      if (mine.length) {
        const tb = shape.boundingBox();
        textBase = { min: [tb.min[0], tb.min[1], tb.min[2]], max: [tb.max[0], tb.max[1], tb.max[2]] };
        try {
          shape = applyTextFeatures(shape, mine, rt.CrossSection);
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
        parts.push({ name, color, positions: new Float32Array(0), indices: new Uint32Array(0), bbox: { min: [bb.min[0], bb.min[1], bb.min[2]], max: [bb.max[0], bb.max[1], bb.max[2]] }, textBase, volume: 0, surfaceArea: 0, triCount: 0, genus: 0, components: 1 });
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
        bbox: { min: [bb.min[0], bb.min[1], bb.min[2]], max: [bb.max[0], bb.max[1], bb.max[2]] }, textBase,
        volume: shape.volume(), surfaceArea: shape.surfaceArea(), triCount: shape.numTri(), genus: shape.genus(),
        // A sealed cavity is a component with negative volume: it is not a separate piece.
        components: shape.decompose().filter((c: Manifold) => c.volume() > 0).length,
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
    for (const f of takeFontSubstitutions()) warnings.push(`Font "${f.replace(/^(std|sys):/, '').replace('|', ' ')}" is not available – the text uses Roboto Bold instead`);
    const print = cleanProfile(rawPrint, parts.map((p) => p.name));
    return { meta, params, values, parts, dimensions, assembly, print, bbox, timeMs: performance.now() - t0, warnings, logs, quality };
  } catch (e) {
    noteTrap(e);
    if (runtimeOutOfMemory()) {
      throw new ScriptError({ message: `Ran out of memory: building the model needed over ${(OUT_OF_MEMORY_BYTES / 2 ** 30).toFixed(0)} GB. Lower segment counts or resolution (sphere/cylinder segments, levelSet, refine, text detail).`, stage: 'build', ...locate(e) });
    }
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
