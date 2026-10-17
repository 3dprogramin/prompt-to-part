// Runs one OpenSCAD job (an attached .scad file) in its own process, started by server/openscad.ts
// with Node's permission model: it may read only node_modules (where the engine was downloaded),
// may not write files, start processes or threads, and gets no environment variables. OpenSCAD
// itself works on an in-memory file system holding just the script, its fonts and libraries.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { parseOff, scadDefines, type ScadParam } from '../shared/scad';
import { renderSheet } from './render';
import type { ParamValues } from '../shared/types';

if (!process.permission || process.permission.has('child') || process.permission.has('fs.write')) {
  console.error('[openscad] refusing to start: the Node permission model is not active');
  process.exit(78);
}
for (const k of ['fetch', 'WebSocket', 'EventSource']) delete (globalThis as Record<string, unknown>)[k];

export interface ScadJob { engineDir: string; source: string; values?: ParamValues }
export interface ScadOutput {
  ok: boolean;
  params: ScadParam[];
  parts: { name: string; color: string; bbox: { min: number[]; max: number[] }; volume: number; triCount: number }[];
  png?: string;
  gridStep?: number;
  /** OpenSCAD's ECHO, WARNING and ERROR lines. */
  messages: string[];
  timeMs: number;
}

interface FS {
  mkdirTree(p: string): void;
  writeFile(p: string, data: string | Uint8Array): void;
  readFile(p: string, o?: { encoding: 'utf8' }): string;
}
type Instance = { FS: FS; callMain(args: string[]): number };
type Factory = (o: Record<string, unknown>) => Promise<Instance>;

const MAX_MESSAGES = 60;

async function run(job: ScadJob): Promise<ScadOutput> {
  const t0 = performance.now();
  const factory = (await import(pathToFileURL(path.join(job.engineDir, 'openscad.js')).href)).default as Factory;
  const wasm = await WebAssembly.compile(readFileSync(path.join(job.engineDir, 'openscad.wasm')));
  const zip = (name: string) => unzipSync(readFileSync(path.join(job.engineDir, 'libraries', `${name}.zip`)));
  // Without its (empty) fonts.conf, OpenSCAD's built-in font setup finds the fonts in /fonts.
  const fonts = Object.fromEntries(Object.entries(zip('fonts')).filter(([n]) => n !== 'fonts.conf'));
  // Libraries the script includes or uses (<BOSL2/std.scad> → BOSL2), from the ones that came with the engine.
  const available = new Set(readdirSync(path.join(job.engineDir, 'libraries')).map((f) => f.replace(/\.zip$/, '')));
  const wanted = [...job.source.matchAll(/\b(?:include|use)\s*<\s*([^/>]+)\//g)].map((m) => m[1].trim());
  const libraries = [...new Set(wanted)].filter((n) => available.has(n) && n !== 'fonts').map((n) => [n, zip(n)] as const);

  const messages: string[] = [];
  // Each OpenSCAD run needs a fresh instance (it exits after one).
  const once = async (args: string[], out: string): Promise<string | null> => {
    const scad = await factory({
      noInitialRun: true,
      instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) => { void WebAssembly.instantiate(wasm, imports).then(done); return {}; },
      print: (s: string) => note(s),
      printErr: (s: string) => note(s),
    });
    const write = (dir: string, files: Record<string, Uint8Array>) => {
      for (const [name, data] of Object.entries(files)) {
        if (name.endsWith('/')) continue;
        const p = `${dir}/${name}`;
        scad.FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
        scad.FS.writeFile(p, data);
      }
    };
    write('/fonts', fonts);
    for (const [name, files] of libraries) write(`/${name}`, files);
    scad.FS.writeFile('/model.scad', job.source);
    try { scad.callMain(['/model.scad', '--backend=manifold', ...args, '-o', out]); } catch { /* reported through its messages */ }
    try { return scad.FS.readFile(out, { encoding: 'utf8' }); } catch { return null; }
  };
  function note(s: string) {
    if (/^(ECHO|WARNING|ERROR|TRACE|Parser error|Execution aborted)/i.test(s) && messages.length < MAX_MESSAGES) messages.push(s.slice(0, 400));
  }

  const paramJson = await once(['--export-format=param'], '/out.param');
  let params: ScadParam[] = [];
  try { params = (JSON.parse(paramJson ?? '{}') as { parameters?: ScadParam[] }).parameters ?? []; } catch { /* no parameters */ }
  messages.length = 0; // the model run reports the same problems again, with its echoes
  const off = await once(scadDefines(job.values), '/out.off');
  if (!off) return { ok: false, params, parts: [], messages: messages.length ? messages : ['OpenSCAD produced no 3D model.'], timeMs: performance.now() - t0 };
  const parts = parseOff(off);
  const sheet = parts.length ? renderSheet(parts) : null;
  return {
    ok: parts.length > 0,
    params,
    parts: parts.map(({ name, color, bbox, volume, triCount }) => ({ name, color, bbox, volume, triCount })),
    png: sheet?.png.toString('base64'),
    gridStep: sheet?.gridStep,
    messages,
    timeMs: performance.now() - t0,
  };
}

process.once('message', (job: ScadJob) => {
  run(job).then(
    (out) => process.send?.({ out }, () => process.exit(0)),
    (e: Error) => process.send?.({ error: e.message }, () => process.exit(0)),
  );
});
