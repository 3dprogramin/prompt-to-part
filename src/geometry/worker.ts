/// <reference lib="webworker" />
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { evaluateScript, formatScriptError, initRuntime } from '../../shared/runtime';
import { solveDimension } from '../../shared/solver';
import { withFonts } from '../../shared/text';
import { validateResult } from './validate';

async function loadFont(id: string): Promise<ArrayBuffer[]> {
  const r = await fetch(`/api/fonts/data?id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  const { files } = (await r.json()) as { files: string[] };
  return files.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
}
import type { DimTarget, ParamValues, Quality } from '../../shared/types';

const ready = Module({ locateFile: () => wasmUrl }).then((wasm) => initRuntime(wasm));

type Req =
  | { id: number; kind: 'eval'; code: string; values: ParamValues; quality: Quality; validate?: { layoutValue?: string } }
  | { id: number; kind: 'solve'; code: string; values: ParamValues; quality: Quality; target: DimTarget; goal: number };

self.onmessage = async (ev: MessageEvent<Req>) => {
  const req = ev.data;
  await ready;
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
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
