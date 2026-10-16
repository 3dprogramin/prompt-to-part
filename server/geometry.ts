import { fitProblem } from '../shared/printer';
import { Worker } from 'node:worker_threads';
import type { ParamValues, Quality } from '../shared/types';
import type { EvalFailure, EvalSummary } from './geometry-worker';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./geometry-worker-boot.mjs', import.meta.url));
  w.on('message', (msg: { id: number; data?: unknown; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.data);
  });
  w.on('error', (e: Error) => { for (const p of pending.values()) p.reject(e); pending.clear(); worker = null; });
  w.on('exit', () => { if (worker === w) worker = null; });
  worker = w;
  return w;
}

// Serialise jobs: one at a time keeps timeouts meaningful.
let chain: Promise<unknown> = Promise.resolve();

function call<T>(msg: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const job = chain.then(() => new Promise<T>((resolve, reject) => {
    const w = getWorker();
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      worker = null;
      w.terminate();
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s – the script is too slow (or loops forever). Reduce segment counts, avoid huge loops/minkowski/levelSet.`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    w.postMessage({ ...msg, id });
  }));
  chain = job.catch(() => undefined);
  return job;
}

export type RenderResult = (EvalSummary | EvalFailure) & { png?: string; gridStep?: number };
export interface StressResult { failures: { case: string; error: string }[]; tested: number; skipped: number }

export const geometry = {
  evaluate: (code: string, values?: ParamValues, quality: Quality = 'normal') =>
    call<EvalSummary | EvalFailure>({ cmd: 'evaluate', code, values, quality }, 30000),
  render: (code: string, values?: ParamValues) => call<RenderResult>({ cmd: 'render', code, values }, 45000),
  stress: (code: string) => call<StressResult>({ cmd: 'stress', code, budgetMs: 20000 }, 40000),
  /** One large iso picture (used for assembled / exploded views). */
  iso: (code: string, values?: ParamValues) => call<RenderResult>({ cmd: 'iso', code, values }, 45000),
  warmup: () => { getWorker(); },
};

const f = (n: number, d = 2) => (Math.abs(n) < 1e-9 ? 0 : n).toFixed(d);

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
    const b = p.bbox!;
    lines.push(`  - "${p.name}": ${f(b.max[0] - b.min[0])} × ${f(b.max[1] - b.min[1])} × ${f(b.max[2] - b.min[2])} mm, Z[${f(b.min[2])}, ${f(b.max[2])}], volume ${f(p.volume / 1000, 3)} cm³, ${p.triCount} triangles, ${p.components} connected piece(s), genus ${p.genus}`);
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
    lines.push(`Print settings (differences from A1 0.20 mm Standard, PLA): ${JSON.stringify(globalPrint)}${partPrint ? ` · per part: ${JSON.stringify(partPrint)}` : ''}`);
  }
  const warn = [...r.warnings];
  if (r.bbox && Math.abs(r.bbox.min[2]) > 0.01) warn.push(`Model does not rest on the build plate: min Z = ${f(r.bbox.min[2])} (should be 0)`);
  for (const p of r.parts) if (p.components > 1) warn.push(`Part "${p.name}" consists of ${p.components} disconnected pieces – if it should be one solid, make the sub-shapes overlap (≥0.05 mm) before union`);
  const tris = r.parts.reduce((s, p) => s + p.triCount, 0);
  const fit = fitProblem(r.bbox);
  if (fit) warn.push(fit);
  if (tris > 1_500_000) warn.push(`Very high triangle count (${tris}); reduce segments for responsive sliders`);
  if (r.timeMs > 1500) warn.push(`Slow evaluation (${Math.round(r.timeMs)} ms) – sliders will feel laggy; simplify or lower segment counts`);
  if (warn.length) { lines.push('Warnings:'); for (const w of warn) lines.push(`  - ${w}`); }
  if (r.logs.length) { lines.push('console output:'); for (const l of r.logs.slice(0, 40)) lines.push(`  ${l}`); }
  return lines.join('\n');
}
