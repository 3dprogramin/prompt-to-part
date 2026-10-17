import type { DimTarget, EvalResult, ParamValues, Quality, ScriptErrorInfo, SolveResult } from '../../shared/types';
import type { ValidateOptions, ValidationReport } from './validate';

export type EvalOutcome =
  | { result: EvalResult; report?: ValidationReport; error?: undefined }
  | { result?: undefined; report?: undefined; error: ScriptErrorInfo };

interface Job {
  code: string;
  values: ParamValues;
  quality: Quality;
  solve?: { target: DimTarget; goal: number };
  /** Find which parts each parameter changes (probeParamOwners). */
  owners?: boolean;
  validate?: ValidateOptions;
  /** A live preview (superseded by the next one) rather than a job someone waits for. */
  preview?: boolean;
  /** Also prepare the viewer's mesh in the worker (PartMesh.display). */
  display?: boolean;
  timeoutMs: number;
  resolve: (o: EvalOutcome | SolveResult | Record<string, string[]> | null) => void;
  /** Set once the job has been re-run after a worker crash. */
  retried?: boolean;
}

interface Reply { id: number; result?: EvalResult; error?: ScriptErrorInfo; solve?: SolveResult; report?: ValidationReport; crashed?: boolean; oom?: boolean; built?: boolean; owners?: Record<string, string[]> }

// A live preview should be quick; an export or validation at high quality may take longer.
const PREVIEW_TIMEOUT_MS = 30000;
const JOB_TIMEOUT_MS = 120000;
/** A preview still running this long when a newer one arrives is abandoned (worker restarted). */
const STALE_PREVIEW_MS = 1500;
/** After an export or validation this big the worker is restarted once idle, so its wasm heap shrinks back. */
const BIG_JOB_TRIANGLES = 400_000;

/**
 * Evaluates model scripts in a Web Worker. Live-preview requests are coalesced:
 * while one runs, only the most recent pending request is kept.
 */
export class GeometryClient {
  private worker!: Worker;
  private seq = 0;
  /** `built`: the script finished and the worker is preparing the viewer mesh (no time limit). */
  private running: { id: number; job: Job; timer: number; started: number; built?: boolean } | null = null;
  private pending: Job | null = null;
  private queue: Job[] = [];
  private staleTimer = 0;
  private recycle = false;
  /** The worker failed while idle (e.g. its script didn't load): the next job starts a new one. */
  private dead = false;

  constructor() { this.spawn(); }

  private spawn() {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = (ev) => this.reply(ev.data as Reply);
    // An uncaught error kills the job without a reply; treat it like a crash.
    worker.onerror = (ev) => {
      ev.preventDefault();
      if (this.worker !== worker) return;
      if (this.running) this.reply({ id: this.running.id, error: { message: ev.message || 'The geometry worker failed to start', stage: 'build' }, crashed: true });
      else this.dead = true;
    };
  }

  private reply({ id, result, error, solve, report, crashed, oom, built, owners }: Reply) {
    if (!this.running || this.running.id !== id) return;
    clearTimeout(this.running.timer);
    if (built) {
      this.running.built = true;
      return;
    }
    const { job } = this.running;
    this.running = null;
    // A wasm trap leaves the heap unusable: replace the worker and run the job once more (not
    // after running out of memory, which would only happen again).
    if (crashed) {
      this.restart();
      if (!job.retried && !oom) {
        console.warn(`Geometry worker crashed (${error?.message ?? 'wasm trap'}); restarting it and retrying`);
        job.retried = true;
        this.start(job);
        return;
      }
    } else if (!job.preview && (job.quality === 'high' || (result?.parts.reduce((s, p) => s + p.triCount, 0) ?? 0) > BIG_JOB_TRIANGLES)) {
      // An export or validation often needs far more memory than the previews that follow.
      this.recycle = true;
    }
    if (job.owners) job.resolve(owners ?? null);
    else if (job.solve) job.resolve(solve ?? { ok: false, message: error?.message ?? 'Failed' });
    else job.resolve(result ? { result, report } : { error: error! });
    this.pump();
  }

