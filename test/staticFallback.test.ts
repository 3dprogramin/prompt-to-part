import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The app's own page, served for any client-side route in production, from a repo under a
// dot-directory (a git worktree in .worktrees/, ~/.local/share/...): sendFile refuses those by default.
// The check only discriminates when the repo sits under such a directory, as this worktree does.
process.env.PTP_DATA = mkdtempSync(path.join(os.tmpdir(), 'ptp-static-test-'));
process.env.NODE_ENV = 'production';
const { ROOT } = await import('../server/config');
const index = path.join(ROOT, 'dist', 'index.html');
const madeDist = !existsSync(index);
if (madeDist) { mkdirSync(path.dirname(index), { recursive: true }); writeFileSync(index, '<!doctype html><title>app</title>'); }
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const { createApp } = await import('../server/app');
server.on('request', createApp({ port }));
after(() => {
  server.close();
  rmSync(process.env.PTP_DATA!, { recursive: true, force: true });
  if (madeDist) rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
});

test('a client-side route gets index.html even when the repo is under a dot-directory', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/some/client/route`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), readFileSync(index, 'utf8'));
});
