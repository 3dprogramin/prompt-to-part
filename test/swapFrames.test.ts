import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropBox, plaqueBounds, transitions } from '../scripts/swap-frames';
import type { DesignVersion } from '../shared/types';

const version = (pictureEdit?: { parent: number; linesUp: boolean }): DesignVersion => ({
  code: '', values: {}, createdAt: 0, ...(pictureEdit ? { pictureEdit: { picture: 'p', change: 'c', masked: true, cost: null, ...pictureEdit } } : {}),
} as unknown as DesignVersion);

test('a swap that lines up with the original fades, a redraw slides, and the loop back follows the same rule', () => {
  const versions = [version(), version({ parent: 0, linesUp: true }), version({ parent: 0, linesUp: false })];
  assert.deepEqual(transitions(versions, [0, 1, 2]), ['fade', 'slideleft', 'slideleft']);
  assert.deepEqual(transitions(versions, [0, 1]), ['fade', 'fade'], 'first and last line up: the loop back fades too');
  assert.deepEqual(transitions(versions, [0, 2]), ['slideleft', 'slideleft']);
  assert.deepEqual(transitions(versions, [1, 0]), ['fade', 'fade'], 'either direction');
});

test('a version lines up only with its own parent', () => {
  const versions = [version(), version(), version({ parent: 0, linesUp: true })];
  assert.deepEqual(transitions(versions, [1, 2]), ['slideleft', 'slideleft']);
});

test('plaqueBounds finds the non-background pixels, ignoring near-background noise', () => {
  const w = 10, h = 8;
  const blank = () => { const a = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) a.set([0xf4, 0xf6, 0xfa, 255], i * 4); return a; };
  const rgba = blank();
  rgba.set([0xf2, 0xf6, 0xfa, 255], 0);
  for (let y = 2; y <= 4; y++) for (let x = 3; x <= 6; x++) rgba.set([10, 20, 30, 255], (y * w + x) * 4);
  assert.deepEqual(plaqueBounds(rgba, w, h), { x: 3, y: 2, w: 4, h: 3 });
  assert.equal(plaqueBounds(blank(), w, h), null);
});

test('cropBox centres on the plaque and stays inside the frame', () => {
  assert.deepEqual(cropBox({ x: 340, y: 340, w: 400, h: 400 }, 900), { x: 90, y: 90, w: 900, h: 900 });
  assert.deepEqual(cropBox({ x: 0, y: 0, w: 100, h: 100 }, 900), { x: 0, y: 0, w: 900, h: 900 });
  assert.deepEqual(cropBox({ x: 1000, y: 1000, w: 80, h: 80 }, 900), { x: 180, y: 180, w: 900, h: 900 });
});
