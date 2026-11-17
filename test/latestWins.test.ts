import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestWins } from '../src/components/settings/latestWins';

test('three quick changes with a slow first save make two saves, in order, the second with the newest', async () => {
  const calls: number[] = [];
  const reports: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((r) => { release = r; });
  const enqueue = latestWins<number>(
    async (n) => { calls.push(n); if (n === 1) await slow; },
    { onSaved: () => reports.push('saved'), onFailed: (e) => reports.push(`failed ${e.message}`) },
  );
  enqueue(1); enqueue(2); enqueue(3);
  assert.deepEqual(calls, [1]);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, [1, 3]);
  assert.deepEqual(reports, ['saved']);
});

test('a failed save reports only when it is the newest, and a later change still saves', async () => {
  const calls: number[] = [];
  const reports: string[] = [];
  const enqueue = latestWins<number>(
    async (n) => { calls.push(n); if (n === 1) throw new Error('no'); },
    { onSaved: () => reports.push('saved'), onFailed: (e) => reports.push(`failed ${e.message}`) },
  );
  enqueue(1);
  await new Promise((r) => setTimeout(r, 5));
  enqueue(2);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(reports, ['failed no', 'saved']);
});
