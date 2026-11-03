// OpenSCAD for .scad files attached in the chat. The engine (the OpenSCAD Playground's WebAssembly
// build, with its fonts and libraries such as BOSL2 and MCAD) is GPL software and not part of Jig:
// it is downloaded from npm the first time it is needed, checked against a pinned hash, and run in
// a separate locked-down process (server/openscad-worker.ts), on this server only, never sent to
// the browser.
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { abortable, bundleWorker, NODE_MODULES, PERMISSION_FLAG, stoppedError } from './geometry';
import { describeScadParams } from '../shared/scad';
import type { ParamValues } from '../shared/types';
import type { ScadJob, ScadOutput } from './openscad-worker';

const ENGINE = {
  version: '2.4.0',
  url: 'https://registry.npmjs.org/openscad-playground/-/openscad-playground-2.4.0.tgz',
  integrity: 'sha512-y9xoInvFz7WhkA/3izy3C6MwCeQ7xPvxQNg42bhlYsz8GdUdGschpJ7DhAn0nwZuJeILECujS/z8kDT/IbI0kw==',
};
/** Inside node_modules, the only place the worker may read. */
export const ENGINE_DIR = path.join(NODE_MODULES, '.cache', 'jig', `openscad-${ENGINE.version}`);
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export const engineInstalled = () => existsSync(path.join(ENGINE_DIR, 'openscad.wasm'));

let installing: Promise<void> | null = null;

/** Downloads the engine once (about 20 MB); `onStatus` hears about it when that is needed. */
export function ensureEngine(onStatus?: (text: string) => void): Promise<void> {
  if (engineInstalled()) return Promise.resolve();
  onStatus?.('Downloading the OpenSCAD engine (one time, about 20 MB)…');
  installing ??= install().finally(() => { installing = null; });
  return installing;
}

async function install() {
  const res = await fetch(ENGINE.url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`OpenSCAD engine download failed: HTTP ${res.status}`);
  const tgz = Buffer.from(await res.arrayBuffer());
  if (tgz.length > MAX_DOWNLOAD) throw new Error('OpenSCAD engine download is unexpectedly large');
  if (`sha512-${createHash('sha512').update(tgz).digest('base64')}` !== ENGINE.integrity) throw new Error('OpenSCAD engine download does not match its expected hash');
  const tmp = `${ENGINE_DIR}.${process.pid}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(path.join(tmp, 'libraries'), { recursive: true });
  for (const [name, data] of untar(gunzipSync(tgz))) {
    const lib = /^package\/dist\/libraries\/([\w.-]+\.zip)$/.exec(name);
    if (name === 'package/dist/wasm/openscad.js' || name === 'package/dist/wasm/openscad.wasm') await writeFile(path.join(tmp, path.basename(name)), data);
    else if (lib) await writeFile(path.join(tmp, 'libraries', lib[1]), data);
  }
  if (!existsSync(path.join(tmp, 'openscad.wasm'))) throw new Error('OpenSCAD engine package has no openscad.wasm');
  await rm(ENGINE_DIR, { recursive: true, force: true });
  await rename(tmp, ENGINE_DIR);
}

/** The regular files in a tar archive (npm packages use plain ustar). */
function* untar(buf: Buffer): Generator<[string, Buffer]> {
  for (let at = 0; at + 512 <= buf.length;) {
    const header = buf.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const str = (from: number, len: number) => header.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const prefix = str(345, 155);
    const name = (prefix ? `${prefix}/` : '') + str(0, 100);
    const type = str(156, 1);
    at += 512;
    if (type === '0' || type === '') yield [name, buf.subarray(at, at + size)];
    at += Math.ceil(size / 512) * 512;
  }
}

/**
 * Renders a .scad source with OpenSCAD at the given Customizer values (defaults for the rest).
 * `signal` (the generation's) aborting stops the wait for the engine download and kills OpenSCAD.
 */
export async function runScad(source: string, values?: ParamValues, onStatus?: (text: string) => void, signal?: AbortSignal): Promise<ScadOutput> {
  if (signal?.aborted) throw stoppedError();
  // (The download itself goes on: another file may be waiting for it.)
  await abortable(ensureEngine(onStatus), signal);
  const child = fork(bundleWorker('openscad-worker'), [], {
    execArgv: [PERMISSION_FLAG, '--disable-warning=ExperimentalWarning', `--allow-fs-read=${NODE_MODULES}`, '--max-old-space-size=1024'],
    env: {},
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return workerResult(child, { engineDir: ENGINE_DIR, source, values } satisfies ScadJob, TIMEOUT_MS, signal);
}

/** The part of a ChildProcess workerResult uses (tests pass a stand-in). */
export type WorkerChild = Pick<ChildProcess, 'on' | 'once' | 'send' | 'kill'>;

/**
 * Sends `job` to a forked OpenSCAD worker and settles once, with its answer or the first thing that
 * goes wrong: an error reply, the worker exiting, the time running out, `signal` aborting (Stop), or
 * the fork or send failing (an 'error' event, which would otherwise crash the server). The worker is
 * killed on every failure.
 */
export function workerResult(child: WorkerChild, job: ScadJob, timeoutMs: number, signal?: AbortSignal): Promise<ScadOutput> {
  return new Promise<ScadOutput>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const fail = (e: Error) => settle(() => { child.kill(); reject(e); });
    const onAbort = () => fail(stoppedError());
    const timer = setTimeout(() => fail(new Error(`OpenSCAD took longer than ${timeoutMs / 1000} s`)), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    // on, not once: a child process can emit 'error' more than once (a failed kill after a failed send).
    child.on('error', (e: Error) => fail(new Error(`OpenSCAD could not run: ${e.message}`)));
    child.once('message', (m: { out?: ScadOutput; error?: string }) => settle(() => {
      if (m.out) resolve(m.out); else reject(new Error(m.error ?? 'OpenSCAD failed'));
    }));
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => settle(() => reject(new Error(`OpenSCAD stopped (${signal ?? `code ${code}`})`))));
    try {
      child.send(job, (e) => { if (e) fail(new Error(`OpenSCAD could not run: ${e.message}`)); });
    } catch (e) {
      fail(new Error(`OpenSCAD could not run: ${(e as Error).message}`));
    }
  });
}

const f = (n: number, d = 2) => (Math.abs(n) < 1e-9 ? 0 : n).toFixed(d);

/** What OpenSCAD made of a file, for Claude. */
export function formatScadReport(r: ScadOutput): string {
  const lines = [`${r.ok ? 'OK' : 'FAILED'} – OpenSCAD ran in ${Math.round(r.timeMs)} ms.`, `Customizer parameters:\n${describeScadParams(r.params)}`];
  if (r.parts.length) {
    lines.push(`Parts (one per color() in the file):`);
    for (const p of r.parts) {
      const b = p.bbox;
      lines.push(`  - ${p.name}: ${f(b.max[0] - b.min[0])} × ${f(b.max[1] - b.min[1])} × ${f(b.max[2] - b.min[2])} mm, X[${f(b.min[0])}, ${f(b.max[0])}] Y[${f(b.min[1])}, ${f(b.max[1])}] Z[${f(b.min[2])}, ${f(b.max[2])}], volume ${f(p.volume / 1000, 3)} cm³, ${p.triCount} triangles`);
    }
  }
  if (r.messages.length) lines.push(`OpenSCAD output:\n${r.messages.map((m) => `  ${m}`).join('\n')}`);
  return lines.join('\n');
}
