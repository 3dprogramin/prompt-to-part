import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decode } from 'fast-png';
import { isFlat, renderIso, renderSheet, renderThumb } from '../server/render';
import type { PartMesh } from '../shared/types';

/** An axis-aligned box as a part. */
function box(name: string, lo: [number, number, number], hi: [number, number, number], color: string): PartMesh {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const vol = (x1 - x0) * (y1 - y0) * (z1 - z0);
  return { name, color, positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()), bbox: { min: lo, max: hi }, volume: vol, surfaceArea: 0, triCount: 12, genus: 0, components: 1 };
}
type Img = ReturnType<typeof decode>;
const rgbAt = (img: Img, i: number) => { const c = img.data.length / (img.width * img.height); return [img.data[i * c], img.data[i * c + 1], img.data[i * c + 2]]; };
const isRed = (p: number[]) => p[0] > 150 && p[1] < 80 && p[2] < 80;
const isWhite = (p: number[]) => p[0] > 150 && p[1] > 150 && p[2] > 150;
const redPixels = (img: Img) => { let n = 0; for (let i = 0; i < img.width * img.height; i++) if (isRed(rgbAt(img, i))) n++; return n; };
function bounds(img: Img, test: (p: number[]) => boolean) {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!test(rgbAt(img, y * img.width + x))) continue;
    b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x); b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
  }
  return b;
}
const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');
const BEFORE_ISO = 'fecad0db9b019e1ad8264685c22bebb90417115b', BEFORE_SHEET = 'bc0e642dbc16871deba35476c77d5d6cbf9a0caa';

test('isFlat: thinnest side at most 15 % of the longest', () => {
  assert.equal(isFlat({ min: [0, 0, 0], max: [100, 80, 3] }), true);
  assert.equal(isFlat({ min: [0, 0, 0], max: [100, 3, 80] }), true);
  assert.equal(isFlat({ min: [0, 0, 0], max: [100, 100, 15] }), true);
  assert.equal(isFlat({ min: [0, 0, 0], max: [100, 100, 16] }), false);
  assert.equal(isFlat({ min: [0, 0, 0], max: [20, 20, 20] }), false);
});

test('renderThumb: square, dark backdrop, the model in view, its size reported', () => {
  const r = renderThumb([box('A', [0, 0, 0], [40, 30, 20], '#ff0000')], 200);
  const img = decode(r.png);
  assert.deepEqual([img.width, img.height], [200, 200]);
  assert.deepEqual([...img.data.slice(0, 3)], [0x1b, 0x1d, 0x22]);
  assert.ok(redPixels(img) > 200 * 200 * 0.15);
  assert.deepEqual(r.size, [40, 30, 20]);
});

test('renderThumb: a flat piece is seen nearly straight on, upright', () => {
  const img = decode(renderThumb([box('Plate', [0, 0, 0], [100, 60, 2], '#ffffff'), box('Mark', [90, 50, 2], [100, 60, 3], '#ff0000')], 300).png);
  const white = bounds(img, isWhite), red = bounds(img, isRed);
  assert.ok((white.maxX - white.minX) / (white.maxY - white.minY) > 1.5);
  assert.ok(red.minX > 150 && red.maxY < 150);
});

test('renderThumb: flat in Y and in X stand upright with +Z up', () => {
  // thin in Y: marker in the +X +Z corner; thin in X: marker in the +Y +Z corner
  const front = decode(renderThumb([box('P', [0, 0, 0], [100, 2, 60], '#ffffff'), box('M', [90, 0, 50], [100, 3, 60], '#ff0000')], 300).png);
  const fr = bounds(front, isRed), fw = bounds(front, isWhite);
  assert.ok(fr.minX > 150 && fr.maxY < 150);
  assert.ok((fw.maxX - fw.minX) / (fw.maxY - fw.minY) > 1.2);
  const side = decode(renderThumb([box('P', [0, 0, 0], [2, 100, 60], '#ffffff'), box('M', [0, 90, 50], [3, 100, 60], '#ff0000')], 300).png);
  const sr = bounds(side, isRed);
  assert.ok(sr.maxY < 150, 'Z is up');
  assert.ok(sr.minX > 150, '+Y is right when looking along -X');
});

test('the other renders are unchanged', () => {
  const parts = [box('A', [0, 0, 0], [40, 30, 20], '#ff0000')];
  assert.equal(sha1(renderIso(parts).png), BEFORE_ISO);
  assert.equal(sha1(renderSheet(parts).png), BEFORE_SHEET);
});
