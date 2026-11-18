// UI smoke test (`pnpm test:ui`): the built app in one headless Chromium against a throwaway
// server with its own data folder and a stand-in for Claude, so it never touches your designs, the
// Docker container or your Claude usage. It opens a tiny cube design and checks the top bar, the 3D
// view, a link in a reply, the Print tab (which must not start a slice by itself), the Designs menu's export and
// import, Export project… (as a zip), stepping through enlarged product photos, a reply that was cut short, one that goes on through a reload or a dropped connection, the Meshy credits on the 3D figure button, a coloured figure (and repainting a patch of it),
// "Print in one colour" in the Print tab, and the chat's model chip, "Send my view" and the 3D figure's ▾ menu ("Wait for my OK") with a concept
// picture's countdown, Ask first's question card (clicked answers sent as the next message), the small-screen layouts: a phone (one panel at a time, picked in the bottom tab bar)
// and an unfolded foldable (the 3D view beside the chat or the side panel), the Designs menu's search, the
// picture mode menu on a phone (every mode, Line art's style ▾) and a part's filament picker in the Object
// tab, Shop photos (a set of 5 from their own renders, the size one beside a light switch, with a stand-in for the image model), and sale sizes (S / M / L built, shown and
// resized alone, sliced one at a time by a stand-in for Bambu Studio, scene photos for every size from one scene), and a picture edit from the artwork brush (the
// stand-in fills the area marked), also on a version marked printed meanwhile, and from a LayerTone photo's picture editor, and the Settings dialog's Filaments tab (adding from the library, rolls, custom filaments, phone width, the picker's link). Each test closes its pages, passed or not, and has a bounded time. A screenshot of each step is saved to
// PTP_UI_SHOTS (default: a temp folder) for a look at what the browser saw.
// Needs Playwright's Chromium (`pnpm exec playwright-core install chromium` once).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from 'playwright-core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { encode as encodePng } from 'fast-png';
import { FILAMENT_LIBRARY, filamentLines } from '../../shared/filaments';
import { libraryBrands, libraryLines } from '../../src/components/settings/filamentsTab';
import type { AgentEvent, GenerateRequest } from '../../shared/api';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-ui-test-'));
process.env.PTP_DATA = dataDir;
process.env.NODE_ENV = 'production';
// The stand-in for Claude needs no credentials, but the API checks them first.
process.env.PTP_AUTH = 'subscription';
process.env.PTP_CLAUDE = ''; // the mode set here, whatever PTP_CLAUDE the shell or .env names
delete process.env.PTP_DOCKER;
// The Settings test types its own Meshy key and expects the provider address locked: nothing of this
// computer's environment may decide that. Set but empty, so the .env next to package.json (which only
// fills variables that are not set) cannot bring them back.
for (const name of ['PTP_PASSWORD', 'MESHY_API_KEY', 'ANTHROPIC_BASE_URL']) process.env[name] = '';
// No presets of this computer's Bambu Studio user in the printer list.
process.env.BAMBU_STUDIO_USER_DIR = path.join(dataDir, 'no-bambu-user');
const shots = process.env.PTP_UI_SHOTS ?? path.join(os.tmpdir(), 'ptp-ui-shots');
mkdirSync(shots, { recursive: true });

const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const { createApp } = await import('../../server/app');
// Stand-ins for Claude and for the connection check (the real one would start Claude Code with this
// computer's login to read the subscription's usage).
const connectionAsks: boolean[] = []; // every connection check the page asked for: true when it asked for a fresh one
const connection = async (fresh = false) => (connectionAsks.push(fresh), { via: 'subscription' as const, ok: true, detail: 'Stand-in for the smoke test.',
  usage: [{ kind: 'five_hour', label: '5-hour', percent: 62, resetsAt: Date.now() + 3600_000, limited: false, at: Date.now() }] });
// The browser's connections, to drop them as a phone locking its screen would.
const sockets = new Set<Socket>();
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
// The one reply it generates, "a slow cube", waits for finishSlowCube() (or Stop).
let finishSlowCube = () => {};
// A reply that edits a picture in the chat (edit_picture), set up by its test.
const chatEdit: { prompt: string; reply: (req: GenerateRequest, send: (e: AgentEvent) => void) => void } = { prompt: '', reply: () => {} };
// A stand-in for the image model (the shop photos test): the "photo" is the render it was sent,
// held until openImages() and refused once for a close-up; what it was asked for is kept. A picture
// edit is answered at once (blackInMark) and kept apart (editAsks).
let openImages = () => {};
const imagesOpen = new Promise<void>((resolve) => { openImages = resolve; });
const imageAsks: { prompt: string; aspect: string; size?: string }[] = [];
const editAsks: { prompt: string; aspect: string; size?: string; references: number }[] = [];
let refuseCloseUp = true;
const { decodeImage } = await import('../../server/artwork');
/** A picture edit's stand-in answer: the crop sent, filled with black inside the area outlined in magenta (on the second picture), row by row. */
const blackInMark = (references: string[]) => {
  const raster = (url: string) => decodeImage(Buffer.from(url.split(',')[1], 'base64'));
  const crop = raster(references[0]), outlined = raster(references[1]), w = crop.width, data = new Uint8Array(crop.data);
  for (let j = 0; j < crop.height; j++) {
    let lo = -1, hi = -1;
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4, d = outlined.data;
      if (d[o] > 200 && d[o + 1] < 80 && d[o + 2] > 200) { if (lo < 0) lo = i; hi = i; }
    }
    for (let i = lo; lo >= 0 && i <= hi; i++) data.set([0x11, 0x11, 0x11], (j * w + i) * 4);
  }
  return { image: { data: Buffer.from(encodePng({ width: w, height: crop.height, data, channels: 4 })).toString('base64'), mediaType: 'image/png' }, model: 'test/image', cost: 0.04 };
};
/** How the next picture edit is answered: at once, held until it is stopped, or refused. */
let nextEdit: 'answer' | 'hold' | 'fail' = 'answer';
let editStopped = false;
const image = async (prompt: string, aspect: string, references: string[] | undefined, signal?: AbortSignal, _onStatus?: unknown, size?: string) => {
  // (A picture edit is answered at once, and kept apart from the photos asked for.)
  if (prompt.includes('outlined in magenta')) {
    editAsks.push({ prompt, aspect, size, references: references?.length ?? 0 });
    const how = nextEdit;
    nextEdit = 'answer';
    if (how === 'fail') throw new Error('test/image is busy');
    if (how === 'hold') return new Promise<never>((_, reject) => signal!.addEventListener('abort', () => { editStopped = true; reject(new Error('Stopped')); }));
    return blackInMark(references!);
  }
  imageAsks.push({ prompt, aspect, size });
  await imagesOpen;
  if (refuseCloseUp && prompt.includes('CLOSE-UP DETAIL')) { refuseCloseUp = false; throw new Error('test/image is busy'); }
  const [, mediaType, data] = /^data:([^;]+);base64,(.+)$/s.exec(references![0])!;
  return { image: { data, mediaType }, model: 'test/image', cost: 0.1 };
};
server.on('request', createApp({ port, password: '', connection, image, ideas: async () => '[{"text":"A test idea for the smoke test","mode":"lithophane"}]', generate: async (req, send, abort) => {
  if (req.prompt === chatEdit.prompt) return chatEdit.reply(req, send);
  if (req.prompt !== 'a slow cube') throw new Error('the smoke test never generates');
  send({ type: 'step', step: { kind: 'status', text: 'Measuring the slow cube' } });
  await new Promise<void>((resolve) => { finishSlowCube = resolve; abort.signal.addEventListener('abort', () => resolve()); });
  if (!abort.signal.aborted) send({ type: 'done', durationMs: 5000, turns: 1, submitted: false, text: 'The slow cube is done.' });
} }));

// Headless Chromium renders in software here, so a model build can take a while: waits are generous
// but bounded, and so is each test (a hang fails it rather than the run going on for ever).
const WAIT = 60_000;
const TEST = { timeout: 180_000 };
let browser: Browser;
let stopGeometry = () => {};
before(async () => { browser = await chromium.launch(); });
// Each test's pages go when it ends, passed or not, so a failure doesn't leave a 3D view rendering.
afterEach(async () => { await Promise.all(browser?.contexts().map((c) => c.close().catch(() => {})) ?? []); });
after(async () => {
  try {
    await browser?.close();
  } finally {
    stopGeometry();
    server.closeAllConnections();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
/** A page in its own context, with the generous timeouts. */
async function newPage(options: BrowserContextOptions = { viewport: { width: 1400, height: 850 } }): Promise<Page> {
  const context = await browser.newContext(options);
  context.setDefaultTimeout(WAIT);
  return context.newPage();
}
/** Waits for the server side of something (polled), failing with `what` after `ms`. */
async function until(check: () => Promise<boolean>, what: string, ms = 15_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((r) => setTimeout(r, 200))) assert.ok(Date.now() < end, what);
}
const getDesign = async (designId: string) => (await fetch(`${A}/api/designs/${designId}`)).json();
const putDesign = (design: Record<string, unknown>) => fetch(`${A}/api/designs/${design.id}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PTP': '1' }, body: JSON.stringify(design) });
/** The model is built: its parts listed in the Object tab, the view no longer evaluating. */
async function built(page: Page) {
  await page.locator('.object-tree [role=treeitem]').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('.busy-dot')?.textContent);
}

const A = `http://127.0.0.1:${port}`;
// A Galaxy Z Fold's cover screen (as CSS pixels), touch only.
const PHONE: BrowserContextOptions = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const id = 'ui-smoke-00000001';
const code = 'function build() { return Manifold.cube([20, 20, 20]); }';

// First, while the data folder is new (no designs yet: a first start).
test('a first start asks for the printer; the Print tab changes it, and the plate and checks follow', TEST, async () => {
  const page = await newPage();
  try {
    await page.goto(`${A}/`);
    const dialog = page.getByRole('dialog', { name: 'Which printer do you have?' });
    await dialog.waitFor();
    await page.screenshot({ path: path.join(shots, '0-first-start.png') });
    await dialog.getByLabel('Printer', { exact: true }).selectOption('Bambu Lab A1 mini');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });
    const info = await (await fetch(`${A}/api/printer`)).json();
    assert.equal(info.printer.name, 'Bambu Lab A1 mini');
    assert.equal(info.firstStart, false);

    // A 200 mm cube doesn't fit the A1 mini's 180 mm plate; switched to the A1 it does.
    const big = 'function build() { return Manifold.cube([200, 20, 20]); }';
    const pid = 'ui-smoke-printer-1';
    const saved = await putDesign({ id: pid, name: 'Printer bar', createdAt: 1, updatedAt: 1000, code: big, messages: [], values: {}, currentVersion: 0, versions: [{ code: big, summary: 'A bar', createdAt: 1000, source: 'manual' }] });
    assert.equal(saved.status, 200, await saved.text());
    await page.goto(`${A}/?design=${pid}`);
    await built(page);
    await page.locator('.plate-label', { hasText: 'Bambu Lab A1 mini · 180 × 180 mm plate' }).waitFor();
    const fits = (name: string, yes: string) => page.locator('table.kv tr', { hasText: `Fits ${name}` }).filter({ hasText: yes }).waitFor();
    await page.getByRole('tab', { name: /Code/ }).click();
    await fits('Bambu Lab A1 mini', 'No');
    // The on-demand check says it's too big; a printer switch takes its report away (it was for the old printer).
    await page.getByRole('button', { name: 'Validate' }).click();
    await page.getByText('Too big for the Bambu Lab A1 mini').first().waitFor();
    await page.getByRole('tab', { name: /Print/ }).click();
    await page.locator('.pp-printer', { hasText: 'Bambu Lab A1 mini' }).waitFor();
    await page.locator('.pp-printer').getByRole('button', { name: 'Change' }).click();
    const change = page.getByRole('dialog', { name: 'Printer' });
    await change.getByLabel('Printer', { exact: true }).selectOption('Bambu Lab A1');
    await change.getByLabel('Filaments it loads at once').selectOption('8');
    await page.screenshot({ path: path.join(shots, '0-change-printer.png') });
    await change.getByRole('button', { name: 'Save' }).click();
    await change.waitFor({ state: 'detached' });
    await page.locator('.plate-label', { hasText: 'Bambu Lab A1 · 256 × 256 mm plate' }).waitFor();
    await page.locator('.pp-printer', { hasText: 'loads 8 filaments at once' }).waitFor();
    await page.screenshot({ path: path.join(shots, '0-print-tab-printer.png') });
    assert.equal(await page.getByText('Too big for the Bambu Lab A1 mini').count(), 0, 'the old printer\'s check report is gone');
    await page.getByRole('tab', { name: /Code/ }).click();
    await fits('Bambu Lab A1', 'Yes');
  } finally {
    await page.close();
    // Gone without a trace (the API's delete would also write tags.json, which the backup test counts).
    rmSync(path.join(dataDir, 'designs', 'ui-smoke-printer-1.json'), { force: true });
    rmSync(path.join(dataDir, 'designs', 'ui-smoke-printer-1'), { recursive: true, force: true });
    // The rest of the tests run with the A1 0.4 and 4 filaments.
    await fetch(`${A}/api/printer`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PTP': '1' }, body: JSON.stringify({ printerId: 'Bambu Lab A1 0.4 nozzle', filaments: 4 }) });
  }
});

test('the app opens a design: top bar, 3D view, Print tab without an automatic slice', TEST, async () => {
  const saved = await fetch(`${A}/api/designs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-PTP': '1' },
    body: JSON.stringify({ id, name: 'Smoke cube', createdAt: 1, updatedAt: 1000, code,
      messages: [{ id: 'm1', role: 'assistant', text: 'A cube. Battery: [DJI Store (EU)](https://store.dji.com/p?vid=1).', createdAt: 1000 }], values: {}, currentVersion: 0,
      versions: [{ code, summary: 'A 20 mm cube', createdAt: 1000, source: 'manual' }] }),
  });
  assert.equal(saved.status, 200, await saved.text());

  const page = await newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const slices: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/slice')) slices.push(r.url()); });

  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => (document.querySelector('.design-name') as HTMLInputElement | null)?.value === 'Smoke cube');
  await page.waitForFunction(() => document.title === 'prompt-to-part - Smoke cube');
  assert.equal(await page.locator('.app-version').textContent(), `v${version}`);
  assert.equal(await page.locator('a.btn', { hasText: 'New' }).getAttribute('href'), '/');
  await page.locator('.conn-chip', { hasText: 'Claude subscription · 62%' }).waitFor();
  assert.equal(await page.locator('.conn-chip .conn-win').textContent(), '5h');
  await page.locator('canvas').first().waitFor();
  await built(page);
  await page.screenshot({ path: path.join(shots, '1-design.png') });
  // A markdown link in a reply opens in a new tab.
  const dji = page.locator('.md-bubble a', { hasText: 'DJI Store (EU)' });
  assert.equal(await dji.getAttribute('href'), 'https://store.dji.com/p?vid=1');
  assert.equal(await dji.getAttribute('target'), '_blank');

  await page.getByRole('tab', { name: /Print/ }).click();
  const cost = page.locator('.cost-panel');
  await cost.waitFor();
  // With Bambu Studio installed there is a Slice button; without, a note saying it is needed.
  await cost.getByRole('button', { name: 'Slice', exact: true }).or(cost.getByText('Needs Bambu Studio installed', { exact: false })).first()
    .waitFor().catch(async (e) => { throw new Error(`${e.message}\nCost panel: ${await cost.innerText()}`); });
  // Nothing to wait for when nothing should happen: the model is built and the panel is up, so a slice
  // started by either would have gone out by now; a moment of quiet on the network makes sure.
  await page.waitForLoadState('networkidle');
  assert.deepEqual(slices, [], 'opening the Print tab must not slice');
  await cost.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, '2-print.png') });

  // More print settings, in folded groups below the main rows: closed, and a change shows a mark.
  const groups = page.locator('details.pp-group');
  assert.deepEqual(await groups.locator('> summary').allInnerTexts(), ['Supports', 'Top surface', 'Seam', 'Ironing', 'Fit', 'Advanced']);
  for (const g of await groups.all()) assert.equal(await g.evaluate((d) => (d as HTMLDetailsElement).open), false, 'groups start closed');
  const advanced = groups.filter({ has: page.locator('> summary', { hasText: 'Advanced' }) });
  await advanced.locator('> summary').click();
  const vase = advanced.getByRole('button', { name: 'On', exact: true });
  await vase.click();
  await advanced.getByText('Prints as one continuous wall: 1 wall, no top layers, no infill, no supports. One part, one colour.').waitFor();
  assert.equal(await vase.getAttribute('aria-pressed'), 'true');
  await advanced.locator('> summary .sr-only', { hasText: '(changed)' }).waitFor();
  await page.locator('details.pp-fold > summary', { hasText: 'Written to the 3MF' }).click();
  await page.locator('.pp-summary li', { hasText: 'spiral mode 1' }).waitFor();
  // Every group open (turn supports and ironing on to see their rows): nothing wider than the panel, on desktop and phone.
  await page.locator('.print-panel .pp-row', { hasText: 'Supports' }).first().getByRole('button', { name: 'Normal' }).click();
  await page.locator('.print-panel .pp-row', { hasText: 'Ironing' }).first().locator('select').selectOption('top');
  for (const g of await groups.all()) if (!(await g.evaluate((d) => (d as HTMLDetailsElement).open))) await g.locator('> summary').click();
  const overflow = () => page.evaluate(() => [...document.querySelectorAll('.print-panel *')].filter((e) => e.getBoundingClientRect().right > (e.closest('.print-panel') as HTMLElement).getBoundingClientRect().right + 1).map((e) => e.className || e.tagName));
  assert.deepEqual(await overflow(), [], 'nothing overflows the Print tab');
  await groups.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, '2-print-groups.png') });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('tab', { name: 'Panel', exact: true }).click();
  await groups.first().scrollIntoViewIfNeeded();
  assert.deepEqual(await overflow(), [], 'nothing overflows the Print tab at phone width');
  await page.screenshot({ path: path.join(shots, '2-print-groups-phone.png') });
  await page.setViewportSize({ width: 1400, height: 850 });
  await advanced.getByRole('button', { name: 'Off', exact: true }).click();
  await page.locator('.pp-summary li', { hasText: 'spiral mode' }).waitFor({ state: 'detached' });
  // Off is still the user's own choice (a "You" row) until it is reset; then nothing in the group is changed.
  await advanced.getByRole('button', { name: 'Reset Spiral vase' }).click();
  await advanced.locator('> summary .sr-only').waitFor({ state: 'detached' });
  assert.deepEqual(slices, [], 'the new settings must not slice');

  // Product photos: the suggested scene, one more and Your idea…; the other 22 after "More scenes", searchable.
  await page.getByRole('button', { name: 'Product photos' }).click();
  const scenes = page.locator('.ph-scenes [role=radio]');
  await page.getByRole('button', { name: 'More scenes (22 more)' }).waitFor();
  assert.equal(await scenes.count(), 3);
  await page.getByRole('button', { name: 'More scenes (22 more)' }).click();
  assert.equal(await scenes.count(), 25);
  await page.getByRole('searchbox', { name: 'Search scenes' }).fill('christmas');
  assert.equal(await scenes.count(), 4, 'the three Christmas scenes and Your idea');
  await page.getByRole('searchbox', { name: 'Search scenes' }).fill('');
  // Your idea: a few words in the notes box, which is written out when a photo is made.
  await scenes.filter({ hasText: 'Your idea…' }).click();
  await page.getByRole('textbox', { name: 'Your idea for the scene' }).waitFor();
  await page.screenshot({ path: path.join(shots, '2-scenes.png') });

  assert.deepEqual(errors, []);
  console.log(`screenshots: ${shots}`);
});

test('the Designs menu exports every design as a zip and imports one', TEST, async () => {
  const page = await newPage();
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Smoke cube');
  await page.getByRole('button', { name: 'Designs' }).click();
  const menu = page.locator('.menu');

  const [download] = await Promise.all([page.waitForEvent('download'), menu.getByText('Export all designs').click()]);
  assert.match(download.suggestedFilename(), /^prompt-to-part-designs-\d{4}-\d\d-\d\d\.zip$/);
  const exported = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
  // The printer choice is a setting the backup keeps (the first-start test saved one).
  assert.deepEqual(Object.keys(exported), ['printer.json', `designs/${id}.json`]);

  const other = 'ui-smoke-00000002';
  const copy = { ...JSON.parse(strFromU8(exported[`designs/${id}.json`])), id: other, name: 'Imported cube' };
  const zip = zipSync({ ...exported, [`designs/${other}.json`]: strToU8(JSON.stringify(copy)) });
  await menu.locator('input[type=file]').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
  await menu.getByText('Imported 1, skipped 1').waitFor();
  await menu.getByText('Imported cube').waitFor();
  await page.screenshot({ path: path.join(shots, '3-import.png') });
  await page.close();
});

test('the Designs menu lists 10 designs at a time and marks starred ones', TEST, async () => {
  // 12 more designs (14 in all), the oldest first.
  for (let i = 1; i <= 12; i++) {
    const n = `ui-smoke-1${String(i).padStart(7, '0')}`;
    const r = await fetch(`${A}/api/designs/${n}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PTP': '1' },
      body: JSON.stringify({ id: n, name: `Cube ${i}`, createdAt: 1, updatedAt: 2000 + i, messages: [], code, values: {}, currentVersion: -1, versions: [] }) });
    assert.equal(r.status, 200, await r.text());
  }
  const page = await newPage();
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Smoke cube');
  await page.getByRole('button', { name: 'Designs' }).click();
  const menu = page.locator('.menu');
  await menu.getByText('Load more (4 more)').waitFor();
  assert.equal(await menu.locator('.menu-item').count(), 10);
  await menu.getByText('Load more (4 more)').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, '4-menu.png') });

  // Starring the oldest marks it where it is, and it stays starred after a reload.
  await menu.getByText('Load more (4 more)').click();
  assert.equal(await menu.locator('.menu-item').count(), 14);
  await menu.getByRole('button', { name: 'Star Smoke cube' }).click();
  await menu.locator('.menu-item.starred', { hasText: 'Smoke cube' }).waitFor();
  assert.equal(await menu.locator('.menu-item.starred').count(), 1);
  await page.screenshot({ path: path.join(shots, '5-starred.png') });
  await page.reload();
  await page.getByRole('button', { name: 'Designs' }).click();
  await menu.getByText('Load more (4 more)').click();
  await menu.getByRole('button', { name: 'Unstar Smoke cube' }).waitFor();

  // Search by name: case and accents don't matter, the matches page like the list, Enter opens the first.
  const search = menu.getByRole('searchbox', { name: 'Search designs' });
  const names = () => menu.locator('.menu-open > span:first-child').allInnerTexts().then((n) => n.map((x) => x.trim()));
  await search.fill('cube');
  await menu.getByText('Load more (4 more)').waitFor();
  await search.fill('CÚBE 1');
  await menu.getByText('Load more').waitFor({ state: 'detached' });
  assert.deepEqual(await names(), ['Cube 12', 'Cube 11', 'Cube 10', 'Cube 1']);
  await page.screenshot({ path: path.join(shots, '5-search.png') });
  await search.fill('no such design');
  await menu.getByText('No design\'s name contains “no such design”').waitFor();
  await search.fill('cube 11');
  await search.press('Enter');
  await page.waitForFunction(() => document.title === 'prompt-to-part - Cube 11');
  assert.equal(await menu.count(), 0, 'the menu closes');
  await page.close();
});

