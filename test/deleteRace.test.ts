// Deleting a design and starting a reply on it exclude each other: a delete held up in its queue
// (here: reading printed.json, made a pipe so the test decides when the read ends) can't remove a
// design whose reply started meanwhile, and a deleted design gets no new reply.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-delete-race-'));
process.env.PTP_DATA = dataDir;
process.env.PTP_AUTH = 'subscription';
process.env.PTP_CLAUDE = ''; // the mode set here, whatever PTP_CLAUDE the shell or .env names
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
let release = () => {};
const { createApp } = await import('../server/app');
server.on('request', createApp({
  port,
  generate: (_req, send, abort) => new Promise((resolve) => {
    send({ type: 'live', text: 'working' });
    release = () => resolve();
    abort.signal.addEventListener('abort', () => resolve());
  }),
}));
after(() => { release(); server.closeAllConnections(); server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const A = `http://127.0.0.1:${port}`;
const W = { 'Content-Type': 'application/json', 'X-PTP': '1' };
const ID = 'test-race-00000001';
const design = { id: ID, name: 't', createdAt: 1, updatedAt: 1, messages: [], versions: [], currentVersion: -1, code: 'x', values: {} };
const printedJson = path.join(dataDir, 'printed.json');

/** Opens the pipe's writing end once a reader (the delete) is waiting on it. */
async function writerOnceRead(fifo: string): Promise<number> {
  for (let i = 0; i < 500; i++) {
    try { return openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK); } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  throw new Error('the delete never read printed.json');
}

test('a reply that starts while a delete waits in the queue keeps its design; a deleted design gets no reply', async () => {
  assert.equal((await fetch(`${A}/api/designs/${ID}`, { method: 'PUT', headers: W, body: JSON.stringify(design) })).status, 200);
  execFileSync('mkfifo', [printedJson]);
  const deleting = fetch(`${A}/api/designs/${ID}`, { method: 'DELETE', headers: W });
  const fd = await writerOnceRead(printedJson);
  // The delete is past its first check and waits on printed.json: a reply starts now.
  const reply = await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: ID, prompt: 'a cube' }) });
  assert.equal(reply.status, 200);
  writeSync(fd, '{}');
  closeSync(fd);
  const deleted = await deleting;
  rmSync(printedJson);
  assert.equal(deleted.status, 409, 'the design being worked on is not deleted');
  assert.ok(existsSync(path.join(dataDir, 'designs', `${ID}.json`)), 'its file is still there');
  release();
  await reply.text();

  assert.equal((await fetch(`${A}/api/designs/${ID}`, { method: 'DELETE', headers: W })).status, 200);
  const late = await fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: ID, prompt: 'a cube' }) });
  assert.equal(late.status, 410, 'a deleted design gets no new reply');
  await late.text();
  assert.ok(!existsSync(path.join(dataDir, 'designs', `${ID}.json`)));
});
