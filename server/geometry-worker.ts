// Runs model scripts in a separate, locked-down Node process (started by server/geometry.ts with
// Node's permission model: no child processes, workers or file writes, file reads only inside
// node_modules, an empty environment; and no network, see closeNetwork below), so a slow or
// looping script can be killed and a script that ever got past the SES sandbox would still find
// nothing to reach.
import '../shared/sandbox'; // first: locks down the worker before anything else loads
import { setPrinter, type ActivePrinter } from '../shared/printer';
import dgram from 'node:dgram';
import dns from 'node:dns';
import inspector from 'node:inspector';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Module from 'manifold-3d';
import { initRuntime, evaluateScript, formatScriptError, importMeshFile, inspectScript, instantiateWith, runtimeOutOfMemory, runtimeTrapped } from '../shared/runtime';
import { renderIso, renderSheet, renderTop } from './render';
import { withFonts } from '../shared/text';
import { decodeMesh, encodeMesh, withMeshes, type MeshData } from '../shared/meshes';
import type { ImportOptions } from '../shared/meshRepair';
import { decodeTexture } from '../shared/imageDecode';
import { meshPalette, meshSlots, triangleAreas, type PaintFilament } from '../shared/meshColors';
import type { LayerToneFilament } from '../shared/layertone';
import { checkPose, footprint, meshCentroid, partMass, type MassPoint, type PoseCheck } from '../shared/stability';
import { effectiveSettings, parseProfile, PRINT_KEY, type PrintSettings } from '../shared/print';
import type { Box3, EvalResult, ParamValues, Quality } from '../shared/types';
import type { LayerColor } from '../shared/layertone';
import type { LithophaneSource } from '../shared/lithophane';
import type { LineArtInfo } from '../shared/lineart';

// Refuse to run model scripts without the process lock.
if (!process.permission || process.permission.has('child') || process.permission.has('fs.write')) {
  console.error('[geometry] refusing to start: the Node permission model is not active');
  process.exit(78);
}

/**
 * The permission model has no network switch before Node 25, so close the network here: an
 * escaped script could otherwise call Jig's own API (which trusts local requests) or send data
 * out. The low-level socket bindings are already refused by the permission model; this replaces
 * every public way to open a connection, listen, or resolve a name. IPC to the server is an
 * already-open channel and keeps working.
 */
function closeNetwork() {
  const refuse = () => { throw new Error('The geometry worker has no network access'); };
  const lock = (o: object, keys: string[]) => {
    for (const k of keys) if (k in o) Object.defineProperty(o, k, { value: refuse, writable: false, configurable: false });
  };
  lock(net.Socket.prototype, ['connect']);
  lock(net.Server.prototype, ['listen']);
  lock(dgram.Socket.prototype, ['bind', 'connect', 'send']);
  lock(net, ['connect', 'createConnection', 'createServer']);
  lock(dgram, ['createSocket']);
  lock(inspector, ['open']);
  for (const R of [dns.Resolver, dns.promises.Resolver]) lock(R.prototype, Object.getOwnPropertyNames(R.prototype).filter((k) => k !== 'constructor'));
  // Functions only, not the Resolver classes (their prototypes are locked above).
  for (const m of [dns, dns.promises]) lock(m, Object.keys(m).filter((k) => typeof (m as Record<string, unknown>)[k] === 'function' && !/^[A-Z]/.test(k)));
  for (const k of ['fetch', 'WebSocket', 'EventSource']) delete (globalThis as Record<string, unknown>)[k];
  // `import('node:dns')` hands out a namespace copied when the module was first imported; bring
  // it up to date with the locked functions.
  syncBuiltinESMExports();
}
closeNetwork();

const send = (msg: object) => process.send?.(msg);