test('the Designs menu shows a picture of each design on a computer (a larger one when pointed at) and none on a phone', TEST, async () => {
  // The smoke cube (made by an earlier test of the file) when this test runs alone.
  if ((await fetch(`${A}/api/designs/${id}`)).status === 404) {
    assert.equal((await putDesign({ id, name: 'Smoke cube', createdAt: 1, updatedAt: 1000, messages: [], code, values: {}, currentVersion: -1, versions: [] })).status, 200);
  }
  // A design without code has no picture: its row keeps the icon tile.
  const empty = 'ui-smoke-20000001';
  assert.equal((await putDesign({ id: empty, name: 'Empty idea', createdAt: 1, updatedAt: 1, messages: [], code: '', values: {}, currentVersion: -1, versions: [] })).status, 200);
  const page = await newPage();
  try {
    await page.goto(`${A}/?design=${id}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - Smoke cube');
    await page.getByRole('button', { name: 'Designs' }).click();
    const menu = page.locator('.menu');
    const rows = menu.locator('.menu-item');
    const n = await rows.count();
    assert.equal(await menu.locator('.menu-item .design-thumb').count(), n, 'every row has a tile');
    const cube = rows.filter({ hasText: 'Smoke cube' }).first();
    const img = cube.locator('.design-thumb img');
    await page.waitForFunction((el) => (el as HTMLImageElement | null)?.naturalWidth === 520, await img.elementHandle(), { timeout: 20_000 });
    const box = await cube.locator('.design-thumb').boundingBox();
    assert.equal(Math.round(box!.width), 48);
    assert.ok((await cube.boundingBox())!.height <= 60, 'rows stay at most 60 px tall');
    const emptyRow = rows.filter({ hasText: 'Empty idea' });
    assert.equal(await emptyRow.locator('.design-thumb').count(), 1);
    assert.equal(await emptyRow.locator('.design-thumb img').count(), 0, 'no picture, no img');

    // Pointing at a row shows the larger picture with the size; leaving the menu hides it.
    const pane = page.locator('.design-preview');
    assert.equal(await pane.count(), 0);
    await cube.hover();
    await pane.waitFor();
    assert.match(await pane.innerText(), /Smoke cube/);
    await page.waitForFunction(() => /\d+ x \d+ x \d+ mm/.test(document.querySelector('.design-preview')?.textContent ?? ''), null, { timeout: 20_000 });
    const pb = (await pane.boundingBox())!;
    const mb = (await menu.boundingBox())!;
    assert.ok(pb.x >= 0 && pb.x + pb.width <= mb.x, 'the pane stands left of the menu, inside the window');
    assert.equal(Math.round((await pane.locator('.design-thumb').boundingBox())!.width), 260);
    await page.screenshot({ path: path.join(shots, '6-thumbs-desktop.png') });
    await page.mouse.move(5, 600);
    await pane.waitFor({ state: 'detached' });

    // The keyboard shows it too.
    await menu.getByRole('button', { name: 'Star Smoke cube' }).focus();
    await pane.waitFor();
    await menu.getByRole('searchbox', { name: 'Search designs' }).focus();
    await pane.waitFor({ state: 'detached' });
    await cube.locator('.menu-open').focus();
    await pane.waitFor();
    assert.match(await pane.innerText(), /Smoke cube/);

    // A window 900 px wide: the pane is still inside it.
    await page.setViewportSize({ width: 900, height: 850 });
    await cube.hover();
    await pane.waitFor();
    assert.ok((await pane.boundingBox())!.x >= 0);
    await page.screenshot({ path: path.join(shots, '6-thumbs-900.png') });
    await page.setViewportSize({ width: 1400, height: 850 });
    await page.close();

    // A phone: today's menu, no picture, no request for one.
    const phone = await newPage(PHONE);
    const thumbRequests: string[] = [];
    phone.on('request', (r) => { if (r.url().includes('/thumb')) thumbRequests.push(r.url()); });
    await phone.goto(`${A}/?design=${id}`);
    await phone.locator('.app.layout-phone').waitFor();
    await phone.getByRole('button', { name: 'Designs' }).click();
    await phone.locator('.menu .menu-item').first().waitFor();
    await phone.waitForTimeout(1500);
    assert.equal(await phone.locator('.menu .design-thumb').count(), 0);
    assert.equal(await phone.locator('.design-preview').count(), 0);
    assert.deepEqual(thumbRequests, []);
    await phone.screenshot({ path: path.join(shots, '6-thumbs-phone.png') });
    await phone.close();
  } finally {
    await fetch(`${A}/api/designs/${empty}`, { method: 'DELETE', headers: { 'X-PTP': '1' } });
    await page.close().catch(() => {});
  }
});

test('Export ▸ GLB… downloads the model for a shop\'s 3D view, standing as printed when it is not flat', TEST, async () => {
  const page = await newPage();
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Smoke cube');
  await page.getByRole('button', { name: 'More export formats' }).click();
  await page.getByRole('button', { name: /GLB… \(shop 3D view\)/ }).click();
  // A cube is not a wall piece: upright starts off.
  const upright = page.getByRole('checkbox', { name: /Upright, as it hangs on the wall/ });
  assert.equal(await upright.isChecked(), false);
  await page.screenshot({ path: path.join(shots, '5-glb.png') });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export GLB' }).click()]);
  assert.equal(download.suggestedFilename(), 'smoke-cube.glb');
  const glb = readFileSync((await download.path())!);
  assert.equal(glb.readUInt32LE(0), 0x46546c67, 'glTF magic');
  if (process.env.PTP_UI_SHOTS) writeFileSync(path.join(shots, 'smoke-cube.glb'), glb);
  await page.getByText(/Exported smoke-cube\.glb/).waitFor();
  await page.close();
});

test('Export project… downloads the design as one zip where there is no folder picker', TEST, async () => {
  const page = await newPage();
  // Playwright has no folder picker: the zip, as in Firefox.
  await page.addInitScript(() => { delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker; });
  // As if Blender and Bambu Studio weren't installed (they would make the test slow): no .blend, a plain 3MF.
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), blender: null, blenderProblem: null, bambu: null } });
  });
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Smoke cube');
  await page.getByRole('button', { name: 'More export formats' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export project…/ }).click()]);
  assert.equal(download.suggestedFilename(), 'Smoke cube.zip');
  const zip = readFileSync((await download.path())!);
  const files = unzipSync(new Uint8Array(zip));
  assert.deepEqual(Object.keys(files).sort(), ['README.md', 'design.ptp.json', 'model.js', 'smoke-cube.3mf', 'smoke-cube.stl', 'values.json'].map((f) => `Smoke cube/${f}`));
  assert.equal(strFromU8(files['Smoke cube/model.js']), code);
  assert.equal(JSON.parse(strFromU8(files['Smoke cube/design.ptp.json'])).id, id);
  const readme = strFromU8(files['Smoke cube/README.md']);
  for (const want of ['# Smoke cube', 'A 20 mm cube', '20.00 × 20.00 × 20.00 mm', `prompt-to-part ${version}`, 'No `.blend` file', 'The 3MF has no print settings']) assert.ok(readme.includes(want), `README: ${want}\n${readme}`);
  await page.getByText('Exported Smoke cube.zip').waitFor();
  await page.screenshot({ path: path.join(shots, '5-project.png') });

  // Import designs… reads the zip as it is (the design is here already, so it is kept).
  await page.getByRole('button', { name: 'Designs' }).click();
  await page.locator('.menu input[type=file]').setInputFiles({ name: 'Smoke cube.zip', mimeType: 'application/zip', buffer: zip });
  await page.locator('.menu').getByText('Imported 0, skipped 1').waitFor();
  await page.close();
});

test('a reply saved while a reply was running shows as interrupted, with its thinking kept', TEST, async () => {
  const cut = 'ui-smoke-20000001';
  const r = await fetch(`${A}/api/designs/${cut}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PTP': '1' },
    body: JSON.stringify({ id: cut, name: 'Cut short', createdAt: 1, updatedAt: 1, code: '', values: {}, currentVersion: -1, versions: [], sessionId: 'abc',
      messages: [{ id: 'u1', role: 'user', text: 'A cube', createdAt: 1 },
        { id: 'a1', role: 'assistant', text: '', createdAt: 1, pending: true, steps: [{ kind: 'thinking', text: 'Planning a 20 mm cube' }],
          activity: [{ kind: 'thinking', text: 'Planning a 20 mm cube with chamfered edges', at: 5 }] }] }) });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  await page.goto(`${A}/?design=${cut}`);
  await page.locator('.bubble.interrupted', { hasText: 'Interrupted: the reply stopped before finishing' }).waitFor();
  await page.locator('.think-link').click();
  await page.locator('.activity-panel', { hasText: 'chamfered edges' }).waitFor();
  assert.equal(await page.locator('.chat-panel textarea').isEnabled(), true);
  await page.screenshot({ path: path.join(shots, '6-interrupted.png') });
  await page.close();
});

test('a stopped reply says so at the end of its work, as in the chat', TEST, async () => {
  const id = 'ui-smoke-20000009';
  const r = await fetch(`${A}/api/designs/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PTP': '1' },
    body: JSON.stringify({ id, name: 'Stopped', createdAt: 1, updatedAt: 1, code: '', values: {}, currentVersion: -1, versions: [],
      messages: [{ id: 'u1', role: 'user', text: 'A mask', createdAt: 1 },
        { id: 'a1', role: 'assistant', text: '', createdAt: 1, error: 'Stopped.', steps: [{ kind: 'thinking', text: 'Planning the mask' }],
          activity: [{ kind: 'thinking', text: 'Planning the mask outline', at: 5 }] }] }) });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  await page.goto(`${A}/?design=${id}`);
  await page.locator('.bubble.error', { hasText: 'Stopped.' }).waitFor();
  await page.locator('.think-link').click();
  await page.locator('.activity-panel .act-end', { hasText: 'Stopped.' }).waitFor();
  assert.equal((await page.locator('.activity-panel .act-step').last().innerText()).trim(), 'Stopped.');
  await page.close();
});

test('a reply under way goes on through a reload or a dropped connection: the page catches up with it', TEST, async () => {
  const slow = 'ui-smoke-20000002';
  const r = await fetch(`${A}/api/designs/${slow}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PTP': '1' },
    body: JSON.stringify({ id: slow, name: 'Slow', createdAt: 1, updatedAt: 1, code, values: {}, currentVersion: 0, versions: [{ code, summary: 'A cube', createdAt: 1, source: 'manual' }], messages: [] }) });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  await page.goto(`${A}/?design=${slow}`);
  const box = page.locator('.chat-panel textarea');
  await box.fill('a slow cube');
  await box.press('Enter');
  // Saved while it works, with how far the page got.
  await until(async () => (await getDesign(slow)).messages.at(-1)?.run?.seen >= 2, 'saved with its run');
  await page.reload();
  await page.locator('.msg.assistant', { hasText: 'Measuring the slow cube' }).waitFor();
  await page.getByRole('button', { name: /^Stop/ }).waitFor(); // following it again
  finishSlowCube();
  await page.locator('.msg.assistant', { hasText: 'The slow cube is done.' }).waitFor();
  assert.equal(await page.locator('.bubble.interrupted').count(), 0);
  await page.screenshot({ path: path.join(shots, '6-caught-up.png') });
  // The connection drops (a phone locks its screen): the page picks it up again by itself.
  const resumed: string[] = [];
  page.on('request', (q) => { if (q.url().includes('/events?')) resumed.push(q.url()); });
  await box.fill('a slow cube');
  await box.press('Enter');
  await page.locator('.msg.assistant').nth(1).filter({ hasText: 'Measuring the slow cube' }).waitFor();
  for (const s of sockets) s.destroy();
  finishSlowCube();
  await page.locator('.msg.assistant').nth(1).filter({ hasText: 'The slow cube is done.' }).waitFor();
  assert.ok(resumed.length, 'caught up after the drop');
  await page.close();
});

test('an enlarged product photo steps to the next and previous one (buttons, arrow keys)', TEST, async () => {
  const pid = 'ui-smoke-20000003';
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  const photos = ['table', 'shelf', 'desk'].map((scene, i) => ({ url: `${png}#${i}`, scene: 'custom', notes: scene, aspect: '4:5', prompt: scene, model: 'test/image', cost: null, createdAt: i + 1 }));
  const r = await fetch(`${A}/api/designs/${pid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PTP': '1' },
    body: JSON.stringify({ id: pid, name: 'Photos', createdAt: 1, updatedAt: 1, code, values: {}, currentVersion: 0, versions: [{ code, summary: 'A cube', createdAt: 1, source: 'manual' }], messages: [], photos }) });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  await page.goto(`${A}/?design=${pid}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Photos');
  await page.getByRole('button', { name: 'Product photos' }).click();
  await page.locator('.ph-thumb').first().click();
  const count = page.locator('.lightbox-count');
  assert.equal(await count.innerText(), '1 / 3');
  await page.keyboard.press('ArrowRight');
  assert.equal(await count.innerText(), '2 / 3');
  await page.getByRole('button', { name: 'Previous photo' }).click();
  await page.getByRole('button', { name: 'Previous photo' }).click();
  assert.equal(await count.innerText(), '3 / 3');
  await page.screenshot({ path: path.join(shots, '15-photo-arrows.png') });
  await page.close();
});

test('3D figure mode shows the Meshy credits left on its button', TEST, async () => {
  const page = await newPage();
  // As if the app had a Meshy key; the balance is a stand-in (the real one would ask Meshy). Opus, as the
  // model: beside a longer chip name (the Fable 5.2 default) the badge goes below 440 px, which is the chat's width here.
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), meshy: true, model: 'opus' } });
  });
  let asked = 0;
  await page.route('**/api/meshy/balance', (route) => { asked++; return route.fulfill({ json: { balance: 1200, monthly_credits: 1000, permanent_credits: 200, monthly_resets_at: 1795034540000 } }); });
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Smoke cube');
  assert.equal(await page.locator('.mode-credits').count(), 0);
  await page.getByRole('button', { name: /^Picture mode:/ }).click();
  await page.getByRole('menuitemradio', { name: /3D figure/ }).click();
  const badge = page.locator('.mode-btn .mode-credits');
  await badge.waitFor();
  assert.equal(await badge.textContent(), '1,200');
  assert.match(await page.locator('.mode-btn').getAttribute('title') ?? '', /1,200 Meshy credits left .*a model costs 25/);
  assert.ok(asked >= 1);
  await page.screenshot({ path: path.join(shots, '7-meshy-credits.png') });
  // Colour (4 filaments) in the figure's ▾ menu, off by default: a coloured model costs 35, and the
  // figure button shows it's on.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '3D figure options' }).click();
  const colour = page.getByRole('menuitemcheckbox', { name: /^Colour/ });
  assert.equal(await colour.getAttribute('aria-checked'), 'false');
  assert.match(await page.locator('.figure-credits').textContent() ?? '', /1,200 Meshy credits left/);
  await colour.click();
  assert.equal(await colour.getAttribute('aria-checked'), 'true');
  assert.match(await page.locator('.mode-btn').getAttribute('title') ?? '', /a model costs 35 in colour/);
  assert.equal(await page.locator('.mode-btn .figure-marks .figure-color-dots').count(), 1);
  await page.locator('.chat-panel').screenshot({ path: path.join(shots, '7-figure-menu.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('menu', { name: '3D figure options' }).waitFor({ state: 'detached' });
  await page.close();
});

test('a coloured figure: its filaments in the Object tab, the STL hint says the colours are lost', TEST, async () => {
  // The mock's coloured figure, imported (in the geometry process) as generate_3d stores it.
  const { geometry } = await import('../../server/geometry');
  stopGeometry = () => geometry.stop();
  const imported = await geometry.importMesh(new Uint8Array(readFileSync(new URL('../fixtures/meshes/colour-figure.glb', import.meta.url))), 'figure.glb', { colors: true }, { colors: 4, mine: [] });
  geometry.stop();
  const palette = imported.palette!;
  const fid = 'ui-smoke-00000003', bin = `${'ab'.repeat(16)}.bin`;
  mkdirSync(path.join(dataDir, 'designs', fid, 'meshes'), { recursive: true });
  writeFileSync(path.join(dataDir, 'designs', fid, 'meshes', bin), imported.bin);
  const mesh = { indices: { length: imported.report.triangles * 3 } };
  const black = palette.find((c) => c.filament.name === 'PLA Basic Black')!.filament.color;
  const figCode = `function build() { return [{ name: 'Kid', color: '${black}', shape: H.mesh('kid', { height: 50 }).translate([0, 0, 2]).add(Manifold.cylinder(2.5, 16, 16, 40)) }]; }`;
  const saved = await fetch(`${A}/api/designs/${fid}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PTP': '1' },
    body: JSON.stringify({ id: fid, name: 'Coloured kid', createdAt: 1, updatedAt: 1000, code: figCode, messages: [], currentVersion: 0,
      values: { $meshes: JSON.stringify({ kid: { file: `/api/designs/${fid}/meshes/${bin}`, triangles: mesh.indices.length / 3, size: [35, 35, 80], source: 'meshy', palette } }) },
      versions: [{ code: figCode, summary: 'A coloured kid', createdAt: 1000, source: 'manual' }] }),
  });
  assert.equal(saved.status, 200, await saved.text());
  const page = await newPage();
  await page.goto(`${A}/?design=${fid}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Coloured kid');
  const rows = page.locator('.mesh-colors-row');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 4);
  assert.match(await page.locator('.mesh-colors').textContent() ?? '', /4 of 4 AMS slots/);
  assert.equal(await page.getByRole('button', { name: /PLA Basic Black.*change the filament/ }).count(), 1);
  await page.screenshot({ path: path.join(shots, '8-coloured-figure.png') });
  // Repaint: a click on the figure picks the patch under it, a filament repaints it (saved with the design).
  await page.getByRole('button', { name: 'Repaint', exact: true }).click();
  const box = (await page.locator('.viewer-host canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByText(/Patch: [\d.<\s]+ % of the figure/).waitFor();
  await page.screenshot({ path: path.join(shots, '8b-repaint-patch.png') });
  await page.getByRole('group', { name: 'Print it in' }).getByRole('button').last().click();
  await page.getByRole('button', { name: 'Clear repaints (1)' }).waitFor();
  await until(async () => JSON.parse((await getDesign(fid)).values?.$meshes ?? '{}').kid?.repaint?.length === 1, 'the repaint is saved with the design');
  // The brush: one drag over the figure is one more repaint; Undo takes it back.
  await page.getByRole('button', { name: 'Brush', exact: true }).click();
  await page.mouse.move(box.x + box.width / 2 - 15, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2 + 10, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Clear repaints (2)' }).waitFor();
  await page.screenshot({ path: path.join(shots, '8c-repaint-brush.png') });
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Clear repaints (1)' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Repaint', exact: true }).getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: 'More export formats' }).click();
  await page.locator('.export-menu', { hasText: 'Geometry only: the figure\'s colours are lost' }).waitFor();
  await page.close();
});

