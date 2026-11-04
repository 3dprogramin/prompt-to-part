import { modelWarnings } from '../shared/modelWarnings';
import { filamentLabel, type MeshColor } from '../shared/meshColors';
import type { LayerToneFilament } from '../shared/layertone';
import { printer } from '../shared/printer';
import { LINE_ART_STYLE_INFO, type LineArtInfo } from '../shared/lineart';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { ROOT } from './config';
import { loadFontBuffers } from './fonts';
import { readMeshFile } from './meshes';
import type { ImportOptions, ImportReport } from '../shared/meshRepair';
import type { PrintSettings } from '../shared/print';
import type { PoseCheck } from '../shared/stability';
import type { ParamValues, Quality } from '../shared/types';
import type { EvalFailure, EvalSummary } from './geometry-worker';

type Worker = ChildProcess;
let worker: Worker | null = null;
let jobsOnWorker = 0;
let seq = 0;
interface Reply { data?: unknown; error?: string; crashed?: boolean; oom?: boolean }
const pending = new Map<number, { worker: Worker; resolve: (r: Reply) => void }>();

/** A fresh worker every this many jobs, so a slow leak in the wasm heap can never build up. */
const RECYCLE_AFTER = 300;

// The real path: the permission model checks resolved paths, so a symlinked node_modules (a git
// worktree sharing another checkout's) would otherwise be unreadable to the workers.
export const NODE_MODULES = realpathSync(path.join(ROOT, 'node_modules'));
const CACHE = path.join(NODE_MODULES, '.cache', 'prompt-to-part');
const major = Number(process.versions.node.split('.')[0]);
// The flag lost its "experimental" prefix in Node 22.13 and 23.5.
export const PERMISSION_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';

/**
 * Model scripts are evaluated in their own Node process under the permission model: it may read
 * only node_modules (where its bundled code lives), may not write files, start processes or
 * threads, and gets no environment variables. The worker is bundled to plain JS first because
 * tsx's loader needs a thread, which the permission model forbids.
 */