// Fonts are read by the server (this process may not read them) and sent over IPC.
let fontSeq = 0;
const fontWaiters = new Map<number, { resolve: (b: ArrayBuffer[]) => void; reject: (e: Error) => void }>();
function requestFont(font: string): Promise<ArrayBuffer[]> {
  return new Promise((resolve, reject) => {
    const fontReq = ++fontSeq;
    fontWaiters.set(fontReq, { resolve, reject });
    send({ fontReq, font });
  });
}

// Meshes the same way: the server reads the design's mesh file and sends its bytes.
let meshSeq = 0;
const meshWaiters = new Map<number, { resolve: (m: MeshData) => void; reject: (e: Error) => void }>();
function requestMesh(url: string): Promise<MeshData> {
  return new Promise((resolve, reject) => {
    const meshReq = ++meshSeq;
    meshWaiters.set(meshReq, { resolve, reject });
    send({ meshReq, url });
  });
}
/** Runs fn with every font and mesh it needs loaded. */
const withAssets = <T>(fn: () => T): Promise<T> => withMeshes(() => withFonts(fn, requestFont), requestMesh);

let startFailed!: (e: unknown) => void;
const ready = Promise.race([
  // instantiateWasm is an emscripten Module option that manifold-3d's types leave out.
  Module({
    instantiateWasm: instantiateWith(
      async (imports) => WebAssembly.instantiate(await readFile(fileURLToPath(import.meta.resolve('manifold-3d/manifold.wasm'))), imports),
      (e) => startFailed(e),
    ),
  } as unknown as Parameters<typeof Module>[0]),
  new Promise<never>((_, reject) => { startFailed = reject; }),
]).then((wasm) => initRuntime(wasm));

export interface EvalSummary {
  ok: true;
  meta: EvalResult['meta'];
  params: EvalResult['params'];
  values: ParamValues;
  bbox: EvalResult['bbox'];
  timeMs: number;
  warnings: string[];
  logs: string[];
  dimensions: EvalResult['dimensions'];
  assembly: EvalResult['assembly'];
  print: EvalResult['print'];
  parts: { name: string; color: string; bbox: Box3; volume: number; surfaceArea: number; triCount: number; genus: number; components: number; layerColors?: LayerColor[]; lithophane?: LithophaneSource; lineArt?: LineArtInfo; paint?: PaintSummary }[];
}
/** A part coloured per triangle: its filaments and each one's share of the part's surface. */
export interface PaintSummary { filaments: PaintFilament[]; share: number[] }

function paintSummary(p: EvalResult['parts'][number]): PaintSummary | undefined {
  if (!p.paint) return undefined;
  const areas = triangleAreas(p.positions, p.indices);
  const sums = p.paint.filaments.map(() => 0);
  let total = 0;
  areas.forEach((a, t) => { sums[p.paint!.tri[t]] += a; total += a; });
  return { filaments: p.paint.filaments, share: sums.map((x) => (total ? +(x / total).toFixed(3) : 0)) };
}
export interface EvalFailure { ok: false; error: ReturnType<typeof formatScriptError> }

function summarize(r: EvalResult): EvalSummary {
  return {
    ok: true, meta: r.meta, params: r.params, values: r.values, bbox: r.bbox, timeMs: r.timeMs,
    warnings: r.warnings, logs: r.logs, dimensions: r.dimensions, assembly: r.assembly, print: r.print,
    parts: r.parts.map((p) => {
      const { name, color, bbox, volume, surfaceArea, triCount, genus, components, layerColors, lithophane, lineArt } = p;
      const paint = paintSummary(p);
      return { name, color, bbox, volume, surfaceArea, triCount, genus, components, ...(layerColors ? { layerColors } : {}), ...(lithophane ? { lithophane } : {}), ...(lineArt ? { lineArt } : {}), ...(paint ? { paint } : {}) };
    }),
  };
}

async function run(code: string, values: ParamValues | undefined, quality: Quality): Promise<{ result?: EvalResult; out: EvalSummary | EvalFailure }> {
  try {
    const result = await withAssets(() => evaluateScript(code, values, quality));
    return { result, out: summarize(result) };
  } catch (e) {
    return { out: { ok: false, error: formatScriptError(e) } };
  }
}