test('"Print in one colour" in the Print tab: the view shows one filament, saved with the design', TEST, async () => {
  const fid = 'ui-smoke-00000003';
  const page = await newPage();
  await page.goto(`${A}/?design=${fid}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Coloured kid');
  await page.getByRole('tab', { name: /Print/ }).click();
  const toggle = page.getByRole('checkbox', { name: 'Print in one colour' });
  assert.equal(await toggle.isChecked(), false);
  await toggle.check({ force: true });
  await page.getByRole('note').filter({ hasText: 'Printing in one colour' }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Filament to print with' }).inputValue(), 'main');
  await page.screenshot({ path: path.join(shots, '9-one-colour.png') });
  // Saved with the design (autosave), so it is still on after a reload, and Export ▸ 3MF… follows it.
  await until(async () => (await getDesign(fid)).values?.$oneColour === true, 'the switch is saved with the design');
  await page.reload();
  await page.waitForFunction(() => document.title === 'prompt-to-part - Coloured kid');
  await page.getByRole('tab', { name: /Print/ }).click();
  assert.equal(await page.getByRole('checkbox', { name: 'Print in one colour' }).isChecked(), true);
  await page.getByRole('button', { name: 'More export formats' }).click();
  await page.getByRole('button', { name: /^3MF…/ }).click();
  assert.equal(await page.getByRole('checkbox', { name: /Colours \(AMS\)/ }).isChecked(), false);
  await page.close();
});

test('"Send my view" and "Wait for my OK": saved after a reload; a concept picture is built after a countdown unless stopped', TEST, async () => {
  const fid = 'ui-smoke-00000004';
  const saved = await fetch(`${A}/api/designs/${fid}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PTP': '1' },
    body: JSON.stringify({ id: fid, name: 'Knight', createdAt: 1, updatedAt: 1000, code, messages: [], values: {}, currentVersion: 0,
      versions: [{ code, summary: 'A 20 mm cube', createdAt: 1000, source: 'manual' }] }),
  });
  assert.equal(saved.status, 200, await saved.text());
  const page = await newPage();
  // As if the app had a Meshy key and an image model; the replies are stand-ins: a concept picture, or
  // (for an approval) a short answer.
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), meshy: true, artwork: 'Image model', effort: 'high' } });
  });
  await page.route('**/api/meshy/balance', (route) => route.fulfill({ json: { balance: 1200, monthly_credits: 1000, permanent_credits: 200 } }));
  const sent: { prompt: string; currentView?: unknown; renderValues?: unknown; model?: string; effort?: string; askFirst?: boolean }[] = [];
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  await page.route('**/api/generate', (route) => {
    const body = route.request().postDataJSON();
    sent.push(body);
    const events = body.prompt.startsWith('Approved') ? [{ type: 'done', durationMs: 900, turns: 1, submitted: false, text: 'Building it.' }] : [
      { type: 'concept', name: 'knight', entry: { image: `/api/designs/${fid}/meshes/${'cd'.repeat(16)}.png`, subject: 'a knight', createdAt: 1 } },
      { type: 'step', step: { kind: 'render', ok: true, text: 'Concept "knight"', image: `data:image/png;base64,${pixel}` } },
      { type: 'done', durationMs: 1200, turns: 1, submitted: false, text: 'Here is the concept for your knight: approve it or say what to change.' },
    ];
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') });
  });
  await page.goto(`${A}/?design=${fid}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Knight');
  // The toggles are rows of the options menu (the sliders button): open it before each look.
  const view = page.getByRole('menuitemcheckbox', { name: 'Send my view' });
  const askFirst = page.getByRole('menuitemcheckbox', { name: 'Ask first' });
  const openOptions = () => page.getByRole('button', { name: /^Options:/ }).click();
  await openOptions();
  assert.equal(await view.getAttribute('aria-checked'), 'true');
  assert.match(await view.getAttribute('title') ?? '', /so "this" is clear/);
  // Ask first: on by default, every mode; off, the model is told to pick defaults.
  assert.equal(await askFirst.getAttribute('aria-checked'), 'true');
  assert.match(await askFirst.getAttribute('title') ?? '', /at most 5/);
  await page.keyboard.press('Escape');
  await page.locator('.composer').screenshot({ path: path.join(shots, '10-chat-bar.png') });
  const figureMode = async () => {
    await page.getByRole('button', { name: /^Picture mode:/ }).click();
    await page.getByRole('menuitemradio', { name: /3D figure/ }).click();
    await page.keyboard.press('Escape');
  };
  // Wait for my OK is in the figure's ▾ menu; off, the figure button shows a timer.
  await figureMode();
  const figureOptions = page.getByRole('button', { name: '3D figure options' });
  await figureOptions.click();
  const wait = page.getByRole('menuitemcheckbox', { name: /^Wait for my OK/ });
  assert.equal(await wait.getAttribute('aria-checked'), 'true');
  await wait.click();
  assert.match(await wait.getAttribute('title') ?? '', /Wait for my OK is off: 10 s after/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.mode-btn .figure-marks svg').count(), 1);
  await openOptions();
  await view.click();
  await askFirst.click();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForFunction(() => document.title === 'prompt-to-part - Knight');
  await openOptions();
  assert.equal(await view.getAttribute('aria-checked'), 'false');
  assert.equal(await askFirst.getAttribute('aria-checked'), 'false');
  await page.keyboard.press('Escape');
  await figureMode();
  await figureOptions.click();
  assert.equal(await wait.getAttribute('aria-checked'), 'false');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(shots, '10-chat-switches.png') });
  // Model and effort in one chip, from the keyboard: Enter opens its menu on the chosen model, Right
  // goes to the efforts, Down and Enter choose the next one; Escape closes it.
  const chip = page.getByRole('button', { name: /^Model and reasoning effort:/ });
  await chip.focus();
  await page.keyboard.press('Enter');
  const modelMenu = page.getByRole('menu', { name: 'Model and reasoning effort' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-checked')), 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await modelMenu.getByRole('menuitemradio', { name: 'X-High' }).getAttribute('aria-checked'), 'true');
  await modelMenu.getByRole('menuitemradio', { name: 'Sonnet' }).click();
  await page.locator('.chat-panel').screenshot({ path: path.join(shots, '10-model-menu.png') });
  await page.keyboard.press('Escape');
  await modelMenu.waitFor({ state: 'detached' });
  assert.match(await chip.getAttribute('aria-label') ?? '', /Sonnet · X-High$/);

  const box = page.locator('.chat-panel textarea');
  const card = page.locator('.auto-build');
  const ask = async (text: string) => { await box.fill(text); await box.press('Enter'); await card.waitFor(); };
  // Send my view off: neither the screenshot nor the four-view render goes.
  await ask('A knight figure');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].currentView, undefined);
  assert.equal(sent[0].renderValues, undefined);
  assert.equal(sent[0].model, 'sonnet');
  assert.equal(sent[0].effort, 'xhigh');
  assert.equal(sent[0].askFirst, false, 'Ask first off');
  assert.match(await card.innerText(), /Building with Meshy in \d+ s · 25 credits/);
  await page.screenshot({ path: path.join(shots, '11-countdown.png') });
  // Stop: the countdown is gone and nothing is sent.
  await card.getByRole('button', { name: 'Stop' }).click();
  await card.waitFor({ state: 'detached' });
  // Typing a change stops it too.
  await openOptions();
  await view.click();
  await page.keyboard.press('Escape');
  await ask('Another knight');
  assert.ok(sent[1].currentView, 'with Send my view on, the view goes');
  await box.fill('make the sword longer');
  await card.waitFor({ state: 'detached' });
  await box.fill('');
  // Build now: the approval goes at once, without the view (it only approves the picture).
  await ask('A third knight');
  await card.getByRole('button', { name: 'Build now' }).click();
  await page.locator('.msg.user .bubble', { hasText: 'Approved – build it.' }).waitFor();
  assert.equal(sent.length, 4);
  assert.equal(sent[3].prompt, 'Approved – build it.');
  assert.equal(sent[3].askFirst, false, 'an approval never asks');
  assert.equal(sent[3].currentView, undefined);
  assert.equal(sent[3].renderValues, undefined);
  // Left alone, the countdown sends the approval by itself (the one 10 s wait).
  await ask('A fourth knight');
  await page.waitForFunction(() => document.querySelectorAll('.msg.user .bubble').length === 6, undefined, { timeout: 30_000 });
  assert.equal(sent.length, 6);
  assert.equal(sent[5].prompt, 'Approved – build it.');
  assert.equal(await card.count(), 0);
  // At the chat's narrowest (240 px) the composer's controls still fit one row, as icons.
  await page.evaluate(() => localStorage.setItem('sidebarWidthsUser', JSON.stringify({ left: 240 })));
  await page.reload();
  await page.waitForFunction(() => document.title === 'prompt-to-part - Knight');
  await figureMode();
  const bar = await page.locator('.composer-bar').boundingBox();
  assert.ok(bar && bar.height < 36, `one row (${bar?.height} px high)`);
  assert.equal(await page.locator('.model-text').isVisible(), false);
  await page.locator('.composer').screenshot({ path: path.join(shots, '12-chat-bar-narrow.png') });
  await page.close();
});

test('Ask first: the questions come as a card of options with its pick preselected; the answers go as the next message, and the card stays read-only after a reload', TEST, async () => {
  const qid = 'ui-smoke-30000001';
  const saved = await putDesign({ id: qid, name: 'Phone stand', createdAt: 1, updatedAt: 1, code: '', values: {}, currentVersion: -1, versions: [], messages: [] });
  assert.equal(saved.status, 200, await saved.text());
  const page = await newPage();
  // The stand-in reply asks three questions; the next one (the answers) just answers.
  const questions = [
    { question: 'Which way is the phone held?', options: ['Landscape', 'Portrait'], pick: 0, why: 'best for watching' },
    { question: 'What should it hold too?', options: ['Charging cable slot', 'Pen holder', 'Card slot'], pick: 0, multi: true },
    { question: 'How tall?', options: ['Desk height (12 cm)', 'Tall (18 cm)'], pick: 0 },
  ];
  const sent: { prompt: string; askFirst?: boolean }[] = [];
  await page.route('**/api/generate', (route) => {
    sent.push(route.request().postDataJSON());
    const events = sent.length > 1 ? [{ type: 'done', durationMs: 900, turns: 1, submitted: false, text: 'Building it.' }] : [
      { type: 'questions', questions },
      { type: 'step', step: { kind: 'tool', ok: true, text: 'Asked 3 questions before building' } },
      { type: 'done', durationMs: 1200, turns: 1, submitted: false, text: 'A few quick questions before I build.' },
    ];
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') });
  });
  await page.goto(`${A}/?design=${qid}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Phone stand');
  const box = page.locator('.chat-panel textarea');
  await box.fill('A phone stand');
  await box.press('Enter');
  const card = page.getByRole('form', { name: "Questions" });
  await card.waitFor();
  assert.equal(sent[0].askFirst, true);
  // The suggested pick is chosen and marked.
  const held = card.getByRole('radiogroup', { name: 'Which way is the phone held?' });
  assert.ok(await held.getByRole('radio', { name: /^Landscape/ }).isChecked());
  assert.ok(!await held.getByRole('radio', { name: /^Portrait/ }).isChecked());
  assert.match(await held.locator('.q-chip.on').innerText(), /Landscape\s*Suggested/);
  assert.ok(await card.getByRole('group', { name: 'What should it hold too?' }).getByRole('checkbox', { name: /^Charging cable slot/ }).isChecked());
  // A card that just arrived counts down to sending the suggested picks.
  assert.match(await card.getByRole('timer').innerText(), /Sending the suggested picks in \d+ s/);
  await card.screenshot({ path: path.join(shots, '13-questions.png') });
  // At a narrow chat (320 px) the chips wrap inside the card.
  await page.evaluate(() => localStorage.setItem('sidebarWidthsUser', JSON.stringify({ left: 320 })));
  await page.reload();
  await card.waitFor();
  assert.ok(await card.evaluate((el) => el.scrollWidth <= el.clientWidth), 'nothing sticks out');
  // Found unanswered after a reload, it waits for the user.
  assert.equal(await card.getByRole('timer').count(), 0);
  await page.locator('.chat-panel').screenshot({ path: path.join(shots, '13-questions-narrow.png') });
  // Another option, a second one where several may go, and Other… with the user's own words; Enter sends.
  await held.getByText('Portrait').click();
  assert.ok(await held.getByRole('radio', { name: /^Portrait/ }).isChecked());
  await card.getByRole('group', { name: 'What should it hold too?' }).getByText('Pen holder').click();
  await card.getByRole('radiogroup', { name: 'How tall?' }).getByText('Other…').click();
  const other = card.getByRole('textbox', { name: 'Your own answer: How tall?' });
  assert.equal(await card.getByRole('button', { name: 'Send answers' }).isDisabled(), true, 'Other… needs words');
  await other.fill('About 15 cm');
  await card.screenshot({ path: path.join(shots, '13-questions-chosen.png') });
  await other.press('Enter');
  const answer = '1. Which way is the phone held? Portrait\n2. What should it hold too? Charging cable slot + Pen holder\n3. How tall? About 15 cm';
  await page.locator('.msg.user .bubble', { hasText: 'About 15 cm' }).waitFor();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].prompt, answer);
  assert.equal(sent[1].askFirst, true, 'with the current toggles');
  await page.locator('.msg.assistant', { hasText: 'Building it.' }).waitFor();
  // Answered: read-only, showing the answers, also after a reload.
  assert.equal(await card.getByRole('button', { name: 'Send answers' }).count(), 0);
  await until(async () => !!(await getDesign(qid)).messages[1]?.answers, 'saved with the answers');
  assert.deepEqual((await getDesign(qid)).messages[1].answers, [['Portrait'], ['Charging cable slot', 'Pen holder'], ['About 15 cm']]);
  await page.reload();
  await card.waitFor();
  assert.match(await card.innerText(), /Your answers/);
  const portrait = card.getByRole('radio', { name: /^Portrait/ });
  assert.ok(await portrait.isChecked());
  assert.ok(await portrait.isDisabled());
  assert.equal(await card.locator('.q-chip.on', { hasText: 'About 15 cm' }).count(), 1);
  await card.screenshot({ path: path.join(shots, '13-questions-answered.png') });
  await page.close();
});

test('Ask first: a question card nobody touches sends the suggested picks after its countdown; a click on it stops the countdown', TEST, async () => {
  const qid = 'ui-smoke-30000002';
  const saved = await putDesign({ id: qid, name: 'Hook', createdAt: 1, updatedAt: 1, code: '', values: {}, currentVersion: -1, versions: [], messages: [] });
  assert.equal(saved.status, 200, await saved.text());
  const page = await newPage();
  await page.clock.install();
  const questions = [
    { question: 'Which side?', options: ['Left', 'Right'], pick: 1 },
    { question: 'Extras?', options: ['Cable clip', 'Label'], pick: 0, multi: true },
  ];
  const sent: { prompt: string }[] = [];
  await page.route('**/api/generate', (route) => {
    sent.push(route.request().postDataJSON());
    const events = sent.length === 2 ? [{ type: 'done', durationMs: 900, turns: 1, submitted: false, text: 'Building it.' }] : [
      { type: 'questions', questions },
      { type: 'done', durationMs: 1200, turns: 1, submitted: false, text: 'Two quick questions.' },
    ];
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') });
  });
  await page.goto(`${A}/?design=${qid}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Hook');
  const box = page.locator('.chat-panel textarea');
  await box.fill('A desk hook');
  await box.press('Enter');
  const card = page.getByRole('form', { name: "Questions" });
  await card.waitFor();
  await card.getByRole('timer').waitFor();
  await page.clock.fastForward(61_000);
  await page.locator('.msg.user .bubble', { hasText: '1. Which side? Right' }).waitFor();
  assert.equal(sent[1].prompt, '1. Which side? Right\n2. Extras? Cable clip');
  await page.locator('.msg.assistant', { hasText: 'Building it.' }).waitFor();
  // A new card, and this time a click on it: no countdown any more, nothing goes out by itself.
  await box.fill('Another one');
  await box.press('Enter');
  const second = page.locator('.questions:not(.done)');
  await second.getByRole('timer').waitFor();
  await second.getByText('Left').click();
  assert.equal(await second.getByRole('timer').count(), 0);
  await page.clock.fastForward(61_000);
  assert.equal(sent.length, 3);
  await page.close();
});

test('on a computer the prompt box has the focus as the app opens and after New, ready for a paste; on a phone it does not (no keyboard popping up)', TEST, async () => {
  const page = await newPage();
  await page.goto(`${A}/?design=${id}`);
  await page.locator('.chat-panel textarea').waitFor();
  await until(async () => page.evaluate(() => document.activeElement?.matches('.chat-panel textarea') ?? false), 'the prompt box is focused');
  // New: the new design's prompt box takes the focus from the button.
  await page.locator('.chat-panel textarea').blur();
  await page.locator('header a.btn', { hasText: 'New' }).click();
  await until(async () => page.evaluate(() => document.activeElement?.matches('.chat-panel textarea') ?? false), 'focused after New');
  await page.close();
  const phone = await newPage(PHONE);
  await phone.goto(`${A}/?design=${id}`);
  await phone.locator('.app.layout-phone').waitFor();
  await phone.waitForTimeout(500);
  assert.equal(await phone.evaluate(() => document.activeElement?.matches('textarea') ?? false), false);
  await phone.close();
});

test('a phone shows one panel at a time, picked in the bottom tabs; an unfolded one the 3D view beside a pane', TEST, async () => {
  const page = await newPage(PHONE);
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Smoke cube');
  await page.locator('.app.layout-phone').waitFor();
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
  assert.ok(await noSideScroll(), 'no horizontal scroll');
  // The top bar keeps the name, the connection chip and Designs in view; no sidebar handles.
  for (const el of [page.locator('.design-name'), page.locator('.conn-chip'), page.getByRole('button', { name: 'Designs' })]) {
    const b = (await el.boundingBox())!;
    assert.ok(b.width > 0 && b.x >= 0 && b.x + b.width <= 412, `in view: ${JSON.stringify(b)}`);
  }
  assert.equal(await page.locator('.sidebar-resize').count(), 0);
  // No zoom on focus: text fields at 16 px.
  assert.equal(await page.locator('.chat-panel textarea').evaluate((t) => getComputedStyle(t).fontSize), '16px');
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  const shown = async () => ({ chat: await page.locator('.chat-panel').isVisible(), view: await page.locator('.viewer-panel').isVisible(), panel: await page.locator('.side-panel').isVisible() });
  assert.deepEqual(await shown(), { chat: true, view: false, panel: false });
  await page.screenshot({ path: path.join(shots, '13-phone-chat.png') });
  await tab('3D').tap();
  assert.deepEqual(await shown(), { chat: false, view: true, panel: false });
  await page.waitForFunction(() => { const c = document.querySelector<HTMLCanvasElement>('.viewer-host canvas'); return !!c && c.clientWidth > 300 && c.clientHeight > 300; });
  await page.screenshot({ path: path.join(shots, '13-phone-3d.png') });
  await tab('Panel').tap();
  assert.deepEqual(await shown(), { chat: false, view: false, panel: true });
  await page.screenshot({ path: path.join(shots, '13-phone-panel.png') });
  // The Designs menu fits the screen.
  await page.getByRole('button', { name: 'Designs' }).tap();
  const menu = (await page.locator('.menu').boundingBox())!;
  assert.ok(menu.x >= 0 && menu.x + menu.width <= 412, `menu in view: ${JSON.stringify(menu)}`);
  await page.screenshot({ path: path.join(shots, '13-phone-designs.png') });
  assert.ok(await noSideScroll(), 'no horizontal scroll');
  // The tab is remembered.
  await page.reload();
  await page.waitForFunction(() => document.title === 'prompt-to-part - Smoke cube');
  assert.equal(await tab('Panel').getAttribute('aria-selected'), 'true');
  await page.context().close();

  // Unfolded (the inner screen): the 3D view always, beside the chat or the side panel.
  const big = await newPage({ viewport: { width: 880, height: 1000 }, isMobile: true, hasTouch: true });
  await big.goto(`${A}/?design=${id}`);
  await big.waitForFunction(() => document.title === 'prompt-to-part - Smoke cube');
  await big.locator('.app.layout-split').waitFor();
  assert.equal(await big.getByRole('tab', { name: '3D', exact: true }).count(), 0);
  for (const name of ['Chat', 'Panel']) {
    await big.getByRole('tab', { name, exact: true }).tap();
    assert.equal(await big.locator(name === 'Chat' ? '.chat-panel' : '.side-panel').isVisible(), true);
    assert.equal(await big.locator('.viewer-panel').isVisible(), true);
    assert.ok(await big.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
    await big.screenshot({ path: path.join(shots, `14-unfolded-${name.toLowerCase()}.png`) });
  }
  // The pane hides (the edge tab), for the whole width to the 3D view.
  const width = async () => (await big.locator('.viewer-panel').boundingBox())!.width;
  const narrow = await width();
  await big.getByRole('button', { name: 'Hide the panel' }).tap();
  assert.equal(await big.locator('.side-panel').isVisible(), false);
  assert.ok(await width() > narrow + 200, 'the 3D view takes the width');
  await big.getByRole('button', { name: 'Show the panel' }).tap();
  assert.equal(await big.locator('.side-panel').isVisible(), true);
});

test('on a phone the picture mode menu fits the screen and every mode can be picked; Line art has its style ▾', TEST, async () => {
  const page = await newPage(PHONE);
  // As if the app had a Meshy key and an image model, so every mode is offered and can be chosen.
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), meshy: true, artwork: 'Image model' } });
  });
  await page.route('**/api/meshy/balance', (route) => route.fulfill({ json: { balance: 1200, monthly_credits: 1000, permanent_credits: 200 } }));
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Smoke cube');
  await page.locator('.app.layout-phone').waitFor();
  const inView = async (what: string, el: Locator) => {
    const b = await el.boundingBox();
    assert.ok(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= PHONE.viewport!.width && b.y + b.height <= PHONE.viewport!.height, `${what} in view: ${JSON.stringify(b)}`);
  };
  const button = page.getByRole('button', { name: /^Picture mode:/ });
  await button.tap();
  const menu = page.getByRole('menu', { name: 'Picture mode' });
  await inView('the picture mode menu', menu);
  assert.equal(await menu.getByRole('menuitemradio').count(), 6);
  await page.screenshot({ path: path.join(shots, '16-phone-picture-menu.png') });
  // Picking another mode keeps the menu open, so each one in turn (3D model, the default, last).
  for (const mode of ['AI artwork', 'LayerTone', 'Lithophane', 'Line art', '3D figure', '3D model']) {
    const item = menu.getByRole('menuitemradio', { name: new RegExp(`^${mode}`) });
    await inView(mode, item);
    await item.tap();
    assert.equal(await item.getAttribute('aria-checked'), 'true', mode);
    assert.match(await button.getAttribute('aria-label') ?? '', new RegExp(`^Picture mode: ${mode}`));
  }
  // Line art: the chosen mode again closes the menu, its ▾ picks the style, named on the button.
  await menu.getByRole('menuitemradio', { name: /^Line art/ }).tap();
  await menu.getByRole('menuitemradio', { name: /^Line art/ }).tap();
  await menu.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Line art style' }).tap();
  const styles = page.getByRole('menu', { name: 'Line art style' });
  await inView('the Line art style menu', styles);
  assert.equal(await styles.getByRole('menuitemradio').count(), 6);
  await styles.getByRole('menuitemradio', { name: /^Key holder/ }).tap();
  assert.equal(await button.getAttribute('aria-label'), 'Picture mode: Line art – Key holder');
  assert.equal(await button.locator('.mode-label').textContent(), 'Key holder');
  await page.screenshot({ path: path.join(shots, '16-phone-lineart-style.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
});

test('a part\'s filament: its swatch opens the picker at the panel\'s width, a pick recolours the part and is saved, ↺ resets it', TEST, async () => {
  const pid = 'ui-smoke-00000005';
  const parts = 'function build() { return [{ name: \'Base\', color: \'#d0d0d0\', shape: Manifold.cube([30, 30, 6]) }, { name: \'Lid\', color: \'#d0d0d0\', shape: Manifold.cube([20, 20, 4]).translate([5, 5, 10]) }]; }';
  const r = await putDesign({ id: pid, name: 'Two parts', createdAt: 1, updatedAt: 1, code: parts, values: {}, messages: [], currentVersion: 0,
    versions: [{ code: parts, summary: 'A base and a lid', createdAt: 1, source: 'manual' }] });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  await page.goto(`${A}/?design=${pid}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Two parts');
  await built(page);
  const swatch = page.getByRole('button', { name: 'Filament of Lid', exact: true });
  const background = () => swatch.evaluate((el) => getComputedStyle(el).backgroundColor);
  const was = await background();
  const view = page.locator('.viewer-host canvas').first();
  const before = await view.screenshot();
  await swatch.click();
  const picker = page.getByRole('dialog', { name: 'Add a filament' });
  await picker.waitFor();
  // Under its part, as wide as the row (not squeezed into the swatch).
  const row = (await page.locator('.object-row', { has: swatch }).boundingBox())!, box = (await picker.boundingBox())!;
  assert.ok(Math.abs(box.x - row.x) < 2 && Math.abs(box.width - row.width) < 2 && box.width > 200, `picker ${JSON.stringify(box)}, row ${JSON.stringify(row)}`);
  await page.screenshot({ path: path.join(shots, '17-part-filament.png') });
  await picker.getByRole('textbox', { name: 'Search the filaments' }).fill('red');
  const option = picker.getByRole('option').first();
  const colour = await option.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(colour, was);
  await option.click();
  await picker.waitFor({ state: 'detached' });
  // Buttons ease their background (0.15 s): wait for the swatch to settle.
  await until(async () => (await background()) === colour, `the swatch shows the pick (${await background()})`, 2000);
  // The 3D view follows, and the pick is saved with the design.
  await until(async () => !before.equals(await view.screenshot()), 'the part is recoloured in the view');
  await until(async () => !!JSON.parse((await getDesign(pid)).values?.$partColors ?? '{}').Lid?.color, 'the pick is saved with the design');
  await page.screenshot({ path: path.join(shots, '17-part-recoloured.png') });
  await page.getByRole('button', { name: 'Reset the filament of Lid' }).click();
  await until(async () => (await background()) === was, `the swatch is back to the part's colour (${await background()})`, 2000);
  await until(async () => !(await getDesign(pid)).values?.$partColors, 'the reset is saved with the design');
});

test('Shop photos makes a set of 5 square 2K photos, each from its own render, with progress, and a failed one can be tried again', TEST, async () => {
  const pid = 'ui-smoke-00000006';
  // A flat wall plaque: face-on, at an angle, a close-up, on the wall and on the wall by a light switch.
  const plaque = 'function build() { return [{ name: \'Board\', color: \'#2f6f8f\', shape: Manifold.cube([120, 80, 4]) }, { name: \'Bar\', color: \'#f2efe6\', shape: Manifold.cube([80, 10, 2]).translate([20, 58, 4]) }, { name: \'Dot\', color: \'#e0a43c\', shape: Manifold.cylinder(2, 18, 18, 48).translate([60, 32, 4]) }]; }';
  const r = await putDesign({ id: pid, name: 'Home wall plaque', createdAt: 1, updatedAt: 1, code: plaque, values: {}, messages: [], currentVersion: 0,
    versions: [{ code: plaque, summary: 'A wall plaque', createdAt: 1, source: 'manual' }] });
  assert.equal(r.status, 200, await r.text());
  // As if the app had an OpenRouter key; the image model is the stand-in.
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    const page = await newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${A}/?design=${pid}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - Home wall plaque');
    await built(page);
    const view = page.locator('.viewer-host canvas').first();
    const before = await view.screenshot();
    await page.getByRole('button', { name: 'Product photos' }).click();
    const shop = page.locator('button.ph-shop');
    await shop.click();
    // Two at a time: the others wait their turn, and the button says how far the set got.
    await page.getByRole('button', { name: /Making shop photos · 0 \/ 5/ }).waitFor();
    await until(async () => imageAsks.length === 2, 'two photos asked for at a time');
    assert.equal(await page.locator('.ph-tile.pending', { hasText: 'waiting' }).count(), 3);
    await page.locator('.ph-gallery').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, '18-shop-progress.png') });
    openImages();
    // The close-up fails once; the other four land in the design as they come.
    const failed = page.locator('.ph-tile.failed', { hasText: 'Shop · Detail' });
    await failed.waitFor();
    await until(async () => ((await getDesign(pid)).photos ?? []).length === 4, 'four photos in the design');
    await page.getByRole('button', { name: 'Shop photos', exact: true }).waitFor();
    await page.locator('.ph-gallery').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, '18-shop-failed.png') });
    await failed.getByRole('button', { name: 'Try again' }).click();
    await until(async () => ((await getDesign(pid)).photos ?? []).length === 5, 'the close-up made again');
    await page.locator('.ph-tile.failed').waitFor({ state: 'detached' });
    const photos = (await getDesign(pid)).photos as { shop?: string; scene: string; aspect: string; render?: string; scaleRef?: string }[];
    assert.deepEqual(photos.map((ph) => ph.shop).sort(), ['angle', 'detail', 'lifestyle', 'main', 'size']);
    assert.ok(photos.every((ph) => ph.aspect === '1:1'));
    assert.deepEqual(Object.fromEntries(photos.map((ph) => [ph.shop, ph.scene])), { main: 'grey-studio', angle: 'grey-studio', detail: 'grey-studio', lifestyle: 'wall', size: 'wall' });
    // Each from its own render (the face, an angle and a close-up differ; the wall ones are face-on).
    const renders = new Map(photos.map((ph) => [ph.shop, ph.render]));
    assert.equal(new Set([renders.get('main'), renders.get('angle'), renders.get('detail')]).size, 3);
    // The lifestyle photo's own: the plaque at true size on a plain wall, framed with room around it.
    assert.equal(new Set([renders.get('main'), renders.get('lifestyle'), renders.get('size')]).size, 3);
    // The size photo's own render: the plaque at true size beside a light switch on a plain wall.
    assert.notEqual(renders.get('size'), renders.get('main'));
    assert.deepEqual(photos.filter((ph) => ph.scaleRef).map((ph) => [ph.shop, ph.scaleRef]).sort(), [['angle', 'wall'], ['lifestyle', 'wall'], ['size', 'switch']]);
    assert.ok(imageAsks.some((a) => a.prompt.includes('SIZE PHOTO FOR THE LISTING: the render already shows it at its true size')));
    writeFileSync(path.join(shots, '18-shop-size-render.png'), Buffer.from(await (await fetch(`${A}${renders.get('size')}`)).arrayBuffer()));
    assert.ok(imageAsks.every((a) => a.size === '2K' && a.aspect === '1:1'), JSON.stringify(imageAsks.map((a) => [a.size, a.aspect])));
    assert.equal(imageAsks.length, 6, 'five photos and the one tried again');
    for (const label of ['Shop · Main', 'Shop · 3/4 view', 'Shop · Detail', 'Shop · Lifestyle', 'Shop · Size']) await page.locator('.ph-tile-bar', { hasText: label }).waitFor();
    // The 3D view's camera is where the user left it.
    await page.getByRole('button', { name: 'Close product photos' }).click();
    assert.ok(before.equals(await view.screenshot()), 'the view is as it was');
    await page.getByRole('button', { name: 'Product photos' }).click();
    await page.locator('.ph-gallery').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, '18-shop-set.png') });
    await page.locator('.ph-thumb').first().click();
    await page.locator('.ph-big', { hasText: 'Shop set · ' }).waitFor();
    await page.screenshot({ path: path.join(shots, '18-shop-big.png') });
    assert.deepEqual(errors, []);
  } finally {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
  }
});

