import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SvgDrawing } from '../shared/svgFeatures';
import type { ArtworkStroke } from '../shared/artworkEdits';
import type { Box3 } from '../shared/types';
import { colourNames, colourOps, mmPerUnit, registerDrawing, topGroups } from '../src/components/artwork/artworkCanvas';

const BLACK = '#111111', GOLD = '#e0a868';
const sq = (h: number): [number, number][] => [[-h, -h], [h, -h], [h, h], [-h, h]];
const d: SvgDrawing = {
  name: 't.svg', aspect: 1,
  shapes: [{ rule: 'NonZero', contours: [sq(0.5)], color: BLACK }, { rule: 'NonZero', contours: [sq(0.25)], color: GOLD }],
};

test('colourNames: each drawing colour after the part nearest in colour, else its hex', () => {
  const parts = [{ name: 'White', color: '#f4f4f4' }, { name: 'Black', color: '#111111' }, { name: 'Red', color: '#d01c1f' }, { name: 'Gold', color: '#e0a868' }];
  // (Traced colours a little off the parts' own.)
  assert.deepEqual(colourNames(['#ffffff', '#141414', '#c8202a', '#e2a96a', '#00ff00'], parts), {
    '#ffffff': 'White', '#141414': 'Black', '#c8202a': 'Red', '#e2a96a': 'Gold', '#00ff00': '#00ff00',
  });
});

test('mmPerUnit: the model height over the default colours height', () => {
  const tall: SvgDrawing = {
    name: 'p', aspect: 1,
    shapes: [
      { rule: 'NonZero', contours: [sq(0.5)], color: '#ffffff' },
      { rule: 'NonZero', contours: [[[-0.3, -0.4], [0.3, -0.4], [0.3, 0.4], [-0.3, 0.4]]], color: BLACK },
    ],
  };
  assert.equal(mmPerUnit(tall, { min: [0, 0, 0], max: [100, 160, 3] }), 200);
  assert.equal(mmPerUnit(tall, null), null);
});

test('colourOps: paint gold then erase gold', () => {
  const paint: ArtworkStroke = { mode: 'paint', color: GOLD, width: 0.1, points: [[0.4, 0]] };
  const erase: ArtworkStroke = { mode: 'erase', color: GOLD, width: 0.1, points: [[0, 0]] };
  assert.deepEqual(colourOps(d, [paint, erase], GOLD), [{ op: 'fill', shape: 1 }, { op: 'fill', shape: paint }, { op: 'cut', shape: erase }]);
  assert.deepEqual(colourOps(d, [paint, erase], BLACK), [{ op: 'fill', shape: 0 }, { op: 'cut', shape: 1 }, { op: 'cut', shape: paint }]);
  // A stroke in a colour the drawing doesn't have is left out (as the build does).
  assert.deepEqual(colourOps(d, [{ ...paint, color: '#00ff00' }], BLACK), [{ op: 'fill', shape: 0 }, { op: 'cut', shape: 1 }]);
});

const bb = (x0: number, y0: number, x1: number, y1: number): Box3 => ({ min: [x0, y0, 0], max: [x1, y1, 3] });

test('registerDrawing: the parts whose size matches their colour place the drawing; a frame or plate does not count', () => {
  // Gold's part is a frame 160 x 120 mm around a 0.5 x 0.5 colour: 320 and 240 mm per unit disagree.
  const parts = [{ name: 'Black', color: BLACK, bbox: bb(-50, -50, 50, 50) }, { name: 'Gold', color: GOLD, bbox: bb(-80, -60, 80, 60) }];
  assert.deepEqual(registerDrawing(d, parts), { k: 100, tx: 0, ty: 0 });
});

test('registerDrawing: offset parts give the offset', () => {
  assert.deepEqual(registerDrawing(d, [{ name: 'Black', color: BLACK, bbox: bb(10, -20, 110, 80) }]), { k: 100, tx: 60, ty: 30 });
});

test('registerDrawing: null when no part matches a colour, or the matching ones disagree', () => {
  assert.equal(registerDrawing(d, [{ name: 'Green', color: '#00ff00', bbox: bb(-50, -50, 50, 50) }]), null);
  assert.equal(registerDrawing(d, []), null);
  // Both consistent on their own (square), but 100 vs 200 mm per unit.
  assert.equal(registerDrawing(d, [{ name: 'Black', color: BLACK, bbox: bb(-50, -50, 50, 50) }, { name: 'Gold', color: GOLD, bbox: bb(-50, -50, 50, 50) }]), null);
  // The same size, but placed apart.
  assert.equal(registerDrawing(d, [{ name: 'Black', color: BLACK, bbox: bb(-50, -50, 50, 50) }, { name: 'Gold', color: GOLD, bbox: bb(0, -25, 50, 25) }]), null);
  // Only a frame: nothing consistent.
  assert.equal(registerDrawing(d, [{ name: 'Gold', color: GOLD, bbox: bb(-80, -60, 80, 60) }]), null);
});

test('registerDrawing: two consistent colours within 2% agree, on their median', () => {
  const r = registerDrawing(d, [{ name: 'Black', color: BLACK, bbox: bb(-50, -50, 50, 50) }, { name: 'Gold', color: GOLD, bbox: bb(-25.25, -25.25, 25.25, 25.25) }]);
  assert.ok(r);
  assert.ok(Math.abs(r.k - 100.5) < 1e-9 && Math.abs(r.tx) < 1e-9 && Math.abs(r.ty) < 1e-9, JSON.stringify(r));
});

test('registerDrawing: a colour painted wider (inside the picture box) is measured with its paint', () => {
  // Gold painted out to the right edge of the box: gold spans x [-0.25, 0.5], y [-0.25, 0.25].
  const painted: SvgDrawing = { ...d, shapes: [...d.shapes, { rule: 'NonZero', contours: [[[0.2, -0.05], [0.9, -0.05], [0.9, 0.05], [0.2, 0.05]]], color: GOLD, edit: 'paint' }] };
  const parts = [{ name: 'Gold', color: GOLD, bbox: bb(-25, -25, 50, 25) }];
  const r = registerDrawing(painted, parts);
  assert.ok(r && Math.abs(r.k - 100) < 1e-9 && Math.abs(r.tx) < 1e-9 && Math.abs(r.ty) < 1e-9, JSON.stringify(r));
  // Without the paint, gold (0.5 wide) doesn't fit that part (75 mm).
  assert.equal(registerDrawing(d, parts), null);
});

test('topGroups: up-facing triangles by part and height (0.05 mm), lowest first', () => {
  // Part 0: a square at z 0 (two counter-clockwise triangles) and one facing down (clockwise).
  const plate = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 2, 1]) };
  // Part 1: a triangle at z 2.01 and one at z 1.
  const raised = { positions: new Float32Array([0, 0, 2.01, 1, 0, 2.01, 1, 1, 2.01, 0, 0, 1, 1, 0, 1, 1, 1, 1]), indices: new Uint32Array([0, 1, 2, 3, 4, 5]) };
  assert.deepEqual(topGroups([plate, raised]), [{ part: 0, z: 0, tris: [0, 1] }, { part: 1, z: 1, tris: [1] }, { part: 1, z: 2, tris: [0] }]);
});
