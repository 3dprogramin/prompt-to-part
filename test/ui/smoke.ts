// UI smoke test (`npm run test:ui`): the built app in one headless Chromium against a throwaway
// server with its own data folder and a stand-in for Claude, so it never touches your designs, the
// Docker container or your Claude usage. It opens a tiny cube design and checks the top bar, the 3D
// view, a link in a reply, the Print tab (which must not start a slice by itself), the Designs menu's export and
// import, Export project… (as a zip), stepping through enlarged product photos, a reply that was cut short, one that goes on through a reload or a dropped connection, the Meshy credits on the 3D figure button, a coloured figure (and repainting a patch of it),
// "Print in one colour" in the Print tab, and the chat's model chip, "Send my view" and the 3D figure's ▾ menu ("Wait for my OK") with a concept
// picture's countdown, the small-screen layouts: a phone (one panel at a time, picked in the bottom tab bar)
// and an unfolded foldable (the 3D view beside the chat or the side panel), the Designs menu's search, the
// picture mode menu on a phone (every mode, Line art's style ▾) and a part's filament picker in the Object
// tab, Shop photos (a set of 5 from their own renders, with a stand-in for the image model), and sale sizes (S / M / L built, shown and
// resized alone, sliced one at a time by a stand-in for Bambu Studio, scene photos for every size from one scene). Each test closes its pages, passed or not, and has a bounded time. A screenshot of each step is saved to
// JIG_UI_SHOTS (default: a temp folder) for a look at what the browser saw.
// Needs Playwright's Chromium (`npx playwright install chromium` once).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from 'playwright-core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jig-ui-test-'));
process.env.JIG_DATA = dataDir;
process.env.NODE_ENV = 'production';
// The stand-in for Claude needs no credentials, but the API checks them first.
process.env.JIG_AUTH = 'subscription';
delete process.env.JIG_DOCKER;
const shots = process.env.JIG_UI_SHOTS ?? path.join(os.tmpdir(), 'jig-ui-shots');
mkdirSync(shots, { recursive: true });

const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const { createApp } = await import('../../server/app');
// Stand-ins for Claude and for the connection check (the real one would start Claude Code with this
// computer's login to read the subscription's usage).
const connection = async () => ({ via: 'subscription' as const, ok: true, detail: 'Stand-in for the smoke test.',
  usage: [{ kind: 'five_hour', label: '5-hour', percent: 62, resetsAt: Date.now() + 3600_000, limited: false, at: Date.now() }] });