  private restart() {
    this.worker.terminate();
    this.dead = false;
    this.recycle = false;
    this.spawn();
  }

  /** Live preview: superseded requests resolve with null. */
  preview(code: string, values: ParamValues, quality: Quality): Promise<EvalOutcome | null> {
    return new Promise((resolve) => {
      if (this.pending) this.pending.resolve(null);
      this.pending = { code, values, quality, preview: true, display: true, timeoutMs: PREVIEW_TIMEOUT_MS, resolve: resolve as Job['resolve'] };
      this.dropStalePreview();
      this.pump();
    });
  }

  /**
   * A preview that is still running when a newer one is waiting gets STALE_PREVIEW_MS, then the
   * worker is restarted: a slider value that makes the script very slow (or loop) must not hold up
   * the value that fixes it for the full timeout.
   */
  private dropStalePreview() {
    clearTimeout(this.staleTimer);
    const r = this.running;
    // Once built, its mesh is nearly ready: dropping it now would only throw that work away.
    if (!r?.job.preview || r.built || !this.pending) return;
    const wait = r.started + STALE_PREVIEW_MS - performance.now();
    if (wait > 0) { this.staleTimer = window.setTimeout(() => this.dropStalePreview(), wait); return; }
    clearTimeout(r.timer);
    this.running = null;
    this.restart();
    r.job.resolve(null);
    this.pump();
  }

  /** Guaranteed evaluation (e.g. high-quality export); runs before any pending preview. Optionally validates the mesh. */
  evaluate(code: string, values: ParamValues, quality: Quality, opts: { validate?: ValidateOptions; display?: boolean } = {}): Promise<EvalOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ code, values, quality, ...opts, timeoutMs: JOB_TIMEOUT_MS, resolve: resolve as Job['resolve'] });
      this.pump();
    });
  }

  /** Which parts each parameter changes (null if the model fails). */
  owners(code: string, values: ParamValues): Promise<Record<string, string[]> | null> {
    return new Promise((resolve) => {
      this.queue.push({ code, values, quality: 'draft', owners: true, timeoutMs: JOB_TIMEOUT_MS, resolve: resolve as Job['resolve'] });
      this.pump();
    });
  }

  /** Find the parameter value that makes a dimension hit `goal` mm. */
  solve(code: string, values: ParamValues, quality: Quality, target: DimTarget, goal: number): Promise<SolveResult> {
    return new Promise((resolve) => {
      this.queue.push({ code, values, quality, solve: { target, goal }, timeoutMs: JOB_TIMEOUT_MS, resolve: resolve as Job['resolve'] });
      this.pump();
    });
  }

  private pump() {
    if (this.running) return;
    const job = this.queue.shift() ?? this.pending;
    if (!job) {
      if (this.recycle) this.restart();
      return;
    }
    if (job === this.pending) this.pending = null;
    this.start(job);
  }

  private start(job: Job) {
    if (this.dead) this.restart();
    const id = ++this.seq;
    const timer = window.setTimeout(() => {
      // Script hung: kill the worker and start a fresh one.
      this.running = null;
      this.restart();
      const message = `Evaluation timed out after ${job.timeoutMs / 1000} s – the script is too slow at this quality (or loops forever)`;
      job.resolve(job.owners ? null : job.solve ? { ok: false, message } : { error: { message, stage: 'build' } });
      this.pump();
    }, job.timeoutMs);
    this.running = { id, job, timer, started: performance.now() };
    this.worker.postMessage(job.owners
      ? { id, kind: 'owners', code: job.code, values: job.values }
      : job.solve
      ? { id, kind: 'solve', code: job.code, values: job.values, quality: job.quality, ...job.solve }
      : { id, kind: 'eval', code: job.code, values: job.values, quality: job.quality, validate: job.validate, display: job.display });
  }
}
