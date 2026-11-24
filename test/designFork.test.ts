import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forkedDesign } from '../shared/designFork';
import type { Design } from '../shared/types';

const version = (code: string, summary: string) => ({ code, summary, createdAt: 1, source: 'ai' as const, values: { a: 1 } });

const parent: Design = {
  id: 'parent-id-1234', name: 'Door sign', createdAt: 1, updatedAt: 2, sessionId: 's1',
  messages: [{ id: 'm1', role: 'user', text: 'make a sign' }] as Design['messages'],
  versions: [version('v1 code', 'First'), version('v2 code', 'Second')],
  currentVersion: 1, code: 'v2 code', values: { a: 1 },
};
const fresh: Design = { id: 'clone-id-5678', name: '', createdAt: 10, updatedAt: 10, messages: [], versions: [], currentVersion: 0, code: '', values: {} };

test('a clone records the design and version it came from', () => {
  const d = forkedDesign(parent, 0, fresh, { a: 2 });
  assert.deepEqual(d.forkedFrom, { id: 'parent-id-1234', version: 0 });
});

test('a clone starts a fresh chat from that version', () => {
  const d = forkedDesign(parent, 0, fresh, { a: 2 });
  assert.equal(d.id, 'clone-id-5678');
  assert.equal(d.name, 'Door sign (from v1)');
  assert.equal(d.code, 'v1 code');
  assert.deepEqual(d.values, { a: 2 });
  assert.deepEqual(d.messages, []);
  assert.equal(d.sessionId, undefined);
  assert.equal(d.currentVersion, 0);
  assert.equal(d.versions.length, 1);
  assert.equal(d.versions[0].summary, 'From "Door sign" v1: First');
  assert.deepEqual(d.versions[0].values, { a: 2 });
  assert.equal(d.versions[0].createdAt, 10);
});