test('sale sizes: S / M / L suggested, one shown and resized alone, sliced one at a time, and scene photos for every size from one scene', TEST, async () => {
  const pid = 'ui-smoke-00000007';
  // A flat wall plaque without parameters: its sizes scale its face, its thickness stays.
  const plaque = 'function build() { return [{ name: \'Board\', color: \'#2f6f8f\', shape: Manifold.cube([120, 80, 4]) }, { name: \'Bar\', color: \'#f2efe6\', shape: Manifold.cube([80, 10, 2]).translate([20, 58, 4]) }]; }';
  const r = await putDesign({ id: pid, name: 'Sized wall plaque', createdAt: 1, updatedAt: 1, code: plaque, values: {}, messages: [], currentVersion: 0,
    versions: [{ code: plaque, summary: 'A wall plaque', createdAt: 1, source: 'manual' }] });
  assert.equal(r.status, 200, await r.text());
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  openImages();
  try {
    const page = await newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // A stand-in for Bambu Studio: the page is told it is installed, and its slices are counted (never two at once).
    let active = 0, most = 0, slices = 0;
    await page.route('**/api/capabilities', async (route) => { const res = await route.fetch(); await route.fulfill({ response: res, json: { ...(await res.json()), bambu: '02.04.00.00' } }); });
    await page.route('**/api/bambu/template', (route) => route.fulfill({ json: { version: '02.08.04.57', settings: { filament_colour: ['#00AE42'], filament_type: ['PLA'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0', '280', '280', '0'], flush_volumes_vector: ['140', '140'] }, perFilament: ['filament_colour', 'filament_type'], perFilamentPlus2: [] } }));
    await page.route('**/api/slice', async (route) => {
      const n = ++slices;
      most = Math.max(most, ++active);
      await new Promise((res) => setTimeout(res, 300));
      active--;
      await route.fulfill({ json: { seconds: 1800 * n, grams: 10 * n, filaments: [{ color: '#2f6f8f', grams: 10 * n }] } });
    });
    await page.goto(`${A}/?design=${pid}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - Sized wall plaque');
    await built(page);

    // Three sizes around its own 120 mm width, each built for real: the face scales, 6 mm thick.
    await page.getByRole('button', { name: 'Suggest S / M / L' }).click();
    const dims = page.locator('.size-row .size-dims');
    await until(async () => (await dims.allInnerTexts()).join('|') === '85 × 56.7 × 6|120 × 80 × 6|170 × 113 × 6', 'the three sizes built', 30_000);
    await page.locator('.size-how', { hasText: 'Scaled across its face; the thickness stays' }).waitFor();
    await until(async () => ((await getDesign(pid)).sizes ?? []).filter((s: { resolved?: unknown }) => s.resolved).length === 3, 'the sizes saved with the design');
    await page.locator('.sizes').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, '19-sizes.png') });

    // L in the view: the banner says so, and Overall size changes L alone.
    await page.getByRole('button', { name: 'Show size L in the 3D view' }).click();
    await page.locator('.size-banner', { hasText: 'Size L' }).locator('.mono').waitFor();
    await page.locator('.size-mode h4', { hasText: 'Overall size · L' }).waitFor();
    const w = page.locator('.size-mode .axis-x input');
    await w.fill('180');
    await w.press('Enter');
    await page.locator('.size-banner', { hasText: '180 × 120 × 6 mm' }).waitFor();
    await until(async () => ((await getDesign(pid)).sizes as { mm: number }[]).map((s) => s.mm).join() === '85,120,180', 'L saved; S and M stay');
    // A size out of order is pointed out, never fixed by changing another one.
    const m = page.getByRole('textbox', { name: 'W of size M, mm' });
    await m.fill('200');
    await m.press('Enter');
    await page.locator('.sizes .size-note', { hasText: 'L (180 mm) is not bigger than M (200 mm)' }).waitFor();
    await m.fill('120');
    await m.press('Enter');
    await page.locator('.sizes .size-note', { hasText: 'is not bigger' }).waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(shots, '19-size-shown.png') });

    // Export makes the size shown: L, 180 mm wide, named for it (not the design's own 120 mm).
    await page.getByRole('button', { name: 'More export formats' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.export-menu button', { hasText: /^STL/ }).click()]);
    assert.equal(dl.suggestedFilename(), 'sized-wall-plaque-l.stl');
    const stl = readFileSync((await dl.path())!);
    let minX = Infinity, maxX = -Infinity;
    for (let t = 0, n = stl.readUInt32LE(80); t < n; t++) {
      for (let v = 0; v < 3; v++) { const x = stl.readFloatLE(84 + t * 50 + 12 + v * 12); minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    }
    assert.equal(Math.round(maxX - minX), 180);
    await page.getByText(/Exported sized-wall-plaque-l\.stl/).waitFor();

    // Every size sliced, one after the other.
    await page.getByRole('button', { name: 'Slice every size' }).click();
    await until(async () => (await page.locator('.sizes-table tbody td.mono').allInnerTexts()).filter((t) => t.endsWith(' g')).length === 3, 'three sizes sliced', 30_000);
    assert.deepEqual(await page.locator('.sizes-table tbody tr').evaluateAll((rows) => rows.map((tr) => tr.children[2]?.textContent)), ['10.0 g', '20.0 g', '30.0 g']);
    assert.equal(slices, 3);
    assert.equal(most, 1, 'one slice at a time');
    await until(async () => ((await getDesign(pid)).sizes as { slice?: { stats: { grams: number } } }[]).map((s) => s.slice?.stats.grams).join() === '10,20,30', 'the grams saved per size');
    await page.screenshot({ path: path.join(shots, '19-sizes-sliced.png') });

    // Photos for all sizes: the lifestyle and size photos of L (shown in the view) first, then S
    // and M from their own renders in L's scenes.
    const asked = imageAsks.length;
    await page.getByRole('button', { name: 'Product photos' }).click();
    await page.getByRole('button', { name: 'Photos for all sizes (S, M, L)' }).click();
    await until(async () => ((await getDesign(pid)).photos ?? []).length === 6, 'six size photos in the design', 60_000);
    type Photo = { url: string; render?: string; shop?: string; scene: string; saleSize?: { label: string; mm: number }; sizeOf?: string; dims?: number[]; prompt: string };
    const photos = (await getDesign(pid)).photos as Photo[];
    const of = (shot: string, label: string) => photos.find((ph) => ph.shop === shot && ph.saleSize?.label === label)!;
    for (const shot of ['lifestyle', 'size']) {
      const first = of(shot, 'L');
      assert.ok(first && !first.sizeOf, `${shot}: L made first`);
      for (const label of ['S', 'M']) {
        const ph = of(shot, label);
        assert.equal(ph.sizeOf, first.url, `${shot} ${label}: in L's scene`);
        assert.notEqual(ph.render, first.render, `${shot} ${label}: its own render`);
        assert.match(ph.prompt, new RegExp(`THIS PHOTO SHOWS THE ${label} SIZE`));
        assert.match(ph.prompt, /THE SCENE TO KEEP EXACTLY/);
      }
    }
    assert.deepEqual(of('size', 'S').dims, [85, 56.7, 6]);
    assert.match(of('size', 'S').prompt, /0\.47x as wide and as tall as in the earlier photo \(just as thick as before\)/);
    assert.match(of('size', 'S').prompt, /now it is 1x as wide as it/);
    assert.ok(imageAsks.slice(asked).every((a) => a.size === '2K'), 'shop photos stay at 2K');
    for (const label of ['Shop · Lifestyle · L', 'Shop · Size · S', 'Shop · Size · M']) await page.getByRole('button', { name: `${label} photo, enlarge` }).waitFor();
    // The gallery by size.
    await page.locator('.ph-filter').getByRole('radio', { name: 'S', exact: true }).click();
    assert.equal(await page.locator('.ph-gallery .ph-tile:not(.pending)').count(), 2);
    await page.locator('.ph-gallery').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, '19-size-photos.png') });

    // S made bigger: only S's numbers and photos are out of date, with a one-click redo in the same scene.
    await page.getByRole('button', { name: 'Close product photos' }).click();
    const s = page.getByRole('textbox', { name: 'W of size S, mm' });
    await s.fill('90');
    await s.press('Enter');
    await page.locator('.sizes-table tbody tr').first().locator('td', { hasText: 'changed since it was sliced' }).waitFor();
    assert.deepEqual(await page.locator('.sizes-table tbody tr').evaluateAll((rows) => rows.slice(1).map((tr) => tr.children[2]?.textContent)), ['20.0 g', '30.0 g']);
    await page.getByRole('button', { name: 'Product photos' }).click();
    const old = page.locator('.ph-outdated[title*="made for 85 mm, now 90 mm"]', { hasText: 'Made for 85 mm' });
    await until(async () => (await old.count()) === 2, 'the two S photos out of date');
    await page.locator('.ph-filter').getByRole('radio', { name: 'All', exact: true }).click();
    assert.equal(await page.locator('.ph-outdated').count(), 2, 'M and L photos are still up to date');
    await page.locator('.ph-gallery').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, '19-size-outdated.png') });
    await old.first().click();
    await until(async () => ((await getDesign(pid)).photos ?? []).length === 7, 'the S photo made again', 30_000);
    const redone = ((await getDesign(pid)).photos as Photo[]).at(-1)!;
    assert.equal(redone.saleSize?.mm, 90);
    assert.match(redone.prompt, /THIS PHOTO SHOWS THE S SIZE OF THE PRODUCT: 90 mm wide/);
    assert.equal(await page.locator('.ph-outdated').count(), 2, 'the old photo stays, marked');
    assert.deepEqual(errors, []);
  } finally {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
  }
});

test('Edit drawing paints lines in another filament: shown on the lines only (also while painting), and fills inside an outline: shown off them only; built as a part of its own, its top layers by default with the swaps it costs', TEST, async () => {
  const lid = 'ui-smoke-00000009';
  const box = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  // A 2:1 rectangle outline, 120 mm wide.
  const frame = { name: 'frame', aspect: 2, shapes: [{ rule: 'EvenOdd', contours: [box(-1, -0.5, 1, 0.5), box(-0.98, -0.48, 0.98, 0.48)], color: '#000000' }] };
  const art = "function build() { return H.lineart('frame', { style: 'outline', width: 120 }); }";
  const r = await putDesign({ id: lid, name: 'Painted frame', createdAt: 1, updatedAt: 1, code: art, values: { $drawings: JSON.stringify({ frame }) }, messages: [], currentVersion: 0,
    versions: [{ code: art, summary: 'A frame', createdAt: 1, source: 'manual' }] });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${A}/?design=${lid}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Painted frame');
  await built(page);
  await page.getByRole('tab', { name: /Print/ }).click();
  await page.getByRole('button', { name: 'Paint and fix the picture by hand' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit the drawing' });
  await editor.waitFor();
  await editor.getByRole('radio', { name: 'Paint' }).click();
  await editor.getByRole('button', { name: 'Pick another filament' }).click();
  const picker = page.getByRole('dialog', { name: 'Add a filament' });
  await picker.getByRole('textbox', { name: 'Search the filaments' }).fill('red');
  const option = picker.getByRole('option').first();
  const name = (await option.getAttribute('aria-label'))!.split(',')[0];
  await option.click();
  await picker.waitFor({ state: 'detached' });
  assert.equal(await editor.getByRole('radio', { name, exact: true }).getAttribute('aria-checked'), 'true');
  // A stroke down the middle, across the top and bottom lines.
  const over = editor.locator('.la-ed-over');
  const b = (await over.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 5);
  await page.mouse.down();
  for (let k = 1; k <= 20; k++) await page.mouse.move(b.x + b.width / 2, b.y + 5 + ((b.height - 10) * k) / 20);
  // Red where the stroke crosses the lines, not over the paper between them: while it is drawn (see-through) and once it is.
  const reds = (alpha: number) => over.evaluate((c: HTMLCanvasElement, [cssArea, a]: number[]) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > a && d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) n++;
    return { n, px: (c.width * c.height) / cssArea };
  }, [b.width * b.height, alpha]);
  const live = await reds(60);
  assert.ok(live.n > 100 * live.px && live.n < 4000 * live.px, `${live.n} red pixels while painting`);
  await page.mouse.up();
  const red = await reds(200);
  assert.ok(red.n > 100 * red.px && red.n < 4000 * red.px, `${red.n} red pixels`);
  await page.screenshot({ path: path.join(shots, '18-lineart-paint.png') });
  // Fill (in the same red): a stroke along the inside of the top line, over its edge. It shows only
  // off the lines (the paper inside), never on them: while it is drawn and once it is.
  await editor.getByRole('radio', { name: 'Fill' }).click();
  const edge = await editor.locator('.la-ed-canvas').first().evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(Math.round(c.width * 0.3), 0, 1, c.height).data;
    let y = 0;
    while (y < c.height && d[y * 4] > 128) y++;
    while (y < c.height && d[y * 4] <= 128) y++;
    return y / (c.height / c.getBoundingClientRect().height);
  });
  const fb = (await over.boundingBox())!;
  await page.mouse.move(fb.x + fb.width * 0.2, fb.y + edge + 2);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(fb.x + fb.width * (0.2 + (0.2 * k) / 10), fb.y + edge + 2);
  // Red over the paper and over the lines, left of the paint down the middle.
  const filled = (alpha: number) => page.evaluate((a) => {
    const [base, top] = [...document.querySelectorAll<HTMLCanvasElement>('.la-ed-canvas')];
    const w = top.width, h = top.height, bd = base.getContext('2d')!.getImageData(0, 0, w, h).data, od = top.getContext('2d')!.getImageData(0, 0, w, h).data;
    let on = 0, off = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w * 0.45; x++) {
      const i = (y * w + x) * 4;
      if (od[i + 3] > a && od[i] > 150 && od[i + 1] < 90 && od[i + 2] < 90) { if (bd[i] < 100) on++; else off++; }
    }
    return { on, off, px: (w * h) / (top.getBoundingClientRect().width * top.getBoundingClientRect().height) };
  }, alpha);
  const liveFill = await filled(60);
  assert.ok(liveFill.off > 300 * liveFill.px && liveFill.on < 0.1 * liveFill.off, `filling: ${liveFill.off} red pixels off the lines, ${liveFill.on} on them`);
  await page.mouse.up();
  const fill = await filled(200);
  assert.ok(fill.off > 300 * fill.px && fill.on < 0.1 * fill.off, `filled: ${fill.off} red pixels off the lines, ${fill.on} on them`);
  await page.screenshot({ path: path.join(shots, '18-lineart-fill.png') });
  // A square brush (Draw's lines stay round): a dab by the top line, saved square.
  const square = editor.getByRole('radio', { name: 'Square brush' });
  await square.click();
  assert.equal(await square.getAttribute('aria-checked'), 'true');
  await editor.getByRole('radio', { name: 'Draw' }).click();
  assert.ok(await square.isDisabled(), 'no square for a line');
  await editor.getByRole('radio', { name: 'Fill' }).click();
  assert.equal(await square.getAttribute('aria-checked'), 'true');
  await page.mouse.click(fb.x + fb.width * 0.7, fb.y + edge + 2);
  await editor.getByRole('button', { name: 'Done' }).click();
  await editor.waitFor({ state: 'detached' });
  // Built: the painted lines are a part in that filament, saved with the design.
  await page.getByRole('tab', { name: /Object/ }).click();
  await page.locator('.object-name', { hasText: `Line art (${name})` }).waitFor();
  await until(async () => !!(await getDesign(lid)).values?.$lineartEdits, 'the paint is saved with the design');
  const saved = JSON.parse((await getDesign(lid)).values.$lineartEdits).frame.strokes;
  assert.equal(saved[0].mode, 'paint');
  assert.equal(saved[0].filament.name, name);
  assert.deepEqual([saved[1].mode, saved[1].filament.name], ['fill', name]);
  assert.deepEqual([saved[1].shape, saved[2].mode, saved[2].shape], [undefined, 'fill', 'square']);
  await page.screenshot({ path: path.join(shots, '18-lineart-painted.png') });
  // The first colour goes in the top layers; the Print tab says what its filament changes cost, and the other choice.
  assert.equal((await getDesign(lid)).values.$lineartColourDepth, 'auto');
  await page.getByRole('tab', { name: /Print/ }).click();
  const depth = page.getByRole('combobox', { name: 'How deep the colours go' });
  assert.equal(await depth.inputValue(), 'auto');
  await page.locator('.lineart-depth', { hasText: /Top layers \(auto\): \d+ filament changes? on \d+ layers?, about \d+ min/ }).waitFor();
  await page.locator('.lineart-depth', { hasText: /Through the piece: \d+ filament changes/ }).waitFor();
  await page.screenshot({ path: path.join(shots, '18-lineart-depth.png') });
  await depth.selectOption('through');
  await until(async () => (await getDesign(lid)).values?.$lineartColourDepth === 'through', 'the depth is saved with the design');
  assert.deepEqual(errors, []);
});

