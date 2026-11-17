import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

test('a server that cannot listen says so and exits, instead of announcing itself', async () => {
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
  const port = (taken.address() as { port: number }).port;
  const data = mkdtempSync(path.join(os.tmpdir(), 'ptp-port-test-'));
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, '..', 'server', 'index.ts')], {
    env: { ...process.env, PORT: String(port), PTP_HOST: '127.0.0.1', PTP_DATA: data },
  });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const killer = setTimeout(() => child.kill(), 45_000);
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  clearTimeout(killer);
  taken.close();
  rmSync(data, { recursive: true, force: true });
  assert.doesNotMatch(out, /server on http/);
  assert.match(err, /EADDRINUSE|already in use/);
  assert.equal(code, 1);
});
