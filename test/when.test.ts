import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenShort } from '../src/lib/when';

test('whenShort: minutes, today, yesterday, then just the date', () => {
  const now = new Date(2026, 9, 31, 18, 0).getTime();
  assert.equal(whenShort(now - 20_000, now), 'just now');
  assert.equal(whenShort(now - 12 * 60_000, now), '12 min ago');
  assert.match(whenShort(new Date(2026, 9, 31, 9, 5), now), /^today \S/);
  assert.match(whenShort(new Date(2026, 9, 30, 23, 47), now), /^yesterday \S/);
  const older = whenShort(new Date(2026, 9, 27, 13, 2), now);
  assert.match(older, /27/);
  assert.doesNotMatch(older, /2026|13|1:02/);
  assert.match(whenShort(new Date(2025, 2, 3), now), /2025/);
});
