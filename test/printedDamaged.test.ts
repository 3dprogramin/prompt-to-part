// A damaged or unreadable printed.json: kept aside as it is, its marks recovered (from its text and
// from the stored print 3MFs), and work goes on: saves are not all refused, and printed versions
// stay locked.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Design } from '../shared/types';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-printed-damaged-'));
process.env.PTP_DATA = dataDir;
process.env.PTP_AUTH = 'subscription';
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const { createApp } = await import('../server/app');
const { versionFingerprint } = await import('../server/printed');
server.on('request', createApp({ port }));
after(() => { server.closeAllConnections(); server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const A = `http://127.0.0.1:${port}`;
const W = { 'Content-Type': 'application/json', 'X-PTP': '1' };
const designs = path.join(dataDir, 'designs');
const printedJson = path.join(dataDir, 'printed.json');
const version = (code: string) => ({ code, values: {}, summary: code, createdAt: 1 });
/** A design on disk with versions of these codes. */
function stored(id: string, codes: string[]): Design {
  const d = { id, name: id, createdAt: 1, updatedAt: 1, messages: [], versions: codes.map(version), currentVersion: codes.length - 1, code: codes.at(-1)!, values: {}, rev: 1 } as unknown as Design;
  mkdirSync(designs, { recursive: true });
  writeFileSync(path.join(designs, `${id}.json`), JSON.stringify(d));
  return d;
}
function print3mf(id: string, v: number, settings: boolean) {
  mkdirSync(path.join(designs, id, 'printed'), { recursive: true });
  writeFileSync(path.join(designs, id, 'printed', `v${v + 1}.3mf`), `PK 3D/3dmodel.model ${settings ? 'Metadata/project_settings.config' : ''}`);
}
const mark = (d: Design, v: number, at: number, file: boolean, settings = false) => ({ v, at, fp: versionFingerprint(d.versions[v]), file, settings });
const put = (d: Design) => fetch(`${A}/api/designs/${d.id}`, { method: 'PUT', headers: W, body: JSON.stringify(d) });
/** The design with version v's code changed. */
const changed = (d: Design, v: number): Design => ({ ...d, versions: d.versions.map((x, i) => (i === v ? { ...x, code: `${x.code} changed` } : x)) });
const listed = async () => Object.fromEntries(((await (await fetch(`${A}/api/designs`)).json()) as { id: string; printed?: unknown }[]).map((s) => [s.id, s.printed]));

test('a damaged printed.json is kept aside, its readable marks and the printed 3MFs come back, and saves go on', async () => {
  const a = stored('printed-dmg-0000a', ['a0', 'a1']);
  const b = stored('printed-dmg-0000b', ['b0', 'b1']);
  const c = stored('printed-dmg-0000c', ['c0']);
  print3mf(b.id, 1, true);
  print3mf(c.id, 0, false);
  const whole = JSON.stringify({ printed: { [a.id]: [mark(a, 0, 111, false)], [b.id]: [mark(b, 1, 222, true, true)], [c.id]: [mark(c, 0, 333, true)] } });
  // Cut in the middle of c's mark, then garbage (a crash mid-write, a bad disk block).
  const damaged = `${whole.slice(0, whole.indexOf('"fp"', whole.indexOf(c.id)))}\u0000\u0000garbage`;
  writeFileSync(printedJson, damaged);

  const d = stored('printed-dmg-0000d', ['d0']);
  assert.equal((await put(d)).status, 200, 'a design with no printed versions saves');
  const aside = readdirSync(dataDir).filter((n) => n.startsWith('printed.json.damaged-'));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(path.join(dataDir, aside[0]), 'utf8'), damaged, 'the damaged file is kept as it was');

  const got = await listed();
  assert.deepEqual(got[a.id], [{ v: 0, at: 111, file: false, settings: false }]);
  assert.deepEqual(got[b.id], [{ v: 1, at: 222, file: true, settings: true }]);
  assert.deepEqual((got[c.id] as { v: number; file: boolean; settings: boolean }[]).map(({ v, file, settings }) => ({ v, file, settings })), [{ v: 0, file: true, settings: false }]);
  // Printed versions stay locked; the others save.
  for (const [x, v] of [[a, 0], [b, 1], [c, 0]] as const) assert.equal((await put(changed(x, v))).status, 423, `${x.id} v${v + 1}`);
  assert.equal((await put(changed(a, 1))).status, 200);
  const caps = await (await fetch(`${A}/api/capabilities`)).json() as { printedProblem?: string };
  assert.match(caps.printedProblem ?? '', new RegExp(aside[0].replace(/\./g, '\\.')));
});

test('a printed.json that can\'t be read is not taken as "nothing printed"', async () => {
  const e = stored('printed-dmg-0000e', ['e0']);
  print3mf(e.id, 0, false);
  const text = JSON.stringify({ printed: { [e.id]: [mark(e, 0, 444, true)] } });
  writeFileSync(printedJson, text);
  chmodSync(printedJson, 0);
  try {
    assert.equal((await put(changed(e, 0))).status, 423, 'its printed version stays locked');
  } finally {
    for (const n of readdirSync(dataDir)) if (n.startsWith('printed.json')) chmodSync(path.join(dataDir, n), 0o644);
  }
  const kept = readdirSync(dataDir).filter((n) => n.startsWith('printed.json')).map((n) => readFileSync(path.join(dataDir, n), 'utf8'));
  assert.ok(kept.includes(text), 'the unreadable file is kept as it was');
});