/** Every job carries the server's chosen printer (its bed decides how line art splits, what fits). */
type Req = { printer?: ActivePrinter } & (
  | { id: number; cmd: 'evaluate'; code: string; values?: ParamValues; quality?: Quality }
  | { id: number; cmd: 'render'; code: string; values?: ParamValues }
  | { id: number; cmd: 'stress'; code: string; budgetMs?: number; extra?: ParamValues }
  | { id: number; cmd: 'stability'; code: string; extra: ParamValues; poses: { label: string; values: ParamValues }[]; printBase: Required<PrintSettings>; nozzle: number; upright?: [number, number, number] }
  | { id: number; cmd: 'iso'; code: string; values?: ParamValues }
  | { id: number; cmd: 'importMesh'; bytes: Uint8Array; filename: string; options?: ImportOptions; palette?: { colors: number; mine: LayerToneFilament[] } });

type FontReply = { fontReply: number; buffers?: ArrayBuffer[]; error?: string };
type MeshReply = { meshReply: number; bytes?: Uint8Array; error?: string; transient?: boolean };

// `crashed` tells the parent the wasm instance trapped, so it replaces this worker and retries
// (not after running out of memory, `oom`, which a retry would only repeat).
process.on('message', async (req: Req | FontReply | MeshReply) => {
  if ('fontReply' in req) {
    const w = fontWaiters.get(req.fontReply);
    fontWaiters.delete(req.fontReply);
    if (req.buffers) w?.resolve(req.buffers); else w?.reject(new Error(req.error ?? 'font failed to load'));
    return;
  }
  if ('meshReply' in req) {
    const w = meshWaiters.get(req.meshReply);
    meshWaiters.delete(req.meshReply);
    try {
      if (!req.bytes) throw Object.assign(new Error(req.error ?? 'mesh failed to load'), { transient: req.transient });
      w?.resolve(decodeMesh(new Uint8Array(req.bytes)));
    } catch (e) { w?.reject(e as Error); }
    return;
  }
  if (req.printer) setPrinter(req.printer);
  const post = (msg: { data?: unknown; error?: string; crashed?: boolean }) => send({ id: req.id, crashed: runtimeTrapped(), oom: runtimeOutOfMemory(), ...msg });
  try {
    await ready;
  } catch (e) {
    post({ error: `The geometry engine failed to start: ${(e as Error)?.message ?? e}`, crashed: true });
    return;
  }
  try {
    if (req.cmd === 'evaluate') {
      post({ data: (await run(req.code, req.values, req.quality ?? 'normal')).out });
    } else if (req.cmd === 'render') {
      const { result, out } = await run(req.code, req.values, 'normal');
      let png: Buffer | undefined, gridStep: number | undefined;
      if (result && result.parts.length) ({ png, gridStep } = renderSheet(result.parts));
      // Line art: also the piece straight on and large, where merged lines show.
      const lineArt = result?.parts.filter((p) => p.lineArt);
      const top = lineArt?.length ? renderTop(lineArt).png.toString('base64') : undefined;
      post({ data: { ...out, png: png?.toString('base64'), gridStep, ...(top ? { top } : {}) } });
    } else if (req.cmd === 'iso') {
      const { result, out } = await run(req.code, req.values, 'normal');
      const png = result && result.parts.length ? renderIso(result.parts).png.toString('base64') : undefined;
      post({ data: { ...out, png } });
    } else if (req.cmd === 'importMesh') {
      // The file is untrusted: parsed and repaired here, in the locked-down process.
      const { mesh, report } = importMeshFile(new Uint8Array(req.bytes), req.filename, req.options, decodeTexture);
      // A coloured mesh: its colours (at most palette.colors) and their filaments; the picture shows them.
      const palette = mesh.colors && req.palette ? meshPalette({ ...mesh, colors: mesh.colors }, req.palette.colors, req.palette.mine) : undefined;
      const part = { name: 'Mesh', color: '#b0b7c3', positions: mesh.positions, indices: mesh.indices, bbox: { min: [-report.size[0] / 2, -report.size[1] / 2, 0], max: [report.size[0] / 2, report.size[1] / 2, report.size[2]] }, volume: report.volume, surfaceArea: 0, triCount: report.triangles, genus: 0, components: report.components } as EvalResult['parts'][number];
      if (palette && mesh.colors) part.paint = { filaments: palette.map((c) => c.filament), tri: meshSlots({ ...mesh, colors: mesh.colors }, palette.map((c) => c.color)) };
      const { png, gridStep } = renderSheet([part]);
      post({ data: { bin: encodeMesh(mesh), report, png: png.toString('base64'), gridStep, ...(palette ? { palette } : {}) } });
    } else if (req.cmd === 'stress') {
      post({ data: await stress(req.code, req.budgetMs ?? 20000, req.extra) });
    } else if (req.cmd === 'stability') {
      post({ data: await stability(req) });
    }
  } catch (e) {
    post({ error: (e as Error).message });
  }
});

