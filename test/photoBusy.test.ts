// A photo request runs no process, so it holds a marker file in the temp folder while the image model
// works: scripts/rebuild.sh looks for /tmp/ptp-busy-* and must wait for it (a paid request).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-photo-busy-test-'));
process.env.PTP_DATA = dataDir;
process.env.PTP_AUTH = 'subscription';
const savedKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = 'test';
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
let asked = 0;
let finish: (ok: boolean) => void = () => {};
const { createApp } = await import('../server/app');
server.on('request', createApp({
  port,
  image: () => new Promise((resolve, reject) => {
    asked++;
    finish = (ok) => (ok ? resolve({ image: { data: Buffer.from('89504e470d0a1a0a70686f746f', 'hex').toString('base64'), mediaType: 'image/png' }, model: 'test/image', cost: 0.04 }) : reject(new Error('The image model refused: no')));
  }),
}));
after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
});

const A = `http://127.0.0.1:${port}`;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const photo = () => fetch(`${A}/api/designs/test-pb-00000001/photos`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-PTP': '1' },
  body: JSON.stringify({ render: { mediaType: 'image/png', data: PNG }, scene: 'table', aspect: '4:5', product: { name: 'Coaster', size: [100, 100, 5] } }),
});
/** The marker files of this server (it writes its own process id into each). */
const markers = () => readdirSync(os.tmpdir()).filter((n) => n.startsWith('ptp-busy-photo-'));
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };

test('a photo request holds a busy marker while the image model works, and drops it after the answer or an error', async () => {
  const before = markers().length;
  const first = photo();
  await until(() => asked === 1);
  const held = markers().length;
  finish(true);
  assert.equal(held, before + 1, 'busy while the image model works');
  assert.equal((await first).status, 200);
  assert.equal(markers().length, before, 'not busy any more once answered');

  const failing = photo();
  await until(() => asked === 2);
  const heldAgain = markers().length;
  finish(false);
  assert.equal(heldAgain, before + 1);
  assert.equal((await failing).status, 502);
  assert.equal(markers().length, before, 'an error frees it too');
});

test('rebuild.sh --check sees a photo request as busy (the marker is in the container /tmp)', () => {
  // A stand-in docker: `top` lists only the server, `exec ... sh -c` runs the command here against this folder.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-fakedocker-'));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ptp-fake-tmp-'));
  try {
    const run = () => spawnSync('bash', [path.resolve(import.meta.dirname, '../scripts/rebuild.sh'), '--check'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_TMP: tmp } });
    writeFileSync(path.join(dir, 'docker'), [
      '#!/bin/sh',
      "if [ \"$1\" = top ]; then printf '%s\\n' 'PID ARGS' '1 node server/index.ts'; exit 0; fi",
      // docker exec <container> sh -c '<command>': the command runs here, its /tmp being the fake one.
      'if [ "$1" = exec ]; then sh -c "$(printf \'%s\' "$5" | sed "s#/tmp/#$FAKE_TMP/#g")"; exit $?; fi',
      'exit 1', ''].join('\n'), { mode: 0o755 });
    assert.equal(run().status, 0, 'idle with no marker');
    writeFileSync(path.join(tmp, 'ptp-busy-photo-x'), '1\n');
    assert.equal(run().status, 1, 'busy with a photo marker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
