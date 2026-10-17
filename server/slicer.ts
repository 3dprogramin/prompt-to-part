// Slicing a Bambu Studio project with the user's Bambu Studio, to learn how much filament it uses and
// how long it prints – the numbers Bambu Studio itself shows. One slice at a time.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { unzipSync, strFromU8 } from 'fflate';
import { DATA_DIR } from './config';
import { findBambuBinary } from './bambu';
import type { SliceStats } from '../shared/cost';

const run = promisify(execFile);
// Bambu Studio's own settings for these runs, so the user's Bambu Studio configuration is never touched.
const SLICER_DATA = path.join(DATA_DIR, 'bambu', 'slicer-data');
const TIMEOUT_MS = 5 * 60_000;

let chain: Promise<unknown> = Promise.resolve();

/**
 * Slice plate 1 of a Bambu Studio project (.3mf); rejects with Bambu Studio's reason if it can't.
 * Filament changes in the project (LayerTone prints) are sliced too, so each filament's grams are its own.
 */
export async function sliceProject(project: Uint8Array): Promise<SliceStats> {
  const info = (await slicedProject(project))['Metadata/slice_info.config'];
  if (!info) throw new Error('Bambu Studio sliced it but reported no print time or filament');
  return parseSliceInfo(strFromU8(info));
}

/** The files of the sliced project (Metadata/plate_1.gcode, Metadata/slice_info.config…); one slice at a time. */
export function slicedProject(project: Uint8Array): Promise<Record<string, Uint8Array>> {
  const job = chain.then(() => slice(project));
  chain = job.catch(() => undefined);
  return job;
}

async function slice(project: Uint8Array): Promise<Record<string, Uint8Array>> {
  const bin = await findBambuBinary();
  if (!bin) throw new Error('Bambu Studio was not found on this computer');
  const work = await mkdtemp(path.join(os.tmpdir(), 'jig-slice-'));
  try {
    const input = path.join(work, 'project.3mf'), out = path.join(work, 'out');
    await writeFile(input, project);
    await mkdir(out);
    await mkdir(SLICER_DATA, { recursive: true });
    const failed = await run(bin, ['--datadir', SLICER_DATA, '--slice', '0', '--export-3mf', 'sliced.3mf', '--outputdir', out, input],
      { cwd: work, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }).then(() => null, (e: Error & { killed?: boolean }) => e);
    // Bambu Studio explains a failed slice (e.g. G-code outside the plate) in result.json.
    const result = await readFile(path.join(out, 'result.json'), 'utf8').then((t) => JSON.parse(t) as { return_code?: number; error_string?: string }, () => null);
    if (failed?.killed) throw new Error(`Bambu Studio took more than ${TIMEOUT_MS / 60000} minutes to slice`);
    if (result && result.return_code !== 0) throw new Error(`Bambu Studio couldn't slice it: ${result.error_string ?? `code ${result.return_code}`}`);
    const sliced = await readFile(path.join(out, 'sliced.3mf')).catch(() => null);
    if (!sliced) throw new Error(`Bambu Studio didn't slice it${failed ? `: ${failed.message.split('\n')[0]}` : ''}`);
    return unzipSync(new Uint8Array(sliced));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Print time and filament of plate 1 from a sliced project's Metadata/slice_info.config. */
export function parseSliceInfo(xml: string): SliceStats {
  const meta = (key: string) => Number(new RegExp(`<metadata key="${key}" value="([^"]*)"`).exec(xml)?.[1]);
  const filaments = [...xml.matchAll(/<filament\b([^>]*)\/?>/g)].map(([, attrs]) => ({
    color: /\bcolor="([^"]*)"/.exec(attrs)?.[1] ?? '',
    grams: Number(/\bused_g="([^"]*)"/.exec(attrs)?.[1]),
  })).filter((f) => Number.isFinite(f.grams));
  const seconds = meta('prediction'), weight = meta('weight');
  const grams = Number.isFinite(weight) ? weight : filaments.reduce((s, f) => s + f.grams, 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(grams)) throw new Error('Bambu Studio reported no print time or filament');
  return { seconds, grams, filaments };
}
