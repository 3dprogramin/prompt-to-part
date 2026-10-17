import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHfImages, parseHueforgeSetup } from '../src/lib/hfImage';
import { linearColors, usableColors } from '../src/geometry/vertexColors';

test('HueForge setup: bad filaments and swaps are left out', () => {
  assert.deepEqual(parseHueforgeSetup(undefined), {});
  assert.deepEqual(parseHueforgeSetup('not json'), {});
  const black = { name: 'PLA Basic Black', color: '#161616', td: 0.6 };
  assert.deepEqual(parseHueforgeSetup(JSON.stringify({ filaments: [black, { name: 'x', color: 'red', td: 1 }], swaps: [4] })), { filaments: [black], swaps: [4] });
  assert.deepEqual(parseHueforgeSetup(JSON.stringify({ swaps: [1.5] })), {});
});

test('HueForge pictures: only complete ones', () => {
  const ok = { name: 'a', width: 2, height: 1, luma: 'AAA=' };
  assert.deepEqual(parseHfImages(JSON.stringify({ a: ok, b: { name: 'b' } })), { a: ok });
  assert.deepEqual(parseHfImages('[]'), {});
});

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
