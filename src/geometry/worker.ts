/// <reference lib="webworker" />
import '../../shared/sandbox'; // first: locks down the worker before anything else loads
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { evaluateScript, formatScriptError, initRuntime, instantiateWith, runtimeOutOfMemory, runtimeTrapped } from '../../shared/runtime';
import { solveDimension } from '../../shared/solver';
import { probeParamOwners } from '../../shared/paramOwners';
import { withFonts } from '../../shared/text';
import { decodeMesh, withMeshes, type MeshData } from '../../shared/meshes';
import { validateResult, type ValidateOptions } from './validate';
import { linearColors, paintedGeometry, usableColors } from './vertexColors';
import { api, HttpError, request } from '../lib/api';
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

/** A design's mesh (H.mesh), fetched once: the files never change, and the runtime keeps a few loaded. */
async function loadMesh(url: string): Promise<MeshData> {
  try {
    return decodeMesh(new Uint8Array(await (await request(url)).arrayBuffer()));
  } catch (e) {
    // A missing file stays missing; anything else (the server restarting) is tried again next time.
    if (!(e instanceof HttpError && e.status === 404)) Object.assign(e as Error, { transient: true });
    throw e;
  }
}
/** Runs fn with every font and mesh it needs loaded. */
const withAssets = <T>(fn: () => T): Promise<T> => withMeshes(() => withFonts(fn, loadFont), loadMesh);

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
 * a second or more on big models): creased normals, feature edges, the raycasting BVH and, for parts
 * coloured per vertex (LayerTone), their colours on the same unshared vertices as the positions.
 */
function displayMesh(part: PartMesh): { display: PartDisplay; transfer: Transferable[] } {
  // A coloured mesh's part: unshared triangles, each in its filament's colour.
  let g = paintedGeometry(part);
  const colors = g ? undefined : usableColors(part.vertexColors, part.positions);
  if (!g) {
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
    // toNonIndexed (inside toCreasedNormals) unshares every attribute, so the colours follow the positions.
    if (colors) g.setAttribute('color', new THREE.BufferAttribute(linearColors(colors), 3));
    g.setIndex(new THREE.BufferAttribute(part.indices, 1));
  }
  const creased = toCreasedNormals(g, THREE.MathUtils.degToRad(32));
  const edges = new THREE.EdgesGeometry(creased, 30);
  const bvh = MeshBVH.serialize(new MeshBVH(creased));
  const display: PartDisplay = {
    positions: creased.getAttribute('position').array as Float32Array,
    normals: creased.getAttribute('normal').array as Float32Array,
    edges: edges.getAttribute('position').array as Float32Array,
    bvh,
  };
  if (creased.getAttribute('color')) display.colors = creased.getAttribute('color').array as Float32Array;
  const transfer: Transferable[] = [display.positions.buffer, display.normals.buffer, display.edges.buffer, ...bvh.roots];
  if (display.colors) transfer.push(display.colors.buffer);
  if (bvh.index) transfer.push(bvh.index.buffer);
  if (bvh.indirectBuffer) transfer.push(bvh.indirectBuffer.buffer);
  return { display, transfer };
}

type Req =
  | { id: number; kind: 'eval'; code: string; values: ParamValues; quality: Quality; validate?: ValidateOptions; display?: boolean }
  | { id: number; kind: 'solve'; code: string; values: ParamValues; quality: Quality; target: DimTarget; goal: number }
  | { id: number; kind: 'owners'; code: string; values: ParamValues };

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
    if (req.kind === 'owners') {
      // Draft builds, one per parameter: which parts each one changes.
      const base = await withAssets(() => evaluateScript(req.code, req.values, 'draft'));
      post({ id: req.id, owners: probeParamOwners(base, req.values, (v) => evaluateScript(req.code, v, 'draft')) });
      return;
    }
    if (req.kind === 'solve') {
      // Evaluate once first so every font the model needs is loaded before solving.
      await withAssets(() => evaluateScript(req.code, req.values, req.quality, { lite: true })).catch(() => null);
      post({ id: req.id, solve: solveDimension(req.code, req.values, req.target, req.goal, req.quality) });
      return;
    }
    const result = await withAssets(() => evaluateScript(req.code, req.values, req.quality));
    // The script is done: preparing the viewer mesh below takes time of its own, which must not
    // count against the script's time limit.
    if (req.display) post({ id: req.id, built: true });
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
      // Only a buffer of its own (not a view into a bigger one) can be handed over.
      if (p.vertexColors && p.vertexColors.byteLength === p.vertexColors.buffer.byteLength) transfer.push(p.vertexColors.buffer);
      if (p.paint) transfer.push(p.paint.tri.buffer, ...(p.paint.source ? [p.paint.source.mesh.buffer, p.paint.source.face.buffer] : []));
    }
    if (report) transfer.push(report.overlay.overhang.buffer, report.overlay.thin.buffer);
    post({ id: req.id, result, report }, transfer);
  } catch (e) {
    post({ id: req.id, error: formatScriptError(e) });
  }
};
