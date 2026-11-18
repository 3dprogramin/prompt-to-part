import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TRIES, RETRY_MS, nextTry } from '../src/components/designThumbRetry';

test('the menu asks again for a picture not drawn yet every 3 s, 20 asks at most', () => {
  assert.equal(RETRY_MS, 3000);
  assert.equal(MAX_TRIES, 20);
  for (let tries = 1; tries < 20; tries++) assert.equal(nextTry(tries, 'pending'), 3000);
  assert.equal(nextTry(20, 'pending'), null);
  assert.equal(nextTry(21, 'pending'), null);
});

test('no picture for good stops at once', () => {
  assert.equal(nextTry(1, null), null);
});

test('a picture that is there but did not load waits 3 s too, never 0; so does an unreachable server', () => {
  for (let tries = 1; tries < 20; tries++) {
    assert.equal(nextTry(tries, { size: [10, 20, 30] }), 3000);
    assert.equal(nextTry(tries, 'error'), 3000);
  }
  assert.equal(nextTry(20, { size: [10, 20, 30] }), null);
  assert.equal(nextTry(20, 'error'), null);
});
