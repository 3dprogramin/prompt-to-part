/// <reference lib="webworker" />
import '../../shared/sandbox'; // first: locks down the worker before anything else loads
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { evaluateScript, formatScriptError, initRuntime, instantiateWith, runtimeOutOfMemory, runtimeTrapped } from '../../shared/runtime';
import { solveDimension } from '../../shared/solver';
import { withFonts } from '../../shared/text';
import { validateResult, type ValidateOptions } from './validate';
import { api, HttpError } from '../lib/api';
import type { DimTarget, ParamValues, PartDisplay, PartMesh, Quality } from '../../shared/types';

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

let startFailed!: (e: unknown) => void;
const ready = Promise.race([
  // instantiateWasm is an emscripten Module option that manifold-3d's types leave out.
  Module({
    locateFile: () => wasmUrl,
    instantiateWasm: instantiateWith(
      async (imports) => WebAssembly.instantiate(await (await fetch(wasmUrl)).arrayBuffer(), imports),
      (e) => startFailed(e),
    ),
  } as Parameters<typeof Module>[0]),
  new Promise<never>((_, reject) => { startFailed = reject; }),
]).then((wasm) => initRuntime(wasm));

/**
 * What the viewer draws, computed here rather than on the main thread (where it froze the page for
 * a second or more on big models): creased normals, feature edges and the raycasting BVH.
 */
function displayMesh(part: PartMesh): { display: PartDisplay; transfer: Transferable[] } {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
  g.setIndex(new THREE.BufferAttribute(part.indices, 1));
  const creased = toCreasedNormals(g, THREE.MathUtils.degToRad(32));
  const edges = new THREE.EdgesGeometry(creased, 30);
  const bvh = MeshBVH.serialize(new MeshBVH(creased));
  const display: PartDisplay = {
    positions: creased.getAttribute('position').array as Float32Array,
    normals: creased.getAttribute('normal').array as Float32Array,
    edges: edges.getAttribute('position').array as Float32Array,
    bvh,
  };
  const transfer: Transferable[] = [display.positions.buffer, display.normals.buffer, display.edges.buffer, ...bvh.roots];
  if (bvh.index) transfer.push(bvh.index.buffer);
  if (bvh.indirectBuffer) transfer.push(bvh.indirectBuffer.buffer);
  return { display, transfer };
}

type Req =
  | { id: number; kind: 'eval'; code: string; values: ParamValues; quality: Quality; validate?: ValidateOptions; display?: boolean }
  | { id: number; kind: 'solve'; code: string; values: ParamValues; quality: Quality; target: DimTarget; goal: number };

self.onmessage = async (ev: MessageEvent<Req>) => {
  const req = ev.data;
  // `crashed` tells the client the wasm instance trapped, so it replaces this worker and retries
  // (unless it ran out of memory, which a retry would only repeat).
  const post = (msg: object, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage({ crashed: runtimeTrapped(), oom: runtimeOutOfMemory(), ...msg }, transfer);
  try {
    await ready;
  } catch (e) {
    post({ id: req.id, error: { message: `The geometry engine failed to start: ${(e as Error)?.message ?? e}`, stage: 'build' }, crashed: true });
    return;
  }
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
    for (const p of result.parts) {
      if (req.display) {
        const d = displayMesh(p);
        p.display = d.display;
        transfer.push(...d.transfer);
      }
      transfer.push(p.positions.buffer, p.indices.buffer);
    }
    if (report) transfer.push(report.overlay.overhang.buffer, report.overlay.thin.buffer);
    post({ id: req.id, result, report }, transfer);
  } catch (e) {
    post({ id: req.id, error: formatScriptError(e) });
  }
};
