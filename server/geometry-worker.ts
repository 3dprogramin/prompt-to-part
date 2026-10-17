// Runs model scripts in a separate, locked-down Node process (started by server/geometry.ts with
// Node's permission model: no child processes, workers or file writes, file reads only inside
// node_modules, an empty environment; and no network, see closeNetwork below), so a slow or
// looping script can be killed and a script that ever got past the SES sandbox would still find
// nothing to reach.
import '../shared/sandbox'; // first: locks down the worker before anything else loads
import dgram from 'node:dgram';
import dns from 'node:dns';
import inspector from 'node:inspector';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Module from 'manifold-3d';
import { initRuntime, evaluateScript, formatScriptError, inspectScript, instantiateWith, runtimeOutOfMemory, runtimeTrapped } from '../shared/runtime';
import { renderIso, renderSheet } from './render';
import { withFonts } from '../shared/text';
import type { Box3, EvalResult, ParamValues, Quality } from '../shared/types';

// Refuse to run model scripts without the process lock.
if (!process.permission || process.permission.has('child') || process.permission.has('fs.write')) {
  console.error('[geometry] refusing to start: the Node permission model is not active');
  process.exit(78);
}

/**
 * The permission model has no network switch before Node 25, so close the network here: an
 * escaped script could otherwise call Jig's own API (which trusts local requests) or send data
 * out. The low-level socket bindings are already refused by the permission model; this replaces
 * every public way to open a connection, listen, or resolve a name. IPC to the server is an
 * already-open channel and keeps working.
 */
function closeNetwork() {
  const refuse = () => { throw new Error('The geometry worker has no network access'); };
  const lock = (o: object, keys: string[]) => {
    for (const k of keys) if (k in o) Object.defineProperty(o, k, { value: refuse, writable: false, configurable: false });
  };
  lock(net.Socket.prototype, ['connect']);
  lock(net.Server.prototype, ['listen']);
  lock(dgram.Socket.prototype, ['bind', 'connect', 'send']);
  lock(net, ['connect', 'createConnection', 'createServer']);
  lock(dgram, ['createSocket']);
  lock(inspector, ['open']);
  for (const R of [dns.Resolver, dns.promises.Resolver]) lock(R.prototype, Object.getOwnPropertyNames(R.prototype).filter((k) => k !== 'constructor'));
  // Functions only, not the Resolver classes (their prototypes are locked above).
  for (const m of [dns, dns.promises]) lock(m, Object.keys(m).filter((k) => typeof (m as Record<string, unknown>)[k] === 'function' && !/^[A-Z]/.test(k)));
  for (const k of ['fetch', 'WebSocket', 'EventSource']) delete (globalThis as Record<string, unknown>)[k];
  // `import('node:dns')` hands out a namespace copied when the module was first imported; bring
  // it up to date with the locked functions.
  syncBuiltinESMExports();
}
closeNetwork();

const send = (msg: object) => process.send?.(msg);

// Fonts are read by the server (this process may not read them) and sent over IPC.
let fontSeq = 0;
const fontWaiters = new Map<number, { resolve: (b: ArrayBuffer[]) => void; reject: (e: Error) => void }>();
function requestFont(font: string): Promise<ArrayBuffer[]> {
  return new Promise((resolve, reject) => {
    const fontReq = ++fontSeq;
    fontWaiters.set(fontReq, { resolve, reject });
    send({ fontReq, font });
  });
}

let startFailed!: (e: unknown) => void;
const ready = Promise.race([
  // instantiateWasm is an emscripten Module option that manifold-3d's types leave out.
  Module({
    instantiateWasm: instantiateWith(
      async (imports) => WebAssembly.instantiate(await readFile(fileURLToPath(import.meta.resolve('manifold-3d/manifold.wasm'))), imports),
      (e) => startFailed(e),
    ),
  } as unknown as Parameters<typeof Module>[0]),
  new Promise<never>((_, reject) => { startFailed = reject; }),
]).then((wasm) => initRuntime(wasm));

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
  assembly: EvalResult['assembly'];
  print: EvalResult['print'];
  parts: { name: string; color: string; bbox: Box3; volume: number; surfaceArea: number; triCount: number; genus: number; components: number }[];
}
export interface EvalFailure { ok: false; error: ReturnType<typeof formatScriptError> }

