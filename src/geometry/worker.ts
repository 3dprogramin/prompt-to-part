/// <reference lib="webworker" />
import '../../shared/sandbox'; // first: locks down the worker before anything else loads
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { evaluateScript, formatScriptError, initRuntime, runtimeTrapped } from '../../shared/runtime';
import { solveDimension } from '../../shared/solver';
import { withFonts } from '../../shared/text';
import { validateResult, type ValidateOptions } from './validate';
import { api, HttpError } from '../lib/api';

async function loadFont(id: string): Promise<ArrayBuffer[]> {
  try {
    const { files } = await api.fontData(id);
    return files.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
  } catch (e) {
    // Only "no such font" (404) means falling back to the default font; anything else (the
    // server restarting) is retried on the next evaluation.
    if (!(e instanceof HttpError && e.status === 404)) Object.assign(e as Error, { transient: true });
    throw e;
  }
}
import type { DimTarget, ParamValues, Quality } from '../../shared/types';

const ready = Module({ locateFile: () => wasmUrl }).then((wasm) => initRuntime(wasm));

type Req =
  | { id: number; kind: 'eval'; code: string; values: ParamValues; quality: Quality; validate?: ValidateOptions }
  | { id: number; kind: 'solve'; code: string; values: ParamValues; quality: Quality; target: DimTarget; goal: number };

self.onmessage = async (ev: MessageEvent<Req>) => {
  const req = ev.data;
  await ready;
  // `crashed` tells the client the wasm instance trapped, so it replaces this worker and retries.
  const post = (msg: object, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage({ ...msg, crashed: runtimeTrapped() }, transfer);
  try {
    if (req.kind === 'solve') {
      // Evaluate once first so every font the model needs is loaded before solving.
      await withFonts(() => evaluateScript(req.code, req.values, req.quality, { lite: true }), loadFont).catch(() => null);
      post({ id: req.id, solve: solveDimension(req.code, req.values, req.target, req.goal, req.quality) });
      return;
    }
    const result = await withFonts(() => evaluateScript(req.code, req.values, req.quality), loadFont);
    // Validate before the buffers are transferred away.
    const report = req.validate ? validateResult(result, req.validate) : undefined;
    const transfer: Transferable[] = [];
    for (const p of result.parts) transfer.push(p.positions.buffer, p.indices.buffer);
    if (report) transfer.push(report.overlay.overhang.buffer, report.overlay.thin.buffer);
    post({ id: req.id, result, report }, transfer);
  } catch (e) {
    post({ id: req.id, error: formatScriptError(e) });
  }
};
