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
  validate?: ValidateOptions;
  resolve: (o: any) => void;
  /** Set once the job has been re-run after a worker crash. */
  retried?: boolean;
}

interface Reply { id: number; result?: EvalResult; error?: ScriptErrorInfo; solve?: SolveResult; report?: ValidationReport; crashed?: boolean }

const TIMEOUT_MS = 30000;

/**
 * Evaluates model scripts in a Web Worker. Live-preview requests are coalesced:
 * while one runs, only the most recent pending request is kept.
 */
export class GeometryClient {
  private worker!: Worker;
  private seq = 0;
  private running: { id: number; job: Job; timer: number } | null = null;
  private pending: Job | null = null;
  private queue: Job[] = [];

  constructor() { this.spawn(); }

  private spawn() {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = (ev) => this.reply(ev.data as Reply);
    // An uncaught error kills the job without a reply; treat it like a crash.
    worker.onerror = (ev) => {
      ev.preventDefault();
      if (this.worker === worker && this.running) {
        this.reply({ id: this.running.id, error: { message: ev.message || 'Geometry worker failed', stage: 'build' }, crashed: true });
      }
    };
  }

  private reply({ id, result, error, solve, report, crashed }: Reply) {
    if (!this.running || this.running.id !== id) return;
    clearTimeout(this.running.timer);
    const { job } = this.running;
    this.running = null;
    // A wasm trap leaves the heap unusable: replace the worker and run the job once more.
    if (crashed) {
      this.restart();
      if (!job.retried) {
        console.warn(`Geometry worker crashed (${error?.message ?? 'wasm trap'}); restarting it and retrying`);
        job.retried = true;
        this.start(job);
        return;
      }
    }
    if (job.solve) job.resolve(solve ?? { ok: false, message: error?.message ?? 'Failed' });
    else job.resolve(result ? { result, report } : { error: error! });
    this.pump();
  }

  private restart() {
    this.worker.terminate();
    this.spawn();
  }

  /** Live preview: superseded requests resolve with null. */
  preview(code: string, values: ParamValues, quality: Quality): Promise<EvalOutcome | null> {
    return new Promise((resolve) => {
      if (this.pending) this.pending.resolve(null as unknown as EvalOutcome);
      this.pending = { code, values, quality, resolve: resolve as Job['resolve'] };
      this.pump();
    });
  }

  /** Guaranteed evaluation (e.g. high-quality export); runs before any pending preview. Optionally validates the mesh. */
  evaluate(code: string, values: ParamValues, quality: Quality, validate?: ValidateOptions): Promise<EvalOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ code, values, quality, validate, resolve });
      this.pump();
    });
  }

  /** Find the parameter value that makes a dimension hit `goal` mm. */
  solve(code: string, values: ParamValues, quality: Quality, target: DimTarget, goal: number): Promise<SolveResult> {
    return new Promise((resolve) => {
      this.queue.push({ code, values, quality, solve: { target, goal }, resolve });
      this.pump();
    });
  }

  private pump() {
    if (this.running) return;
    const job = this.queue.shift() ?? this.pending;
    if (!job) return;
    if (job === this.pending) this.pending = null;
    this.start(job);
  }

  private start(job: Job) {
    const id = ++this.seq;
    const timer = window.setTimeout(() => {
      // Script hung: kill the worker and start a fresh one.
      this.running = null;
      this.restart();
      const message = `Evaluation timed out after ${TIMEOUT_MS / 1000}s`;
      job.resolve(job.solve ? { ok: false, message } : { error: { message, stage: 'build' } });
      this.pump();
    }, TIMEOUT_MS);
    this.running = { id, job, timer };
    this.worker.postMessage(job.solve
      ? { id, kind: 'solve', code: job.code, values: job.values, quality: job.quality, ...job.solve }
      : { id, kind: 'eval', code: job.code, values: job.values, quality: job.quality, validate: job.validate });
  }
}
