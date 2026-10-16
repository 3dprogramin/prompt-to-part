import type { EvalResult, ParamValues, Quality, ScriptErrorInfo } from '../../shared/types';

export type EvalOutcome = { result: EvalResult; error?: undefined } | { result?: undefined; error: ScriptErrorInfo };

interface Job { code: string; values: ParamValues; quality: Quality; resolve: (o: EvalOutcome) => void }

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
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => {
      const { id, result, error } = ev.data as { id: number; result?: EvalResult; error?: ScriptErrorInfo };
      if (!this.running || this.running.id !== id) return;
      clearTimeout(this.running.timer);
      const { job } = this.running;
      this.running = null;
      job.resolve(result ? { result } : { error: error! });
      this.pump();
    };
  }

  /** Live preview: superseded requests resolve with null. */
  preview(code: string, values: ParamValues, quality: Quality): Promise<EvalOutcome | null> {
    return new Promise((resolve) => {
      if (this.pending) this.pending.resolve(null as unknown as EvalOutcome);
      this.pending = { code, values, quality, resolve: resolve as Job['resolve'] };
      this.pump();
    });
  }

  /** Guaranteed evaluation (e.g. high-quality export); runs before any pending preview. */
  evaluate(code: string, values: ParamValues, quality: Quality): Promise<EvalOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ code, values, quality, resolve });
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
      this.worker.terminate();
      this.running = null;
      this.spawn();
      job.resolve({ error: { message: `Evaluation timed out after ${TIMEOUT_MS / 1000}s`, stage: 'build' } });
      this.pump();
    }, TIMEOUT_MS);
    this.running = { id, job, timer };
    this.worker.postMessage({ id, code: job.code, values: job.values, quality: job.quality });
  }
}