test('Edit drawing selects an area and clears the hand edits there only: shown as the app made it, then built so', TEST, async () => {
  const { drawingFingerprint } = await import('../../shared/lineart');
  const cid = 'ui-smoke-0000000a';
  const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  // The frame of the paint test, with a line drawn by hand down each half.
  const frame = { name: 'frame', aspect: 2, shapes: [{ rule: 'EvenOdd' as const, contours: [box(-1, -0.5, 1, 0.5), box(-0.98, -0.48, 0.98, 0.48)], color: '#000000' }] };
  const line = (x: number) => ({ mode: 'draw', width: 1.5, points: [[x, -0.48], [x, 0.48]] });
  const edits = { frame: { fp: drawingFingerprint(frame), strokes: [line(-0.6), line(0.6)] } };
  const art = "function build() { return H.lineart('frame', { style: 'outline', width: 120 }); }";
  const r = await putDesign({ id: cid, name: 'Cleared frame', createdAt: 1, updatedAt: 1, code: art, values: { $drawings: JSON.stringify({ frame }), $lineartEdits: JSON.stringify(edits) }, messages: [], currentVersion: 0,
    versions: [{ code: art, summary: 'A frame', createdAt: 1, source: 'manual' }] });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${A}/?design=${cid}`);
  await page.waitForFunction(() => document.title === 'prompt-to-part - Cleared frame');
  await built(page);
  await page.getByRole('tab', { name: /Print/ }).click();
  await page.locator('.lineart-edit-row', { hasText: '2 hand edits' }).waitFor();
  await page.getByRole('button', { name: 'Paint and fix the picture by hand' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit the drawing' });
  await editor.waitFor();
  await editor.getByRole('radio', { name: 'Select' }).click();
  const here = editor.getByRole('button', { name: 'Clear edits here' });
  assert.ok(await here.isDisabled(), 'nothing selected yet');
  // The dark runs across the middle of the piece: the frame, the left line, the right line, the frame.
  const over = editor.locator('.la-ed-over');
  const b = (await over.boundingBox())!;
  const runs = await editor.locator('.la-ed-canvas').first().evaluate((c: HTMLCanvasElement) => {
    const k = c.width / c.getBoundingClientRect().width, d = c.getContext('2d')!.getImageData(0, Math.round(c.height / 2), c.width, 1).data, out: number[] = [];
    for (let x = 0, start = -1; x < c.width; x++) {
      const dark = d[x * 4] < 100;
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) { out.push((start + x) / 2 / k); start = -1; }
    }
    return out;
  });
  assert.equal(runs.length, 4, `dark runs at ${runs.map(Math.round)}`);
  // Down the left line, past the piece's top and bottom.
  const select = async () => {
    await page.mouse.move(b.x + runs[1], b.y + 4);
    await page.mouse.down();
    for (let k = 1; k <= 10; k++) await page.mouse.move(b.x + runs[1], b.y + 4 + ((b.height - 8) * k) / 10);
    await page.mouse.up();
  };
  await select();
  assert.ok(!(await here.isDisabled()), 'selected');
  // Escape drops the selection (the editor stays open), and it is selected again.
  await page.keyboard.press('Escape');
  await until(async () => here.isDisabled(), 'Escape deselects');
  await select();
  await page.screenshot({ path: path.join(shots, '20-lineart-select.png') });
  await here.click();
  // Once the piece as the app made it is known, the left line is gone from the view, the frame's top line there as it was.
  await editor.locator('.la-ed-note', { hasText: 'Working out the piece' }).waitFor({ state: 'detached' });
  const at = (x: number, y: number) => over.evaluate((c: HTMLCanvasElement, [px, py]: number[]) => {
    const k = c.width / c.getBoundingClientRect().width;
    return [...c.getContext('2d')!.getImageData(Math.round(px * k), Math.round(py * k), 1, 1).data];
  }, [x, y]);
  const top = await editor.locator('.la-ed-canvas').first().evaluate((c: HTMLCanvasElement, x: number) => {
    const k = c.width / c.getBoundingClientRect().width, d = c.getContext('2d')!.getImageData(Math.round(x * k), 0, 1, c.height).data;
    let y = 0;
    while (y < c.height && d[y * 4] > 100) y++;
    return (y + 2) / k;
  }, runs[1]);
  await until(async () => { const p = await at(runs[1], b.height / 2); return p[3] > 200 && p[0] > 200; }, 'the left line cleared in the view');
  const t = await at(runs[1], top);
  assert.ok(t[3] > 200 && t[0] < 100, `the frame's top line shows there (${t})`);
  await page.screenshot({ path: path.join(shots, '20-lineart-cleared.png') });
  await editor.getByRole('button', { name: 'Done' }).click();
  await editor.waitFor({ state: 'detached' });
  // Saved: only the right line is left (the left one all cleared, so no clear is kept either).
  await until(async () => JSON.parse((await getDesign(cid)).values.$lineartEdits ?? '{}').frame?.strokes.length === 1, 'the cleared edit is gone from the design');
  assert.deepEqual(JSON.parse((await getDesign(cid)).values.$lineartEdits).frame.strokes, [line(0.6)]);
  await page.locator('.lineart-edit-row', { hasText: '1 hand edit' }).waitFor();
  assert.deepEqual(errors, []);
});

test('the artwork editor edits only the marked area: a new version that lines up', TEST, async () => {
  // As if the app had an OpenRouter key; the image model is the stand-in (black inside the mark).
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const { drawingFingerprint } = await import('../../shared/lineart');
  const aid = 'ui-smoke-0000000e';
  const BLACK = '#111111', GOLD = '#e0a868';
  const square = (h: number): [number, number][] => [[-h, -h], [h, -h], [h, h], [-h, h]];
  const disc = (r: number): [number, number][] => Array.from({ length: 64 }, (_, i) => [r * Math.cos((2 * Math.PI * i) / 64), r * Math.sin((2 * Math.PI * i) / 64)]);
  // A black square with a gold disc, and a gold stroke painted across the middle by hand.
  const art = { name: 'art', aspect: 1, shapes: [{ rule: 'EvenOdd' as const, contours: [square(0.5)], color: BLACK }, { rule: 'EvenOdd' as const, contours: [disc(0.3)], color: GOLD }] };
  const edits = { art: { fp: drawingFingerprint(art), strokes: [{ mode: 'paint', color: GOLD, width: 0.04, points: [[-0.45, 0], [0.45, 0]] }] } };
  const script = `function build() { return [
    { name: 'Black', color: '${BLACK}', shape: H.svg('art', { height: 40, colors: ['${BLACK}'] }).extrude(1) },
    { name: 'Gold', color: '${GOLD}', shape: H.svg('art', { height: 40, colors: ['${GOLD}'] }).extrude(2) },
  ]; }`;
  const values = { $drawings: JSON.stringify({ art }), $artworkEdits: JSON.stringify(edits) };
  const r = await putDesign({ id: aid, name: 'Gold disc', createdAt: 1, updatedAt: 1, code: script, values, messages: [], currentVersion: 0,
    versions: [{ code: script, summary: 'A gold disc', createdAt: 1, source: 'manual', values }] });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${A}/?design=${aid}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - Gold disc');
    await built(page);
    await page.getByRole('button', { name: 'Paint and fix the picture by hand' }).click();
    const editor = page.getByRole('dialog', { name: 'Paint the artwork' });
    await editor.waitFor();
    await editor.getByRole('radio', { name: 'Select' }).click();
    // No mark yet: the whole picture.
    await editor.getByText('Edit the whole picture').waitFor();
    // A short stroke across the middle of the picture marks the area.
    const b = (await editor.locator('.la-ed-over').boundingBox())!;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2, half = Math.min(b.width, b.height) * 0.08;
    await page.mouse.move(cx - half, cy);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(cx - half + (2 * half * k) / 8, cy);
    await page.mouse.up();
    await editor.getByText('Edit this picture here').waitFor();
    // The mark is saved with the design as it is made (the chat can use it).
    await until(async () => !!JSON.parse((await getDesign(aid)).values.$pictureMarks ?? '{}').art, 'the mark saved with the design');
    assert.equal(JSON.parse((await getDesign(aid)).values.$pictureMarks).art.fp, drawingFingerprint(art));

    const change = editor.getByPlaceholder('What to change, e.g. make him look like the man in the photo');
    await change.fill('make the middle black');
    // Escape in the text box only leaves it: the mark and the editor stay.
    await change.press('Escape');
    await editor.getByRole('button', { name: 'Deselect' }).waitFor();
    await editor.getByText('Edit this picture here').waitFor();
    const photo = Buffer.from(encodePng({ width: 4, height: 4, data: new Uint8Array(64).fill(200), channels: 4 }));
    await editor.locator('input[type=file]').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: photo });
    await editor.getByRole('img', { name: 'Photo 1' }).waitFor();
    const editButton = editor.getByRole('button', { name: 'Edit', exact: true });

    // Cancel while it works stops the request (the image model's call is aborted).
    nextEdit = 'hold';
    await editButton.click();
    await editor.getByText(/Editing the picture\.\.\. \d+ s/).waitFor();
    await editor.getByRole('button', { name: 'Cancel', exact: true }).last().click();
    await until(async () => editStopped, 'Cancel aborts the picture edit');
    await until(async () => !existsSync(path.join(os.tmpdir(), `ptp-busy-picture-edit-${aid}`)), 'the server is done with the stopped edit');
    await editButton.waitFor();

    // An edit that fails says why; painted after it, Try again sends the strokes as they are now.
    nextEdit = 'fail';
    await editButton.click();
    await editor.getByRole('alert').filter({ hasText: 'test/image is busy' }).waitFor();
    await editor.getByRole('radio', { name: 'Paint' }).click();
    await page.mouse.move(cx, cy - half);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(cx, cy - half + (2 * half * k) / 8);
    await page.mouse.up();
    await editor.getByRole('button', { name: 'Try again' }).click();

    const keep = editor.getByRole('button', { name: 'Keep' });
    await keep.waitFor();
    await editor.getByText('Outside the mark: unchanged').waitFor();
    await editor.getByText('Cost $0.04').waitFor();
    // The mark's edge over the before / after pictures.
    assert.equal(await editor.locator('.la-ed-edit-edge').count(), 2);
    await page.screenshot({ path: path.join(shots, '21-artwork-edit-result.png') });
    // Sent each time: the crop, the crop outlined, the whole picture and the photo.
    assert.equal(editAsks.length, 3);
    assert.ok(editAsks.every((a) => a.references === 4));
    assert.match(editAsks[2].prompt, /make the middle black/);
    // Escape doesn't drop the result: the editor stays open.
    await page.keyboard.press('Escape');
    await keep.waitFor();
    await keep.click();
    await editor.waitFor({ state: 'detached' });

    // A new version, measured once its build is in: it lines up with the one it came from.
    await until(async () => (await getDesign(aid)).versions[1]?.pictureEdit?.linesUp === true, 'the kept edit lines up', 30_000);
    const d = await getDesign(aid);
    assert.equal(d.versions.length, 2);
    assert.equal(d.currentVersion, 1);
    assert.deepEqual(d.versions[1].pictureEdit, { picture: 'art', change: 'make the middle black', masked: true, parent: 0, linesUp: true, cost: 0.04 });
    assert.notEqual(d.values.$drawings, values.$drawings, 'the drawing changed');
    // The stroke saved and the one painted after the failed edit, both cut by the mark.
    const strokes = JSON.parse(d.values.$artworkEdits).art.strokes;
    assert.equal(strokes.length, 2);
    assert.ok(strokes.every((s: { cut?: unknown[] }) => s.cut?.length), 'the strokes carry the cut');
    assert.equal(d.values.$pictureMarks, undefined, 'the mark is used up');
    // The chat: the change with the photo, and the result with its version, stored pictures only.
    const [user, reply] = d.messages;
    assert.equal(user.text, 'Picture edit: make the middle black');
    assert.match(user.images[0], /^\/api\/designs\/ui-smoke-0000000e\/images\//);
    assert.equal(reply.versionIndex, 1);
    assert.match(reply.text, /^Picture edit kept as v2\. Outside the mark: unchanged\. Cost \$0\.04\.$/);
    assert.doesNotMatch(JSON.stringify(d.messages), /data:/);
    await page.locator('.msg.assistant', { hasText: 'Picture edit kept as v2' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
  }
});

