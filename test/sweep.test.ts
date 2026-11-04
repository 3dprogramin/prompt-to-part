import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jig-sweep-test-'));
process.env.JIG_DATA = dataDir;
const { sweepDataDir } = await import('../server/sweep');
after(() => rmSync(dataDir, { recursive: true, force: true }));

const UUID = '0b8f3c1e-2d4a-4b6c-9e1f-3a5b7c9d1e2f';
const now = Date.now();
const old = (now - 2 * 24 * 60 * 60_000) / 1000;
const hoursAgo = (h: number) => (now - h * 60 * 60_000) / 1000;
function file(rel: string, at: number) {
  const p = path.join(dataDir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, 'x');
  utimesSync(p, at, at);
  return p;
}

test('the startup sweep removes only old leftovers of their exact patterns', async () => {
  const gone = [
    file(`.backup-import-${UUID}.zip`, hoursAgo(2)),
    file(`cost.json.${UUID}.tmp`, hoursAgo(2)),
    file(`designs/design-00000001.json.${UUID}.tmp`, hoursAgo(2)),
    file(`designs/design-00000001/${'a'.repeat(32)}.png.${UUID}.tmp`, hoursAgo(2)),
    file(`designs/design-00000001/meshes/${'b'.repeat(32)}.bin.${UUID}.tmp`, hoursAgo(2)),
  ];
  const kept = [
    file(`.backup-import-${UUID}.zip.part`, hoursAgo(2)),
    file('.backup-import-0b8f3c1e-2d4a-4b6c-9e1f-3a5b7c9d1e2e.zip', hoursAgo(0.5)), // a restore under way
    file('cost.json.0b8f3c1e-2d4a-4b6c-9e1f-3a5b7c9d1e2d.tmp', hoursAgo(0.5)),
    file('cost.json', hoursAgo(2)),
    file('notes.tmp', hoursAgo(2)),
    file(`other/x.${UUID}.tmp`, hoursAgo(2)), // not a folder the app writes temp files in
    file('designs/design-00000001.json', old),
    file(`designs/design-00000001/${'a'.repeat(32)}.png`, old),
  ];
  // Workspaces: of a saved design (kept, however old), of an unsaved one (gone when a day old),
  // a recent unsaved one, and one whose folder is old but whose model.js was written lately.
  const saved = file('workspaces/design-00000001/model.js', old);
  const orphan = file('workspaces/design-00000002/model.js', old);
  const fresh = file('workspaces/design-00000003/model.js', hoursAgo(2));
  const rewritten = file('workspaces/design-00000004/model.js', hoursAgo(2));
  for (const ws of ['design-00000001', 'design-00000002', 'design-00000004']) utimesSync(path.join(dataDir, 'workspaces', ws), old, old);
  const strange = file('workspaces/not an id/model.js', old);

  const { removed } = await sweepDataDir(dataDir, now);
  for (const p of gone) assert.ok(!existsSync(p), p);
  for (const p of [...kept, saved, fresh, rewritten, strange]) assert.ok(existsSync(p), p);
  assert.ok(!existsSync(path.dirname(orphan)));
  assert.equal(removed.length, gone.length + 1);
});

test('the sweep copes with a data folder that has nothing yet', async () => {
  assert.deepEqual(await sweepDataDir(path.join(dataDir, 'missing'), now), { removed: [] });
});
