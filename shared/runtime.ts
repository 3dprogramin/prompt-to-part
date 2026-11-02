// Shared model-script runtime. Runs in the browser worker (live preview) and in
// the Node worker (validation + rendering for the AI agent).
import type { ManifoldToplevel, Manifold, CrossSection } from 'manifold-3d';
import { FontMissingError, takeFontSubstitutions } from './text';
import { compile, locate, ScriptError } from './compile';
import { makeHelpers, type PaintedMesh } from './helpers';
import { sameFilament, storedSlots, type PaintFilament } from './meshColors';
import { FACE_SCALE_KEY, normalizeParams, parsePartColors, PART_COLORS_KEY, resolveValues, SCALE_KEY } from './params';
import { applyTextFeatures, parseTextFeatures, TEXT_KEY } from './textFeatures';
import { applySvgFeatures, DRAWINGS_KEY, parseDrawings, parseSvgFeatures, SVG_KEY } from './svgFeatures';
import { cleanLayerToneSource, cleanLayerColors, LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, parseLayerToneImages, parseLayerToneSetup, vertexColors, type LayerToneSource, type LayerColor } from './layertone';
import { cleanLineArtInfo, lineArtPrint, LINEART_DEPTH_KEY, LINEART_EDITS_KEY, LINEART_ENDS_KEY, LINEART_LAYOUT_KEY, LINEART_JOIN_KEY, LINEART_SIZE_KEY, LINEART_SPLIT_KEY, parseLineArtDepth, parseLineArtEdits, parseLineArtEnds, parseLineArtJoin, parseLineArtSize, parseLineArtSplit, type LineArtInfo } from './lineart';
import { cleanLithophaneSource, lithoVertexColors, type LithophaneSource } from './lithophane';
import type { Load } from './stability';
import { cleanProfile, parseProfile, PRINT_KEY } from './print';
import { getMeshData, MESHES_KEY, MeshMissingError, parseMeshes, type MeshData, type MeshEntry } from './meshes';
import { parseMeshFile, type Raster } from './meshFormats';
import { repairMesh, type ImportOptions, type ImportReport } from './meshRepair';
import type {
  AssemblyStep, Box3, DimensionAnnotation, EvalResult, ModelMeta, ParamDef, ParamValues,
  PaintSource, PartMesh, Quality, ScriptErrorInfo, Vec3,
} from './types';

export { ScriptError } from './compile';
export { normalizeParams, resolveValues, SCALE_KEY } from './params';

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
  /** Keeps a handle alive across evaluations (checked like the others, never deleted by cleanup). */
  keep: (h: object) => void;
}

