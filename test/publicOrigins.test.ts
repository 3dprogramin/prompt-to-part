import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-origins-test-'));
process.env.PTP_DATA = dataDir;
process.env.NODE_ENV = 'test';
const open = (): Promise<Server> => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const { createApp } = await import('../server/app');
const plain = await open(), proxied = await open();
const plainPort = (plain.address() as { port: number }).port, proxiedPort = (proxied.address() as { port: number }).port;
plain.on('request', createApp({ port: plainPort }));
// Behind an HTTPS reverse proxy the browser's Host has no port and its Origin is https.
proxied.on('request', createApp({ port: proxiedPort, origins: ['https://ptp.example.com', 'https://other.example.com:8443/', 'not a url', 'ftp://x.example.com'] }));
after(() => { plain.close(); proxied.close(); rmSync(dataDir, { recursive: true, force: true }); });

/** Status of a request to /api/designs with the headers of our choosing (fetch() sets Host itself). */
const status = (port: number, headers: Record<string, string>, method = 'GET') => new Promise<number>((resolve, reject) => {
  request({ host: '127.0.0.1', port, path: '/api/designs/test-orig-00000001', method, headers }, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject).end();
});

test('without PTP_ORIGINS a public name is refused, whatever the proxy forwards', async () => {
  assert.equal(await status(plainPort, { Host: 'ptp.example.com' }), 421);
  assert.equal(await status(plainPort, { Host: `127.0.0.1:${plainPort}`, Origin: 'https://ptp.example.com' }), 403);
  assert.equal(await status(plainPort, { Host: 'ptp.example.com', 'X-Forwarded-Host': 'ptp.example.com', 'X-Forwarded-Proto': 'https', Origin: 'https://ptp.example.com' }), 421);
});

test('a configured public origin is accepted for reads and writes', async () => {
  // 404: past the checks, the design is just not there.
  assert.equal(await status(proxiedPort, { Host: 'ptp.example.com', Origin: 'https://ptp.example.com' }), 404);
  assert.equal(await status(proxiedPort, { Host: 'ptp.example.com', Origin: 'https://ptp.example.com', 'X-PTP': '1' }, 'DELETE'), 200); // deleting what is not there is fine
  assert.equal(await status(proxiedPort, { Host: 'other.example.com:8443', Origin: 'https://other.example.com:8443' }), 404);
  // Still needs X-PTP to write.
  assert.equal(await status(proxiedPort, { Host: 'ptp.example.com', Origin: 'https://ptp.example.com' }, 'DELETE'), 403);
});

test('a configured public origin leaves every other site and name refused', async () => {
  assert.equal(await status(proxiedPort, { Host: 'ptp.example.com', Origin: 'https://evil.com' }), 403);
  assert.equal(await status(proxiedPort, { Host: 'ptp.example.com', Origin: 'http://ptp.example.com' }), 403);
  assert.equal(await status(proxiedPort, { Host: 'evil.com' }), 421);
  assert.equal(await status(proxiedPort, { Host: 'x.example.com' }), 421);
  // The local names keep working beside it.
  assert.equal(await status(proxiedPort, { Host: `localhost:${proxiedPort}`, Origin: `http://localhost:${proxiedPort}` }), 404);
});
