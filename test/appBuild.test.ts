import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAppBuild, formatAppBuild } from '../shared/appBuild';
import { cleanPrintedMap } from '../shared/printed';

test('formatAppBuild', () => {
  assert.equal(formatAppBuild({ version: '0.2.0', commit: 'abc1234' }), 'v0.2.0 (abc1234)');
  assert.equal(formatAppBuild({ version: '0.2.0' }), 'v0.2.0');
  assert.equal(formatAppBuild(undefined), '');
});
test('cleanAppBuild keeps only a well-formed build', () => {
  assert.deepEqual(cleanAppBuild({ version: '0.2.0', commit: 'abc1234', extra: 1 }), { version: '0.2.0', commit: 'abc1234' });
  assert.deepEqual(cleanAppBuild({ version: '0.2.0', commit: 'not a hash' }), { version: '0.2.0' });
  for (const bad of ['0.2.0', null, {}, { version: 5 }, { version: '' }]) assert.equal(cleanAppBuild(bad), undefined);
});
test('cleanPrintedMap keeps a mark and drops a malformed app', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const out = cleanPrintedMap({ [id]: [
    { v: 0, at: 1, fp: 'a', file: true, settings: true, app: { version: '0.2.0', commit: 'abc1234' } },
    { v: 1, at: 2, fp: 'b', file: false, settings: false, app: 'broken' },
    { v: 2, at: 3, fp: 'c', file: false, settings: false },
  ] }, () => true);
  assert.deepEqual(out[id][0].app, { version: '0.2.0', commit: 'abc1234' });
  assert.equal('app' in out[id][1], false);
  assert.equal('app' in out[id][2], false);
});

test('the browser build without Vite is "unknown"', async () => {
  const { appBuild } = await import('../src/lib/appBuild');
  assert.deepEqual(appBuild(), { version: 'unknown' });
});