test('a LayerTone photo\'s picture editor edits only the marked area: a new version that lines up, its automatic swaps kept', TEST, async () => {
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const { toBase64 } = await import('../../shared/layertone');
  const lid = 'ui-smoke-00000011';
  // A grey photo: dark at the left, bright at the right, a lighter disc in the middle.
  const W = 120, H = 90, luma = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) luma[y * W + x] = Math.min(255, Math.round(20 + 235 * (x / (W - 1)) * 0.8 + (Math.hypot(x - 60, y - 45) < 15 ? 40 : 0)));
  const photo = { name: 'photo-1', width: W, height: H, luma: toBase64(luma) };
  const script = "function build() { return { name: 'Picture', ...H.layertone('photo-1', { width: 60 }) }; }";
  const values = { $images: JSON.stringify({ 'photo-1': photo }) };
  const r = await putDesign({ id: lid, name: 'Grey photo', createdAt: 1, updatedAt: 1, code: script, values, messages: [], currentVersion: 0,
    versions: [{ code: script, summary: 'A grey photo', createdAt: 1, source: 'manual', values }] });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${A}/?design=${lid}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - Grey photo');
    await built(page);
    await page.getByRole('button', { name: 'Edit the picture' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit the picture' });
    await editor.waitFor();
    await editor.getByText('Edit the whole picture').waitFor();
    // A short stroke across the middle of the picture marks the area.
    const b = (await editor.locator('.la-ed-over').boundingBox())!;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2, half = Math.min(b.width, b.height) * 0.06;
    await page.mouse.move(cx - half, cy);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(cx - half + (2 * half * k) / 8, cy);
    await page.mouse.up();
    await editor.getByText('Edit this picture here').waitFor();
    await until(async () => !!JSON.parse((await getDesign(lid)).values.$pictureMarks ?? '{}')['photo-1'], 'the mark saved with the design');

    await editor.getByPlaceholder('What to change, e.g. make him look like the man in the photo').fill('a dark face');
    const asked = editAsks.length;
    await editor.getByRole('button', { name: 'Edit', exact: true }).click();
    const keep = editor.getByRole('button', { name: 'Keep' });
    await keep.waitFor();
    await editor.getByText('Outside the mark: unchanged').waitFor();
    await editor.getByText(/Swap layers kept as they were \(layer \d+\)/).waitFor();
    assert.equal(editAsks.length, asked + 1);
    assert.equal(editAsks.at(-1)!.references, 3);
    assert.match(editAsks.at(-1)!.prompt, /LayerTone/);
    await page.screenshot({ path: path.join(shots, '22-layertone-edit-result.png') });
    await keep.click();
    await editor.waitFor({ state: 'detached' });

    await until(async () => (await getDesign(lid)).versions[1]?.pictureEdit?.linesUp === true, 'the kept edit lines up', 30_000);
    const d = await getDesign(lid);
    assert.deepEqual(d.versions[1].pictureEdit, { picture: 'photo-1', change: 'a dark face', masked: true, parent: 0, linesUp: true, cost: 0.04 });
    assert.notEqual(d.values.$images, values.$images, 'the picture changed');
    assert.equal(JSON.parse(d.values.$layertone).swaps.length, 1, 'the automatic swap kept');
    assert.equal(d.values.$pictureMarks, undefined, 'the mark is used up');
    await page.locator('.msg.assistant', { hasText: 'Picture edit kept as v2' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
  }
});

test('a lithophane\'s picture editor edits only the marked area: a new version that lines up, no swap layers involved', TEST, async () => {
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const { toBase64 } = await import('../../shared/layertone');
  const lid = 'ui-smoke-00000012';
  const W = 120, H = 90, luma = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) luma[y * W + x] = Math.min(255, Math.round(20 + 235 * (x / (W - 1)) * 0.8 + (Math.hypot(x - 60, y - 45) < 15 ? 40 : 0)));
  const photo = { name: 'photo-1', width: W, height: H, luma: toBase64(luma) };
  const script = "function build() { return { name: 'Lithophane', ...H.lithophane('photo-1', { width: 60 }) }; }";
  const values = { $images: JSON.stringify({ 'photo-1': photo }) };
  const r = await putDesign({ id: lid, name: 'Grey lithophane', createdAt: 1, updatedAt: 1, code: script, values, messages: [], currentVersion: 0,
    versions: [{ code: script, summary: 'A lithophane', createdAt: 1, source: 'manual', values }] });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${A}/?design=${lid}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - Grey lithophane');
    await built(page);
    await page.getByRole('button', { name: 'Edit the picture' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit the picture' });
    await editor.waitFor();
    const b = (await editor.locator('.la-ed-over').boundingBox())!;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2, half = Math.min(b.width, b.height) * 0.06;
    await page.mouse.move(cx - half, cy);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(cx - half + (2 * half * k) / 8, cy);
    await page.mouse.up();
    await editor.getByText('Edit this picture here').waitFor();
    await until(async () => !!JSON.parse((await getDesign(lid)).values.$pictureMarks ?? '{}')['photo-1'], 'the mark saved with the design');

    await editor.getByPlaceholder('What to change, e.g. make him look like the man in the photo').fill('a dark face');
    const asked = editAsks.length;
    await editor.getByRole('button', { name: 'Edit', exact: true }).click();
    const keep = editor.getByRole('button', { name: 'Keep' });
    await keep.waitFor();
    await editor.getByText('Outside the mark: unchanged').waitFor();
    assert.equal(editAsks.length, asked + 1);
    assert.match(editAsks.at(-1)!.prompt, /lithophane/);
    assert.equal(await editor.getByText(/Swap layers/).count(), 0);
    await keep.click();
    await editor.waitFor({ state: 'detached' });

    await until(async () => (await getDesign(lid)).versions[1]?.pictureEdit?.linesUp === true, 'the kept edit lines up', 30_000);
    const d = await getDesign(lid);
    assert.deepEqual(d.versions[1].pictureEdit, { picture: 'photo-1', change: 'a dark face', masked: true, parent: 0, linesUp: true, cost: 0.04 });
    assert.notEqual(d.values.$images, values.$images, 'the picture changed');
    assert.equal(d.values.$layertone, undefined, 'no LayerTone setup written');
    assert.equal(d.values.$pictureMarks, undefined, 'the mark is used up');
    assert.deepEqual(errors, []);
  } finally {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
  }
});

test('the line art editor edits only the selected area: a new version that lines up, the hand edits outside kept', TEST, async () => {
  // As if the app had an OpenRouter key; the image model is the stand-in (black inside the mark).
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const { drawingFingerprint } = await import('../../shared/lineart');
  const lid = 'ui-smoke-00000013';
  const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  // A 2:1 frame with a bar across its middle, 120 mm wide, and a line drawn by hand down its right part.
  const frame = { name: 'frame', aspect: 2, shapes: [{ rule: 'EvenOdd' as const, contours: [box(-1, -0.5, 1, 0.5), box(-0.97, -0.47, 0.97, 0.47), box(-0.97, -0.02, 0.97, 0.02)], color: '#000000' }] };
  const line = { mode: 'draw', width: 1.5, points: [[0.7, -0.47], [0.7, 0.47]] };
  const art = "function build() { return H.lineart('frame', { style: 'outline', width: 120 }); }";
  const values = { $drawings: JSON.stringify({ frame }), $lineartEdits: JSON.stringify({ frame: { fp: drawingFingerprint(frame), strokes: [line] } }) };
  const r = await putDesign({ id: lid, name: 'Barred frame', createdAt: 1, updatedAt: 1, code: art, values, messages: [], currentVersion: 0,
    versions: [{ code: art, summary: 'A frame', createdAt: 1, source: 'manual', values }] });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${A}/?design=${lid}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - Barred frame');
    await built(page);
    await page.getByRole('button', { name: 'Paint and fix the picture by hand' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit the drawing' });
    await editor.waitFor();
    await editor.getByRole('radio', { name: 'Select' }).click();
    // One drawing and nothing selected: the whole drawing.
    await editor.getByText('Edit the whole picture').waitFor();
    // A short stroke along the bar in the middle marks the area.
    const b = (await editor.locator('.la-ed-over').boundingBox())!;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2, half = Math.min(b.width, b.height) * 0.08;
    // A selection in a far corner of the view reaches no drawing: it is not a whole-drawing edit, Edit waits.
    for (let k = 0; k < 4; k++) await editor.getByRole('button', { name: 'Zoom out' }).click();
    await page.mouse.move(b.x + 3, b.y + 3);
    await page.mouse.down();
    await page.mouse.move(b.x + 12, b.y + 3, { steps: 4 });
    await page.mouse.up();
    await editor.getByText("The selection doesn't reach the drawing").waitFor();
    await editor.getByPlaceholder('What to change, e.g. make him look like the man in the photo').fill('x');
    assert.ok(await editor.getByRole('button', { name: 'Edit', exact: true }).isDisabled(), 'Edit waits when the selection reaches no drawing');
    await editor.getByPlaceholder('What to change, e.g. make him look like the man in the photo').fill('');
    // (Escape leaves the box, then drops the selection.)
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await editor.getByText('Edit the whole picture').waitFor();
    await page.mouse.move(cx - half, cy);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(cx - half + (2 * half * k) / 8, cy);
    await page.mouse.up();
    await editor.getByText('Edit this picture here').waitFor();
    // The selection is saved with the design as the drawing's mark (the chat can use it).
    await until(async () => !!JSON.parse((await getDesign(lid)).values.$pictureMarks ?? '{}').frame, 'the mark saved with the design');
    assert.equal(JSON.parse((await getDesign(lid)).values.$pictureMarks).frame.fp, drawingFingerprint(frame));

    await editor.getByPlaceholder('What to change, e.g. make him look like the man in the photo').fill('a solid block in the middle of the bar');
    const asked = editAsks.length;
    await editor.getByRole('button', { name: 'Edit', exact: true }).click();
    const keep = editor.getByRole('button', { name: 'Keep' });
    await keep.waitFor();
    await editor.getByText('Outside the mark: unchanged').waitFor();
    await editor.getByText('Joins and bridges are worked out again for the whole piece: check them near the mark.').waitFor();
    // Sent: the crop, the crop outlined and the whole drawing, with the line-art prompt.
    assert.equal(editAsks.length, asked + 1);
    assert.equal(editAsks[asked].references, 3);
    assert.match(editAsks[asked].prompt, /black line art/);
    // While the result waits, the brush is locked and Escape keeps the editor open.
    assert.ok(await editor.getByRole('button', { name: 'Done' }).isDisabled(), 'Done waits for Keep or Discard');
    assert.ok(await editor.getByRole('radio', { name: 'Draw' }).isDisabled(), 'the brush is locked');
    await page.keyboard.press('Escape');
    await keep.waitFor();
    await page.screenshot({ path: path.join(shots, '21-lineart-edit-result.png') });
    await keep.click();
    await editor.waitFor({ state: 'detached' });

    // A new version, measured once its build is in: it lines up with the one it came from.
    await until(async () => (await getDesign(lid)).versions[1]?.pictureEdit?.linesUp === true, 'the kept edit lines up', 30_000);
    const d = await getDesign(lid);
    assert.equal(d.currentVersion, 1);
    assert.deepEqual(d.versions[1].pictureEdit, { picture: 'frame', change: 'a solid block in the middle of the bar', masked: true, parent: 0, linesUp: true, cost: 0.04 });
    const next = JSON.parse(d.values.$drawings).frame;
    assert.notDeepEqual(next, frame, 'the drawing changed');
    // The hand-drawn line outside the mark stays, re-keyed to the new drawing, the mark after it as a clear; the mark is used up.
    const edits = JSON.parse(d.values.$lineartEdits).frame;
    assert.equal(edits.fp, drawingFingerprint(next));
    assert.deepEqual(edits.strokes[0], line);
    assert.ok(edits.strokes.length > 1 && edits.strokes.slice(1).every((s: { mode: string; k?: number }) => s.mode === 'restore' && s.k === 1), JSON.stringify(edits.strokes.slice(1)));
    assert.equal(d.values.$pictureMarks, undefined);
    await page.locator('.msg.assistant', { hasText: 'Picture edit kept as v2' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
  }
});

test('a picture edit in the chat: its values applied, the reply\'s version records it and lines up; the editor\'s edits go along', TEST, async () => {
  const { drawingFingerprint } = await import('../../shared/lineart');
  const cid = 'ui-smoke-0000000f';
  const BLACK = '#111111', GOLD = '#e0a868';
  const square = (h: number): [number, number][] => [[-h, -h], [h, -h], [h, h], [-h, h]];
  const disc = (r: number): [number, number][] => Array.from({ length: 64 }, (_, i) => [r * Math.cos((2 * Math.PI * i) / 64), r * Math.sin((2 * Math.PI * i) / 64)]);
  const art = (r: number) => ({ name: 'art', aspect: 1, shapes: [{ rule: 'EvenOdd' as const, contours: [square(0.5)], color: BLACK }, { rule: 'EvenOdd' as const, contours: [disc(r)], color: GOLD }] });
  const script = `function build() { return [
    { name: 'Black', color: '${BLACK}', shape: H.svg('art', { height: 40, colors: ['${BLACK}'] }).extrude(1) },
    { name: 'Gold', color: '${GOLD}', shape: H.svg('art', { height: 40, colors: ['${GOLD}'] }).extrude(2) },
  ]; }`;
  const marks = JSON.stringify({ art: { fp: drawingFingerprint(art(0.3)), mark: { strokes: [{ width: 0.2, points: [[0, 0]] }] } } });
  const values = { $drawings: JSON.stringify({ art: art(0.3) }), $pictureMarks: marks };
  // v1 from the chat, v2 a picture edit kept in the brush editor since.
  const kept = { picture: 'art', change: 'a gold disc', masked: true, parent: 0, linesUp: true, cost: 0.04 };
  const r = await putDesign({ id: cid, name: 'Chat edit', createdAt: 1, updatedAt: 1, code: script, values, messages: [], currentVersion: 1,
    versions: [{ code: script, summary: 'A disc', createdAt: 1, source: 'ai', values }, { code: script, summary: 'Picture edit: a gold disc', createdAt: 2, source: 'manual', values, pictureEdit: kept }] });
  assert.equal(r.status, 200, await r.text());
  // The reply: edit_picture makes the disc smaller (inside the square: the same box), then the same script is submitted.
  let sent: GenerateRequest | null = null;
  chatEdit.prompt = 'make the disc smaller';
  chatEdit.reply = (req, send) => {
    sent = req;
    send({ type: 'pictureEdited', set: { $drawings: JSON.stringify({ art: art(0.25) }), $pictureMarks: null }, info: { picture: 'art', change: 'a smaller disc', masked: true, outsideSame: true, cost: 0.03 } });
    send({ type: 'model', code: script, summary: 'A smaller gold disc', sources: [] });
    send({ type: 'done', durationMs: 1000, turns: 1, submitted: true, text: 'The disc is smaller.' });
  };
  const page = await newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${A}/?design=${cid}`);
    await built(page);
    const box = page.locator('.chat-panel textarea');
    await box.fill('make the disc smaller');
    await box.press('Enter');
    await page.locator('.msg.assistant', { hasText: 'The disc is smaller.' }).waitFor();
    // Sent along: the user's mark and the editor's edit since the chat's last version.
    assert.ok(sent);
    const req = sent as GenerateRequest;
    assert.equal(req.pictures?.$pictureMarks, marks);
    assert.deepEqual(req.pictureEdits, [{ picture: 'art', change: 'a gold disc', masked: true, version: 2 }]);
    // The values set, a version that records the edit (its parent: v2, current as the reply started), measured once built.
    await until(async () => (await getDesign(cid)).versions[2]?.pictureEdit?.linesUp === true, 'the chat\'s edit lines up', 30_000);
    const d = await getDesign(cid);
    assert.equal(d.versions.length, 3);
    assert.equal(d.currentVersion, 2);
    assert.equal(d.versions[2].source, 'ai');
    assert.deepEqual(d.versions[2].pictureEdit, { picture: 'art', change: 'a smaller disc', masked: true, parent: 1, linesUp: true, cost: 0.03 });
    assert.equal(d.values.$drawings, JSON.stringify({ art: art(0.25) }));
    assert.equal(d.values.$pictureMarks, undefined, 'the mark is used up');
    assert.deepEqual(errors, []);
  } finally {
    chatEdit.prompt = '';
  }
});

test('a printed picture edit: its note and the Printed mark in the version menu; an edit being kept as another tab marks it is not kept, the brush is off', TEST, async () => {
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const pid = 'ui-smoke-00000010';
  const BLACK = '#111111', GOLD = '#e0a868';
  const square = (h: number): [number, number][] => [[-h, -h], [h, -h], [h, h], [-h, h]];
  const disc = (r: number): [number, number][] => Array.from({ length: 64 }, (_, i) => [r * Math.cos((2 * Math.PI * i) / 64), r * Math.sin((2 * Math.PI * i) / 64)]);
  const art = { name: 'art', aspect: 1, shapes: [{ rule: 'EvenOdd' as const, contours: [square(0.5)], color: BLACK }, { rule: 'EvenOdd' as const, contours: [disc(0.3)], color: GOLD }] };
  const script = `function build() { return [
    { name: 'Black', color: '${BLACK}', shape: H.svg('art', { height: 40, colors: ['${BLACK}'] }).extrude(1) },
    { name: 'Gold', color: '${GOLD}', shape: H.svg('art', { height: 40, colors: ['${GOLD}'] }).extrude(2) },
  ]; }`;
  const values = { $drawings: JSON.stringify({ art }) };
  // v2 is a picture edit of v1 that lines up with it; it is the version printed.
  const kept = { picture: 'art', change: 'a gold disc', masked: true, parent: 0, linesUp: true, cost: 0.04 };
  const r = await putDesign({ id: pid, name: 'Printed disc', createdAt: 1, updatedAt: 1, code: script, values, messages: [], currentVersion: 1,
    versions: [{ code: script, summary: 'A disc', createdAt: 1, source: 'manual', values }, { code: script, summary: 'Picture edit: a gold disc', createdAt: 2, source: 'manual', values, pictureEdit: kept }] });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${A}/?design=${pid}`);
    await built(page);
    const brush = page.getByRole('button', { name: 'Paint and fix the picture by hand' });
    await brush.click();
    const editor = page.getByRole('dialog', { name: 'Paint the artwork' });
    await editor.getByRole('radio', { name: 'Select' }).click();
    // A short stroke across the middle marks the area (the stand-in fills it black).
    const b = (await editor.locator('.la-ed-over').boundingBox())!;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2, half = Math.min(b.width, b.height) * 0.08;
    await page.mouse.move(cx - half, cy);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(cx - half + (2 * half * k) / 8, cy);
    await page.mouse.up();
    await editor.getByText('Edit this picture here').waitFor();
    await editor.getByPlaceholder('What to change, e.g. make him look like the man in the photo').fill('make the middle black');
    await editor.getByRole('button', { name: 'Edit', exact: true }).click();
    const keep = editor.getByRole('button', { name: 'Keep' });
    await keep.waitFor();
    // Keep stores the before / after picture first: held here while another tab marks v2 printed.
    const held: { continue: () => Promise<void> }[] = [];
    await page.route(`**/api/designs/${pid}/images`, (route) => { held.push(route); });
    await keep.click();
    await until(async () => held.length === 1, 'Keep stores its picture');
    const marked = await fetch(`${A}/api/designs/${pid}/printed/1`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PTP': '1' }, body: new Uint8Array(0) });
    assert.equal(marked.status, 200, await marked.text());
    await page.evaluate((designId) => new BroadcastChannel('ptp').postMessage({ type: 'printed', tab: 'another-tab', id: designId }), pid);
    // The lock closes the editor, and the brush stays off.
    await editor.waitFor({ state: 'detached' });
    await page.getByText('Printed v2 · locked').waitFor();
    assert.equal(await brush.getAttribute('title'), 'Printed v2 is locked: clone it to change it');
    assert.ok(await brush.isDisabled());
    // The picture stored, Keep goes on: nothing is made from the printed version.
    const stored = page.waitForResponse((res) => res.url().endsWith(`/api/designs/${pid}/images`));
    await Promise.all(held.map((h) => h.continue()));
    await stored;
    await page.waitForTimeout(1500);
    const versionsBtn = page.locator('.version-btn[title=Versions]');
    assert.equal(await versionsBtn.textContent(), 'v2 of 2');
    const d = await getDesign(pid);
    assert.equal(d.versions.length, 2);
    assert.equal(d.currentVersion, 1);
    assert.equal(d.values.$drawings, values.$drawings, 'the picture is as printed');
    // The version menu shows both: where v2 came from, and that it is printed.
    await versionsBtn.click();
    const row = page.locator('.menu-item', { hasText: 'Picture edit: a gold disc' });
    await row.getByText('your picture edit, lines up with v1').waitFor();
    await row.locator('.printed-badge', { hasText: 'Printed' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
    await fetch(`${A}/api/designs/${pid}/printed/1`, { method: 'DELETE', headers: { 'X-PTP': '1' } }).catch(() => undefined);
  }
});

test('the new-design screen offers four starters with their mode, and "Give me 4 new ideas" swaps them for new ones', TEST, async () => {
  // Ideas in the picture modes need an image model (a key), as the starters do.
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const page = await newPage();
  try {
    await page.goto(`${A}/?design=${id}`);
    await page.locator('header a.btn', { hasText: 'New' }).click();
    const intro = page.locator('.chat-intro');
    await intro.waitFor({ timeout: 15_000 });
    await until(async () => (await intro.locator('.example').count()) === 4, 'four starters');
    assert.equal(await intro.locator('.example .idea-mode').count(), 4);
    await page.screenshot({ path: path.join(shots, '7-starters.png') });
    await intro.getByRole('button', { name: 'Give me 4 new ideas' }).click();
    const idea = intro.locator('.example', { hasText: 'A test idea for the smoke test' });
    await idea.waitFor({ timeout: 15_000 });
    assert.equal(await idea.locator('.idea-mode').innerText(), 'Lithophane');
    await page.screenshot({ path: path.join(shots, '7-new-ideas.png') });
    await idea.click();
    assert.equal(await page.locator('.chat-panel textarea').inputValue(), 'A test idea for the smoke test');
    await page.getByRole('button', { name: 'Picture mode: Lithophane' }).waitFor({ timeout: 15_000 });
  } finally {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
    await page.close();
  }
});

test('through OpenRouter the model menu lists its top models with prices, finds the others by search or Show more, and sends the one picked', TEST, async () => {
  const mid = 'ui-smoke-40000001';
  const saved = await putDesign({ id: mid, name: 'Model pick', createdAt: 1, updatedAt: 1, code: '', values: {}, currentVersion: -1, versions: [], messages: [] });
  assert.equal(saved.status, 200, await saved.text());
  const page = await newPage();
  try {
    const entry = (id: string, name: string, created: number, featured = false) => ({
      id, name, fullName: `Maker: ${name}`, created, contextLength: 100000, images: false, featured,
      pricing: { prompt: 0.000000045, completion: 0.0000005, cacheRead: 0.000000045, cacheWrite: 0.000000045 },
    });
    const models = [
      entry('anthropic/claude-opus-5.5', 'Claude Opus 5.5', 30, true),
      entry('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 29, true),
      ...Array.from({ length: 25 }, (_, i) => entry(`other/model-${i}`, `Other Model ${i}`, 20 - i)),
    ];
    await page.route('**/api/capabilities', async (route) => { const res = await route.fetch(); await route.fulfill({ response: res, json: { ...(await res.json()), openRouterModels: true } }); });
    await page.route('**/api/models', (route) => route.fulfill({ json: { models } }));
    const sent: { model?: string }[] = [];
    await page.route('**/api/generate', (route) => {
      sent.push(route.request().postDataJSON());
      const events = [{ type: 'done', durationMs: 900, turns: 1, submitted: false, text: 'Done.', costUsd: 0.0042 }];
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') });
    });
    await page.goto(`${A}/?design=${mid}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - Model pick');
    const chip = page.getByRole('button', { name: /^Model and reasoning effort:/ });
    await chip.click();
    const menu = page.getByRole('menu', { name: 'Model and reasoning effort' });
    const group = menu.getByRole('group', { name: 'Model' });
    // The chosen alias (Fable 5.2) on top, then the two top models; the rest behind Show more.
    await group.getByRole('menuitemradio', { name: /DeepSeek V4.1 Flash/ }).waitFor();
    assert.equal(await group.getByRole('menuitemradio').count(), 3);
    assert.match(await group.getByRole('menuitemradio', { name: /DeepSeek V4.1 Flash/ }).innerText(), /\$0\.045 \/ \$0\.50/);
    await group.getByRole('menuitem', { name: 'Show more (25)' }).click();
    assert.equal(await group.getByRole('menuitemradio').count(), 23);
    // The search types (letters are not menu keys) and finds by every word; Down goes to the first match.
    const search = group.getByRole('searchbox', { name: 'Search OpenRouter models' });
    await search.click();
    await page.keyboard.type('model 24');
    assert.equal(await group.getByRole('menuitemradio').count(), 1);
    await page.keyboard.press('ArrowDown');
    assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ''), /Other Model 24/);
    await search.fill('deepseek');
    await group.getByRole('menuitemradio', { name: /DeepSeek V4.1 Flash/ }).click();
    await page.locator('.chat-panel').screenshot({ path: path.join(shots, '12-openrouter-models.png') });
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    assert.match(await chip.getAttribute('aria-label') ?? '', /DeepSeek V4.1 Flash · High$/);
    const box = page.locator('.chat-panel textarea');
    await box.fill('A cube');
    await box.press('Enter');
    await page.locator('.msg', { hasText: 'Done.' }).waitFor();
    assert.equal(sent[0].model, 'deepseek/deepseek-v4.1-flash');
    assert.match(await page.locator('.msg', { hasText: 'Done.' }).innerText(), /\$0\.004/);
  } finally {
    await page.close();
  }
});

/** Save and Reset sit in the Settings footer: inside the dialog's box and the window, never in the scrolling panel. */
async function settingsFooterInView(page: Page, dialog: Locator, when: string) {
  const box = (await dialog.boundingBox())!;
  const view = page.viewportSize()!;
  for (const name of ['Save', 'Reset to defaults']) {
    const button = dialog.getByRole('button', { name, exact: true });
    const b = (await button.boundingBox())!;
    assert.ok(b.x >= box.x && b.y >= box.y && b.x + b.width <= box.x + box.width + 0.5 && b.y + b.height <= box.y + box.height + 0.5,
      `${name} is inside the dialog ${when} (${JSON.stringify(b)} in ${JSON.stringify(box)})`);
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= view.width && b.y + b.height <= view.height, `${name} is on screen ${when}`);
    assert.equal(await button.evaluate((el) => !!el.closest('[role=tabpanel]')), false, `${name} is not in the scrolling panel ${when}`);
  }
}

test('Settings: the gear opens the dialog, the chip opens Keys and services, a key is saved masked and reset', TEST, async () => {
  const KEY = 'msy_0123456789abcdef';
  const json = { 'Content-Type': 'application/json', 'X-PTP': '1' };
  // A known printer, whatever the tests before left.
  await fetch(`${A}/api/printer`, { method: 'PUT', headers: json, body: JSON.stringify({ printerId: 'Bambu Lab A1 0.4 nozzle', filaments: 4 }) });
  const page = await newPage();
  const asked: string[] = [];
  let answer = false;
  page.on('dialog', (d) => { asked.push(d.message()); void (answer ? d.accept() : d.dismiss()); });
  const gear = page.getByRole('button', { name: 'Settings', exact: true });
  const chip = page.getByRole('button', { name: /^Claude subscription/ });
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const tab = (name: string) => dialog.getByRole('tab', { name });
  const focusIn = () => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));
  const focusOn = (label: RegExp) => page.evaluate((src) => new RegExp(src).test((document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '').trim()), label.source);
  const meshy = () => dialog.locator('.keys-row', { hasText: 'Meshy key' });
  try {
    await page.goto(`${A}/`);
    await gear.waitFor();

    // The gear: three tabs, Printer selected, focus inside; Escape closes it and focus goes back to the gear.
    await gear.click();
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('tab').count(), 3);
    assert.deepEqual(await dialog.getByRole('tab').allInnerTexts(), ['Printer', 'Filaments', 'Keys and services']);
    assert.equal(await tab('Printer').getAttribute('aria-selected'), 'true');
    assert.ok(await focusIn(), 'focus is inside the dialog');
    await page.screenshot({ path: path.join(shots, 'settings-printer.png') });

    // Tabs by keyboard: Right goes on and wraps, Home and End jump.
    const selected = () => dialog.getByRole('tab', { selected: true }).innerText();
    await page.keyboard.press('ArrowRight');
    assert.equal(await selected(), 'Filaments');
    await page.screenshot({ path: path.join(shots, 'settings-filaments.png') });
    await page.keyboard.press('ArrowRight');
    assert.equal(await selected(), 'Keys and services');
    await page.keyboard.press('ArrowRight');
    assert.equal(await selected(), 'Printer');
    await page.keyboard.press('End');
    assert.equal(await selected(), 'Keys and services');
    await page.keyboard.press('Home');
    assert.equal(await selected(), 'Printer');

    // The Printer tab saves at once, and the new count is still there when the dialog is opened again.
    await dialog.getByLabel('Filaments it loads at once').selectOption('8');
    await dialog.getByText('Saved', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await focusOn(/^Settings$/), 'focus is back on the gear');
    await gear.click();
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('Filaments it loads at once').inputValue(), '8');

    // A click on the backdrop does not close it.
    await page.mouse.click(4, 4);
    assert.equal(await dialog.isVisible(), true, 'the backdrop did not close the dialog');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });

    // The chip opens Keys and services; Escape gives the focus back to the chip.
    await chip.click();
    await dialog.waitFor();
    assert.equal(await selected(), 'Keys and services');
    assert.ok(await focusIn(), 'focus is inside the dialog');
    const panel = dialog.getByRole('tabpanel');
    await meshy().getByRole('button', { name: 'Add Meshy key' }).waitFor();
    await page.screenshot({ path: path.join(shots, 'settings-keys.png') });
    // Save and Reset are in the footer from the start, disabled while there is nothing to save or reset.
    await settingsFooterInView(page, dialog, 'on opening Keys and services');
    assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).getAttribute('aria-disabled'), 'true');
    assert.equal(await dialog.getByRole('button', { name: 'Reset to defaults' }).getAttribute('aria-disabled'), 'true');
    await page.screenshot({ path: path.join(shots, 'settings-keys-footer.png') });
    const before = (await meshy().innerText()).replace(/\s+/g, ' ');
    assert.match(before, /not set/);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await focusOn(/^Claude subscription/), `focus is back on the chip (on: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))})`);
    await chip.click();
    await dialog.waitFor();

    // A typed key asks before Escape throws it away; "Cancel" keeps the row as changed.
    await meshy().getByRole('button', { name: 'Add Meshy key' }).click();
    await meshy().getByLabel('Meshy key', { exact: true }).fill(KEY);
    await page.keyboard.press('Escape');
    await until(async () => asked.length > 0, 'Escape asked before discarding');
    assert.match(asked[0], /^Discard the changes you have not saved\?/);
    assert.equal(await dialog.isVisible(), true, 'the dialog stays open when the question is cancelled');
    await meshy().getByText('Not saved yet').waitFor();
    assert.equal(await meshy().getByLabel('Meshy key', { exact: true }).inputValue(), KEY);

    // Save: masked, "set here", the full key nowhere in the page, a connection result line, the chip still alive.
    const asksBeforeSave = connectionAsks.length;
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByText('Saved.', { exact: true }).waitFor();
    await settingsFooterInView(page, dialog, 'after a save');
    assert.ok(await focusOn(/^Save$/), `focus stays on Save after the save (on: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))})`);
    const row = (await meshy().innerText()).replace(/\s+/g, ' ');
    assert.match(row, /msy…def/, row);
    assert.ok(!row.includes('0123456789ab'), row);
    assert.match(row, /set here/);
    assert.ok(!(await page.content()).includes(KEY), 'the page does not hold the full key');
    assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('0123456789ab'));
    // Saving checks the connection afresh (the Keys tab) and the chip reads the answer again.
    await until(async () => connectionAsks.slice(asksBeforeSave).includes(true) && connectionAsks.length >= asksBeforeSave + 2, 'a fresh connection check and the chip reading it again followed the save');
    const result = panel.locator('.keys-conn-result');
    await until(async () => /Claude subscription: /.test(await result.innerText()), 'the Keys tab shows a connection result');
    assert.match(await result.innerText(), /Stand-in for the smoke test\./);
    await chip.waitFor();
    assert.ok(!/Checking/.test(await page.locator('.conn-chip').innerText()), 'the chip is not stuck on Checking');
    await page.screenshot({ path: path.join(shots, 'settings-keys-saved.png') });
    await page.screenshot({ path: path.join(shots, 'settings-keys-footer-saved.png') });
    // The server holds it in secrets.json and never hands it out.
    assert.ok(readFileSync(path.join(dataDir, 'secrets.json'), 'utf8').includes(KEY));
    assert.ok(!(await (await fetch(`${A}/api/settings`)).text()).includes(KEY));

    // The provider address is locked without a password, and says why.
    const address = dialog.locator('.keys-row', { hasText: 'Other provider address' });
    assert.match(await address.innerText(), /PTP_PASSWORD/);
    assert.equal(await address.locator('input').count(), 0, 'no input for the locked address');

    // Reset (confirmed) puts the Meshy row back to what it was.
    answer = true;
    await dialog.getByRole('button', { name: 'Reset to defaults' }).click();
    await dialog.getByText('Everything comes from .env again.').waitFor();
    assert.equal((await meshy().innerText()).replace(/\s+/g, ' '), before);
    assert.ok(asked.some((q) => /Reset to defaults\?$/.test(q) && q.includes('Meshy key')), asked.join(' | '));
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
  } finally {
    await page.close();
    await fetch(`${A}/api/settings/reset`, { method: 'POST', headers: json }).catch(() => {});
    await fetch(`${A}/api/printer`, { method: 'PUT', headers: json, body: JSON.stringify({ printerId: 'Bambu Lab A1 0.4 nozzle', filaments: 4 }) });
  }
});

test('Settings on a phone-width screen: nothing runs off the side, the tabs stay readable, Keys and services rows wrap', TEST, async () => {
  const json = { 'Content-Type': 'application/json', 'X-PTP': '1' };
  const page = await newPage({ viewport: { width: 380, height: 800 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${A}/`);
    const gear = page.getByRole('button', { name: 'Settings', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await gear.waitFor();
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok((await sideways()) <= 0, 'the top bar does not overflow sideways');
    assert.ok((await gear.boundingBox())!.x + (await gear.boundingBox())!.width <= 380, 'the gear is on screen');
    await gear.click();
    await dialog.waitFor();
    const tabs = dialog.getByRole('tab');
    const boxes = await Promise.all([0, 1, 2].map((i) => tabs.nth(i).boundingBox()));
    const keysTab = boxes[2]!;
    assert.ok(Math.abs(keysTab.height - boxes[0]!.height) < 2, `"Keys and services" is on one line (${keysTab.height} vs ${boxes[0]!.height})`);
    const tabRow = await dialog.getByRole('tablist').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    await page.screenshot({ path: path.join(shots, 'settings-phone-printer.png') });
    await tabs.nth(2).click();
    await dialog.getByRole('button', { name: 'Add Meshy key' }).waitFor();
    // Keys tab rows wrap: nothing wider than the panel inside it, and the page doesn't scroll sideways.
    const panel = await dialog.getByRole('tabpanel').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    assert.ok(panel.scroll <= panel.client, `the panel does not scroll sideways (${panel.scroll} > ${panel.client})`);
    assert.ok((await sideways()) <= 0, 'the page does not scroll sideways with the dialog open');
    await page.screenshot({ path: path.join(shots, 'settings-phone-keys.png') });
    console.log(`settings phone: tab row scrollWidth ${tabRow.scroll} / clientWidth ${tabRow.client}`);
    // Save and Reset in view on a phone too, on opening and after a save.
    await settingsFooterInView(page, dialog, 'on a phone, on opening Keys and services');
    await page.screenshot({ path: path.join(shots, 'settings-phone-keys-footer.png') });
    const meshy = dialog.locator('.keys-row', { hasText: 'Meshy key' });
    await meshy.getByRole('button', { name: 'Add Meshy key' }).click();
    await meshy.getByLabel('Meshy key', { exact: true }).fill('msy_phone0123456789');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByText('Saved.', { exact: true }).waitFor();
    await settingsFooterInView(page, dialog, 'on a phone, after a save');
    assert.ok((await sideways()) <= 0, 'the page does not scroll sideways after a save');
    await page.screenshot({ path: path.join(shots, 'settings-phone-keys-footer-saved.png') });
  } finally {
    await page.close();
    await fetch(`${A}/api/settings/reset`, { method: 'POST', headers: json }).catch(() => {});
  }
});

// ---- the Filaments tab of Settings
const jsonHeaders = { 'Content-Type': 'application/json', 'X-PTP': '1' };
type Shelf = { name: string; brand?: string; color: string; td: number; rolls?: number };
const putShelf = (list: Shelf[]) => fetch(`${A}/api/filaments/mine`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ filaments: list }) });
/** A known printer, so the first-start question does not cover the page. */
const knownPrinter = () => fetch(`${A}/api/printer`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ printerId: 'Bambu Lab A1 0.4 nozzle', filaments: 4 }) });
const TOTAL = FILAMENT_LIBRARY.length;
const inBrand = (b: string) => FILAMENT_LIBRARY.filter((f) => f.brand === b).length;
const getShelf = async (): Promise<Shelf[]> => (await (await fetch(`${A}/api/filaments/mine`)).json()).filaments;
/** Five filaments of different brands, one custom, for the screenshots and the phone test. */
const SHELF: Shelf[] = [
  { name: 'PLA Basic Jade White', brand: 'Bambu Lab', color: '#ffffff', td: 4.2, rolls: 2 },
  { name: 'PLA Matte Charcoal', brand: 'Bambu Lab', color: '#000000', td: 0.4, rolls: 1 },
  { name: 'PLA+ White', brand: 'eSUN', color: '#f2f2f2', td: 5.1, rolls: 3 },
  { name: 'PLA+ Black', brand: 'eSUN', color: '#111111', td: 0.3, rolls: 1 },
  { name: 'Workshop Teal Silk With A Rather Long Name For A Row', brand: 'Acme Filaments', color: '#1f9d8f', td: 1.7, rolls: 4 },
];
/** What the browser reports about the Settings dialog's layout. */
const settingsLayout = async (page: Page) => {
  // (Nothing named inside the evaluate: the test runner's transpiler would add a helper the page does not have.)
  const l = await page.evaluate(() => {
    const dialog = document.querySelector('[role=dialog][aria-labelledby=settings-title]')!;
    const panel = dialog.querySelector('[role=tabpanel]')!;
    const rects = [dialog, ...dialog.querySelectorAll('.fil-pane')].map((e) => e.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number });
    return { rects, panelScroll: { w: panel.scrollWidth, cw: panel.clientWidth }, pageSideways: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  const box = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
  return { dialog: box(l.rects[0]), panes: l.rects.slice(1).map(box), panelScroll: l.panelScroll, pageSideways: l.pageSideways };
};

test('Settings: the Filaments tab adds a library colour, counts its rolls and keeps them', TEST, async () => {
  await knownPrinter();
  assert.equal((await putShelf([])).status, 200);
  const page = await newPage();
  const gear = page.getByRole('button', { name: 'Settings', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const mine = dialog.getByRole('region', { name: 'My filaments' });
  const library = dialog.getByRole('region', { name: 'Library' });
  const cards = library.getByRole('list', { name: 'Library filaments' }).getByRole('button');
  const rows = mine.getByRole('listitem');
  const rollsBox = (name: string) => dialog.getByRole('spinbutton', { name: `Rolls of ${name}` });
  const open = async (tab = 'Filaments') => {
    await gear.click();
    await dialog.waitFor();
    await dialog.getByRole('tab', { name: tab, exact: true }).click();
  };
  const shelfSummary = () => mine.locator('.fil-pane-head .small').innerText();
  const libCount = () => library.locator('.fil-pane-head .small').innerText();
  const pill = (group: string, name: string) => library.getByRole('group', { name: group, exact: true }).getByRole('button', { name, exact: true });
  const cardNames = () => cards.evaluateAll((els) => els.map((e) => e.querySelector('.fil-card-name')!.textContent!));
  const active = () => page.evaluate(() => {
    const e = document.activeElement as HTMLElement | null;
    return e ? `${e.tagName.toLowerCase()}:${e.getAttribute('aria-label') ?? e.textContent?.trim().slice(0, 30)}` : '';
  });
  try {
    await page.goto(`${A}/`);
    await gear.waitFor();

    // The empty state, and the footer: no Save or Reset here (they stay on Keys and services).
    await open('Printer');
    const printerWidth = (await dialog.boundingBox())!.width;
    await dialog.getByRole('tab', { name: 'Filaments', exact: true }).click();
    await mine.getByText('No filaments yet. Add one from the library, or a custom one.').waitFor();
    assert.equal(await shelfSummary(), '0 colours · 0 rolls');
    assert.equal(await libCount(), `${TOTAL} colours`);
    assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).count(), 0, 'no Save on the Filaments tab');
    assert.equal(await dialog.getByRole('button', { name: 'Reset to defaults' }).count(), 0, 'no Reset on the Filaments tab');

    // Wider than the Printer tab, inside the window, the panes side by side, the dialog never taller than the window.
    const lay = await settingsLayout(page);
    const view = page.viewportSize()!;
    assert.ok(lay.dialog.w > printerWidth + 100, `wider on Filaments (${lay.dialog.w}) than on Printer (${printerWidth})`);
    assert.ok(lay.dialog.w <= view.width && lay.dialog.x >= 0 && lay.dialog.x + lay.dialog.w <= view.width, 'inside the window');
    assert.ok(lay.dialog.h <= view.height && lay.dialog.y >= 0 && lay.dialog.y + lay.dialog.h <= view.height, `not taller than the window (${JSON.stringify(lay.dialog)})`);
    assert.equal(lay.panes.length, 2);
    assert.ok(Math.abs(lay.panes[0].y - lay.panes[1].y) < 2 && lay.panes[1].x > lay.panes[0].x + lay.panes[0].w - 1, `panes side by side (${JSON.stringify(lay.panes)})`);
    assert.ok(lay.panelScroll.w <= lay.panelScroll.cw, 'the panel does not scroll sideways');
    await dialog.getByRole('tab', { name: 'Keys and services', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Reset to defaults' }).waitFor();
    await dialog.getByRole('tab', { name: 'Filaments', exact: true }).click();

    // The library: every card, scrolling inside their pane, not the dialog.
    const libScroll = library.locator('.fil-scroll');
    assert.equal(await cards.count(), TOTAL);
    const lib0 = await libScroll.evaluate((el) => ({ over: el.scrollHeight > el.clientHeight + 20 }));
    assert.ok(lib0.over, 'the library grid overflows its pane');
    const cols = await cards.evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().x))).size);
    assert.ok(cols >= 3, `the card grid has ${cols} columns`);
    await libScroll.evaluate((el) => { el.scrollTop = 400; });
    assert.equal(await dialog.getByRole('tabpanel').evaluate((el) => el.scrollTop), 0, 'the panel itself did not scroll');
    assert.equal(await mine.locator('.fil-scroll').evaluate((el) => el.scrollTop), 0);
    assert.ok((await libScroll.evaluate((el) => el.scrollTop)) > 0, 'the library pane scrolled by itself');
    assert.ok((await dialog.boundingBox())!.height <= view.height, 'still inside the window after scrolling');
    await libScroll.evaluate((el) => { el.scrollTop = 0; });

    // Search: "white" shows the white filaments first and a count smaller than the library; nonsense shows the empty line.
    const search = library.getByRole('searchbox', { name: 'Search the library' });
    await search.fill('white');
    const white = await cardNames();
    assert.ok(white.length > 0 && white.length < TOTAL / 2, `${white.length} cards for "white"`);
    assert.ok(white.slice(0, 7).every((n) => /white/i.test(n)), `the first cards are the white ones: ${white.join(' | ')}`);
    assert.equal(await libCount(), `${white.length} of ${TOTAL} colours`);
    await search.fill('zzqqxx');
    await library.getByText('Nothing matches. Try another colour or brand.').waitFor();
    assert.equal(await cards.count(), 0);
    await search.fill('');
    assert.equal(await cards.count(), TOTAL);

    // Brand and line pills narrow the grid and combine; changing the brand drops a line it does not have.
    await pill('Brand', 'eSUN').click();
    assert.equal(await libCount(), `${inBrand('eSUN')} of ${TOTAL} colours`);
    assert.ok((await cardNames()).length === inBrand('eSUN') && (await cards.evaluateAll((els) => els.every((e) => /eSUN/.test(e.querySelector('.fil-card-meta')!.textContent!)))));
    await page.screenshot({ path: path.join(shots, 'filaments-library-esun-empty-shelf.png') });
    await pill('Brand', 'Bambu Lab').click();
    assert.equal(await libCount(), `${inBrand('Bambu Lab')} of ${TOTAL} colours`);
    await pill('Line', 'PLA Matte').click();
    assert.equal(await libCount(), `${FILAMENT_LIBRARY.filter((f) => f.brand === 'Bambu Lab' && f.line === 'PLA Matte').length} of ${TOTAL} colours`);
    assert.equal(await pill('Line', 'PLA Matte').getAttribute('aria-pressed'), 'true');
    await search.fill('white');
    const combined = await cardNames();
    assert.ok(combined.length > 0 && combined.length < white.length && combined.every((n) => n.startsWith('PLA Matte')), `brand, line and search together: ${combined.join(' | ')}`);
    await search.fill('');
    await pill('Brand', 'eSUN').click();
    assert.equal(await library.getByRole('group', { name: 'Line', exact: true }).getByRole('button').count(), 1 + libraryLines('eSUN').length, 'the pills are "All lines" and eSUN\'s own lines');
    assert.equal(await pill('Line', 'All lines').getAttribute('aria-pressed'), 'true', 'a line the brand does not have is dropped');
    assert.equal(await libCount(), `${inBrand('eSUN')} of ${TOTAL} colours`);

    // Add one: the card is clicked, the row is on the shelf and in view, 1 roll, the card marked owned; a second click adds nothing.
    await pill('Brand', 'Bambu Lab').click();
    await pill('Line', 'PLA Basic').click();
    const first = cards.first();
    const label = (await first.getAttribute('aria-label'))!;
    assert.match(label, /^Add .+, Bambu Lab, TD [\d.]+$/);
    const name = label.split(',')[0].replace(/^Add /, '');
    await first.click();
    await rows.first().waitFor();
    assert.equal(await rows.count(), 1);
    assert.equal(await shelfSummary(), '1 colour · 1 roll');
    const rowBox = (await rows.first().boundingBox())!, shelfBox = (await mine.locator('.fil-scroll').boundingBox())!;
    assert.ok(rowBox.y >= shelfBox.y - 1 && rowBox.y + rowBox.height <= shelfBox.y + shelfBox.height + 1, 'the new row is in view');
    assert.equal(await rollsBox(name).inputValue(), '1');
    assert.equal(await first.getAttribute('aria-label'), `${name}, Bambu Lab, TD ${label.split('TD ')[1]}, owned`);
    assert.equal(await first.getAttribute('aria-disabled'), 'true');
    assert.ok(await first.locator('.fil-tag.owned').isVisible(), 'the card shows "owned"');
    await dialog.getByText('Saved', { exact: true }).waitFor();
    await first.click({ force: true }); // (Playwright counts aria-disabled as not enabled: the click is what we mean to try)
    assert.equal(await rows.count(), 1, 'a second click adds no second row');
    assert.equal((await getShelf()).length, 1);

    // Rolls: 3 and blur; saved on the server; close, reopen, reload: still 3.
    await rollsBox(name).fill('3');
    await rollsBox(name).blur();
    await until(async () => (await shelfSummary()) === '1 colour · 3 rolls', 'the header counts 3 rolls');
    await until(async () => (await getShelf())[0]?.rolls === 3, 'the server holds 3 rolls');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    await open();
    assert.equal(await rollsBox(name).inputValue(), '3');
    await page.reload();
    await gear.waitFor();
    await open();
    await rows.first().waitFor();
    assert.equal(await rollsBox(name).inputValue(), '3', 'still 3 after a reload');
    assert.equal(await shelfSummary(), '1 colour · 3 rolls');
    // Too many: 250 is 99; text and a negative are made valid too.
    await rollsBox(name).fill('250');
    await rollsBox(name).blur();
    assert.equal(await rollsBox(name).inputValue(), '99');
    await until(async () => (await getShelf())[0]?.rolls === 99, 'the server holds 99');
    assert.equal(await shelfSummary(), '1 colour · 99 rolls');
    await rollsBox(name).fill('-4');
    await rollsBox(name).blur();
    assert.equal(await rollsBox(name).inputValue(), '0');
    await until(async () => (await getShelf())[0]?.rolls === 0, 'the server holds 0');
    await rollsBox(name).fill('3');
    await rollsBox(name).blur();
    await until(async () => (await getShelf())[0]?.rolls === 3, 'back to 3');

    // Keyboard: Tab from the shelf's search reaches the pills, the cards and the roll inputs; Enter on a card adds it, Enter in a roll input saves.
    await pill('Brand', 'All').click();
    assert.equal(await library.getByRole('group', { name: 'Line', exact: true }).count(), 0, 'no line pills while every brand is shown');
    await pill('Brand', 'Bambu Lab').click();
    await pill('Line', 'All lines').click();
    await mine.getByRole('searchbox', { name: 'Search my filaments' }).focus();
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) { seen.push(await active()); await page.keyboard.press('Tab'); }
    assert.ok(seen.some((s) => s === 'input:Search my filaments'), seen.join(' > '));
    assert.ok(seen.some((s) => s === `input:Rolls of ${name}`), `a roll input: ${seen.join(' > ')}`);
    assert.ok(seen.some((s) => s === 'input:Search the library'), `the library search: ${seen.join(' > ')}`);
    assert.ok(seen.some((s) => s === 'button:eSUN') && seen.some((s) => s === 'button:PLA Matte'), `the pills: ${seen.join(' > ')}`);
    assert.ok(seen.some((s) => /^button:Add /.test(s)), `a card: ${seen.join(' > ')}`);
    await pill('Brand', 'eSUN').click();
    const esun = cards.first();
    const esunName = (await esun.getAttribute('aria-label'))!.split(',')[0].replace(/^Add /, '');
    await esun.focus();
    await page.keyboard.press('Enter');
    await until(async () => (await rows.count()) === 2, 'Enter on a card adds it');
    assert.equal(await shelfSummary(), '2 colours · 4 rolls');
    await rollsBox(esunName).focus();
    await rollsBox(esunName).fill('5');
    await page.keyboard.press('Enter');
    await until(async () => (await shelfSummary()) === '2 colours · 8 rolls', 'Enter in the roll input saves');
    await until(async () => (await getShelf()).find((f) => f.name === esunName)?.rolls === 5, 'the server holds the 5 rolls');

    // A custom filament: the form opens in the tab, "Save as mine" puts it on the shelf; Edit on its row opens the same form filled in.
    await mine.getByRole('button', { name: 'Custom filament' }).click();
    const form = mine.getByRole('group', { name: 'Custom filament' });
    await form.waitFor();
    await form.getByRole('textbox', { name: 'Filament name' }).fill('Smoke Test Orange');
    await form.getByRole('textbox', { name: 'Brand' }).fill('Acme');
    await page.screenshot({ path: path.join(shots, 'filaments-custom-form.png') });
    await form.getByRole('button', { name: 'Save as mine' }).click();
    // (Once saved the form is the one of a saved filament: its group is named "Edit …".)
    const saved = mine.getByRole('group', { name: 'Edit Smoke Test Orange' });
    await saved.getByRole('button', { name: 'Saved' }).waitFor();
    await until(async () => (await rows.count()) === 3, 'the custom filament is on the shelf');
    assert.equal((await getShelf()).find((f) => f.name === 'Smoke Test Orange')?.rolls ?? 1, 1);
    await saved.getByRole('button', { name: 'Done' }).click();
    await saved.waitFor({ state: 'detached' });
    await mine.getByRole('button', { name: 'Edit Smoke Test Orange' }).click();
    const edit = mine.getByRole('group', { name: 'Edit Smoke Test Orange' });
    assert.equal(await edit.getByRole('textbox', { name: 'Filament name' }).inputValue(), 'Smoke Test Orange');
    assert.equal(await edit.getByRole('textbox', { name: 'Brand' }).inputValue(), 'Acme');
    await edit.getByRole('textbox', { name: 'Brand' }).fill('Acme Two');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await until(async () => (await getShelf()).find((f) => f.name === 'Smoke Test Orange')?.brand === 'Acme Two', 'the edit is saved');
    assert.equal((await getShelf()).length, 3, 'editing did not add a row');
    await edit.getByRole('button', { name: 'Done' }).click();

    // The shelf's own search, then the two-click Remove down to the empty state.
    await mine.getByRole('searchbox', { name: 'Search my filaments' }).fill('smoke test');
    assert.equal(await rows.count(), 1);
    await mine.getByRole('searchbox', { name: 'Search my filaments' }).fill('');
    for (const f of await getShelf()) {
      await mine.getByRole('button', { name: `Remove ${f.name}`, exact: true }).click();
      await mine.getByRole('button', { name: `Remove ${f.name}: click again to confirm`, exact: true }).click();
      await until(async () => !(await getShelf()).some((g) => g.name === f.name), `${f.name} is removed on the server`);
    }
    await mine.getByText('No filaments yet. Add one from the library, or a custom one.').waitFor();
    assert.equal(await shelfSummary(), '0 colours · 0 rolls');

    // Both panes scroll on their own: a long shelf scrolls inside its pane, the dialog keeps its size.
    const many: Shelf[] = Array.from({ length: 30 }, (_, i) => ({ name: `Shelf filler ${String(i).padStart(2, '0')}`, brand: 'Filler', color: '#808080', td: 1, rolls: 1 }));
    assert.equal((await putShelf(many)).status, 200);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    await open();
    await rows.nth(29).waitFor();
    const shelfScroll = mine.locator('.fil-scroll');
    assert.ok(await shelfScroll.evaluate((el) => el.scrollHeight > el.clientHeight + 20), 'the shelf overflows its pane');
    await shelfScroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    assert.equal(await dialog.getByRole('tabpanel').evaluate((el) => el.scrollTop), 0);
    assert.equal(await libScroll.evaluate((el) => el.scrollTop), 0, 'the library pane did not move');
    assert.ok((await dialog.boundingBox())!.height <= view.height);
    // A card clicked while the shelf is scrolled to its end: the new row (sorted among the others) is scrolled into view.
    await pill('Brand', 'Bambu Lab').click();
    await cards.first().click();
    await until(async () => (await rows.count()) === 31, 'the 31st row is added');
    const added = rows.filter({ hasText: 'Bambu Lab' });
    await added.first().waitFor();
    const ab = (await added.first().boundingBox())!, sb = (await shelfScroll.boundingBox())!;
    assert.ok(ab.y >= sb.y - 1 && ab.y + ab.height <= sb.y + sb.height + 1, `the added row is in view (${JSON.stringify(ab)} in ${JSON.stringify(sb)})`);

    // The screenshots: five filaments of different brands, one custom; the library filtered to one brand.
    assert.equal((await putShelf(SHELF)).status, 200);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    await open();
    await rows.nth(4).waitFor();
    assert.equal(await shelfSummary(), '5 colours · 11 rolls');
    await page.screenshot({ path: path.join(shots, 'filaments-desktop.png') });
    await pill('Brand', 'eSUN').click();
    await page.screenshot({ path: path.join(shots, 'filaments-library-esun.png') });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
  } finally {
    await page.close();
    await putShelf([]);
  }
});

