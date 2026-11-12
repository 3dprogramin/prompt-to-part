import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { drawingColors, drawingSection, type SvgDrawing } from '../shared/svgFeatures';
import { drawingFingerprint } from '../shared/lineart/strokes';
import { withArtworkEdits, type ArtworkStroke } from '../shared/artworkEdits';
import { renderDrawing, wholeWindow } from '../shared/pictureEdit/render';

const wasm = await Module();
wasm.setup();
const C = wasm.CrossSection;

const BLACK = '#111111', GOLD = '#e0a868';
const sq = (h: number, cx = 0, cy = 0): [number, number][] => [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
const d: SvgDrawing = {
  name: 't.svg', aspect: 1,
  shapes: [{ rule: 'NonZero', contours: [sq(0.5)], color: BLACK }, { rule: 'NonZero', contours: [sq(0.25)], color: GOLD }],
};
const stroke = (o: Partial<ArtworkStroke>): ArtworkStroke => ({ mode: 'paint', color: GOLD, width: 0.1, points: [[0, 0]], ...o });
type Render = ReturnType<typeof renderDrawing>;
/** The RGB of the pixel at (x, y) picture units over the whole window of an aspect-1 picture. */
const px = (r: Render, x: number, y: number) => {
  const i = Math.floor((x + 0.5) * r.width), j = Math.floor((0.5 - y) * r.height), o = (j * r.width + i) * 4;
  return [...r.data.slice(o, o + 3)];
};
const GOLD_RGB = [0xe0, 0xa8, 0x68], BLACK_RGB = [0x11, 0x11, 0x11], WHITE_RGB = [255, 255, 255];

test('a two-colour drawing renders whole in its own colours', () => {
  const r = renderDrawing(d, [], wholeWindow(d), 100);
  assert.equal(r.width, 100);
  assert.deepEqual(px(r, 0, 0), GOLD_RGB);
  assert.deepEqual(px(r, 0.4, 0.4), BLACK_RGB);
  assert.equal(r.labels[50 * 100 + 50], 1);
  assert.equal(r.labels[2 * 100 + 2], 0);
});

test('a window of the gold square at 200 px is all gold, and a window past the drawing is background', () => {
  const r = renderDrawing(d, [], { x0: -0.2, y1: 0.2, w: 0.4, h: 0.4 }, 200);
  assert.equal(r.width, 200);
  assert.ok(r.labels.every((l) => l === 1));
  const out = renderDrawing(d, [], { x0: 1, y1: 0.2, w: 0.4, h: 0.4 }, 20);
  assert.ok(out.labels.every((l) => l === -1));
  assert.deepEqual([...out.data.slice(0, 4)], [255, 255, 255, 255]);
});

test('a paint stroke takes over, erase clears only its own colour, a cut exempts', () => {
  const black = stroke({ color: BLACK, points: [[0, 0]], width: 0.2 });
  assert.deepEqual(px(renderDrawing(d, [black], wholeWindow(d), 100), 0, 0), BLACK_RGB);
  const erase = renderDrawing(d, [stroke({ mode: 'erase', width: 0.2 })], wholeWindow(d), 100);
  assert.deepEqual(px(erase, 0, 0), WHITE_RGB);
  assert.deepEqual(px(erase, 0.4, 0.4), BLACK_RGB);
  // Erasing black over the gold changes nothing there.
  assert.deepEqual(px(renderDrawing(d, [stroke({ mode: 'erase', color: BLACK, width: 0.2 })], wholeWindow(d), 100), 0, 0), GOLD_RGB);
  // Black on gold, then gold erased: the black is not gold, so it stays.
  assert.deepEqual(px(renderDrawing(d, [black, stroke({ mode: 'erase', width: 0.2 })], wholeWindow(d), 100), 0, 0), BLACK_RGB);
  // The cut covers the right half of the stroke (an outer and a hole inside it, as a NonZero cut has them).
  const hole: [number, number][] = [[0.3, 0.3], [0.3, 0.4], [0.4, 0.4], [0.4, 0.3]].reverse() as [number, number][];
  const cut = renderDrawing(d, [stroke({ color: BLACK, width: 0.2, cut: [[[0, -1], [1, -1], [1, 1], [0, 1]], hole] })], wholeWindow(d), 100);
  assert.deepEqual(px(cut, -0.05, 0), BLACK_RGB);
  assert.deepEqual(px(cut, 0.05, 0), GOLD_RGB);
});

test('paint stays inside the box of the default colours', () => {
  const inset: SvgDrawing = { ...d, shapes: [{ rule: 'NonZero', contours: [sq(0.5)], color: '#ffffff' }, { rule: 'NonZero', contours: [sq(0.2)], color: BLACK }] };
  const r = renderDrawing(inset, [stroke({ color: BLACK, width: 0.4, points: [[0.2, 0]] })], wholeWindow(inset), 100);
  assert.deepEqual(px(r, 0.1, 0), BLACK_RGB);
  assert.deepEqual(px(r, 0.35, 0), WHITE_RGB);
});

test('colour shares of labels agree with drawingSection areas within 1 %', () => {
  const ring: SvgDrawing = { name: 'r.svg', aspect: 1.5, shapes: [
    { rule: 'EvenOdd', contours: [sq(0.45, -0.1), sq(0.3, -0.1)], color: BLACK },
    { rule: 'NonZero', contours: [sq(0.3, 0.2, 0.05), sq(0.15, 0.2, 0.05).reverse()], color: GOLD },
    { rule: 'NonZero', contours: [[[-0.5, -0.4], [0.6, -0.1], [0.1, 0.4]]], color: '#2266cc' },
  ] };
  for (const [name, base] of [['two squares', d], ['ring', ring]] as const) {
    const strokes = [
      stroke({ color: BLACK, width: 0.25, points: [[-0.2, -0.1], [0.1, 0.1]] }),
      stroke({ mode: 'erase', color: GOLD, width: 0.2, points: [[0, 0], [0.2, 0.1]] }),
      stroke({ color: GOLD, width: 0.15, shape: 'square', points: [[-0.1, 0.2], [0.05, 0.3]], cut: [[[-0.1, 0.1], [0, 0.1], [0, 0.4], [-0.1, 0.4]]] }),
      stroke({ mode: 'erase', color: BLACK, width: 0.3, points: [[-0.3, 0]] }),
    ];
    const e = withArtworkEdits({ t: base }, { t: { fp: drawingFingerprint(base), strokes } }).t;
    assert.ok(e.shapes.length > base.shapes.length);
    const r = renderDrawing(base, strokes, { x0: -base.aspect / 2, y1: 0.5, w: base.aspect, h: 1 }, 400);
    drawingColors(base).forEach((col, i) => {
      const share = r.labels.reduce((n, l) => n + (l === i ? 1 : 0), 0) / (r.width * r.height);
      const cs = drawingSection(e, 1, [col], C);
      const want = (cs ? cs.area() : 0) / base.aspect;
      assert.ok(Math.abs(share - want) <= 0.01, `${name} ${col}: ${share} vs ${want}`);
    });
  }
});