function summarize(r: EvalResult): EvalSummary {
  return {
    ok: true, meta: r.meta, params: r.params, values: r.values, bbox: r.bbox, timeMs: r.timeMs,
    warnings: r.warnings, logs: r.logs, dimensions: r.dimensions, assembly: r.assembly, print: r.print,
    parts: r.parts.map(({ name, color, bbox, volume, surfaceArea, triCount, genus, components }) => ({ name, color, bbox, volume, surfaceArea, triCount, genus, components })),
  };
}

async function run(code: string, values: ParamValues | undefined, quality: Quality): Promise<{ result?: EvalResult; out: EvalSummary | EvalFailure }> {
  try {
    const result = await withFonts(() => evaluateScript(code, values, quality), requestFont);
    return { result, out: summarize(result) };
  } catch (e) {
    return { out: { ok: false, error: formatScriptError(e) } };
  }
}

type Req =
  | { id: number; cmd: 'evaluate'; code: string; values?: ParamValues; quality?: Quality }
  | { id: number; cmd: 'render'; code: string; values?: ParamValues }
  | { id: number; cmd: 'stress'; code: string; budgetMs?: number; extra?: ParamValues }
  | { id: number; cmd: 'iso'; code: string; values?: ParamValues };

type FontReply = { fontReply: number; buffers?: ArrayBuffer[]; error?: string };

// `crashed` tells the parent the wasm instance trapped, so it replaces this worker and retries
// (not after running out of memory, `oom`, which a retry would only repeat).
process.on('message', async (req: Req | FontReply) => {
  if ('fontReply' in req) {
    const w = fontWaiters.get(req.fontReply);
    fontWaiters.delete(req.fontReply);
    if (req.buffers) w?.resolve(req.buffers); else w?.reject(new Error(req.error ?? 'font failed to load'));
    return;
  }
  const post = (msg: { data?: unknown; error?: string; crashed?: boolean }) => send({ id: req.id, crashed: runtimeTrapped(), oom: runtimeOutOfMemory(), ...msg });
  try {
    await ready;
  } catch (e) {
    post({ error: `The geometry engine failed to start: ${(e as Error)?.message ?? e}`, crashed: true });
    return;
  }
  try {
    if (req.cmd === 'evaluate') {
      post({ data: (await run(req.code, req.values, req.quality ?? 'normal')).out });
    } else if (req.cmd === 'render') {
      const { result, out } = await run(req.code, req.values, 'normal');
      let png: Buffer | undefined, gridStep: number | undefined;
      if (result && result.parts.length) ({ png, gridStep } = renderSheet(result.parts));
      post({ data: { ...out, png: png?.toString('base64'), gridStep } });
    } else if (req.cmd === 'iso') {
      const { result, out } = await run(req.code, req.values, 'normal');
      const png = result && result.parts.length ? renderIso(result.parts).png.toString('base64') : undefined;
      post({ data: { ...out, png } });
    } else if (req.cmd === 'stress') {
      post({ data: await stress(req.code, req.budgetMs ?? 20000, req.extra) });
    }
  } catch (e) {
    post({ error: (e as Error).message });
  }
});

/** Evaluate the script across parameter extremes so sliders never break the model. */
async function stress(code: string, budgetMs: number, extra: ParamValues = {}) {
  const t0 = performance.now();
  let params;
  try {
    params = (await withFonts(() => inspectScript(code), requestFont)).params;
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
    if (performance.now() - t0 > budgetMs || runtimeTrapped()) break;
    tested++;
    const { out } = await run(code, { ...extra, ...c.values }, 'draft');
    if (!out.ok) failures.push({ case: c.label, error: `${out.error.message}${out.error.line ? ` (line ${out.error.line})` : ''}` });
    else if (!out.parts.length) failures.push({ case: c.label, error: 'produced no geometry (all parts empty)' });
  }
  return { failures, tested, skipped: cases.length - tested };
}
