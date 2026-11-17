import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// A data folder under a dot-directory (~/.local/share/..., say): res.sendFile refuses those by default.
const root = mkdtempSync(path.join(os.tmpdir(), 'ptp-dot-test-'));
process.env.PTP_DATA = path.join(root, '.hidden', 'data');
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const { createApp } = await import('../server/app');
const { printedFileName } = await import('../shared/printed');
server.on('request', createApp({ port }));
after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

const A = `http://127.0.0.1:${port}`;
const ID = 'test-dot-00000001';
const hash = (c: string) => c.repeat(32);

test('images, meshes and printed files are served from a data folder under a dot-directory', async () => {
  const dir = path.join(process.env.PTP_DATA!, 'designs', ID);
  mkdirSync(path.join(dir, 'meshes'), { recursive: true });
  mkdirSync(path.join(dir, 'printed'), { recursive: true });
  writeFileSync(path.join(process.env.PTP_DATA!, 'designs', `${ID}.json`), JSON.stringify({ id: ID, name: 'Hook' }));
  writeFileSync(path.join(dir, `${hash('a')}.png`), 'png-bytes');
  writeFileSync(path.join(dir, 'meshes', `${hash('b')}.bin`), 'mesh-bytes');
  writeFileSync(path.join(dir, 'printed', printedFileName(0)), '3mf-bytes');
  const image = await fetch(`${A}/api/designs/${ID}/images/${hash('a')}.png`);
  assert.equal(image.status, 200);
  assert.equal(await image.text(), 'png-bytes');
  const mesh = await fetch(`${A}/api/designs/${ID}/meshes/${hash('b')}.bin`);
  assert.equal(mesh.status, 200);
  assert.equal(await mesh.text(), 'mesh-bytes');
  const printed = await fetch(`${A}/api/designs/${ID}/printed/0/3mf`);
  assert.equal(printed.status, 200);
  assert.equal(await printed.text(), '3mf-bytes');
});

test('names that are not a stored file are still refused', async () => {
  assert.equal((await fetch(`${A}/api/designs/${ID}/images/..%2F..%2Fx.png`)).status, 400);
  assert.equal((await fetch(`${A}/api/designs/${ID}/images/.hidden.png`)).status, 400);
  assert.equal((await fetch(`${A}/api/designs/${ID}/meshes/${hash('c')}.bin`)).status, 404);
  assert.equal((await fetch(`${A}/api/designs/${ID}/printed/7/3mf`)).status, 404);
});
