// UI smoke test (`npm run test:ui`): the built app in one headless Chromium against a throwaway
// server with its own data folder and a stand-in for Claude, so it never touches your designs, the
// Docker container or your Claude usage. It opens a tiny cube design and checks the top bar, the 3D
// view, a link in a reply, the Print tab (which must not start a slice by itself), the Designs menu's export and
// import, Export project… (as a zip), a reply that was cut short, the Meshy credits on the 3D figure button, a coloured figure,
// "Print in one colour" in the Print tab, and the chat's "Send my view" and "Wait for my OK" switches with a concept
// picture's countdown. A screenshot of each step is saved to JIG_UI_SHOTS (default: a temp folder) for a look at
// what the browser saw.
// Needs Playwright's Chromium (`npx playwright install chromium` once).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('a reply saved while Jig was working shows as interrupted, with its thinking kept', async () => {
  assert.ok(browser, 'runs after the first test');
  const cut = 'ui-smoke-20000001';
  const r = await fetch(`${A}/api/designs/${cut}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Jig': '1' },
    body: JSON.stringify({ id: cut, name: 'Cut short', createdAt: 1, updatedAt: 1, code: '', values: {}, currentVersion: -1, versions: [], sessionId: 'abc',
      messages: [{ id: 'u1', role: 'user', text: 'A cube', createdAt: 1 },
        { id: 'a1', role: 'assistant', text: '', createdAt: 1, pending: true, steps: [{ kind: 'thinking', text: 'Planning a 20 mm cube' }],
          activity: [{ kind: 'thinking', text: 'Planning a 20 mm cube with chamfered edges', at: 5 }] }] }) });
  assert.equal(r.status, 200, await r.text());
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(`${A}/?design=${cut}`);
  await page.locator('.bubble.interrupted', { hasText: 'Interrupted – Jig stopped before finishing' }).waitFor();
  await page.locator('.think-link').click();
  await page.locator('.activity-panel', { hasText: 'chamfered edges' }).waitFor();
  assert.equal(await page.locator('.chat-panel textarea').isEnabled(), true);
  await page.screenshot({ path: path.join(shots, '6-interrupted.png') });
  await page.close();
});

test('3D figure mode shows the Meshy credits left on its button', async () => {
  assert.ok(browser, 'runs after the first test');
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
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
  // Colour (4 filaments), off by default: a coloured model costs 35.
  await page.keyboard.press('Escape');
  const colour = page.locator('button.figure-color');
  assert.equal(await colour.getAttribute('aria-pressed'), 'false');
  await colour.click();
  assert.equal(await colour.getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('.mode-btn').getAttribute('title') ?? '', /a model costs 35 in colour/);
  await page.close();
});

test('a coloured figure: its filaments in the Object tab, the STL hint says the colours are lost', async () => {
  assert.ok(browser, 'runs after the first test');
  // The mock's coloured figure, imported (in the geometry process) as generate_3d stores it.
  const { geometry } = await import('../../server/geometry');
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(`${A}/?design=${fid}`);
  await page.waitForFunction(() => document.title === 'Jig - Coloured kid');
  const rows = page.locator('.mesh-colors-row');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 4);
  assert.match(await page.locator('.mesh-colors').textContent() ?? '', /4 of 4 AMS slots/);
  assert.equal(await page.getByRole('button', { name: /PLA Basic Black.*change the filament/ }).count(), 1);
  await page.screenshot({ path: path.join(shots, '8-coloured-figure.png') });
  await page.getByRole('button', { name: 'More export formats' }).click();
  await page.locator('.export-menu', { hasText: 'Geometry only: the figure\'s colours are lost' }).waitFor();
  await page.close();
});

test('"Print in one colour" in the Print tab: the view shows one filament, saved with the design', async () => {
  assert.ok(browser, 'runs after the coloured figure');
  const fid = 'ui-smoke-00000003';
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
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
  const until = Date.now() + 10_000;
  for (;;) {
    const d = await (await fetch(`${A}/api/designs/${fid}`)).json();
    if (d.values?.$oneColour === true) break;
    assert.ok(Date.now() < until, 'the switch is saved with the design');
    await new Promise((r) => setTimeout(r, 200));
  }
  await page.reload();
  await page.waitForFunction(() => document.title === 'Jig - Coloured kid');
  await page.getByRole('tab', { name: /Print/ }).click();
  assert.equal(await page.getByRole('checkbox', { name: 'Print in one colour' }).isChecked(), true);
  await page.getByRole('button', { name: 'More export formats' }).click();
  await page.getByRole('button', { name: /^3MF…/ }).click();
  assert.equal(await page.getByRole('checkbox', { name: /Colours \(AMS\)/ }).isChecked(), false);
  await page.close();
});

test('"Send my view" and "Wait for my OK": saved after a reload; a concept picture is built after a countdown unless stopped', async () => {
  assert.ok(browser, 'runs after the first test');
  const fid = 'ui-smoke-00000004';
  const saved = await fetch(`${A}/api/designs/${fid}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Jig': '1' },
    body: JSON.stringify({ id: fid, name: 'Knight', createdAt: 1, updatedAt: 1000, code, messages: [], values: {}, currentVersion: 0,
      versions: [{ code, summary: 'A 20 mm cube', createdAt: 1000, source: 'manual' }] }),
  });
  assert.equal(saved.status, 200, await saved.text());
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  // As if Jig had a Meshy key and an image model; the replies are stand-ins: a concept picture, or
  // (for an approval) a short answer.
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), meshy: true, artwork: 'Image model' } });
  });
  await page.route('**/api/meshy/balance', (route) => route.fulfill({ json: { balance: 1200, monthly_credits: 1000, permanent_credits: 200 } }));
  const sent: { prompt: string; currentView?: unknown; renderValues?: unknown }[] = [];
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
  await figureMode();
  const wait = page.getByRole('button', { name: 'Wait for my OK' });
  assert.equal(await wait.getAttribute('aria-pressed'), 'true');
  await wait.click();
  await view.click();
  assert.match(await wait.getAttribute('title') ?? '', /Wait for my OK is off: 10 s after/);
  await page.reload();
  await page.waitForFunction(() => document.title === 'Jig - Knight');
  assert.equal(await view.getAttribute('aria-pressed'), 'false');
  await figureMode();
  assert.equal(await wait.getAttribute('aria-pressed'), 'false');
  await page.screenshot({ path: path.join(shots, '10-chat-switches.png') });

  const box = page.locator('.chat-panel textarea');
  const card = page.locator('.auto-build');
  const ask = async (text: string) => { await box.fill(text); await box.press('Enter'); await card.waitFor(); };
  // Send my view off: neither the screenshot nor the four-view render goes.
  await ask('A knight figure');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].currentView, undefined);
  assert.equal(sent[0].renderValues, undefined);
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
  await page.waitForFunction(() => document.querySelectorAll('.msg.user .bubble').length === 6, undefined, { timeout: 15_000 });
  assert.equal(sent.length, 6);
  assert.equal(sent[5].prompt, 'Approved – build it.');
  assert.equal(await card.count(), 0);
  await page.close();
});