function spawnWorker(): Worker {
  return fork(bundleWorker('geometry-worker'), [], {
    execArgv: [PERMISSION_FLAG, '--disable-warning=ExperimentalWarning', `--allow-fs-read=${NODE_MODULES}`, '--max-old-space-size=2048'],
    env: {},
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}

const bundles = new Map<string, string>();

/**
 * A worker (server/<name>.ts) bundled once per server process, so a respawned worker always
 * matches the code this server runs (not files edited since). The file is named after its content
 * and written atomically, so two servers in the same folder never read each other's half-written bundle.
 */
export function bundleWorker(name: string): string {
  const done = bundles.get(name);
  if (done) return done;
  const out = buildSync({
    entryPoints: [path.join(ROOT, 'server', `${name}.ts`)],
    bundle: true, platform: 'node', format: 'esm', packages: 'external', target: `node${major}`,
    outfile: path.join(CACHE, `${name}.mjs`), write: false, logLevel: 'warning',
  });
  const code = out.outputFiles[0].contents;
  const file = path.join(CACHE, `${name}-${createHash('sha256').update(code).digest('hex').slice(0, 16)}.mjs`);
  if (!existsSync(file)) {
    mkdirSync(CACHE, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, code);
    renameSync(tmp, file);
  }
  bundles.set(name, file);
  return file;
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = spawnWorker();
  // The worker dying mid-job (uncaught error, abort) counts as a crash, so the job is retried,
  // unless it ran out of memory (`oom`), which a retry would only repeat.
  const crashAll = (error: string, oom = false) => {
    for (const [id, p] of pending) if (p.worker === w) { pending.delete(id); p.resolve({ error, crashed: true, oom }); }
  };
  w.on('message', (msg: Reply & { id: number } | { fontReq: number; font: string } | { meshReq: number; url: string }) => {
    if ('fontReq' in msg) {
      loadFontBuffers(msg.font).then(
        (buffers) => w.connected && w.send({ fontReply: msg.fontReq, buffers }),
        (e: Error) => w.connected && w.send({ fontReply: msg.fontReq, error: e.message }),
      );
      return;
    }
    // A design's mesh file (H.mesh): read here, as the worker may only read node_modules.
    if ('meshReq' in msg) {
      readMeshFile(String(msg.url)).then(
        (bytes) => w.connected && w.send({ meshReply: msg.meshReq, bytes }),
        (e: NodeJS.ErrnoException) => w.connected && w.send({ meshReply: msg.meshReq, error: e.code === 'ENOENT' ? 'the file is missing' : e.message, transient: e.code !== 'ENOENT' && !/not a mesh/i.test(e.message) }),
      );
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    p.resolve(msg);
  });
  w.on('error', (e: Error) => { if (worker === w) worker = null; crashAll(e.message); });
  w.on('exit', (code, signal) => {
    if (worker === w) worker = null;
    if (diedOfOom(code, signal)) crashAll('The script ran out of memory (more than 2 GB): build less at once (fewer segments, smaller loops, no huge arrays).', true);
    else crashAll(`Geometry worker exited (${signal ?? `code ${code}`})`);
  });
  worker = w;
  jobsOnWorker = 0;
  return w;
}

/**
 * How a worker that ran out of JavaScript heap ends: V8 prints "JavaScript heap out of memory" and
 * aborts the process (SIGABRT; exit code 134 where no signal is reported).
 */
export function diedOfOom(code: number | null, signal: NodeJS.Signals | null): boolean {
  return signal === 'SIGABRT' || code === 134;
}

/** The error for a job whose generation was stopped. */
export const stoppedError = () => Object.assign(new Error('Stopped.'), { name: 'AbortError' });

/** `p`, or a rejection (stoppedError) as soon as `signal` aborts. */
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(stoppedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(stoppedError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function dropWorker(w: Worker) {
  if (worker === w) worker = null;
  w.kill();
}

/**
 * Runs one job on `w`. Running out of time, or `signal` aborting (the generation was stopped),
 * kills the worker: the job is the only one on it, and the next job starts a fresh one.
 */
function attempt(w: Worker, msg: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const give = (e: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pending.delete(id);
      dropWorker(w);
      reject(e);
    };
    const onAbort = () => give(stoppedError());
    const timer = setTimeout(() => give(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s: the script is too slow (or loops forever). Reduce segment counts, avoid huge loops/minkowski/levelSet.`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, { worker: w, resolve: (r) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(r); } });
    w.send({ ...msg, id, printer: printer() });
  });
}

// Serialise jobs: one at a time keeps timeouts meaningful.
let chain: Promise<unknown> = Promise.resolve();

/**
 * Queues a job. With `signal` (the generation's), a stop drops the job while it waits (its turn
 * passes at once) and kills the worker while it runs; the caller hears of it straight away.
 */
function call<T>(msg: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(stoppedError());
  const job = chain.then(async () => {
    for (let retried = false; ; retried = true) {
      if (signal?.aborted) throw stoppedError();
      const w = getWorker();
      const r = await attempt(w, msg, timeoutMs, signal);
      if (r.crashed) {
        // A wasm trap leaves the heap unusable: replace the worker and run the job once more
        // (not after running out of memory, which would only happen again).
        dropWorker(w);
        if (!retried && !r.oom) {
          const reason = r.error ?? (r.data as EvalFailure | undefined)?.error?.message ?? 'wasm trap';
          console.warn(`[geometry] worker crashed during ${String(msg.cmd)} (${reason}); restarting it and retrying`);
          continue;
        }
      } else if (++jobsOnWorker >= RECYCLE_AFTER) dropWorker(w);
      if (r.error) throw new Error(r.error);
      return r.data as T;
    }
  });
  chain = job.catch(() => undefined);
  return abortable(job, signal);
}

export interface ImportedMesh {
  bin: Uint8Array; report: ImportReport; png: string; gridStep: number;
  /** A coloured mesh's colours and their filaments (importMesh with `palette`). */
  palette?: MeshColor[];
}

/** `top`: line art only – the piece seen straight on, large. */
export type RenderResult = (EvalSummary | EvalFailure) & { png?: string; gridStep?: number; top?: string };
export interface StressResult { failures: { case: string; error: string }[]; tested: number; skipped: number }

export interface StabilityPose { label: string; values: ParamValues }
export interface StabilityRequest { code: string; extra: ParamValues; poses: StabilityPose[]; printBase: Required<PrintSettings>; nozzle: number; upright?: [number, number, number] }
export interface StabilityResult { poses: PoseCheck[]; loads: string[] }

/** Each job takes an optional `signal` (a generation's abort signal): see call(). */
export const geometry = {
  evaluate: (code: string, values?: ParamValues, quality: Quality = 'normal', signal?: AbortSignal) =>
    call<EvalSummary | EvalFailure>({ cmd: 'evaluate', code, values, quality }, 30000, signal),
  render: (code: string, values?: ParamValues, signal?: AbortSignal) => call<RenderResult>({ cmd: 'render', code, values }, 45000, signal),
  /** `extra`: values every case starts from (attached drawings). */
  stress: (code: string, extra?: ParamValues, signal?: AbortSignal) => call<StressResult>({ cmd: 'stress', code, budgetMs: 20000, extra }, 40000, signal),
  /** Does the design stay standing in each pose (parameter values), with its declared loads? */
  stability: (req: StabilityRequest, signal?: AbortSignal) => call<StabilityResult>({ cmd: 'stability', ...req }, 40000, signal),
  /** One large iso picture (used for assembled / exploded views). */
  iso: (code: string, values?: ParamValues, signal?: AbortSignal) => call<RenderResult>({ cmd: 'iso', code, values }, 45000, signal),
  /** Parse, repair and normalise an uploaded mesh file in the locked-down worker (a stored .bin, a report and a four-view render). */
  /** With options.colors and `palette`: its colours, at most palette.colors, each with the closest filament (the user's own, `mine`, first). */
  importMesh: (bytes: Uint8Array, filename: string, options?: ImportOptions, palette?: { colors: number; mine: LayerToneFilament[] }, signal?: AbortSignal) => call<ImportedMesh>({ cmd: 'importMesh', bytes, filename, options, palette }, 120000, signal),
  warmup: () => { getWorker(); },
  /** Stop the worker process (tests: it would keep the event loop alive). */
  stop: () => { if (worker) dropWorker(worker); },
};

const f = (n: number, d = 2) => (Math.abs(n) < 1e-9 ? 0 : n).toFixed(d);
// Each report is a tool result in Claude's context.
const MAX_REPORT = 20000;

/** Human/AI readable report of an evaluation. */
export function formatReport(r: EvalSummary | EvalFailure): string {
  if (!r.ok) {
    const e = r.error;
    return `ERROR (${e.stage}${e.line ? `, model.js line ${e.line}${e.column ? `:${e.column}` : ''}` : ''}): ${e.message}`;
  }
  const lines: string[] = [];
  lines.push(`OK – evaluated in ${Math.round(r.timeMs)} ms at "normal" quality.`);
  if (r.meta.name) lines.push(`Name: ${r.meta.name}`);
  const pv = Object.entries(r.values).map(([k, v]) => {
    const d = r.params[k];
    return `${k}=${typeof v === 'number' ? +v.toFixed(4) : JSON.stringify(v)}${d && 'unit' in d && d.unit ? d.unit : ''}`;
  });
  lines.push(`Parameters (${pv.length}): ${pv.join(', ') || 'none'}`);
  if (r.bbox) {
    const { min, max } = r.bbox;
    lines.push(`Overall bounding box: X[${f(min[0])}, ${f(max[0])}] Y[${f(min[1])}, ${f(max[1])}] Z[${f(min[2])}, ${f(max[2])}] → ${f(max[0] - min[0])} × ${f(max[1] - min[1])} × ${f(max[2] - min[2])} mm (W×D×H)`);
  }
  lines.push('Parts:');
  for (const p of r.parts) {
    const b = p.bbox;
    lines.push(`  - "${p.name}": ${f(b.max[0] - b.min[0])} × ${f(b.max[1] - b.min[1])} × ${f(b.max[2] - b.min[2])} mm, Z[${f(b.min[2])}, ${f(b.max[2])}], volume ${f(p.volume / 1000, 3)} cm³, ${p.triCount} triangles, ${p.components} connected piece(s), genus ${p.genus}`);
    if (p.layerColors?.length) {
      lines.push(`    LayerTone stack, bottom → top: ${p.layerColors.map((l, i) => `${l.brand ? `${l.brand} ` : ''}${l.name ?? l.color} (${l.color}, TD ${l.td}) ${i ? `from layer ${l.layer} (z ${f(l.z)} mm)` : 'from the bed'}`).join('; ')}`);
    }
    if (p.paint) {
      lines.push(`    Coloured (its coloured mesh's filaments, painted on the triangles; the script's own geometry in the part's colour): ${p.paint.filaments.map((x, i) => `${filamentLabel(x)} ${x.color} ${Math.round(p.paint!.share[i] * 100)} %`).join('; ')}`);
    }
    if (p.lithophane) {
      const o = p.lithophane.options;
      const form = o.shape === 'cylinder' ? `a cylinder ${f(o.width / Math.PI, 1)} mm across` : o.shape === 'curved' ? `curved over ${f(o.angle, 0)}°` : o.upright ? 'flat, standing up' : 'flat, lying down';
      lines.push(`    Lithophane of picture "${p.lithophane.image}": ${f(o.width, 1)} mm wide, ${form}, ${f(o.minThickness, 2)}–${f(o.maxThickness, 2)} mm thick (bright → dark)${o.border ? `, ${f(o.border, 1)} mm frame` : ''}${o.stand ? `, foot ${f(o.stand, 1)} mm deep, ${f(o.standHeight, 1)} mm high` : ''}${o.invert ? ', inverted' : ''}${o.gamma !== 1 ? `, gamma ${f(o.gamma, 2)}` : ''}`);
    }
    if (p.lineArt) lines.push(`    ${lineArtLine(p.lineArt)}`);
  }
  if (r.dimensions.length) {
    lines.push('Dimension callouts:');
    for (const d of r.dimensions) lines.push(`  - ${d.label ?? '(unlabelled)'}: ${f(Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]))} mm`);
  }
  if (r.assembly.length) {
    lines.push('Assembly sequence:');
    r.assembly.forEach((st, i) => lines.push(`  ${i + 1}. ${st.label} – ${st.parts.join(', ')}${st.from ? ` from offset [${st.from.map((x) => f(x, 1)).join(', ')}]` : ' (offset from exploded layout)'}${st.rotate ? `, turning ${st.rotate.degrees}° about [${st.rotate.axis.join(', ')}]` : ''}`));
  }
  const { parts: partPrint, ...globalPrint } = r.print;
  if (Object.keys(globalPrint).length || partPrint) {
    lines.push(`Print settings (differences from ${printer().presets?.process ?? 'the default profile'}, PLA): ${JSON.stringify(globalPrint)}${partPrint ? ` · per part: ${JSON.stringify(partPrint)}` : ''}`);
  }
  const warn = modelWarnings(r);
  const tris = r.parts.reduce((s, p) => s + p.triCount, 0);
  if (tris > 1_500_000) warn.push(`Very high triangle count (${tris}); reduce segments for responsive sliders`);
  if (r.timeMs > 1500) warn.push(`Slow evaluation (${Math.round(r.timeMs)} ms) – sliders will feel laggy; simplify or lower segment counts`);
  if (warn.length) { lines.push('Warnings:'); for (const w of warn) lines.push(`  - ${w}`); }
  if (r.logs.length) { lines.push('console output:'); for (const l of r.logs.slice(0, 40)) lines.push(`  ${l}`); }
  const report = lines.join('\n');
  return report.length > MAX_REPORT ? `${report.slice(0, MAX_REPORT)}\n… report cut at ${MAX_REPORT} characters` : report;
}

/** A line-art part in one line: style, drawings, size, lines, what the app fixed and the key holder's pegs; split, the pieces (on the first). */
export function lineArtLine(a: LineArtInfo): string {
  const g = (n: number) => String(+n.toFixed(1));
  if (a.paintedIn) return `Lines of the line art the user coloured ${a.paintedIn.name ?? a.paintedIn.color} (${a.paintedIn.color}) in Edit drawing: printed in that filament, as one piece with the rest`;
  if (a.piece && !a.split) return `Piece ${a.piece.label} of the split line art (see the first piece for the split)`;
  const fixed = `${a.bridges ? `${a.bridges} bridge${a.bridges > 1 ? 's' : ''} added (longest ${g(a.longestBridge)} mm)` : 'no bridges needed'}, ${a.dropped ? `${a.dropped} speck${a.dropped > 1 ? 's' : ''} dropped` : 'no specks dropped'}`;
  // Openings that closed: lines drawn closer together than the print can keep apart.
  const ends = a.endsJoined || a.endsFree ? `; ${a.endsJoined ? `${a.endsJoined} loose line${a.endsJoined > 1 ? 's' : ''} joined to a nearby line` : 'no loose lines joined'}${a.endsFree ? `, ${a.endsFree} still loose (held at one point only, ${a.joinEnds === 0 ? 'joining loose ends is off' : 'nothing within reach to join'}: they can lift off the wall)` : ''}` : '';
  const loose = a.fillsLoose ? `; ${a.fillsLoose} bit${a.fillsLoose > 1 ? 's' : ''} the user filled in Edit drawing left out (touching nothing of the piece, they would fall off)` : '';
  const lost = a.closed ? `; ${a.closed} of ${a.openings} openings between lines closed up (${Math.round((100 * a.closed) / Math.max(1, a.openings))} %: detail lost – the drawing is too fine for this size)` : '';
  const line = `Line art (${LINE_ART_STYLE_INFO[a.style].label.toLowerCase()}) from ${a.sources.map((s) => `"${s}"`).join(' + ') || 'a drawing'}: ${g(a.size[0])} × ${g(a.size[1])} mm, ${g(a.thickness)} mm thick, ${a.lines === 'keep' ? `lines at least ${g(a.lineWidth)} mm (the drawing's own weights)` : `${g(a.lineWidth)} mm lines (even)`}; ${fixed}${ends}${lost}${loose}${a.hooks ? `; ${a.hooks} peg${a.hooks > 1 ? 's' : ''}` : ''}${a.colours?.length ? `; the user coloured lines in ${a.colours.map((c) => `${c.name ?? c.color} (${c.color})`).join(', ')} in Edit drawing (parts of their own, named after the piece and the filament)` : ''}`;
  return a.split ? `${line}${splitLines(a.split, g)}` : line;
}

/** A split line art: the grid, each piece (size, what the app fixed on it alone, dovetails, its name), the seams and joints. */
function splitLines(sp: NonNullable<LineArtInfo['split']>, g: (n: number) => string): string {
  const bed = printer().bed[0];
  const pieces = sp.pieces.map((p) => {
    const fixed = [p.bridges ? `${p.bridges} bridge${p.bridges > 1 ? 's' : ''} (longest ${g(p.longestBridge)} mm)` : '', p.dropped ? `${p.dropped} speck${p.dropped > 1 ? 's' : ''} dropped` : '', p.endsJoined ? `${p.endsJoined} loose line${p.endsJoined > 1 ? 's' : ''} joined` : '', p.endsFree ? `${p.endsFree} still loose` : ''].filter(Boolean).join(', ');
    return `\n      ${p.label}: ${g(p.size[0])} × ${g(p.size[1])} mm${p.size[0] > bed || p.size[1] > bed ? ` – BIGGER THAN THE ${bed} mm BED` : ''}${fixed ? `; ${fixed}` : ''}${p.joints ? `; ${p.joints} dovetail${p.joints > 1 ? 's' : ''}` : ''}; ${p.labelSize ? `name engraved on the back (${g(p.labelSize)} mm)` : 'no room for its name on the back'}`;
  }).join('');
  const crossings = sp.seams.reduce((n, m) => n + m.crossings, 0);
  const apart = sp.pieces.filter((p) => /[a-z]$/.test(p.label)).map((p) => p.label);
  return `\n    Split into ${sp.pieces.length} pieces (${sp.spec === 'auto' ? 'Auto' : sp.spec}: ${sp.cols} column${sp.cols > 1 ? 's' : ''} × ${sp.rows} row${sp.rows > 1 ? 's' : ''}), each on its own plate; the clean-up ran on each piece alone (the counts above are totals):${pieces}`
    + `\n      The seams cut ${crossings} line${crossings === 1 ? '' : 's'} of the drawing (they meet end to end, no joint); ${sp.joints.length} dovetail${sp.joints.length === 1 ? '' : 's'} on the bar or frame${sp.joints.length ? ` (${sp.joints.map((j) => `${j.tab}→${j.socket}`).join(', ')})` : ''}${sp.noJoint.length ? `; no dovetail at ${sp.noJoint.length} crossing${sp.noJoint.length > 1 ? 's' : ''}: ${[...new Set(sp.noJoint.map((j) => j.why))].join('; ')}` : ''}${apart.length ? `; ${apart.join(', ')} ${apart.length > 1 ? 'are bits' : 'is a bit'} of a square too far from the rest to bridge, so a piece of its own` : ''}`;
}
