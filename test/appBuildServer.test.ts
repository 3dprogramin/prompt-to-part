import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// server/config.ts reads the environment when it loads: set it first.
process.env.PTP_COMMIT = 'abc1234';
const { APP_BUILD } = await import('../server/config');

test('the server build: package.json version, commit from PTP_COMMIT', () => {
  assert.equal(APP_BUILD.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
  assert.equal(APP_BUILD.commit, 'abc1234');
});
