/// <reference lib="webworker" />
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { evaluateScript, formatScriptError, initRuntime } from '../../shared/runtime';
import type { ParamValues, Quality } from '../../shared/types';

const ready = Module({ locateFile: () => wasmUrl }).then((wasm) => initRuntime(wasm));

self.onmessage = async (ev: MessageEvent<{ id: number; code: string; values: ParamValues; quality: Quality }>) => {
  const { id, code, values, quality } = ev.data;
  await ready;
  try {
    const result = evaluateScript(code, values, quality);
    const transfer: Transferable[] = [];
    for (const p of result.parts) transfer.push(p.positions.buffer, p.indices.buffer);
    (self as unknown as Worker).postMessage({ id, result }, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: formatScriptError(e) });
  }
};