/** Evaluate the script across parameter extremes so sliders never break the model. */
async function stress(code: string, budgetMs: number, extra: ParamValues = {}) {
  const t0 = performance.now();
  let params;
  try {
    params = (await withAssets(() => inspectScript(code))).params;
  } catch (e) {
    return { failures: [{ case: 'defaults', error: formatScriptError(e).message }], tested: 0, skipped: 0 };
  }
  const cases: { label: string; values: ParamValues }[] = [];
  const defaults: ParamValues = Object.fromEntries(Object.entries(params).map(([k, d]) => [k, d.value]));
  const numeric = Object.entries(params).filter(([, d]) => d.type === 'number' || d.type === 'integer');
  cases.push({ label: 'all at min', values: { ...defaults, ...Object.fromEntries(numeric.map(([k, d]) => [k, (d as { min: number }).min])) } });
  cases.push({ label: 'all at max', values: { ...defaults, ...Object.fromEntries(numeric.map(([k, d]) => [k, (d as { max: number }).max])) } });
  for (const [k, d] of Object.entries(params)) {
    if (d.type === 'number' || d.type === 'integer') {
      cases.push({ label: `${k}=${d.min}`, values: { ...defaults, [k]: d.min } });
      cases.push({ label: `${k}=${d.max}`, values: { ...defaults, [k]: d.max } });
    } else if (d.type === 'boolean') {
      cases.push({ label: `${k}=${!d.value}`, values: { ...defaults, [k]: !d.value } });
    } else if (d.type === 'select') {
      for (const o of d.options.slice(0, 6)) if (o.value !== d.value) cases.push({ label: `${k}="${o.value}"`, values: { ...defaults, [k]: o.value } });
    }
  }
  const failures: { case: string; error: string }[] = [];
  let tested = 0;
  for (const c of cases) {
    if (performance.now() - t0 > budgetMs || runtimeTrapped()) break;
    tested++;
    const { out } = await run(code, { ...extra, ...c.values }, 'draft');
    if (!out.ok) failures.push({ case: c.label, error: `${out.error.message}${out.error.line ? ` (line ${out.error.line})` : ''}` });
    else if (!out.parts.length) failures.push({ case: c.label, error: 'produced no geometry (all parts empty)' });
  }
  return { failures, tested, skipped: cases.length - tested };
}

/** Rotate v by XYZ Euler angles in degrees about the origin (X first, then Y, then Z, about the fixed axes, as Manifold does). Rotating [0, -90, 0] stands a bar lying along +X up along +Z. */
function rotate(v: [number, number, number], deg: [number, number, number]): [number, number, number] {
  let [x, y, z] = v;
  const [a, b, c] = deg.map((d) => d * Math.PI / 180);
  [y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
  [x, z] = [x * Math.cos(b) + z * Math.sin(b), -x * Math.sin(b) + z * Math.cos(b)];
  [x, y] = [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c)];
  return [x, y, z];
}

