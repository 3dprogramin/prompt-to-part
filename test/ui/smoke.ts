// UI smoke test (`npm run test:ui`): the built app in one headless Chromium against a throwaway
// server with its own data folder and a stand-in for Claude, so it never touches your designs, the
// Docker container or your Claude usage. It opens a tiny cube design and checks the top bar, the 3D
// view, a link in a reply, the Print tab (which must not start a slice by itself), the Designs menu's export and
// import, and Export project… (as a zip). A screenshot of each step is saved to JIG_UI_SHOTS (default: a temp folder) for a look at
// what the browser saw.
// Needs Playwright's Chromium (`npx playwright install chromium` once).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
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
server.on('request', createApp({ port, connection, generate: async () => { throw new Error('the smoke test never generates'); } }));

let browser: Browser | null = null;
after(async () => {
  await browser?.close();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const A = `http://127.0.0.1:${port}`;
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const id = 'ui-smoke-00000001';
const code = 'function build() { return Manifold.cube([20, 20, 20]); }';

test('the app opens a design: top bar, 3D view, Print tab without an automatic slice', async () => {
  const saved = await fetch(`${A}/api/designs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Jig': '1' },
    body: JSON.stringify({ id, name: 'Smoke cube', createdAt: 1, updatedAt: 1000, code,
      messages: [{ id: 'm1', role: 'assistant', text: 'A cube. Battery: [DJI Store (EU)](https://store.dji.com/p?vid=1).', createdAt: 1000 }], values: {}, currentVersion: 0,
      versions: [{ code, summary: 'A 20 mm cube', createdAt: 1000, source: 'manual' }] }),
  });
  assert.equal(saved.status, 200, await saved.text());

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
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
  await page.locator('canvas').first().waitFor();
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
  await page.waitForTimeout(1500);
  assert.deepEqual(slices, [], 'opening the Print tab must not slice');
  await cost.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, '2-print.png') });

  // Product photos: 9 scenes and Custom…, the other 9 after "More scenes".
  await page.getByRole('button', { name: 'Product photos' }).click();
  const scenes = page.locator('.ph-scenes [role=radio]');
  await page.getByRole('button', { name: 'More scenes (9 more)' }).waitFor();
  assert.equal(await scenes.count(), 10);
  await page.getByRole('button', { name: 'More scenes (9 more)' }).click();
  assert.equal(await scenes.count(), 19);
  await page.screenshot({ path: path.join(shots, '2-scenes.png') });

  assert.deepEqual(errors, []);
  console.log(`screenshots: ${shots}`);
});

test('the Designs menu exports every design as a zip and imports one', async () => {
  assert.ok(browser, 'runs after the first test');
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
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

test('the Designs menu lists 10 designs at a time and marks starred ones', async () => {
  assert.ok(browser, 'runs after the first test');
  // 12 more designs (14 in all), the oldest first.
  for (let i = 1; i <= 12; i++) {
    const n = `ui-smoke-1${String(i).padStart(7, '0')}`;
    const r = await fetch(`${A}/api/designs/${n}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Jig': '1' },
      body: JSON.stringify({ id: n, name: `Cube ${i}`, createdAt: 1, updatedAt: 2000 + i, messages: [], code, values: {}, currentVersion: -1, versions: [] }) });
    assert.equal(r.status, 200, await r.text());
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
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
  await page.close();
});

test('Export project… downloads the design as one zip where there is no folder picker', async () => {
  assert.ok(browser, 'runs after the first test');
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
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