// The browser's connections, to drop them as a phone locking its screen would.
const sockets = new Set<Socket>();
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
// The one reply it generates, "a slow cube", waits for finishSlowCube() (or Stop).
let finishSlowCube = () => {};
// A stand-in for the image model (the shop photos test): the "photo" is the render it was sent,
// held until openImages() and refused once for a close-up; what it was asked for is kept.
let openImages = () => {};
const imagesOpen = new Promise<void>((resolve) => { openImages = resolve; });
const imageAsks: { prompt: string; aspect: string; size?: string }[] = [];
let refuseCloseUp = true;
const image = async (prompt: string, aspect: string, references: string[] | undefined, _signal?: AbortSignal, _onStatus?: unknown, size?: string) => {
  imageAsks.push({ prompt, aspect, size });
  await imagesOpen;
  if (refuseCloseUp && prompt.includes('CLOSE-UP DETAIL')) { refuseCloseUp = false; throw new Error('test/image is busy'); }
  const [, mediaType, data] = /^data:([^;]+);base64,(.+)$/s.exec(references![0])!;
  return { image: { data, mediaType }, model: 'test/image', cost: 0.1 };
};
server.on('request', createApp({ port, connection, image, generate: async (req, send, abort) => {
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
  method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Jig': '1' }, body: JSON.stringify(design) });
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

test('the app opens a design: top bar, 3D view, Print tab without an automatic slice', TEST, async () => {
  const saved = await fetch(`${A}/api/designs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Jig': '1' },
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
  await page.waitForFunction(() => document.title === 'Jig - Smoke cube');
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

  // Product photos: 13 scenes and Custom…, the other 9 after "More scenes".
  await page.getByRole('button', { name: 'Product photos' }).click();
  const scenes = page.locator('.ph-scenes [role=radio]');
  await page.getByRole('button', { name: 'More scenes (9 more)' }).waitFor();
  assert.equal(await scenes.count(), 14);
  await page.getByRole('button', { name: 'More scenes (9 more)' }).click();
  assert.equal(await scenes.count(), 23);
  await page.screenshot({ path: path.join(shots, '2-scenes.png') });

  assert.deepEqual(errors, []);
  console.log(`screenshots: ${shots}`);
});

test('the Designs menu exports every design as a zip and imports one', TEST, async () => {
  const page = await newPage();
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'Jig - Smoke cube');
  await page.getByRole('button', { name: 'Designs' }).click();
  const menu = page.locator('.menu');

  const [download] = await Promise.all([page.waitForEvent('download'), menu.getByText('Export all designs').click()]);
  assert.match(download.suggestedFilename(), /^jig-designs-\d{4}-\d\d-\d\d\.zip$/);
  const exported = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
  assert.deepEqual(Object.keys(exported), [`designs/${id}.json`]);

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
    const r = await fetch(`${A}/api/designs/${n}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Jig': '1' },
      body: JSON.stringify({ id: n, name: `Cube ${i}`, createdAt: 1, updatedAt: 2000 + i, messages: [], code, values: {}, currentVersion: -1, versions: [] }) });
    assert.equal(r.status, 200, await r.text());
  }
  const page = await newPage();
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'Jig - Smoke cube');
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
  await page.waitForFunction(() => document.title === 'Jig - Cube 11');
  assert.equal(await menu.count(), 0, 'the menu closes');
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
  await page.waitForFunction(() => document.title === 'Jig - Smoke cube');
  await page.getByRole('button', { name: 'More export formats' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export project…/ }).click()]);
  assert.equal(download.suggestedFilename(), 'Smoke cube.zip');
  const zip = readFileSync((await download.path())!);
  const files = unzipSync(new Uint8Array(zip));
  assert.deepEqual(Object.keys(files).sort(), ['README.md', 'design.jig.json', 'model.js', 'smoke-cube.3mf', 'smoke-cube.stl', 'values.json'].map((f) => `Smoke cube/${f}`));
  assert.equal(strFromU8(files['Smoke cube/model.js']), code);
  assert.equal(JSON.parse(strFromU8(files['Smoke cube/design.jig.json'])).id, id);
  const readme = strFromU8(files['Smoke cube/README.md']);
  for (const want of ['# Smoke cube', 'A 20 mm cube', '20.00 × 20.00 × 20.00 mm', `Jig ${version}`, 'No `.blend` file', 'The 3MF has no print settings']) assert.ok(readme.includes(want), `README: ${want}\n${readme}`);
  await page.getByText('Exported Smoke cube.zip').waitFor();
  await page.screenshot({ path: path.join(shots, '5-project.png') });

  // Import designs… reads the zip as it is (the design is here already, so it is kept).
  await page.getByRole('button', { name: 'Designs' }).click();
  await page.locator('.menu input[type=file]').setInputFiles({ name: 'Smoke cube.zip', mimeType: 'application/zip', buffer: zip });
  await page.locator('.menu').getByText('Imported 0, skipped 1').waitFor();
  await page.close();
});