let runtime: Runtime | null = null;
/** Whether a handle's embind record is as Jig created it (set by initRuntime). */
let intactHandle: (h: object) => boolean = () => true;

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
// The heap never shrinks: an earlier large model must not make every later trap look like this one.
let heapAtStart = 0;
const heapSize = () => memory?.buffer.byteLength ?? 0;
/** Size of the wasm heap in bytes (0 if the runtime wasn't started with instantiateWith). */
export function runtimeHeapBytes(): number { return heapSize(); }
/** True if the last trap came from running out of wasm memory during the current evaluation. */
export function runtimeOutOfMemory(): boolean { return trapped && heapSize() >= OUT_OF_MEMORY_BYTES && heapSize() > heapAtStart; }

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
  // embind keeps each object's heap pointer and reference count in its own record ($$), which has to
  // stay writable for delete(). A script that rewrote it could make a call read or write another
  // object's memory, or free one twice. Each handle's record is remembered when Jig first sees it and
  // checked before every call and before the delete in cleanup().
  const born = new WeakMap<object, { rec: any; ptr: unknown; count: any }>();
  const adopt = (h: any) => {
    if (born.has(h)) return;
    const rec = h.$$;
    born.set(h, { rec, ptr: rec?.ptr, count: rec?.count });
    registry.add(h);
  };
  const intact = (h: any) => {
    const b = born.get(h);
    if (!b) return true;
    const rec = h.$$;
    if (rec !== b.rec || rec.count !== b.count) return false;
    // Deleted (by embind's delete): ptr cleared, count 0. Alive: the original ptr and count 1.
    return rec.ptr === undefined ? b.count.value === 0 : rec.ptr === b.ptr && b.count.value === 1;
  };
  const check = (h: unknown): void => {
    // Lists of shapes (union, hull, compose…) are read through each element's record too.
    if (Array.isArray(h)) { for (const x of h) if (isHandle(x)) check(x); return; }
    if (!isHandle(h)) return;
    adopt(h);
    if (!intact(h)) {
      trapped = true;
      throw new Error('The script changed the internals of a Manifold object.');
    }
  };
  const track = (r: any) => {
    if (isHandle(r)) adopt(r);
    else if (Array.isArray(r)) for (const x of r) if (isHandle(x)) adopt(x);
    return r;
  };
  intactHandle = (h) => intact(h);
  // A kept handle (a cached imported mesh) is checked like any other but is not in the registry,
  // so cleanup() leaves it alone. (manifold-3d's constructor already called a method on it.)
  const keep = (h: any) => {
    if (!born.has(h)) born.set(h, { rec: h.$$, ptr: h.$$?.ptr, count: h.$$?.count });
    registry.delete(h);
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
        check(this);
        for (const a of args) check(a);
        // A trap the script catches itself must still retire the worker.
        try { return track(orig.apply(this, args)); } catch (e) { noteTrap(e); throw e; }
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
    construct(target, args) {
      for (const a of args) check(a);
      try { return track(Reflect.construct(target, args)); } catch (e) { noteTrap(e); throw e; }
    },
  });
  // clone() makes a second handle on the same object (shared count); shapes are immutable, so
  // scripts never need it, and refusing it keeps one handle per object for the check above.
  Object.defineProperty(handleProto, 'clone', { value() { throw new Error('clone() is not available: shapes never change, so use the original.'); } });
  // Every script in this worker gets the same classes, so freeze what a script can reach from them:
  // otherwise one design could patch e.g. Manifold.prototype.scale for every later design. embind's
  // per-class records come from sample objects (deleted before freezing, as delete() writes to them).
  const samples = [M.cube([1, 1, 1]), C.square([1, 1])];
  for (const c of classes) if (c !== M && c !== C) try { samples.push(new c()); } catch { /* needs arguments */ }
  const records = samples.map((s) => s.$$?.ptrType);
  for (const s of samples) s.delete();
  freezeReachable([M, C, handleProto, wasm.Mesh, ...classes, ...records]);
  runtime = { wasm, registry, Manifold: proxied(M), CrossSection: proxied(C), keep };
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
    // A tampered handle is left alone (deleting it could free another object's memory), and the
    // worker is retired.
    if (!intactHandle(obj)) { trapped = true; continue; }
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
    if (e instanceof ScriptError || assetMissing(e)) throw e;
    throw new ScriptError({ message: (e as Error)?.message ?? String(e), stage: 'params', ...locate(e) });
  } finally {
    cleanup(rt);
  }
}

