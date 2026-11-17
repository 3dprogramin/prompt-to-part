import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Design, DesignVersion } from '../shared/types';
import { MESHES_KEY, parseMeshes, type MeshEntry } from '../shared/meshes';
import { blockedChange } from '../src/lib/printedLock';
import { withMesh } from '../src/app/designValues';
import { replyModel } from '../src/app/replyVersion';
import { restoreChoice, withVersion } from '../src/app/versionSwitch';

const version = (code: string, width: number): DesignVersion => ({ code, summary: code, createdAt: 0, source: 'ai', values: { width } });
// Three versions, the last one shown, a reply under way on it.
const design = (): Design => ({
  id: 'd', name: 'n', createdAt: 0, updatedAt: 0, versions: [version('v1', 10), version('v2', 20), version('v3', 30)], currentVersion: 2, code: 'v3', values: { width: 30 },
  messages: [{ id: 'asst', role: 'assistant', text: '', createdAt: 0, pending: true }],
});
const mesh = (file: string): MeshEntry => ({ file, triangles: 100, size: [10, 10, 10], source: 'meshy' });

/** A reply's events and a click on version `to` while it runs, through the printed lock as App.setDesign applies them. */
function midReplySwitch(to: number, locked: ReadonlySet<number>) {
  let d = design();
  const set = (fn: (d: Design) => Design) => { const next = fn(d); if (!blockedChange(d, next, locked)) d = next; };
  set((x) => withMesh(x, 'first', mesh(`/api/designs/design-0001/meshes/${'a'.repeat(32)}.bin`))); // paid for (Meshy), before the click
  const choice = restoreChoice({ to, current: d.currentVersion, unsavedSettings: false, locked: locked.has(d.currentVersion), replying: true });
  if (choice === 'switch') set((x) => withVersion(x, to));
  set((x) => withMesh(x, 'second', mesh(`/api/designs/design-0001/meshes/${'b'.repeat(32)}.bin`))); // after the click
  set((x) => replyModel(x, { type: 'model', code: 'v4', summary: 'v4', sources: [] }, 'asst', { edit: null, parent: 2 }).design);
  return { d, choice };
}

test('switching version while a reply runs keeps every mesh it made, in the version it makes', () => {
  const { d, choice } = midReplySwitch(0, new Set());
  assert.deepEqual(Object.keys(parseMeshes(d.versions.at(-1)!.values![MESHES_KEY])).sort(), ['first', 'second']);
  assert.equal(choice, 'wait');
  assert.equal(d.currentVersion, 3);
  assert.equal(d.messages[0].versionIndex, 3);
});

test('switching to a printed version while a reply runs drops none of its results', () => {
  const { d } = midReplySwitch(0, new Set([0]));
  assert.deepEqual(Object.keys(parseMeshes(d.values[MESHES_KEY])).sort(), ['first', 'second']);
  assert.deepEqual(Object.keys(parseMeshes(d.versions.at(-1)!.values![MESHES_KEY])).sort(), ['first', 'second']);
});

test('with no reply running a click switches, or asks first when the settings are not saved', () => {
  assert.equal(restoreChoice({ to: 0, current: 2, unsavedSettings: false, locked: false, replying: false }), 'switch');
  assert.equal(restoreChoice({ to: 0, current: 2, unsavedSettings: true, locked: false, replying: false }), 'ask');
  assert.equal(restoreChoice({ to: 0, current: 2, unsavedSettings: true, locked: true, replying: false }), 'switch');
  const d = withVersion({ ...design(), values: { width: 31, $editHistory: '[]' } }, 0);
  assert.equal(d.code, 'v1');
  assert.equal(d.currentVersion, 0);
  assert.deepEqual(d.values, { width: 10, $editHistory: '[]' });
});

test('App.tsx restore refuses through restoreChoice, not a second hand-written replying guard', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const restore = app.slice(app.indexOf('const restore = (vi: number)'), app.indexOf('const [pendingRestore'));
  assert.doesNotMatch(restore, /if \(replying\)/);
  assert.match(restore, /restoreChoice\(/);
});
