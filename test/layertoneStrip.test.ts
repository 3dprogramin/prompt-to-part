// The strip (the colours a filament stack prints, lowest to highest layer) and pictures stored by
// strip position: drawn for a stack, each pixel prints exactly the strip colour it was painted in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanLayerToneImage, countTable, layerToneLuma, luma, resolveLayerToneOptions, simulateImage, stackLayers, stripColors, stripSwaps, toLayerToneImage, toStripImage,
  type LayerToneFilament, type LayerToneStack,
} from '../shared/layertone';

const BLACK: LayerToneFilament = { name: 'Black', color: '#000000', td: 0.6 };
const WHITE: LayerToneFilament = { name: 'White', color: '#ffffff', td: 1.6 };
const RED: LayerToneFilament = { name: 'Red', color: '#d0201c', td: 2 };
const YELLOW: LayerToneFilament = { name: 'Yellow', color: '#f2c200', td: 2.5 };
const BLUE: LayerToneFilament = { name: 'Blue', color: '#1a3fbf', td: 1 };
const O = { width: 100, maxHeight: 1.6, baseHeight: 0.48 };
const stackOf = (filaments: LayerToneFilament[]): LayerToneStack => ({ filaments, swaps: stripSwaps(filaments, O), maxHeight: O.maxHeight, baseHeight: O.baseHeight });
const rgbaOf = (colours: number[][]) => Uint8Array.from(colours.flatMap((c) => [c[0], c[1], c[2], 255]));

test('every filament gets a band of its own on the strip', () => {
  const stack = stackOf([BLACK, YELLOW, BLUE, WHITE]);
  const strip = stripColors(stack, O);
  const distinct = new Set(strip.map((c) => c.join()));
  assert.ok(distinct.size >= 10, `${distinct.size} colours`);
  // Some strip colour is clearly yellow (red and green high, blue low) and some clearly blue.
  assert.ok(strip.some((c) => c[0] > 150 && c[1] > 120 && c[2] < 60), 'a yellow band');
  assert.ok(strip.some((c) => c[2] > c[0] + 60 && c[2] > c[1] + 40), 'a blue band');
});

test('strip runs from the bottom filament to the top one', () => {
  const strip = stripColors(stackOf([BLACK, WHITE]), O);
  assert.equal(strip.length, 256);
  assert.ok(luma(strip[0]) < 40, `bottom ${strip[0]}`);
  assert.ok(luma(strip[255]) - luma(strip[0]) > 100, `top ${strip[255]}`);
});

test('a strip picture prints its strip colours exactly', () => {
  const stack = stackOf([BLACK, RED, YELLOW, WHITE]);
  const strip = stripColors(stack, O);
  const img = toStripImage('p', 256, 1, rgbaOf(strip), stack, O);
  assert.equal(img.positions, true);
  assert.deepEqual(img.stack, stack);
  const r = resolveLayerToneOptions(O);
  const sim = simulateImage(img, stackLayers(stack.filaments, stack.swaps, r), O);
  for (let i = 0; i < 256; i++) {
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(sim.rgba[i * 4 + k] - strip[i][k]) <= 1, `pixel ${i}: ${[...sim.rgba.slice(i * 4, i * 4 + 3)]} vs ${strip[i]}`);
  }
});

test('snaps by colour, not brightness', () => {
  // Yellow under a dark blue: the strip gets brighter, darker, then brighter again.
  const stack = stackOf([BLACK, YELLOW, BLUE, WHITE]);
  const strip = stripColors(stack, O);
  // Two strip colours about as bright as each other but clearly different colours.
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let pair: [number, number] | null = null;
  for (let i = 0; i < 256 && !pair; i++) for (let j = i + 1; j < 256; j++) if (Math.abs(luma(strip[i]) - luma(strip[j])) < 8 && dist(strip[i], strip[j]) > 60) { pair = [i, j]; break; }
  assert.ok(pair, 'the stack has two equally bright strip colours');
  const img = toStripImage('p', 2, 1, rgbaOf([strip[pair![0]], strip[pair![1]]]), stack, O);
  const v = layerToneLuma(img);
  assert.notEqual(v[0], v[1]);
  assert.ok(dist(strip[v[0]], strip[pair![0]]) < 3 && dist(strip[v[1]], strip[pair![1]]) < 3, `${[...v]} for ${pair}`);
});