/** A font or mesh that the caller loads before running the script again. */
const assetMissing = (e: unknown) => e instanceof FontMissingError || e instanceof MeshMissingError;

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
// So are callouts, assembly steps and warnings: a loop that adds 2000 broken callouts must not
// turn one evaluation into 30k tokens.
const MAX_DIMENSIONS = 200;
const MAX_LABEL = 120;
const MAX_WARNINGS = 25;
function capWarnings(w: string[]): string[] {
  const out = [...new Set(w.map((s) => clip(s, 300)))];
  return out.length > MAX_WARNINGS ? [...out.slice(0, MAX_WARNINGS), `…and ${out.length - MAX_WARNINGS} more warnings`] : out;
}

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
  // A flat piece's sale size ("$faceScale"): only its face grows or shrinks. What a part carries
  // about itself (a LayerTone stack, a lithophane's or line art's source) follows `scale` only.
  const rawFace = Number(inputValues?.[FACE_SCALE_KEY]);
  const face = Number.isFinite(rawFace) && rawFace > 0 ? rawFace : 1;
  // A point or offset scaled with the model.
  const scaled = (v: number[]) => v.slice(0, 3).map((x, k) => x * scale * (k < 2 ? face : 1)) as Vec3;
  const logs: string[] = [];
  const warnings: string[] = [];
  applyQuality(rt.wasm, quality);
  takeFontSubstitutions();
  heapAtStart = heapSize();
  try {
    const meshes = parseMeshes(inputValues?.[MESHES_KEY]);
    // The coloured meshes the script used (H.mesh): their triangles keep their colours (paintOf).
    const painted: PaintedMesh[] = [];
    const userPrint = parseProfile(inputValues?.[PRINT_KEY]);
    const H = makeHelpers(rt, quality, parseDrawings(inputValues?.[DRAWINGS_KEY]), {
      images: parseLayerToneImages(inputValues?.[LAYERTONE_IMAGES_KEY]), setup: parseLayerToneSetup(inputValues?.[LAYERTONE_KEY]),
    }, meshes, painted, parseLineArtEdits(inputValues?.[LINEART_EDITS_KEY]), {
      split: parseLineArtSplit(inputValues?.[LINEART_SPLIT_KEY]),
      size: parseLineArtSize(inputValues?.[LINEART_SIZE_KEY]),
      join: parseLineArtJoin(inputValues?.[LINEART_JOIN_KEY]),
      ends: parseLineArtEnds(inputValues?.[LINEART_ENDS_KEY]),
      depth: parseLineArtDepth(inputValues?.[LINEART_DEPTH_KEY]),
      // Colours are cut to the print's layers: the user's layer heights (Print tab), else line art's.
      layers: { layerHeight: userPrint.layerHeight ?? lineArtPrint().layerHeight, firstLayerHeight: userPrint.firstLayerHeight ?? lineArtPrint().firstLayerHeight },
      layout: typeof inputValues?.[LINEART_LAYOUT_KEY] === 'string' ? inputValues[LINEART_LAYOUT_KEY] as string : undefined,
    });
    let scope;
    try {
      scope = compile(code)(rt.Manifold, rt.CrossSection, H, quality, makeConsole(logs));
    } catch (e) {
      // A font used at the top level (outside build) is loaded and the script run again.
      if (e instanceof ScriptError || assetMissing(e)) throw e;
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
      if (assetMissing(e)) throw e;
      throw new ScriptError({ message: (e as Error)?.message ?? String(e), stage: 'build', ...locate(e) });
    }
    if (out && typeof (out as any).then === 'function') throw new ScriptError({ message: 'build() must be synchronous (no async/await)', stage: 'output' });

    // Normalise output
    let rawParts: unknown[] = [];
    let rawDims: unknown[] = [];
    let rawAssembly: unknown[] = [];
    let rawPrint: unknown;
    let rawLoads: unknown[] = [];
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
      if (Array.isArray(o.loads)) rawLoads = o.loads;
    }
    if (out instanceof C) throw new ScriptError({ message: 'build() returned a 2D CrossSection – extrude or revolve it into a Manifold', stage: 'output' });
    if (!rawParts.length) throw new ScriptError({ message: 'build() must return a Manifold, an array of parts, or { parts: [...], dimensions: [...] }', stage: 'output' });

    const parts: PartMesh[] = [];
    const textFeatures = parseTextFeatures(inputValues?.[TEXT_KEY]);
    const partColors = parsePartColors(inputValues?.[PART_COLORS_KEY]);
    const svgFeatures = parseSvgFeatures(inputValues?.[SVG_KEY]);
    const partNames = rawParts.map((rp, i) => {
      const n = rp && typeof rp === 'object' && !(rp instanceof M) && typeof (rp as { name?: unknown }).name === 'string' ? (rp as { name: string }).name.slice(0, 120) : '';
      return n || (rawParts.length === 1 ? meta.name || 'Model' : `Part ${i + 1}`);
    });
    rawParts.forEach((rp, i) => {
      let shape: any, name = '', color = '';
      let layerColors: LayerColor[] | undefined, layerTone: LayerToneSource | undefined, lithophane: LithophaneSource | undefined, lineArt: LineArtInfo | undefined;
      let plate: number | undefined;
      if (rp instanceof M) shape = rp;
      else if (rp && typeof rp === 'object') {
        const o = rp as Record<string, unknown>;
        shape = o.shape ?? o.manifold;
        name = typeof o.name === 'string' ? o.name : '';
        color = typeof o.color === 'string' ? o.color : '';
        // A LayerTone part (H.layertone): its filament stack, scaled with the part.
        layerColors = cleanLayerColors(o.layerColors, scale);
        layerTone = layerColors && cleanLayerToneSource(o.layerTone, scale);
        // A lithophane part (H.lithophane): what it was made from, scaled with the part. A design is
        // one or the other.
        lithophane = layerColors ? undefined : cleanLithophaneSource(o.lithophane, scale);
        // A line-art part (H.lineart): its style, drawings and what was fixed, scaled with the part.
        lineArt = cleanLineArtInfo(o.lineArt, scale);
        // Its own build plate (a piece of a split model).
        if (Number.isInteger(o.plate) && (o.plate as number) >= 1 && (o.plate as number) <= 200) plate = o.plate as number;
      }
      if (!(shape instanceof M)) throw new ScriptError({ message: `Part ${i + 1} is not a Manifold (got ${shape instanceof C ? 'CrossSection' : typeof shape})`, stage: 'output' });
      if (scale !== 1) shape = shape.scale(scale);
      if (face !== 1) shape = shape.scale([face, face, 1]);
      name = partNames[i];
      const onThisPart = (f: { part?: string }) => (f.part && partNames.includes(f.part) ? f.part === name : i === 0);
      const mine = textFeatures.filter(onThisPart);
      const mySvgs = svgFeatures.filter(onThisPart);
      let textBase: Box3 | undefined;
      if (mine.length || mySvgs.length) {
        // The part without any text or SVG: picked points are relative to it.
        const tb = shape.boundingBox();
        textBase = { min: [tb.min[0], tb.min[1], tb.min[2]], max: [tb.max[0], tb.max[1], tb.max[2]] };
        try {
          if (mine.length) shape = applyTextFeatures(shape, mine, rt.CrossSection, tb);
        } catch (e) {
          if (e instanceof FontMissingError) throw e;
          warnings.push(`Text feature failed: ${(e as Error).message}`);
        }
        try {
          if (mySvgs.length) shape = applySvgFeatures(shape, mySvgs, rt.CrossSection, tb);
        } catch (e) {
          warnings.push(`SVG feature failed: ${(e as Error).message}`);
        }
      }
      // A filament the user picked for this part (Object tab) wins over the script's colour (kept
      // as scriptColor, so the app shows it at once when the pick is reset).
      const scriptColor = color || PALETTE[i % PALETTE.length];
      const picked = (!layerColors && !lithophane && partColors[name]?.color) || '';
      color = picked || scriptColor;
      const keepScript = picked && picked !== scriptColor.toLowerCase() ? { scriptColor } : {};
      const st = shape.status();
      if (st !== 'NoError') warnings.push(`Part "${name}" has status ${st}`);
      if (shape.isEmpty()) { warnings.push(`Part "${name}" is empty`); return; }
      if (opts.lite) {
        const bb = shape.boundingBox();
        parts.push({ name, color, positions: new Float32Array(0), indices: new Uint32Array(0), bbox: { min: [bb.min[0], bb.min[1], bb.min[2]], max: [bb.max[0], bb.max[1], bb.max[2]] }, textBase, volume: 0, surfaceArea: 0, triCount: 0, genus: 0, components: 1, ...(layerColors ? { layerColors } : {}), ...(layerTone ? { layerTone } : {}), ...(lithophane ? { lithophane } : {}), ...(lineArt ? { lineArt } : {}), ...(plate ? { plate } : {}), ...keepScript });
        return;
      }
      const mesh = shape.getMesh();
      const np = mesh.numProp;
      const vp = mesh.vertProperties;
      const nv = vp.length / np;
      const positions = new Float32Array(nv * 3);
      for (let v = 0; v < nv; v++) { positions[v * 3] = vp[v * np]; positions[v * 3 + 1] = vp[v * np + 1]; positions[v * 3 + 2] = vp[v * np + 2]; }
      const bb = shape.boundingBox();
      // A lithophane's thickness rides along as the mesh's fourth property (0 where other geometry
      // joined it), unscaled like every property.
      let litColors: Float32Array | undefined;
      if (lithophane && np >= 4) {
        const thickness = new Float32Array(nv);
        for (let v = 0; v < nv; v++) thickness[v] = vp[v * np + 3] * scale;
        litColors = lithoVertexColors(thickness, lithophane.options);
      }
      const paint = painted.length && !layerColors && !lithophane ? paintOf(mesh, painted, meshes, color) : undefined;
      parts.push({
        name, color, positions, indices: new Uint32Array(mesh.triVerts),
        bbox: { min: [bb.min[0], bb.min[1], bb.min[2]], max: [bb.max[0], bb.max[1], bb.max[2]] }, textBase,
        volume: shape.volume(), surfaceArea: shape.surfaceArea(), triCount: shape.numTri(), genus: shape.genus(),
        // A sealed cavity is a component with negative volume: it is not a separate piece.
        components: shape.decompose().filter((c: Manifold) => c.volume() > 0).length,
        ...(layerColors ? { layerColors, vertexColors: vertexColors(positions, layerColors) } : {}),
        ...(layerTone ? { layerTone } : {}),
        ...(lithophane ? { lithophane, ...(litColors ? { vertexColors: litColors } : {}) } : {}),
        ...(lineArt ? { lineArt } : {}),
        ...(plate ? { plate } : {}),
        ...keepScript,
        ...(paint ? { paint } : {}),
      });
    });

    const dimensions: DimensionAnnotation[] = [];
    for (const d of rawDims.slice(0, MAX_DIMENSIONS)) {
      if (!d || typeof d !== 'object') continue;
      const o = d as Record<string, unknown>;
      const label = typeof o.label === 'string' ? o.label.slice(0, MAX_LABEL) : undefined;
      if (!isVec3(o.from) || !isVec3(o.to)) { warnings.push(`Ignored dimension "${label ?? '?'}": from/to must be [x, y, z]`); continue; }
      dimensions.push({ label, from: scaled(o.from), to: scaled(o.to), offset: isVec3(o.offset) ? scaled(o.offset) : undefined, param: typeof o.param === 'string' && o.param in params ? o.param : undefined });
    }

    let bbox: Box3 | null = null;
    for (const p of parts) {
      if (!bbox) bbox = { min: [...p.bbox.min] as Vec3, max: [...p.bbox.max] as Vec3 };
      else for (let k = 0; k < 3; k++) { bbox.min[k] = Math.min(bbox.min[k], p.bbox.min[k]); bbox.max[k] = Math.max(bbox.max[k], p.bbox.max[k]); }
    }
    const names = new Set(parts.map((p) => p.name));
    const assembly: AssemblyStep[] = [];
    rawAssembly.slice(0, MAX_DIMENSIONS).forEach((st, i) => {
      if (!st || typeof st !== 'object') return;
      const o = st as Record<string, unknown>;
      const stepParts = (Array.isArray(o.parts) ? o.parts : typeof o.part === 'string' ? [o.part] : []).filter((n): n is string => typeof n === 'string');
      const unknown = stepParts.filter((n) => !names.has(n));
      if (unknown.length) warnings.push(`Assembly step ${i + 1}: unknown part(s) ${unknown.slice(0, 5).map((n) => `"${n.slice(0, MAX_LABEL)}"`).join(', ')}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ''}`);
      const known = stepParts.filter((n) => names.has(n));
      if (!known.length) return;
      const step: AssemblyStep = { label: typeof o.label === 'string' ? o.label.slice(0, MAX_LABEL) : `Step ${i + 1}`, parts: known };
      if (isVec3(o.from)) step.from = scaled(o.from);
      const rot = o.rotate as Record<string, unknown> | undefined;
      if (rot && isVec3(rot.axis) && Number.isFinite(rot.degrees)) {
        step.rotate = { axis: rot.axis.slice(0, 3) as Vec3, degrees: Number(rot.degrees), center: isVec3(rot.center) ? scaled(rot.center) : undefined };
      }
      assembly.push(step);
    });
    for (const f of takeFontSubstitutions()) warnings.push(`Font "${f.replace(/^(std|sys):/, '').replace('|', ' ')}" is not available – the text uses Roboto Bold instead`);
    // Loads (a held device): mass in grams stays, the position follows the model's scale.
    const loads: Load[] = [];
    rawLoads.forEach((l, i) => {
      const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
      if (typeof o.mass === 'number' && Number.isFinite(o.mass) && o.mass > 0 && isVec3(o.at)) {
        loads.push({ name: typeof o.name === 'string' && o.name ? o.name : 'load', mass: o.mass, at: scaled(o.at) });
      } else warnings.push(`loads[${i}] ignored: needs { name, mass (g), at: [x, y, z] }`);
    });
    const print = cleanProfile(rawPrint, parts.map((p) => p.name));
    return { meta, params, values, parts, dimensions, assembly, print, loads, bbox, timeMs: performance.now() - t0, warnings: capWarnings(warnings), logs, quality };
  } catch (e) {
    noteTrap(e);
    if (runtimeOutOfMemory()) {
      throw new ScriptError({ message: `Ran out of memory: building the model needed over ${(OUT_OF_MEMORY_BYTES / 2 ** 30).toFixed(0)} GB. Lower segment counts or resolution (sphere/cylinder segments, levelSet, refine, text detail).`, stage: 'build', ...locate(e) });
    }
    if (e instanceof ScriptError || assetMissing(e)) throw e;
    throw new ScriptError({ message: (e as Error)?.message ?? String(e), stage: 'build', ...locate(e) });
  } finally {
    cleanup(rt);
  }
}

