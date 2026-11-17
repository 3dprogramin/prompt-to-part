import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezer } from '../src/lib/frozen';

test('freezer: nothing until ready, then the value of the first ready call stays', () => {
  const f = freezer<string[]>();
  assert.equal(f(['a'], false), undefined);
  assert.equal(f(['b'], false), undefined);
  const first = ['c'];
  assert.equal(f(first, true), first);
  assert.equal(f(['d'], true), first);
  assert.equal(f(['e'], false), first);
});
test('freezer: each freezer is its own', () => {
  const a = freezer<number>(), b = freezer<number>();
  a(1, true);
  assert.equal(b(2, true), 2);
  assert.equal(a(3, true), 1);
});
