// The shop photo set is for the design it was started on: a design switch while it renders stops it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeShots } from '../src/components/photos/shotSet';

const nap = () => Promise.resolve();

test('every item is shot while the design stays', async () => {
  const r = await takeShots('a', () => 'a', [1, 2, 3], nap, (n) => `s${n}`);
  assert.deepEqual(r, { switched: false, shots: ['s1', 's2', 's3'] });
});

test('a switch between two renders stops the set: the new design is never photographed', async () => {
  let now = 'a';
  const shot: number[] = [];
  const r = await takeShots('a', () => now, [1, 2, 3], nap, (n) => { shot.push(n); if (n === 1) now = 'b'; return `s${n}`; });
  assert.deepEqual(r, { switched: true });
  assert.deepEqual(shot, [1]);
});

test('a switch before the first render (while the scene is looked up) shoots nothing', async () => {
  const shot: number[] = [];
  const r = await takeShots('a', () => 'b', [1, 2], nap, (n) => { shot.push(n); return n; });
  assert.deepEqual(r, { switched: true });
  assert.deepEqual(shot, []);
});

test('a render that gives nothing ends the set as failed', async () => {
  assert.deepEqual(await takeShots('a', () => 'a', [1, 2], nap, () => null), { switched: false, failed: true });
});
