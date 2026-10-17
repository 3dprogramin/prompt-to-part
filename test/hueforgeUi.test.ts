import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearColors, usableColors } from '../src/geometry/vertexColors';

test('vertex colours: sRGB to linear, one triple per vertex', () => {
  const lin = linearColors([0, 0.5, 1, 2]);
  assert.equal(lin[0], 0);
  assert.ok(Math.abs(lin[1] - 0.214) < 0.001);
  assert.equal(lin[2], 1);
  assert.equal(lin[3], 1); // clamped
  const pos = new Float32Array(6);
  assert.equal(usableColors(new Float32Array(6), pos)?.length, 6);
  assert.equal(usableColors(new Float32Array(3), pos), undefined);
});
