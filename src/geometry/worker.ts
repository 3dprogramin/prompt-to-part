/// <reference lib="webworker" />
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { evaluateScript, formatScriptError, initRuntime } from '../../shared/runtime';
import { solveDimension } from '../../shared/solver';
import type { DimTarget, ParamValues, Quality } from '../../shared/types';

const ready = Module({ locateFile: () => wasmUrl }).then((wasm) => initRuntime(wasm));

type Req =
  | { id: number; kind: 'eval'; code: string; values: ParamValues; quality: Quality }
  | { id: number; kind: 'solve'; code: string; values: ParamValues; quality: Quality; target: DimTarget; goal: number };

self.onmessage = async (ev: MessageEvent<Req>) => {
  const req = ev.data;
  await ready;
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    if (req.kind === 'solve') {
      post({ id: req.id, solve: solveDimension(req.code, req.values, req.target, req.goal, req.quality) });
      return;
    }
    const result = evaluateScript(req.code, req.values, req.quality);
    const transfer: Transferable[] = [];
    for (const p of result.parts) transfer.push(p.positions.buffer, p.indices.buffer);
    post({ id: req.id, result }, transfer);
  } catch (e) {
    post({ id: req.id, error: formatScriptError(e) });
  }
};