test('a reply saved while Jig was working shows as interrupted, with its thinking kept', TEST, async () => {
  const cut = 'ui-smoke-20000001';
  const r = await fetch(`${A}/api/designs/${cut}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Jig': '1' },
    body: JSON.stringify({ id: cut, name: 'Cut short', createdAt: 1, updatedAt: 1, code: '', values: {}, currentVersion: -1, versions: [], sessionId: 'abc',
      messages: [{ id: 'u1', role: 'user', text: 'A cube', createdAt: 1 },
        { id: 'a1', role: 'assistant', text: '', createdAt: 1, pending: true, steps: [{ kind: 'thinking', text: 'Planning a 20 mm cube' }],
          activity: [{ kind: 'thinking', text: 'Planning a 20 mm cube with chamfered edges', at: 5 }] }] }) });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  await page.goto(`${A}/?design=${cut}`);
  await page.locator('.bubble.interrupted', { hasText: 'Interrupted – Jig stopped before finishing' }).waitFor();
  await page.locator('.think-link').click();
  await page.locator('.activity-panel', { hasText: 'chamfered edges' }).waitFor();
  assert.equal(await page.locator('.chat-panel textarea').isEnabled(), true);
  await page.screenshot({ path: path.join(shots, '6-interrupted.png') });
  await page.close();
});

test('a reply under way goes on through a reload or a dropped connection: the page catches up with it', TEST, async () => {
  const slow = 'ui-smoke-20000002';
  const r = await fetch(`${A}/api/designs/${slow}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Jig': '1' },
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
  const r = await fetch(`${A}/api/designs/${pid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Jig': '1' },
    body: JSON.stringify({ id: pid, name: 'Photos', createdAt: 1, updatedAt: 1, code, values: {}, currentVersion: 0, versions: [{ code, summary: 'A cube', createdAt: 1, source: 'manual' }], messages: [], photos }) });
  assert.equal(r.status, 200, await r.text());
  const page = await newPage();
  await page.goto(`${A}/?design=${pid}`);
  await page.waitForFunction(() => document.title === 'Jig - Photos');
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
  // As if Jig had a Meshy key; the balance is a stand-in (the real one would ask Meshy).
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), meshy: true } });
  });
  let asked = 0;
  await page.route('**/api/meshy/balance', (route) => { asked++; return route.fulfill({ json: { balance: 1200, monthly_credits: 1000, permanent_credits: 200, monthly_resets_at: 1795034540000 } }); });
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'Jig - Smoke cube');
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
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Jig': '1' },
    body: JSON.stringify({ id: fid, name: 'Coloured kid', createdAt: 1, updatedAt: 1000, code: figCode, messages: [], currentVersion: 0,
      values: { $meshes: JSON.stringify({ kid: { file: `/api/designs/${fid}/meshes/${bin}`, triangles: mesh.indices.length / 3, size: [35, 35, 80], source: 'meshy', palette } }) },
      versions: [{ code: figCode, summary: 'A coloured kid', createdAt: 1000, source: 'manual' }] }),
  });
  assert.equal(saved.status, 200, await saved.text());
  const page = await newPage();
  await page.goto(`${A}/?design=${fid}`);
  await page.waitForFunction(() => document.title === 'Jig - Coloured kid');
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
  await page.waitForFunction(() => document.title === 'Jig - Coloured kid');
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
  await page.waitForFunction(() => document.title === 'Jig - Coloured kid');
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
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Jig': '1' },
    body: JSON.stringify({ id: fid, name: 'Knight', createdAt: 1, updatedAt: 1000, code, messages: [], values: {}, currentVersion: 0,
      versions: [{ code, summary: 'A 20 mm cube', createdAt: 1000, source: 'manual' }] }),
  });
  assert.equal(saved.status, 200, await saved.text());
  const page = await newPage();
  // As if Jig had a Meshy key and an image model; the replies are stand-ins: a concept picture, or
  // (for an approval) a short answer.
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), meshy: true, artwork: 'Image model', effort: 'high' } });
  });
  await page.route('**/api/meshy/balance', (route) => route.fulfill({ json: { balance: 1200, monthly_credits: 1000, permanent_credits: 200 } }));
  const sent: { prompt: string; currentView?: unknown; renderValues?: unknown; model?: string; effort?: string }[] = [];
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
  await page.waitForFunction(() => document.title === 'Jig - Knight');
  const view = page.getByRole('button', { name: 'Send my view' });
  assert.equal(await view.getAttribute('aria-pressed'), 'true');
  assert.match(await view.getAttribute('title') ?? '', /what you mean by "this"/);
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
  await view.click();
  await page.reload();
  await page.waitForFunction(() => document.title === 'Jig - Knight');
  assert.equal(await view.getAttribute('aria-pressed'), 'false');
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
  assert.match(await card.innerText(), /Building with Meshy in \d+ s · 25 credits/);
  await page.screenshot({ path: path.join(shots, '11-countdown.png') });
  // Stop: the countdown is gone and nothing is sent.
  await card.getByRole('button', { name: 'Stop' }).click();
  await card.waitFor({ state: 'detached' });
  // Typing a change stops it too.
  await view.click();
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
  await page.waitForFunction(() => document.title === 'Jig - Knight');
  await figureMode();
  const bar = await page.locator('.composer-bar').boundingBox();
  assert.ok(bar && bar.height < 36, `one row (${bar?.height} px high)`);
  assert.equal(await page.locator('.model-text').isVisible(), false);
  await page.locator('.composer').screenshot({ path: path.join(shots, '12-chat-bar-narrow.png') });
  await page.close();
});

test('a phone shows one panel at a time, picked in the bottom tabs; an unfolded one the 3D view beside a pane', TEST, async () => {
  const page = await newPage(PHONE);
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'Jig - Smoke cube');
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
  await page.waitForFunction(() => document.title === 'Jig - Smoke cube');
  assert.equal(await tab('Panel').getAttribute('aria-selected'), 'true');
  await page.context().close();

  // Unfolded (the inner screen): the 3D view always, beside the chat or the side panel.
  const big = await newPage({ viewport: { width: 880, height: 1000 }, isMobile: true, hasTouch: true });
  await big.goto(`${A}/?design=${id}`);
  await big.waitForFunction(() => document.title === 'Jig - Smoke cube');
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
  // As if Jig had a Meshy key and an image model, so every mode is offered and can be chosen.
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), meshy: true, artwork: 'Image model' } });
  });
  await page.route('**/api/meshy/balance', (route) => route.fulfill({ json: { balance: 1200, monthly_credits: 1000, permanent_credits: 200 } }));
  await page.goto(`${A}/?design=${id}`);
  await page.waitForFunction(() => document.title === 'Jig - Smoke cube');
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
  await page.waitForFunction(() => document.title === 'Jig - Two parts');
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
  assert.equal(await background(), colour);
  // The 3D view follows, and the pick is saved with the design.
  await until(async () => !before.equals(await view.screenshot()), 'the part is recoloured in the view');
  await until(async () => !!JSON.parse((await getDesign(pid)).values?.$partColors ?? '{}').Lid?.color, 'the pick is saved with the design');
  await page.screenshot({ path: path.join(shots, '17-part-recoloured.png') });
  await page.getByRole('button', { name: 'Reset the filament of Lid' }).click();
  assert.equal(await background(), was);
  await until(async () => !(await getDesign(pid)).values?.$partColors, 'the reset is saved with the design');
});

test('Shop photos makes a set of 5 square 2K photos, each from its own render, with progress, and a failed one can be tried again', TEST, async () => {
  const pid = 'ui-smoke-00000006';
  // A flat wall plaque: face-on, at an angle, a close-up, on the wall and on the wall by a light switch.
  const plaque = 'function build() { return [{ name: \'Board\', color: \'#2f6f8f\', shape: Manifold.cube([120, 80, 4]) }, { name: \'Bar\', color: \'#f2efe6\', shape: Manifold.cube([80, 10, 2]).translate([20, 58, 4]) }, { name: \'Dot\', color: \'#e0a43c\', shape: Manifold.cylinder(2, 18, 18, 48).translate([60, 32, 4]) }]; }';
  const r = await putDesign({ id: pid, name: 'Home wall plaque', createdAt: 1, updatedAt: 1, code: plaque, values: {}, messages: [], currentVersion: 0,
    versions: [{ code: plaque, summary: 'A wall plaque', createdAt: 1, source: 'manual' }] });
  assert.equal(r.status, 200, await r.text());
  // As if Jig had an OpenRouter key; the image model is the stand-in.
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    const page = await newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${A}/?design=${pid}`);
    await page.waitForFunction(() => document.title === 'Jig - Home wall plaque');
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
    const photos = (await getDesign(pid)).photos as { shop?: string; scene: string; aspect: string; render?: string }[];
    assert.deepEqual(photos.map((ph) => ph.shop).sort(), ['angle', 'detail', 'lifestyle', 'main', 'size']);
    assert.ok(photos.every((ph) => ph.aspect === '1:1'));
    assert.deepEqual(Object.fromEntries(photos.map((ph) => [ph.shop, ph.scene])), { main: 'grey-studio', angle: 'grey-studio', detail: 'grey-studio', lifestyle: 'wall', size: 'wall' });
    // Each from its own render (the face, an angle and a close-up differ; the wall ones are face-on).
    const renders = new Map(photos.map((ph) => [ph.shop, ph.render]));
    assert.equal(new Set([renders.get('main'), renders.get('angle'), renders.get('detail')]).size, 3);
    assert.equal(renders.get('main'), renders.get('lifestyle'));
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
    await page.waitForFunction(() => document.title === 'Jig - Sized wall plaque');
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

test('Edit drawing paints lines in another filament: shown on the lines only, built as a part of its own', TEST, async () => {
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
  await page.waitForFunction(() => document.title === 'Jig - Painted frame');
  await built(page);
  await page.getByRole('tab', { name: /Print/ }).click();
  await page.getByRole('button', { name: 'Edit drawing' }).click();
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
  await page.mouse.up();
  // Red where the stroke crosses the lines, not over the paper between them.
  const red = await over.evaluate((c: HTMLCanvasElement, cssArea: number) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) n++;
    return { n, px: (c.width * c.height) / cssArea };
  }, b.width * b.height);
  assert.ok(red.n > 100 * red.px && red.n < 4000 * red.px, `${red.n} red pixels`);
  await page.screenshot({ path: path.join(shots, '18-lineart-paint.png') });
  await editor.getByRole('button', { name: 'Done' }).click();
  await editor.waitFor({ state: 'detached' });
  // Built: the painted lines are a part in that filament, saved with the design.
  await page.getByRole('tab', { name: /Object/ }).click();
  await page.locator('.object-name', { hasText: `Line art (${name})` }).waitFor();
  await until(async () => !!(await getDesign(lid)).values?.$lineartEdits, 'the paint is saved with the design');
  const saved = JSON.parse((await getDesign(lid)).values.$lineartEdits).frame.strokes;
  assert.equal(saved[0].mode, 'paint');
  assert.equal(saved[0].filament.name, name);
  await page.screenshot({ path: path.join(shots, '18-lineart-painted.png') });
  assert.deepEqual(errors, []);
});
