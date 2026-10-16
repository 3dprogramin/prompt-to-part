// Runs model scripts in a worker thread so a slow or looping script can be killed.
import { parentPort } from 'node:worker_threads';
import Module from 'manifold-3d';
import { initRuntime, evaluateScript, formatScriptError, inspectScript } from '../shared/runtime';
import { renderIso, renderSheet } from './render';
import { withFonts } from '../shared/text';
import { loadFontBuffers } from './fonts';
import type { EvalResult, ParamValues, Quality } from '../shared/types';

const ready = Module().then((wasm) => initRuntime(wasm));

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
  parts: { name: string; color: string; bbox: EvalResult['bbox']; volume: number; surfaceArea: number; triCount: number; genus: number; components: number }[];
}
export interface EvalFailure { ok: false; error: ReturnType<typeof formatScriptError> }

function summarize(r: EvalResult): EvalSummary {
  return {
    ok: true, meta: r.meta, params: r.params, values: r.values, bbox: r.bbox, timeMs: r.timeMs,
    warnings: r.warnings, logs: r.logs, dimensions: r.dimensions,
    parts: r.parts.map(({ positions: _p, indices: _i, ...rest }) => rest),
  };
}

async function run(code: string, values: ParamValues | undefined, quality: Quality): Promise<{ result?: EvalResult; out: EvalSummary | EvalFailure }> {
  try {
    const result = await withFonts(() => evaluateScript(code, values, quality), loadFontBuffers);
    return { result, out: summarize(result) };
  } catch (e) {
    return { out: { ok: false, error: formatScriptError(e) } };
  }
}

type Req =
  | { id: number; cmd: 'evaluate'; code: string; values?: ParamValues; quality?: Quality }
  | { id: number; cmd: 'render'; code: string; values?: ParamValues }
  | { id: number; cmd: 'stress'; code: string; budgetMs?: number }
  | { id: number; cmd: 'iso'; code: string; values?: ParamValues };

parentPort!.on('message', async (req: Req) => {
  await ready;
  try {
    if (req.cmd === 'evaluate') {
      parentPort!.postMessage({ id: req.id, data: (await run(req.code, req.values, req.quality ?? 'normal')).out });
    } else if (req.cmd === 'render') {
      const { result, out } = await run(req.code, req.values, 'normal');
      let png: Buffer | undefined, gridStep: number | undefined;
      if (result && result.parts.length) ({ png, gridStep } = renderSheet(result.parts));
      parentPort!.postMessage({ id: req.id, data: { ...out, png: png?.toString('base64'), gridStep } });
    } else if (req.cmd === 'iso') {
      const { result, out } = await run(req.code, req.values, 'normal');
      const png = result && result.parts.length ? renderIso(result.parts).png.toString('base64') : undefined;
      parentPort!.postMessage({ id: req.id, data: { ...out, png } });
    } else if (req.cmd === 'stress') {
      parentPort!.postMessage({ id: req.id, data: await stress(req.code, req.budgetMs ?? 20000) });
    }
  } catch (e) {
    parentPort!.postMessage({ id: req.id, error: (e as Error).message });
  }
});

/** Evaluate the script across parameter extremes so sliders never break the model. */
async function stress(code: string, budgetMs: number) {
  const t0 = performance.now();
  let params;
  try {
    params = inspectScript(code).params;
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
    if (performance.now() - t0 > budgetMs) break;
    tested++;
    const { out } = await run(code, c.values, 'draft');
    if (!out.ok) failures.push({ case: c.label, error: `${out.error.message}${out.error.line ? ` (line ${out.error.line})` : ''}` });
    else if (!out.parts.length) failures.push({ case: c.label, error: 'produced no geometry (all parts empty)' });
  }
  return { failures, tested, skipped: cases.length - tested };
}
