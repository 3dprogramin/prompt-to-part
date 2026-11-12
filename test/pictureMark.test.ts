import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rasterize } from '../shared/lineart/raster';
import { boxMark, markBounds, markContours, markMask, parsePictureMarks } from '../shared/pictureEdit/mark';

const grid = { w: 100, h: 100, px: 0.01, x0: -0.5, y1: 0.5 };
const count = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);

test('a round stroke covers about its disc', () => {
  const n = count(markMask({ strokes: [{ width: 0.2, points: [[0, 0]] }] }, grid));
  const want = Math.PI * 0.1 ** 2 / 0.01 ** 2;
  assert.ok(Math.abs(n - want) / want < 0.05, `${n} vs ${want}`);
});

test('a square stroke covers its square, and overlapping pieces do not cancel', () => {
  const n = count(markMask({ strokes: [{ width: 0.2, shape: 'square', points: [[0, 0]] }] }, grid));
  assert.ok(Math.abs(n - 400) <= 40, String(n));
  const long = count(markMask({ strokes: [{ width: 0.2, points: [[-0.2, 0], [0, 0], [0.2, 0]] }] }, grid));
  assert.ok(long > 0.9 * (0.4 * 0.2 + Math.PI * 0.01) / 0.0001, String(long));
});

test('markBounds of a stroke and of nothing', () => {
  const b = markBounds({ strokes: [{ width: 0.1, points: [[0, 0], [0.2, 0]] }] })!;
  assert.deepEqual(b.min.map((v) => +v.toFixed(9)), [-0.05, -0.05]);
  assert.deepEqual(b.max.map((v) => +v.toFixed(9)), [0.25, 0.05]);
  assert.equal(markBounds({ strokes: [] }), null);
});

test('markContours gives contours for every stroke', () => {
  assert.ok(markContours({ strokes: [{ width: 0.1, points: [[0, 0], [0.2, 0]] }] }).length >= 3);
});

test('boxMark is the box as a stadium', () => {
  const m = boxMark([0.25, 0.25, 0.75, 0.75], 1);
  assert.equal(m.strokes.length, 1);
  const b = markBounds(m)!;
  [-0.25, -0.25, 0.25, 0.25].forEach((v, i) => assert.ok(Math.abs([...b.min, ...b.max][i] - v) < 1e-9));
  const w = markBounds(boxMark([0, 0.4, 1, 0.6], 2))!;
  assert.ok(Math.abs(w.min[0] + 1) < 1e-9 && Math.abs(w.max[0] - 1) < 1e-9);
  assert.ok(Math.abs(w.max[1] - 0.1) < 1e-9 && Math.abs(w.min[1] + 0.1) < 1e-9);
  const tall = markBounds(boxMark([0.4, 0, 0.6, 1], 1))!;
  assert.ok(Math.abs(tall.max[1] - 0.5) < 1e-9 && Math.abs(tall.min[0] + 0.1) < 1e-9);
});

test('parsePictureMarks drops what is malformed', () => {
  assert.deepEqual(parsePictureMarks(undefined), {});
  assert.deepEqual(parsePictureMarks('nope'), {});
  assert.deepEqual(parsePictureMarks('{"a":{"fp":"x","mark":{"strokes":[{"width":-1,"points":[]}]}}}'), {});
  const ok = parsePictureMarks({ a: { fp: 'x', mark: { strokes: [{ width: -1, points: [[0, 0]] }, { width: 0.1, shape: 'square', points: [[0, 0], ['a', 1], [1, null], [0.1, 0.2]] }] } } });
  assert.deepEqual(ok.a.mark.strokes, [{ width: 0.1, shape: 'square', points: [[0, 0], [0.1, 0.2]] }]);
  const many = parsePictureMarks({ a: { fp: 'x', mark: { strokes: Array.from({ length: 500 }, () => ({ width: 0.1, points: Array.from({ length: 2500 }, () => [0, 0]) })) } } });
  assert.equal(many.a.mark.strokes.length, 400);
  assert.equal(many.a.mark.strokes[0].points.length, 2000);
});

test('markContours are all counter-clockwise (positive area)', () => {
  const area = (c: [number, number][]) => c.reduce((a, p, i) => { const q = c[(i + 1) % c.length]; return a + (p[0] * q[1] - q[0] * p[1]) / 2; }, 0);
  for (const shape of [undefined, 'square' as const]) {
    const cs = markContours({ strokes: [{ width: 0.1, shape, points: [[0, 0], [0.2, 0.1], [0.1, -0.2]] }] });
    assert.ok(cs.length >= 2);
    for (const c of cs) assert.ok(area(c) > 0);
  }
});

test('markMask matches filling each piece with rasterize, pixel for pixel', () => {
  const m = { strokes: [
    { width: 0.13, points: [[-0.3, 0.1], [0, 0.25], [0.3, -0.1]] as [number, number][] },
    { width: 0.1, shape: 'square' as const, points: [[-0.2, -0.3], [0.25, -0.25]] as [number, number][] },
  ] };
  const ref = new Uint8Array(grid.w * grid.h);
  for (const c of markContours(m)) rasterize([c], grid, ref);
  assert.deepEqual(markMask(m, grid), ref);
});

test('a heavy mark rasterises fast', () => {
  const strokes = Array.from({ length: 20 }, (_, s) => ({ width: 0.03, points: Array.from({ length: 1000 }, (_, i): [number, number] => [Math.sin(i / 30 + s) * 0.4, Math.cos(i / 17 + s) * 0.4]) }));
  const t = Date.now();
  const n = count(markMask({ strokes }, { w: 1024, h: 1024, px: 1 / 1024, x0: -0.5, y1: 0.5 }));
  const ms = Date.now() - t;
  console.log(`heavy mark: ${ms} ms`);
  assert.ok(n > 0);
  assert.ok(ms < 1000, `${ms} ms`);
});

test('a box that is empty after clamping gives no strokes', () => {
  assert.deepEqual(boxMark([0.5, 0.2, 0.5, 0.8], 1), { strokes: [] });
  assert.deepEqual(boxMark([0.2, 0.9, 0.8, 0.3], 1), { strokes: [] });
  assert.deepEqual(boxMark([1.2, 0.2, 1.5, 0.8], 1), { strokes: [] });
  const b = markBounds(boxMark([-0.5, 0, 1.5, 1], 1))!;
  assert.ok(Math.abs(b.min[0] + 0.5) < 1e-9 && Math.abs(b.max[0] - 0.5) < 1e-9);
});