test('Settings: the Filaments tab on a phone-width screen stacks its panes and nothing runs off the side', TEST, async () => {
  await knownPrinter();
  assert.equal((await putShelf(SHELF)).status, 200);
  const page = await newPage({ viewport: { width: 380, height: 800 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${A}/`);
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await page.getByRole('button', { name: 'Settings', exact: true }).tap();
    await dialog.getByRole('tab', { name: 'Filaments', exact: true }).tap();
    await dialog.getByRole('listitem').nth(4).waitFor();
    const lay = await settingsLayout(page);
    assert.ok(lay.dialog.h <= 800 && lay.dialog.w <= 380, `the dialog fits the screen (${JSON.stringify(lay.dialog)})`);
    assert.ok(lay.panes[1].y >= lay.panes[0].y + lay.panes[0].h - 1 && Math.abs(lay.panes[0].x - lay.panes[1].x) < 2, `panes stacked (${JSON.stringify(lay.panes)})`);
    assert.ok(lay.panelScroll.w <= lay.panelScroll.cw, `the panel does not scroll sideways (${lay.panelScroll.w} > ${lay.panelScroll.cw})`);
    assert.ok(lay.pageSideways <= 0, 'the page does not scroll sideways');
    // A row stays inside the panel: its name, rolls and buttons.
    const overflow = await dialog.locator('.fil-row').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    assert.equal(overflow, 0, 'no row is wider than itself');
    await page.screenshot({ path: path.join(shots, 'filaments-phone.png') });
    await dialog.getByRole('region', { name: 'Library' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, 'filaments-phone-library.png') });
    const after = await settingsLayout(page);
    assert.ok(after.panelScroll.w <= after.panelScroll.cw && after.pageSideways <= 0, 'no sideways scroll after scrolling to the library');
    await dialog.getByRole('button', { name: 'Close' }).tap();
  } finally {
    await page.close();
    await putShelf([]);
  }
});

test('Settings: the Filaments tab with the whole library: every brand has a pill, the pills wrap, brand and search narrow the cards', TEST, async () => {
  await knownPrinter();
  assert.equal((await putShelf([])).status, 200);
  const brands = libraryBrands();
  assert.ok(brands.length >= 5, `${brands.length} brands in the library`);
  const added = brands.find((b) => b === 'Polymaker') ?? brands[brands.length - 1];
  const addedCards = FILAMENT_LIBRARY.filter((f) => f.brand === added);
  const addedLines = libraryLines(added);
  const shot = (name: string) => path.join(process.env.PTP_LIBRARY_SHOTS ?? shots, `library-${name}.png`);
  const page = await newPage();
  const gear = () => page.getByRole('button', { name: 'Settings', exact: true });
  const dialog = () => page.getByRole('dialog', { name: 'Settings' });
  const library = () => dialog().getByRole('region', { name: 'Library' });
  const cards = () => library().getByRole('list', { name: 'Library filaments' }).getByRole('button');
  const pill = (group: string, name: string) => library().getByRole('group', { name: group, exact: true }).getByRole('button', { name, exact: true });
  const libCount = () => library().locator('.fil-pane-head .small').innerText();
  const pillNames = (group: string) => library().getByRole('group', { name: group, exact: true }).getByRole('button').allInnerTexts();
  const rowsOf = (group: string) => library().getByRole('group', { name: group, exact: true }).evaluate((el) => new Set([...el.children].map((c) => Math.round(c.getBoundingClientRect().y))).size);
  /** The pill rows wrap: no pill leaves the library pane on the side, and the pane does not scroll sideways. */
  const noSideways = async (what: string) => {
    const r = await library().evaluate((el) => {
      const box = el.getBoundingClientRect();
      const out = [...el.querySelectorAll('.fil-pills > *')].filter((c) => c.getBoundingClientRect().right > box.right + 1 || c.getBoundingClientRect().left < box.left - 1).length;
      const wide = [...el.querySelectorAll('.fil-pills')].filter((g) => g.scrollWidth > g.clientWidth + 1).length;
      return { out, wide, own: el.scrollWidth - el.clientWidth };
    });
    assert.deepEqual(r, { out: 0, wide: 0, own: 0 }, `${what}: pills stay inside the library pane (${JSON.stringify(r)})`);
    assert.ok((await settingsLayout(page)).pageSideways <= 0, `${what}: the page does not scroll sideways`);
  };
  /** How long an action takes until the grid has settled (two animation frames after it). */
  const timed = async (f: () => Promise<unknown>) => {
    const t0 = Date.now();
    await f();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return Date.now() - t0;
  };
  try {
    await page.goto(`${A}/`);
    await gear().waitFor();
    const opened = await timed(async () => {
      await gear().click();
      await dialog().waitFor();
      await dialog().getByRole('tab', { name: 'Filaments', exact: true }).click();
      await cards().first().waitFor();
    });
    console.log(`library timing: open the tab with ${await cards().count()} cards ${opened} ms`);
    const view = page.viewportSize()!;

    // Count line, every brand's pill, in alphabetical order after "All".
    assert.equal(await libCount(), `${TOTAL} colours`);
    assert.equal(await cards().count(), TOTAL);
    assert.deepEqual(await pillNames('Brand'), ['All', ...brands]);
    assert.equal(await library().getByRole('group', { name: 'Line', exact: true }).count(), 0, 'no line pills while every brand is shown');
    console.log(`library pills: ${brands.length} brands; unfiltered brand pill rows: ${await rowsOf('Brand')}`);
    await noSideways('desktop, unfiltered');
    await page.screenshot({ path: shot('unfiltered') });

    // One brand: only its cards, its own lines, the count says so.
    await pill('Brand', added).click();
    assert.equal(await cards().count(), addedCards.length);
    assert.equal(await libCount(), `${addedCards.length} of ${TOTAL} colours`);
    assert.deepEqual((await pillNames('Line')).slice(1), addedLines);
    assert.ok(await cards().evaluateAll((els, b) => els.every((e) => e.querySelector('.fil-card-meta')!.textContent!.startsWith(`${b} ·`)), added), 'only that brand\'s cards');
    await noSideways('desktop, one brand');
    await page.screenshot({ path: shot(`${added.toLowerCase()}`) });
    if (addedLines.length > 1) {
      await pill('Line', addedLines[1]).click();
      assert.equal(await libCount(), `${FILAMENT_LIBRARY.filter((f) => f.brand === added && f.line === addedLines[1]).length} of ${TOTAL} colours`);
      await page.screenshot({ path: shot(`${added.toLowerCase()}-line`) });
      await pill('Line', 'All lines').click();
    }

    // Add its first card: on the shelf with the brand, the card marked owned.
    const first = cards().first();
    const label = (await first.getAttribute('aria-label'))!;
    const fname = label.split(',')[0].replace(/^Add /, '');
    assert.ok(label.includes(`, ${added}, TD `), label);
    await first.click();
    const mineRegion = dialog().getByRole('region', { name: 'My filaments' });
    await mineRegion.getByRole('listitem').first().waitFor();
    assert.match(await mineRegion.getByRole('listitem').first().innerText(), new RegExp(`${added}\\s*·\\s*TD`));
    assert.match((await first.getAttribute('aria-label'))!, /, owned$/);
    assert.ok(await first.locator('.fil-tag.owned').isVisible());
    await until(async () => (await getShelf()).some((f) => f.name === fname && f.brand === added), 'the card is on the server shelf');

    // An estimated entry shows its mark (the first one of any brand).
    const est = FILAMENT_LIBRARY.find((f) => f.unverified);
    if (est) {
      await pill('Brand', est.brand).click();
      const c = library().getByRole('button', { name: new RegExp(`^(Add )?${est.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, ${est.brand}, TD ${est.td}, estimated`) });
      assert.equal(await c.count(), 1);
      assert.equal(await c.locator('.fil-tag', { hasText: 'estimated' }).count(), 1, 'the card shows "estimated"');
    }

    // Search "black" with All: cards of at least three brands, every card's accessible name has its brand; and a keystroke's cost.
    await pill('Brand', 'All').click();
    const search = library().getByRole('searchbox', { name: 'Search the library' });
    const typed = await timed(() => search.pressSequentially('b'));
    const typed2 = await timed(() => search.pressSequentially('l'));
    console.log(`library timing: type one search character ${typed} ms (b), ${typed2} ms (l)`);
    await search.fill('black');
    const names = await cards().evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!));
    assert.ok(names.length > 0);
    const seen = new Set(FILAMENT_LIBRARY.filter((f) => /black/i.test(f.name)).map((f) => f.brand));
    const found = new Set(names.map((n) => brands.find((b) => n.includes(`, ${b}, TD `))));
    assert.ok(!found.has(undefined), 'every card names its brand');
    assert.ok(found.size >= Math.min(3, seen.size), `"black" shows ${found.size} brands: ${[...found].join(', ')}`);
    assert.ok(seen.size >= 3, 'the data has "black" in at least three brands');
    await page.screenshot({ path: shot('search-black') });
    await search.fill('');

    // The phone width: the same checks.
    await page.setViewportSize({ width: 380, height: 800 });
    await noSideways('380 px, unfiltered');
    await library().scrollIntoViewIfNeeded();
    await page.screenshot({ path: shot('phone-unfiltered') });
    await pill('Brand', added).click();
    await noSideways('380 px, one brand');
    await library().scrollIntoViewIfNeeded();
    await page.screenshot({ path: shot(`phone-${added.toLowerCase()}`) });
    assert.equal(await libCount(), `${addedCards.length} of ${TOTAL} colours`);
    await page.setViewportSize(view);
  } finally {
    await page.close();
    await putShelf([]);
  }
});

test('Settings: the Filaments tab changes nothing before your list is read, and its edit form opens in view and refuses a name you already have', TEST, async () => {
  await knownPrinter();
  assert.equal((await putShelf(SHELF)).status, 200);
  const page = await newPage({ viewport: { width: 380, height: 800 }, isMobile: true, hasTouch: true });
  // The first read of the list fails, the second (Try again) waits until released; every PUT is counted.
  let reads = 0, puts = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/filaments/mine', async (route) => {
    if (route.request().method() === 'PUT') { puts++; return route.continue(); }
    reads++;
    if (reads === 1) return route.fulfill({ status: 500, json: { error: 'Server busy' } });
    if (reads === 2) await held;
    return route.continue();
  });
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const mine = dialog.getByRole('region', { name: 'My filaments' });
  const library = dialog.getByRole('region', { name: 'Library' });
  const cards = library.getByRole('list', { name: 'Library filaments' }).getByRole('button');
  const rows = mine.getByRole('listitem');
  const empty = mine.getByText('No filaments yet. Add one from the library, or a custom one.');
  const active = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '');
  try {
    await page.goto(`${A}/`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await dialog.getByRole('tab', { name: 'Filaments', exact: true }).click();

    // The read failed: said so, with Try again; not the empty shelf; nothing can be added.
    await mine.getByText('Your filaments could not be loaded. Nothing was changed.').waitFor();
    assert.equal(await empty.count(), 0, 'a failed read is not "No filaments yet"');
    assert.equal(await mine.getByRole('button', { name: 'Custom filament' }).isDisabled(), true);
    assert.equal(await cards.first().getAttribute('aria-disabled'), 'true');
    await cards.first().click({ force: true });
    await page.waitForTimeout(400);
    assert.equal(puts, 0, 'a card click after a failed read sends nothing');

    // Try again: loading (the read is held), still not the empty shelf, a card click still sends nothing.
    await mine.getByRole('button', { name: 'Try again' }).click();
    await mine.getByText('Loading your filaments…').waitFor();
    assert.equal(await empty.count(), 0, 'loading is not "No filaments yet"');
    await cards.nth(1).click({ force: true });
    await page.waitForTimeout(400);
    assert.equal(puts, 0, 'a card click while loading sends nothing');
    release();
    await rows.nth(4).waitFor();
    assert.equal(puts, 0);
    assert.equal((await getShelf()).length, 5, 'the saved list is whole');

    // On a phone a row is two lines: the name in full, then the rolls (a narrow box), Edit and Remove.
    const rowsLayout = await mine.locator('.fil-row').evaluateAll((els) => els.map((e) => {
      const name = e.querySelector('.fil-name')!.getBoundingClientRect(), rolls = e.querySelector('.fil-rolls input')!.getBoundingClientRect();
      const title = e.querySelector('.layertone-title')!;
      return { nameBottom: name.bottom, rollsTop: rolls.top, rollsW: rolls.width, clipped: title.scrollWidth > title.clientWidth + 1, font: parseFloat(getComputedStyle(e.querySelector('.fil-rolls input')!).fontSize) };
    }));
    for (const r of rowsLayout) {
      assert.ok(r.rollsTop >= r.nameBottom - 1, `rolls under the name (${JSON.stringify(r)})`);
      assert.ok(r.rollsW <= r.font * 3.6, `the rolls box is narrow (${r.rollsW}px)`);
      assert.equal(r.clipped, false, 'the name is not cut');
    }
    await page.screenshot({ path: path.join(shots, 'filaments-phone-fixed.png') });

    // Edit on the last row: the form is in view with the focus in its name.
    const last = rows.nth(4);
    const lastName = (await last.locator('.layertone-title').innerText()).trim();
    await last.scrollIntoViewIfNeeded();
    await last.getByRole('button', { name: `Edit ${lastName}` }).click();
    const form = mine.getByRole('group', { name: `Edit ${lastName}` });
    await form.waitFor();
    assert.equal(await active(), 'Filament name', 'the focus is in the form');
    const fb = (await form.boundingBox())!;
    assert.ok(fb.y >= 0 && fb.y < 800, `the form is on screen (${JSON.stringify(fb)})`);
    await page.screenshot({ path: path.join(shots, 'filaments-form-fixed.png') });

    // Renamed to another saved filament's name and brand: refused under the name, nothing sent.
    const other = rows.nth(3);
    const otherName = (await other.locator('.layertone-title').innerText()).trim();
    const nameBox = form.getByRole('textbox', { name: 'Filament name' });
    await nameBox.fill(otherName);
    await form.getByRole('button', { name: 'Save changes' }).click();
    await form.getByText('You already have a filament with this brand and name.').waitFor();
    assert.equal(await nameBox.getAttribute('aria-invalid'), 'true');
    assert.ok((await nameBox.getAttribute('aria-describedby'))?.length);
    await page.waitForTimeout(300);
    assert.equal(puts, 0, 'nothing was sent');
    assert.deepEqual((await getShelf()).map((f) => f.name).sort(), SHELF.map((f) => f.name).sort());
    // Done: the focus goes back to the row's Edit.
    await form.getByRole('button', { name: 'Done' }).click();
    await form.waitFor({ state: 'detached' });
    assert.equal(await active(), `Edit ${lastName}`);
    await dialog.getByRole('button', { name: 'Close' }).click();
  } finally {
    release();
    await page.close();
    await putShelf([]);
  }
});

test('a part\'s filament picker: brands first (the user\'s own ahead), then a brand\'s lines; the Settings brand pills in the same order', TEST, async () => {
  const lib = FILAMENT_LIBRARY;
  const brands = [...new Set(lib.map((f) => f.brand))].sort((a, b) => a.localeCompare(b));
  assert.ok(brands.length >= 2);
  const [few, many] = [brands[brands.length - 1], brands[brands.length - 2]];
  const save = (brand: string, n: number) => Array.from({ length: n }, (_, i) => ({ name: `Smoke Own ${brand} ${i}`, brand, color: '#1f9d8f', td: 1.7, rolls: 1 }));
  assert.equal((await putShelf([...save(few, 1), ...save(many, 2)])).status, 200);
  const want = [many, few, ...brands.filter((b) => b !== few && b !== many)];
  const withLines = brands.find((b) => filamentLines().filter((l) => l.brand === b).length > 1)!;
  const bl = filamentLines().filter((l) => l.brand === withLines);
  const pid = 'ui-smoke-000000f3';
  const parts = 'function build() { return [{ name: \'Base\', color: \'#d0d0d0\', shape: Manifold.cube([30, 30, 6]) }, { name: \'Lid\', color: \'#d0d0d0\', shape: Manifold.cube([20, 20, 4]).translate([5, 5, 10]) }]; }';
  assert.equal((await putDesign({ id: pid, name: 'Two parts for brands', createdAt: 1, updatedAt: 1, code: parts, values: {}, messages: [], currentVersion: 0,
    versions: [{ code: parts, summary: 'A base and a lid', createdAt: 1, source: 'manual' }] })).status, 200);
  const page = await newPage();
  try {
    await page.goto(`${A}/?design=${pid}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - Two parts for brands');
    await built(page);
    await page.getByRole('button', { name: 'Filament of Lid', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add a filament' });
    await picker.waitFor();
    const brandRow = picker.getByRole('tablist', { name: 'Filament brands' });
    await picker.getByRole('group', { name: 'My filaments' }).waitFor();
    assert.deepEqual(await brandRow.getByRole('tab').allInnerTexts(), ['All', ...want]);
    assert.equal(await picker.getByRole('tablist', { name: /lines$/ }).count(), 0, 'no line row before a brand is chosen');
    assert.deepEqual(await picker.getByRole('group').evaluateAll((els) => els.map((e) => e.getAttribute('aria-labelledby') ? document.getElementById(e.getAttribute('aria-labelledby')!)!.textContent : '')).then((l) => l.slice(0, 2)), ['My filaments', 'Common']);
    const sideways = () => picker.evaluate((el) => ({ pop: el.scrollWidth - el.clientWidth, rows: [...el.querySelectorAll('.layertone-lines')].map((r) => r.scrollWidth - r.clientWidth), h: el.getBoundingClientRect().height, win: innerHeight }));
    let m = await sideways();
    assert.ok(m.pop <= 0 && m.rows.every((x) => x <= 0) && m.h <= m.win, `no sideways scroll, fits the window: ${JSON.stringify(m)}`);
    await page.screenshot({ path: path.join(shots, 'picker-brands.png') });

    await brandRow.getByRole('tab', { name: withLines, exact: true }).click();
    const lineRow = picker.getByRole('tablist', { name: `${withLines} lines` });
    assert.deepEqual(await lineRow.getByRole('tab').allInnerTexts(), ['All lines', ...bl.map((l) => l.line)]);
    const names = () => picker.getByRole('option').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!));
    const inBrand = lib.filter((f) => f.brand === withLines);
    assert.equal((await names()).length, inBrand.length, 'every filament of the brand and no other');
    assert.equal(await picker.getByRole('group', { name: 'Common' }).count(), 0);
    m = await sideways();
    assert.ok(m.pop <= 0 && m.rows.every((x) => x <= 0) && m.h <= m.win, `brand view: ${JSON.stringify(m)}`);
    await page.screenshot({ path: path.join(shots, 'picker-brand-lines.png') });
    await lineRow.getByRole('tab', { name: bl[1].line, exact: true }).click();
    assert.equal((await names()).length, bl[1].filaments.length, 'only the chosen line');
    // Another brand drops a line that is not its own.
    await brandRow.getByRole('tab', { name: want.find((b) => b !== withLines)!, exact: true }).click();
    assert.equal(await picker.getByRole('tablist', { name: /lines$/ }).getByRole('tab', { selected: true }).innerText({ timeout: 2000 }), 'All lines');
    // A search with matches only in other brands: said so, and "Search every brand" keeps the text.
    const chosen = want.find((b) => b !== withLines)!;
    const otherName = lib.find((f) => f.brand === withLines)!.name;
    await brandRow.getByRole('tab', { name: chosen, exact: true }).click();
    await picker.getByRole('textbox', { name: 'Search the filaments' }).fill(`${withLines} ${otherName}`);
    await picker.getByText(`No ${chosen} filament matches.`).waitFor();
    await page.screenshot({ path: path.join(shots, 'picker-no-match.png') });
    await picker.getByRole('button', { name: 'Search every brand' }).click();
    assert.equal(await picker.getByRole('textbox', { name: 'Search the filaments' }).inputValue(), `${withLines} ${otherName}`);
    assert.ok((await picker.getByRole('option').count()) > 0);
    await picker.getByRole('textbox', { name: 'Search the filaments' }).fill('');
    await brandRow.getByRole('tab', { name: 'All', exact: true }).click();
    await picker.getByRole('group', { name: 'My filaments' }).waitFor();
    // The brand order stays while it is open: saving a filament of the last brand does not move it.
    await picker.getByRole('button', { name: 'Custom colour…' }).click();
    await picker.getByRole('textbox', { name: 'Filament name' }).fill('Smoke Stay Put');
    await picker.getByRole('textbox', { name: 'Brand' }).fill(brands[0]);
    await picker.getByRole('button', { name: 'Save as mine' }).click();
    await picker.getByRole('button', { name: 'Saved' }).waitFor();
    assert.deepEqual(await brandRow.getByRole('tab').allInnerTexts(), ['All', ...want], 'the row did not move while the picker stayed open');

    // Settings: the same brand order after "All".
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Filaments', exact: true }).click();
    const pills = await dialog.getByRole('region', { name: 'Library' }).getByRole('group', { name: 'Brand', exact: true }).getByRole('button').allInnerTexts();
    // Opened again, the Settings tab has the order the extra saved filament makes.
    const counts = new Map<string, number>([[many, 2], [few, 1]]);
    counts.set(brands[0], (counts.get(brands[0]) ?? 0) + 1);
    const later = [...brands].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
    assert.deepEqual(pills, ['All', ...later]);
  } finally {
    await page.close();
    await putShelf([]);
  }
});

test('Settings: "Edit my filaments in Settings" in a filament picker opens the Filaments tab, also over the line art editor, which keeps its shortcuts to itself', TEST, async () => {
  assert.equal((await putShelf([{ name: 'Smoke Picker Teal', brand: 'Acme', color: '#1f9d8f', td: 1.7, rolls: 2 }])).status, 200);
  const pid = 'ui-smoke-000000f1', lid = 'ui-smoke-000000f2';
  const parts = 'function build() { return [{ name: \'Base\', color: \'#d0d0d0\', shape: Manifold.cube([30, 30, 6]) }, { name: \'Lid\', color: \'#d0d0d0\', shape: Manifold.cube([20, 20, 4]).translate([5, 5, 10]) }]; }';
  assert.equal((await putDesign({ id: pid, name: 'Two parts for settings', createdAt: 1, updatedAt: 1, code: parts, values: {}, messages: [], currentVersion: 0,
    versions: [{ code: parts, summary: 'A base and a lid', createdAt: 1, source: 'manual' }] })).status, 200);
  const box = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const frame = { name: 'frame', aspect: 2, shapes: [{ rule: 'EvenOdd', contours: [box(-1, -0.5, 1, 0.5), box(-0.98, -0.48, 0.98, 0.48)], color: '#000000' }] };
  const art = "function build() { return H.lineart('frame', { style: 'outline', width: 120 }); }";
  assert.equal((await putDesign({ id: lid, name: 'Frame for settings', createdAt: 1, updatedAt: 1, code: art, values: { $drawings: JSON.stringify({ frame }) }, messages: [], currentVersion: 0,
    versions: [{ code: art, summary: 'A frame', createdAt: 1, source: 'manual' }] })).status, 200);
  const page = await newPage();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const picker = page.getByRole('dialog', { name: 'Add a filament' });
  const link = picker.getByRole('button', { name: 'Edit my filaments in Settings' });
  try {
    // A part's picker: the filament is offered under "My filaments"; the link closes the popover and opens Settings on Filaments.
    await page.goto(`${A}/?design=${pid}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - Two parts for settings');
    await built(page);
    const swatch = page.getByRole('button', { name: 'Filament of Lid', exact: true });
    await swatch.click();
    await picker.waitFor();
    const group = picker.getByRole('group', { name: 'My filaments' });
    await group.getByRole('option', { name: /^Smoke Picker Teal/ }).waitFor();
    await link.click();
    await picker.waitFor({ state: 'detached' });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('tab', { selected: true }).innerText(), 'Filaments');
    await dialog.getByRole('listitem').filter({ hasText: 'Smoke Picker Teal' }).waitFor();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    console.log(`settings from picker: focus after close is on ${await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName)}`);

    // The line art editor's picker has the link too; Settings opens over the editor.
    await page.goto(`${A}/?design=${lid}`);
    await page.waitForFunction(() => document.title === 'prompt-to-part - Frame for settings');
    await built(page);
    await page.getByRole('tab', { name: /Print/ }).click();
    await page.getByRole('button', { name: 'Paint and fix the picture by hand' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit the drawing' });
    await editor.waitFor();
    await editor.getByRole('radio', { name: 'Paint' }).click();
    await editor.getByRole('button', { name: 'Pick another filament' }).click();
    await picker.waitFor();
    await link.click();
    await picker.waitFor({ state: 'detached' });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('tab', { selected: true }).innerText(), 'Filaments');
    // Typing in Settings works, and the editor's letter shortcuts (E erases, B draws, G fills) do not fire.
    const shelfSearch = dialog.getByRole('searchbox', { name: 'Search my filaments' });
    await shelfSearch.click();
    await page.keyboard.type('begpqsc[]');
    assert.equal(await shelfSearch.inputValue(), 'begpqsc[]');
    await dialog.getByRole('tab', { name: 'Filaments', exact: true }).focus();
    await page.keyboard.press('e');
    await page.keyboard.press('g');
    await page.keyboard.press('b');
    assert.equal(await editor.getByRole('radio', { name: 'Paint' }).getAttribute('aria-checked'), 'true', 'the editor is still on Paint');
    // Escape closes Settings only; the editor stays.
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await editor.isVisible(), true, 'the editor is still open');
    // Back in the editor its shortcuts work again.
    await editor.getByRole('radio', { name: 'Paint' }).focus();
    await page.keyboard.press('g');
    await until(async () => (await editor.getByRole('radio', { name: 'Fill' }).getAttribute('aria-checked')) === 'true', 'the editor shortcut G works again');
    await page.screenshot({ path: path.join(shots, 'filaments-over-editor.png') });
  } finally {
    await page.close();
    await putShelf([]);
  }
});
