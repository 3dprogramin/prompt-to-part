import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Design } from '../shared/types';
import { blockedChange } from '../src/lib/printedLock';

const base = (): Design => ({
  id: 'a', name: 'n', createdAt: 0, updatedAt: 0, messages: [],
  versions: [{}, {}] as Design['versions'], currentVersion: 1, code: 'x', values: { width: 10, $hidden: '[]' },
});
const locked = new Set([1]);

test('a slider, code or new version on a locked version is blocked', () => {
  const p = base();
  assert.equal(blockedChange(p, { ...p, values: { ...p.values, width: 11 } }, locked), true);
  assert.equal(blockedChange(p, { ...p, code: 'y' }, locked), true);
  assert.equal(blockedChange(p, { ...p, versions: [...p.versions, {} as Design['versions'][0]] }, locked), true);
});

test('looking, switching and other designs are not blocked', () => {
  const p = base();
  assert.equal(blockedChange(p, { ...p, values: { ...p.values, $hidden: '["a"]' } }, locked), false);
  assert.equal(blockedChange(p, { ...p, values: { ...p.values, $lineartLayout: '{}' } }, locked), false);
  assert.equal(blockedChange(p, { ...p, currentVersion: 0, code: 'z' }, locked), false);
  assert.equal(blockedChange(p, { ...p, id: 'b', code: 'z' }, locked), false);
  const q = { ...p, currentVersion: 0 };
  assert.equal(blockedChange(q, { ...q, values: { ...q.values, width: 12 } }, locked), false);
  assert.equal(blockedChange(p, { ...p, photos: [{} as never] }, locked), false);
});

test("the script's own layout choice is for looking when it is passed as a view key", () => {
  const p = { ...base(), values: { width: 10, layout: 'assembled' } };
  const next = { ...p, values: { ...p.values, layout: 'print' } };
  assert.equal(blockedChange(p, next, locked), true);
  assert.equal(blockedChange(p, next, locked, ['layout']), false);
  assert.equal(blockedChange(p, { ...next, values: { ...next.values, width: 11 } }, locked, ['layout']), true);
});
