// The First filament slider: a setup base height thickens the first filament and raises
// everything above it (swaps, relief, top) by the same number of layers.
import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import {
  LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, parseLayerToneSetup, shiftSwaps, simulateImage, stripSwaps, toLayerToneImage, toStripImage,
  type LayerToneFilament, type LayerToneSetup, type LayerToneStack,
} from '../shared/layertone';

const DON: LayerToneFilament[] = [
  { name: 'PLA Basic Black', brand: 'Bambu Lab', color: '#000000', td: 0.2 },
  { name: 'PLA+ Dark Brown', brand: 'eSUN', color: '#55351c', td: 1.8 },
  { name: 'PLA Basic Gray', brand: 'Bambu Lab', color: '#8e9089', td: 0.4 },
  { name: 'PLA Basic Jade White', brand: 'Bambu Lab', color: '#ffffff', td: 5.9 },
];

/** A 60 × 30 gradient, black on the left to white on the right. */
function gradientRgba(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round((x / (w - 1)) * 255);
    rgba.set([v, v, v, 255], (y * w + x) * 4);
  }
  return rgba;
}
const gradient = toLayerToneImage('g', 60, 30, gradientRgba(60, 30));

const DON_SCRIPT = `
const FILAMENTS = ${JSON.stringify(DON)};
function build() { return { name: 'Picture', ...H.layertone('g', { width: 40, maxHeight: 2.8, filaments: FILAMENTS, swaps: [5, 7, 11] }) }; }`;

const run = (setup?: LayerToneSetup, script = DON_SCRIPT, images: Record<string, unknown> = { g: gradient }) =>
  evaluateScript(script, { [LAYERTONE_IMAGES_KEY]: JSON.stringify(images), ...(setup ? { [LAYERTONE_KEY]: JSON.stringify(setup) } : {}) }, 'draft');
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

test('parse keeps a usable baseHeight', () => {
  assert.equal(parseLayerToneSetup('{"baseHeight":1.2}').baseHeight, 1.2);
  assert.equal(parseLayerToneSetup('{"baseHeight":-1}').baseHeight, undefined);
  assert.equal(parseLayerToneSetup('{"baseHeight":"x"}').baseHeight, undefined);
});

test('shiftSwaps moves every swap and keeps them ascending, the first at layer 1 or above', () => {
  assert.deepEqual(shiftSwaps([5, 7, 11], 4), [9, 11, 15]);
  assert.deepEqual(shiftSwaps([5, 7, 11], -4), [1, 3, 7]);
  assert.deepEqual(shiftSwaps([2, 3, 4], -3), [1, 2, 3]);
});

test('no setup base: built as before', () => {
  const a = run().parts[0], b = run({}).parts[0];
  assert.deepEqual(a.layerColors!.map((l) => l.layer), [0, 5, 7, 11]);
  assert.deepEqual(b.layerColors, a.layerColors);
  assert.ok(near(a.bbox.max[2], 2.8));
});

test('a raised base raises everything above it and keeps the look', () => {
  const before = run().parts[0], after = run({ baseHeight: 1.2 }).parts[0];
  assert.ok(near(after.bbox.max[2], 2.8 + 0.72), `top ${after.bbox.max[2]}`);
  assert.deepEqual(after.layerColors!.map((l) => l.layer), [0, 14, 16, 20]);
  assert.deepEqual(after.layerColors!.map((l) => [l.color, l.td]), before.layerColors!.map((l) => [l.color, l.td]));
  assert.ok(near(after.layerTone!.options.baseHeight, 1.2));
  const look = (p: typeof before) => simulateImage(gradient, p.layerColors!, p.layerTone!.options).rgba;
  assert.deepEqual(look(after), look(before));
});

test('a lowered base lowers everything above it', () => {
  const p = run({ baseHeight: 0.16 }).parts[0];
  assert.deepEqual(p.layerColors!.map((l) => l.layer), [0, 1, 3, 7]);
  assert.ok(near(p.bbox.max[2], 2.8 - 0.32), `top ${p.bbox.max[2]}`);
});

test('setup swaps are the built layers: not shifted again', () => {
  const p = run({ baseHeight: 1.2, swaps: [14, 16, 20] }).parts[0];
  assert.deepEqual(p.layerColors!.map((l) => l.layer), [0, 14, 16, 20]);
});

test('a strip picture prints with its own swaps moved with the base', () => {
  const o = { width: 100, maxHeight: 1.6, baseHeight: 0.48 };
  const stack: LayerToneStack = { filaments: DON, swaps: stripSwaps(DON, o), maxHeight: o.maxHeight, baseHeight: o.baseHeight };
  const strip = toStripImage('s', 60, 30, gradientRgba(60, 30), stack, o);
  const script = `function build() { return { name: 'Picture', ...H.layertone('s', { width: 40, maxHeight: 1.6, filaments: ${JSON.stringify(DON)} }) }; }`;
  const p = run({ baseHeight: 0.8 }, script, { s: strip }).parts[0];
  assert.deepEqual(p.layerColors!.slice(1).map((l) => l.layer), stack.swaps.map((s) => s + 4));
});
