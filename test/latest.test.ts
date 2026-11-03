import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestOnly } from '../src/lib/latest';

test('latestOnly: a request is current until another begins', () => {
  const opens = latestOnly();
  const a = opens.begin();
  assert.equal(a(), true);
  const b = opens.begin();
  assert.equal(a(), false);
  assert.equal(b(), true);
  // Still false later, however often it is asked.
  assert.equal(a(), false);
});

test('latestOnly: opening A (slow) then B ends on B', async () => {
  const opens = latestOnly();
  let open = 'blank';
  const openDesign = async (id: string, ms: number) => {
    const isLatest = opens.begin();
    await new Promise((r) => setTimeout(r, ms));
    if (isLatest()) open = id;
  };
  await Promise.all([openDesign('A', 30), openDesign('B', 5)]);
  assert.equal(open, 'B');
});

test('latestOnly: separate trackers do not affect each other', () => {
  const one = latestOnly();
  const two = latestOnly();
  const a = one.begin();
  two.begin();
  assert.equal(a(), true);
});