/** Does each pose stay standing? Parts are weighed as printed, loads added, the base is what touches the bed. */
async function stability(req: Extract<Req, { cmd: 'stability' }>) {
  const user = parseProfile(req.extra?.[PRINT_KEY]);
  const poses: PoseCheck[] = [];
  const loadNames = new Map<string, number>();
  const failed = (label: string, error: string): PoseCheck => ({ pose: label, ok: false, mass: 0, com: [0, 0, 0], edgeMm: 0, tiltDeg: 0, error });
  for (const pose of req.poses) {
    const { result, out } = await run(req.code, { ...req.extra, ...pose.values }, 'draft');
    if (!result) {
      const e = out.ok ? undefined : out.error;
      poses.push(failed(pose.label, e ? `${e.message}${e.line ? ` (line ${e.line})` : ''}` : 'the script failed'));
      continue;
    }
    // A misnamed or mistyped value would be dropped and the defaults checked instead: say so.
    const wrong = poseProblem(pose.values, result.params);
    if (wrong) { poses.push(failed(pose.label, wrong)); continue; }
    // Copies: the result's arrays are not ours to change. Rotated (if asked), then dropped so the lowest vertex is at z = 0.
    // A part with no triangles or no volume has no vertices to stand on and no mass, so it is left out of both.
    const turn = (v: [number, number, number]) => (req.upright ? rotate(v, req.upright) : v);
    const solid = result.parts.filter((p) => p.indices.length && p.volume > 0);
    const moved = solid.map((p) => {
      const pos = new Float32Array(p.positions.length);
      for (let i = 0; i < pos.length; i += 3) pos.set(turn([p.positions[i], p.positions[i + 1], p.positions[i + 2]]), i);
      return { part: p, positions: pos };
    });
    const loads = result.loads.map((l) => ({ ...l, at: turn(l.at) }));
    let low = Infinity;
    for (const { positions } of moved) for (let i = 2; i < positions.length; i += 3) low = Math.min(low, positions[i]);
    if (!Number.isFinite(low)) low = 0;
    for (const { positions } of moved) for (let i = 2; i < positions.length; i += 3) positions[i] -= low;
    for (const l of loads) { l.at = [l.at[0], l.at[1], l.at[2] - low]; if (!loadNames.has(l.name)) loadNames.set(l.name, l.mass); }
    const points: MassPoint[] = moved.map(({ part, positions }) => ({
      name: part.name,
      mass: partMass(part.volume, part.surfaceArea, effectiveSettings(result.print, user, part.name, req.printBase), req.nozzle),
      at: meshCentroid(positions, part.indices),
    }));
    poses.push(checkPose(pose.label, [...points, ...loads], footprint(moved)));
  }
  return { poses, loads: [...loadNames].map(([name, mass]) => `${name} (${+mass.toFixed(1)} g)`) };
}

/** Why a pose's values don't fit the script's parameters (a name it doesn't have, a value of the wrong type), or undefined. */
function poseProblem(values: ParamValues, params: EvalResult['params']): string | undefined {
  for (const [k, v] of Object.entries(values)) {
    if (k.startsWith('$')) continue;
    const d = params[k];
    if (!d) return `unknown parameter "${k}" (parameters: ${Object.keys(params).join(', ') || 'none'})`;
    if ((d.type === 'number' || d.type === 'integer') && !(typeof v === 'number' && Number.isFinite(v))) return `parameter "${k}" needs a number`;
    if (d.type === 'boolean' && typeof v !== 'boolean') return `parameter "${k}" needs true or false`;
    if ((d.type === 'select' || d.type === 'text') && typeof v !== 'string') return `parameter "${k}" needs text`;
    if (d.type === 'select' && !d.options.some((o) => o.value === v)) return `parameter "${k}" has no option "${v}" (options: ${d.options.map((o) => o.value).join(', ')})`;
  }
  return undefined;
}
