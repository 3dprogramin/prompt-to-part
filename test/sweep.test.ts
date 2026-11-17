import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-sweep-test-'));
process.env.PTP_DATA = dataDir;
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

const MESH = `${'c'.repeat(32)}.bin`;
const ORIGINAL = `${'d'.repeat(32)}.stl`;
/** A design folder with mesh files (and its folders) last changed at `at`. */
function meshFolder(id: string, at: number, extra: string[] = []) {
  const files = [MESH, ORIGINAL, ...extra].map((n) => file(`designs/${id}/meshes/${n}`, at));
  for (const d of [`designs/${id}/meshes`, `designs/${id}`]) utimesSync(path.join(dataDir, d), at, at);
  return files;
}
const weeksAgo = (w: number) => (now - w * 7 * 24 * 60 * 60_000) / 1000;

test('mesh uploads of a chat never saved are swept after a grace period, unless anything refers to them', async () => {
  const abandoned = meshFolder('design-00000010', weeksAgo(2));
  const fresh = meshFolder('design-00000011', hoursAgo(24));
  // A chat image stays (outside the sweep), and with it the folder.
  const image = file(`designs/design-00000012/${'e'.repeat(32)}.png`, weeksAgo(2));
  const withImage = meshFolder('design-00000012', weeksAgo(2), ['notes.txt']);
  const notes = withImage.pop()!;
  // Referred to by another design (an old fork), by a printed record, by a save under way, by a workspace used lately.
  const forked = meshFolder('design-00000013', weeksAgo(2));
  file('designs/design-00000014.json', weeksAgo(2));
  writeFileSync(path.join(dataDir, 'designs/design-00000014.json'), JSON.stringify({ id: 'design-00000014', versions: [{ values: { $meshes: `{"a":{"file":"/api/designs/design-00000013/meshes/${MESH}"}}` } }] }));
  const printed = meshFolder('design-00000015', weeksAgo(2));
  writeFileSync(path.join(dataDir, 'printed.json'), JSON.stringify({ printed: { 'design-00000015': [{ v: 0, at: 1, fp: 'x', file: false, settings: false }] } }));
  const saving = meshFolder('design-00000016', weeksAgo(2));
  file(`designs/design-00000016.json.${UUID}.tmp`, hoursAgo(0.5));
  const working = meshFolder('design-00000017', weeksAgo(2));
  file('workspaces/design-00000017/model.js', hoursAgo(2));
  const saved = meshFolder('design-00000001', weeksAgo(2));

  await sweepDataDir(dataDir, now);
  for (const p of [...abandoned, ...withImage]) assert.ok(!existsSync(p), p);
  assert.ok(!existsSync(path.join(dataDir, 'designs/design-00000010')), 'an emptied folder goes');
  for (const p of [...fresh, image, notes, ...forked, ...printed, ...saving, ...working, ...saved]) assert.ok(existsSync(p), p);
});

test('no mesh upload is swept while a design file can\'t be read', async () => {
  const abandoned = meshFolder('design-00000020', weeksAgo(2));
  const unreadable = file('designs/design-00000021.json', weeksAgo(2));
  chmodSync(unreadable, 0);
  try {
    await sweepDataDir(dataDir, now);
  } finally {
    chmodSync(unreadable, 0o644);
  }
  for (const p of abandoned) assert.ok(existsSync(p), p);
});
