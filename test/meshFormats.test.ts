import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the triangle limit is the stated 5 million, not the doubling buffer\'s 8.4 million', async () => {
  const { Ints, MAX_FILE_TRIANGLES, MeshFormatError } = await import('../shared/meshFormats');
  const t = new Ints();
  for (let i = 0; i < MAX_FILE_TRIANGLES; i++) t.push3(0, 1, 2);
  assert.throws(() => t.push3(0, 1, 2), MeshFormatError);
});
