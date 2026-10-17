import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineChanges } from '../shared/lineDiff';

test('line changes: counts like git (common lines, moves, new and empty files)', () => {
  assert.deepEqual(lineChanges('a\nb\nc', 'a\nB\nc'), { added: 1, removed: 1 });
  assert.deepEqual(lineChanges('a\nb\nc', 'a\nb\nx\ny\nc'), { added: 2, removed: 0 });
  assert.deepEqual(lineChanges('a\nb\nc\nd', 'a\nd'), { added: 0, removed: 2 });
  assert.deepEqual(lineChanges('', 'one\ntwo'), { added: 2, removed: 0 });
  assert.deepEqual(lineChanges('x\ny\nz', 'z\nx\ny'), { added: 1, removed: 1 });
  assert.deepEqual(lineChanges('same', 'same'), { added: 0, removed: 0 });
});