test('luma pictures unchanged', () => {
  // A plain picture still goes through brightness: its print is what it was.
  const grey = Array.from({ length: 64 }, (_, i) => [i * 4, i * 4, i * 4]);
  const img = toLayerToneImage('g', 64, 1, rgbaOf(grey));
  assert.equal(img.positions, undefined);
  const r = resolveLayerToneOptions(O);
  const layers = stackLayers([BLACK, WHITE], [9], r);
  const counts = countTable(img, layers, r, 256);
  // Brighter tones never print lower than darker ones with black under white.
  for (let q = 1; q < 256; q++) assert.ok(counts[q] >= counts[q - 1]);
  assert.equal(counts[0], r.nBase);
});

test('cleanLayerToneImage keeps positions, stack and colour; drops a bad colour URL', () => {
  const stack = stackOf([BLACK, WHITE]);
  const img = { ...toStripImage('p', 4, 1, rgbaOf([[0, 0, 0], [80, 80, 80], [160, 160, 160], [255, 255, 255]]), stack, O), colour: `/api/designs/design-0001/images/${'a'.repeat(32)}.png` };
  const kept = cleanLayerToneImage(JSON.parse(JSON.stringify(img)), 'p')!;
  assert.equal(kept.positions, true);
  assert.deepEqual(kept.stack, stack);
  assert.equal(kept.colour, img.colour);
  const bad = cleanLayerToneImage({ ...img, colour: 'https://evil.example/x.png' }, 'p')!;
  assert.equal(bad.colour, undefined);
  assert.equal(bad.positions, true);
});

test('stripPng: a 512 x 64 picture of the strip, lowest layer at the left', async () => {
  const { stripPng } = await import('../server/layerToneStrip');
  const { decode } = await import('fast-png');
  const stack = stackOf([BLACK, YELLOW, BLUE, WHITE]);
  const strip = stripColors(stack, O);
  const png = stripPng(stack, O);
  assert.equal(png.width, 512);
  assert.equal(png.height, 64);
  const m = /^data:image\/png;base64,(.+)$/.exec(png.dataUrl);
  assert.ok(m);
  const img = decode(Buffer.from(m![1], 'base64'));
  const ch = img.channels ?? 4;
  const px = (x: number, y: number) => [0, 1, 2].map((k) => img.data[(y * img.width + x) * ch + k]);
  assert.deepEqual(px(0, 10), strip[0]);
  assert.deepEqual(px(511, 50), strip[255]);
});

test('picturePrompt: drawn or repainted for the strip, unchanged without one', async () => {
  const { picturePrompt } = await import('../server/artwork');
  const plain = 'A picture to be printed as a LayerTone filament painting: a thin relief where brightness becomes height, printed in a few stacked filaments, so the picture is judged by its light and dark values.\nSubject: a lighthouse at dusk\nLook: realistic, detailed and sharp, like a high-quality photo or a fine painting, with strong lighting and clear contrast.\nRules:\n- a full range of tones from deep shadows to bright highlights, with the subject clearly separated from the background by light\n- a simple, uncluttered background that is clearly lighter or darker than the subject\n- no frame, border, text, signature or watermark';
  assert.equal(picturePrompt({ subject: 'a lighthouse at dusk' }), plain);
  const drawn = picturePrompt({ subject: 'a lighthouse at dusk', strip: { filaments: [BLACK, YELLOW, BLUE, WHITE], repaint: false } });
  assert.match(drawn, /only colours from the strip/);
  assert.match(drawn, /Black[\s\S]*Yellow[\s\S]*Blue[\s\S]*White/);
  assert.doesNotMatch(drawn, /likeness/);
  assert.doesNotMatch(drawn, /[–—]/);
  const repaint = picturePrompt({ subject: 'a family photo', references: ['x'], strip: { filaments: [BLACK, WHITE], repaint: true } });
  assert.match(repaint, /likeness/);
  assert.match(repaint, /only colours from the strip/);
  assert.doesNotMatch(repaint, /[–—]/);
});
