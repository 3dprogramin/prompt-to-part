import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SvgDrawing } from '../shared/svgFeatures';
import type { ArtworkStroke } from '../shared/artworkEdits';
import { colourNames, colourOps, mmPerUnit } from '../src/components/artwork/artworkCanvas';

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
