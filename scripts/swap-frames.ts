// Frames for a looping "swap" product video, made the way the owner makes them by hand: each chosen
// version of a design exported as a GLB in the running app, shown front-on in a model-viewer page,
// screenshotted at 1080 x 1080 and cropped to 900 x 900 with ONE box for every frame (taken from the
// first version's plaque), so versions that line up stay lined up pixel for pixel.
//
//   node --import tsx scripts/swap-frames.ts --app http://localhost:8000 --design <id> --versions 1,2,3 \
//     --out <dir> [--password <pw>] [--reel /path/to/swap-reel.sh]
//
// The design itself is never changed: each version is put into a TEMPORARY design, exported from there
// and the temporary design is deleted again (also on Ctrl+C or a kill; a warning names one that could
// not be deleted). Prints the swap-reel.sh command (runs it with --reel).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright-core';
import type { DesignVersion } from '../shared/types';

export interface PixelBox { x: number; y: number; w: number; h: number }

export const FRAME = 1080;
export const CROP = 900;
const BACKGROUND = [0xf4, 0xf6, 0xfa];
const MODEL_VIEWER = 'https://unpkg.com/@google/model-viewer@4.0.0/dist/model-viewer.min.js';

/** Whether one of the two versions is a picture edit of the other that lines up with it. */
function linkedUp(versions: DesignVersion[], a: number, b: number): boolean {
  const edit = (v: number, of: number) => !!versions[v]?.pictureEdit?.linesUp && versions[v].pictureEdit!.parent === of;
  return edit(b, a) || edit(a, b);
}

/**
 * The swap-reel.sh -t list for `picked` (0-based version indexes, in order): one entry per step and a
 * last one for the loop back to the first. A fade only where the two lined-up versions meet, else a slide.
 */
export function transitions(versions: DesignVersion[], picked: number[]): string[] {
  return picked.map((from, i) => (linkedUp(versions, from, picked[(i + 1) % picked.length]) ? 'fade' : 'slideleft'));
}

/** The pixels of an RGBA frame that are not the background (with a small tolerance), as a box; null when there are none. */
export function plaqueBounds(rgba: ArrayLike<number>, width: number, height: number, tolerance = 6): PixelBox | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] === 0) continue;
      if (Math.abs(rgba[i] - BACKGROUND[0]) > tolerance || Math.abs(rgba[i + 1] - BACKGROUND[1]) > tolerance || Math.abs(rgba[i + 2] - BACKGROUND[2]) > tolerance) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A `size` x `size` box centred on `bounds`, clamped to stay inside the `frame` x `frame` picture. */
export function cropBox(bounds: PixelBox, size: number, frame = FRAME): PixelBox {
  const start = (from: number, length: number) => Math.max(0, Math.min(frame - size, Math.round(from + length / 2 - size / 2)));
  return { x: start(bounds.x, bounds.w), y: start(bounds.y, bounds.h), w: size, h: size };
}

/** The body that creates a temporary design holding only `version`, which is not marked as a picture edit there. */
export function temporaryDesign(version: DesignVersion, id: string, now: number) {
  const { pictureEdit: _, ...plain } = version;
  return { id, name: 'swap-frames temp', createdAt: now, updatedAt: now, code: plain.code, values: plain.values ?? {}, messages: [], versions: [plain], currentVersion: 0 };
}