/**
 * A part's colours per triangle: a triangle from a coloured mesh (its run's mesh ID is one H.mesh gave
 * out) prints with the filament of its colour (after the user's repaints), found through its faceID
 * (the triangle's index in the stored mesh), which `source` keeps for repainting by hand; the
 * script's own triangles in the part's colour. Undefined when no triangle came from one.
 */
function paintOf(mesh: { triVerts: Uint32Array; runIndex: Uint32Array; runOriginalID: Uint32Array; faceID: Uint32Array }, painted: PaintedMesh[], meshes: Record<string, MeshEntry>, partColor: string): PartMesh['paint'] {
  const nt = mesh.triVerts.length / 3;
  if (mesh.faceID?.length !== nt || !mesh.runOriginalID?.length) return undefined;
  const filaments: PaintFilament[] = [];
  const indexOf = (f: PaintFilament) => { let i = filaments.findIndex((g) => sameFilament(g, f)); if (i < 0) i = filaments.push(f) - 1; return i; };
  const tri = new Uint8Array(nt);
  const source: PaintSource = { meshes: [], mesh: new Uint8Array(nt).fill(255), face: new Uint32Array(nt).fill(0xffffffff) };
  const ownRuns: [number, number][] = [];
  for (let r = 0; r < mesh.runOriginalID.length; r++) {
    const from = mesh.runIndex[r] / 3, to = (r + 1 < mesh.runIndex.length ? mesh.runIndex[r + 1] : mesh.triVerts.length) / 3;
    if (to <= from) continue;
    const pm = painted.find((p) => p.id === mesh.runOriginalID[r]);
    const entry = pm && meshes[pm.name];
    const data = pm && entry?.palette ? getMeshData(pm.url) : undefined;
    if (!pm || !entry?.palette || !data?.colors) { ownRuns.push([from, to]); continue; }
    const slots = storedSlots(pm.url, { ...data, colors: data.colors }, entry.palette, entry.repaint);
    const map = entry.palette.map((c) => indexOf(c.filament));
    for (let t = from; t < to; t++) tri[t] = map[slots[mesh.faceID[t]] ?? 0] ?? 0;
    let m = source.meshes.indexOf(pm.name);
    if (m < 0) m = source.meshes.push(pm.name) - 1;
    source.mesh.fill(m, from, to);
    source.face.set(mesh.faceID.subarray(from, to), from);
  }
  if (!filaments.length) return undefined;
  if (ownRuns.length) {
    // The part's colour: one of the figure's filaments when it is that colour (a base in the figure's black).
    let own = filaments.findIndex((f) => f.color.toLowerCase() === partColor.toLowerCase());
    if (own < 0) own = filaments.push({ color: partColor.toLowerCase() }) - 1;
    for (const [from, to] of ownRuns) tri.fill(own, from, to);
  }
  return { filaments, tri, source };
}

/**
 * Reads a mesh file (STL, OBJ, GLB/glTF, 3MF) and makes it a printable solid: millimetres, Z up,
 * watertight, on the bed and centred (shared/meshRepair.ts). Throws on a file it can't read. With
 * opts.colors, `decode` reads the textures (shared/imageDecode.ts, kept out of the browser's bundle).
 */
export function importMeshFile(bytes: Uint8Array, filename: string, opts: ImportOptions = {}, decode?: (bytes: Uint8Array, mimeType: string) => Raster): { mesh: MeshData; report: ImportReport } {
  if (!runtime) throw new Error('runtime not initialised');
  const rt = runtime;
  heapAtStart = heapSize();
  try {
    return repairMesh(rt.wasm, parseMeshFile(bytes, filename, opts.colors && decode ? { colors: { decode } } : {}), opts);
  } catch (e) {
    noteTrap(e);
    if (runtimeOutOfMemory()) throw new Error('Ran out of memory importing the mesh: it is too big. Simplify it first (e.g. Blender\'s Decimate) or upload a smaller file.');
    throw e;
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