/** Deletes a temporary design; when that fails, warns with its id (to delete it by hand) and returns false. */
export async function deleteTemporary(app: string, auth: Record<string, string>, id: string, send: typeof fetch = fetch): Promise<boolean> {
  let why: string;
  try {
    const res = await send(`${app}/api/designs/${id}`, { method: 'DELETE', headers: { 'X-PTP': '1', ...auth } });
    if (res.ok) return true;
    why = `HTTP ${res.status}`;
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  console.warn(`warning: could not delete the temporary design ${id} (${why}): delete it in the app`);
  return false;
}

// ---- the browser part -------------------------------------------------------------------------

/** What a Ctrl+C or a kill must clean up: the temporary design being exported and the browser. */
const open: { temporary?: { app: string; auth: Record<string, string>; id: string }; browser?: Browser } = {};

/** On SIGINT or SIGTERM: delete the temporary design, close the browser, exit non-zero. */
function cleanUpOnSignals() {
  const stop = async (signal: NodeJS.Signals) => {
    console.error(`\n${signal}: cleaning up`);
    const t = open.temporary;
    if (t) await deleteTemporary(t.app, t.auth, t.id);
    await open.browser?.close().catch(() => undefined);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const viewerPage = (glbUrl: string) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#F4F6FA}model-viewer{width:${FRAME}px;height:${FRAME}px;background:#F4F6FA;--poster-color:transparent;--progress-bar-color:transparent;--progress-bar-height:0}model-viewer::part(default-progress-bar){display:none}</style>
<script type="module" src="${MODEL_VIEWER}"></script>
<model-viewer id="mv" src="${glbUrl}" camera-orbit="0deg 90deg auto" field-of-view="20deg" environment-image="neutral"
  interaction-prompt="none" disable-zoom disable-pan></model-viewer>`;

async function main() {
  const app = (arg('app') ?? 'http://localhost:8000').replace(/\/$/, '');
  const designId = arg('design');
  const out = arg('out');
  const numbers = (arg('versions') ?? '').split(',').filter(Boolean).map(Number);
  if (!designId || !out || numbers.length < 2 || numbers.some((n) => !Number.isInteger(n) || n < 1)) {
    console.error('usage: swap-frames.ts --app <url> --design <id> --versions 1,2,3 --out <dir> [--password <pw>] [--reel <swap-reel.sh>]');
    process.exit(2);
  }
  const password = arg('password');
  const reel = arg('reel');
  const auth: Record<string, string> = password ? { Authorization: `Basic ${Buffer.from(`ptp:${password}`).toString('base64')}` } : {};

  const res = await fetch(`${app}/api/designs/${designId}`, { headers: auth });
  if (!res.ok) throw new Error(`could not read design ${designId}: ${res.status}`);
  const design = await res.json() as { versions: DesignVersion[] };
  const picked = numbers.map((n) => n - 1);
  for (const i of picked) if (!design.versions?.[i]) throw new Error(`the design has no version ${i + 1}`);
  mkdirSync(out, { recursive: true });

  cleanUpOnSignals();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch();
  open.browser = browser;
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true, ...(password ? { httpCredentials: { username: 'ptp', password } } : {}) });
    context.setDefaultTimeout(120_000);
    const page = await context.newPage();
    // The viewer page and the GLB are answered from memory on a made-up origin.
    const origin = 'http://swap-frames.local';
    let glb: Buffer = Buffer.alloc(0);
    await page.route(`${origin}/**`, (route) => route.request().url().endsWith('.glb')
      ? route.fulfill({ body: glb, contentType: 'model/gltf-binary' })
      : route.fulfill({ body: viewerPage(`${origin}/model.glb`), contentType: 'text/html' }));
    let box: PixelBox | null = null;
    const frames: string[] = [];
    for (const index of picked) {
      glb = await exportGlb(page, app, auth, design.versions[index]);
      await page.setViewportSize({ width: FRAME, height: FRAME });
      await page.goto(`${origin}/index.html`);
      // As a string: tsx would add a helper to a function that the page does not have.
      await page.evaluate(`new Promise((resolve, reject) => {
        const mv = document.getElementById('mv');
        const ready = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        if (mv.loaded) ready();
        else { mv.addEventListener('load', ready, { once: true }); mv.addEventListener('error', () => reject(new Error('model-viewer could not load the model')), { once: true }); }
      })`);
      if (!box) {
        const full = await page.screenshot({ clip: { x: 0, y: 0, width: FRAME, height: FRAME } });
        const pixels = await page.evaluate(`(async () => {
          const img = new Image();
          img.src = 'data:image/png;base64,${full.toString('base64')}';
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.width; canvas.height = img.height;
          const c = canvas.getContext('2d');
          c.drawImage(img, 0, 0);
          return { w: img.width, h: img.height, data: Array.from(c.getImageData(0, 0, img.width, img.height).data) };
        })()`) as { w: number; h: number; data: number[] };
        const bounds = plaqueBounds(pixels.data, pixels.w, pixels.h);
        if (!bounds) throw new Error('the first version rendered as an empty picture');
        box = cropBox(bounds, CROP);
        console.log(`crop box ${box.x},${box.y} ${box.w}x${box.h} (plaque ${bounds.x},${bounds.y} ${bounds.w}x${bounds.h})`);
      }
      const file = path.join(out, `v${index + 1}.png`);
      writeFileSync(file, await page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h } }));
      frames.push(file);
      console.log(`wrote ${file}`);
    }
    const args = ['-t', transitions(design.versions, picked).join(','), path.join(out, 'swap'), ...frames];
    console.log(`\n${reel ?? 'swap-reel.sh'} ${args.join(' ')}`);
    if (reel) {
      const run = spawnSync(reel, args, { stdio: 'inherit' });
      if (run.status !== 0) throw new Error(`swap-reel.sh failed (${run.status ?? run.error})`);
    }
  } finally {
    await browser.close();
  }
}

/** Puts `version` into a temporary design, exports its GLB through the app's own Export GLB, deletes the temporary design. */
async function exportGlb(page: Page, app: string, auth: Record<string, string>, version: DesignVersion): Promise<Buffer> {
  const id = randomUUID();
  // Known before it exists: a Ctrl+C while it is being created still deletes it.
  open.temporary = { app, auth, id };
  const put = await fetch(`${app}/api/designs/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PTP': '1', ...auth }, body: JSON.stringify(temporaryDesign(version, id, Date.now())) });
  if (!put.ok) { open.temporary = undefined; throw new Error(`could not create the temporary design: ${put.status}`); }
  try {
    await page.setViewportSize({ width: 1400, height: 850 });
    await page.goto(`${app}/?design=${id}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - swap-frames temp');
    await page.getByRole('button', { name: 'More export formats' }).click();
    await page.getByRole('button', { name: /GLB… \(shop 3D view\)/ }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export GLB' }).click()]);
    return readFileSync((await download.path())!);
  } finally {
    // Still known while it is deleted: a Ctrl+C meanwhile deletes it again (a DELETE of a design that is gone is fine).
    await deleteTemporary(app, auth, id);
    open.temporary = undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
