import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import {
  autoSwaps, DEFAULT_FILAMENTS, fromBase64, HF_IMAGES_KEY, HF_KEY, hexToRgb, hfLuma, luma, MAX_HF_IMAGE_SIDE,
  resolveHfOptions, simulateColor, simulateImage, toBase64, toHfImage, type HfFilament, type LayerColor,
} from '../shared/hueforge';

/** RGBA pixels from a function of (x, y) → grey level. */
function picture(w: number, h: number, grey: (x: number, y: number) => number, alpha = 255): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    rgba[p] = rgba[p + 1] = rgba[p + 2] = grey(x, y);
    rgba[p + 3] = alpha;
  }
  return rgba;
}

const FOUR: HfFilament[] = [
  { name: 'Black', color: '#161616', td: 0.6 }, { name: 'Blue', color: '#0a5fb4', td: 1.2 },
  { name: 'Yellow', color: '#f4d03f', td: 2.2 }, { name: 'White', color: '#ffffff', td: 3 },
];

test('base64 round-trips every length', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 100, 70000]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 255);
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  }
  assert.equal(toBase64(Uint8Array.from([104, 105])), 'aGk=');
  assert.equal(fromBase64('a$b='), null);
});

test('toHfImage: luminance, transparency, and scaling down to the longest side', () => {
  const red = toHfImage('red.png', 2, 1, [255, 0, 0, 255, 0, 0, 0, 0]);
  assert.deepEqual([...hfLuma(red)], [Math.round(0.2126 * 255), 255]); // Rec. 709; transparent = white paper
  // 1600 × 400, left half black, right half white: half the size, the edge stays sharp.
  const big = toHfImage('big.png', 1600, 400, picture(1600, 400, (x) => (x < 800 ? 0 : 255)));
  assert.deepEqual([big.width, big.height], [MAX_HF_IMAGE_SIDE, 200]);
  const l = hfLuma(big);
  assert.equal(l.length, 800 * 200);
  assert.deepEqual([l[0], l[399], l[400], l[799], l[200 * 800 - 1]], [0, 0, 255, 255, 255]);
  // Box filter: a 1-pixel checkerboard halved averages to mid-grey.
  const check = toHfImage('check.png', 1600, 1600, picture(1600, 1600, (x, y) => ((x + y) % 2 ? 255 : 0)));
  assert.equal(check.width, 800);
  assert.ok(hfLuma(check).every((v) => v === 127 || v === 128), 'averaged');
  // Small pictures keep their size.
  const small = toHfImage('s.png', 30, 20, picture(30, 20, () => 100));
  assert.deepEqual([small.width, small.height, hfLuma(small)[0]], [30, 20, 100]);
});

const stack = (filaments: HfFilament[], swaps: number[]): LayerColor[] =>
  filaments.map((f, i) => ({ z: i ? 0.16 + (swaps[i - 1] - 1) * 0.08 : 0, layer: i ? swaps[i - 1] : 0, color: f.color, td: f.td, name: f.name }));

test('simulateColor: the base shows alone, then the light filament takes over steadily', () => {
  const layers = stack(DEFAULT_FILAMENTS, [6]);
  assert.equal(simulateColor(0.3, layers), '#161616');
  assert.equal(simulateColor(layers[1].z, layers), '#161616');
  let prev = -1;
  for (let z = layers[1].z; z < 12; z += 0.08) {
    const l = luma(hexToRgb(simulateColor(z, layers)));
    assert.ok(l >= prev - 1e-9, `brightness never drops (z = ${z.toFixed(2)})`);
    prev = l;
  }
  // One layer already lightens a lot (light mixes in linear light); past the TD it is nearly white.
  assert.ok(luma(hexToRgb(simulateColor(layers[1].z + 0.08, layers))) > 0.2);
  assert.ok(luma(hexToRgb(simulateColor(layers[1].z + 3, layers))) > 0.97);
  // A lower TD (more opaque) covers faster.
  const opaque = stack([DEFAULT_FILAMENTS[0], { ...DEFAULT_FILAMENTS[1], td: 1 }], [6]);
  assert.ok(luma(hexToRgb(simulateColor(1, opaque))) > luma(hexToRgb(simulateColor(1, layers))));
  // Colours: a blue layer over black is blue-ish.
  const [r, , b] = hexToRgb(simulateColor(1.2, stack(FOUR.slice(0, 2), [6])));
  assert.ok(b > r);
});

test('autoSwaps: ascending layers inside the relief, every filament with room to show', () => {
  const img = toHfImage('g.png', 256, 16, picture(256, 16, (x) => x));
  const r = resolveHfOptions({ width: 100 });
  assert.deepEqual(autoSwaps(img, DEFAULT_FILAMENTS, { width: 100 }), [r.nBase]); // white right above the base
  assert.deepEqual(autoSwaps(img, DEFAULT_FILAMENTS.slice(0, 1), { width: 100 }), []);
  const swaps = autoSwaps(img, FOUR, { width: 100 });
  assert.equal(swaps.length, 3);
  swaps.forEach((s, i) => {
    assert.ok(Number.isInteger(s) && s >= r.nBase && s <= r.nMax - 1, `swap ${s} inside ${r.nBase}…${r.nMax - 1}`);
    if (i) assert.ok(s > swaps[i - 1], 'ascending');
  });
  assert.ok(swaps[1] - swaps[0] >= 2, `blue gets more than one layer: ${swaps}`);
  // More filaments than layers in the relief: one layer each.
  const eight = Array.from({ length: 8 }, (_, i) => ({ name: `F${i}`, color: '#' + (i * 32).toString(16).padStart(2, '0').repeat(3), td: 1 }));
  const thin = autoSwaps(img, eight, { width: 100, baseHeight: 0.24, maxHeight: 0.56 });
  assert.deepEqual(thin, [2, 3, 4, 5, 6, 7, 8]);
});

// A gradient from black (left) to white (right) with a white bar along the top.
const gradient = toHfImage('gradient.png', 200, 100, picture(200, 100, (x, y) => (y < 10 ? 255 : Math.round((x / 199) * 255))));
const values = { [HF_IMAGES_KEY]: JSON.stringify({ 'gradient.png': gradient }) };
const SCRIPT = `
const params = { width: { value: 100, min: 40, max: 200 }, border: { value: 0, min: 0, max: 10 } };
function build(p) { return { name: 'Picture', ...H.hueforge('gradient.png', { width: p.width, border: p.border }) }; }`;

test('H.hueforge: a watertight relief of the picture, heights on layer boundaries, with its colours', () => {
  const r = evaluateScript(SCRIPT, values, 'draft');
  const p = r.parts[0];
  assert.equal(p.name, 'Picture');
  assert.deepEqual(r.warnings, []);
  assert.equal(p.components, 1);
  assert.equal(p.genus, 0);
  const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;
  assert.ok(near(p.bbox.min[0], -50) && near(p.bbox.max[0], 50) && near(p.bbox.min[1], -25) && near(p.bbox.max[1], 25), JSON.stringify(p.bbox));
  assert.ok(near(p.bbox.min[2], 0) && near(p.bbox.max[2], 1.6), JSON.stringify(p.bbox));
  // Every height is the bed or the top of a layer: 0.16, 0.24, 0.32…, never below the base.
  const zs = new Set<number>();
  for (let v = 2; v < p.positions.length; v += 3) zs.add(Math.round(p.positions[v] * 1e5) / 1e5);
  for (const z of zs) {
    if (z === 0) continue;
    assert.ok(z >= 0.48 - 1e-4 && near((z - 0.16) / 0.08, Math.round((z - 0.16) / 0.08)), `z = ${z} is on a layer`);
  }
  assert.ok(zs.size > 10, 'the gradient uses many layers');
  // Volume between the base slab and the full height.
  assert.ok(p.volume > 100 * 50 * 0.48 && p.volume < 100 * 50 * 1.6, String(p.volume));
  // The filament stack: black from the bed, white from a later layer.
  assert.equal(p.layerColors?.length, 2);
  assert.deepEqual(p.layerColors![0], { z: 0, layer: 0, color: '#161616', td: 0.6, name: 'PLA Basic Black', brand: 'Bambu Lab' });
  assert.ok(near(p.layerColors![1].z, 0.16 + (p.layerColors![1].layer - 1) * 0.08));
  // Print settings come with the part.
  assert.deepEqual(r.print, { layerHeight: 0.08, infill: 100, infillPattern: 'zig-zag' });
  // Vertex colours: one RGB per vertex, dark on the left of the top, bright on the right.
  assert.equal(p.vertexColors?.length, p.positions.length);
  let left = 0, right = 0;
  for (let v = 0; v < p.positions.length / 3; v++) {
    const [x, y, z] = [p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2]];
    if (z === 0 || y > 15) continue;
    const l = luma([p.vertexColors![v * 3], p.vertexColors![v * 3 + 1], p.vertexColors![v * 3 + 2]]);
    if (x < -45) left = Math.max(left, l);
    if (x > 45) right = Math.max(right, l);
  }
  assert.ok(left < 0.15 && right > 0.6, `left ${left}, right ${right}`);
});

test('H.hueforge: border, the user\'s setup, scale, lite evaluations and errors', () => {
  const framed = evaluateScript(SCRIPT, { ...values, border: 5 }, 'draft').parts[0];
  assert.ok(Math.abs(framed.bbox.max[0] - 55) < 1e-4 && Math.abs(framed.bbox.max[1] - 30) < 1e-4);
  assert.equal(framed.components, 1);
  // The side panel's filaments and swaps win over the script's.
  const setup = { filaments: FOUR, swaps: [6, 9, 13] };
  const r = evaluateScript(SCRIPT, { ...values, [HF_KEY]: JSON.stringify(setup), $scale: 2 }, 'draft');
  const lc = r.parts[0].layerColors!;
  assert.deepEqual(lc.map((l) => l.layer), [0, 6, 9, 13]);
  assert.deepEqual(lc.map((l) => l.color), FOUR.map((f) => f.color));
  assert.ok(Math.abs(lc[1].z - 2 * 0.56) < 1e-9, 'z scaled with the part');
  assert.ok(Math.abs(r.parts[0].bbox.max[2] - 3.2) < 1e-3);
  // What the side panel needs for its preview: the picture and the options, scaled with the part.
  const src = r.parts[0].hueforge!;
  assert.equal(src.image, 'gradient.png');
  assert.deepEqual([src.options.width, src.options.maxHeight, src.options.layerHeight, src.options.gamma].map((v) => +v.toFixed(9)), [200, 3.2, 0.16, 1]);
  const sim = simulateImage(gradient, lc, src.options);
  assert.ok(sim.rgba[(50 * 200 + 5) * 4] < sim.rgba[(50 * 200 + 195) * 4], 'scaled options still preview the print');
  // Swaps that don't fit the filaments fall back to automatic ones.
  const auto = evaluateScript(SCRIPT, { ...values, [HF_KEY]: JSON.stringify({ filaments: FOUR, swaps: [9, 6] }) }, 'draft').parts[0].layerColors!;
  assert.deepEqual(auto.map((l) => l.layer).slice(1), autoSwaps(gradient, FOUR, { width: 100 }));
  const lite = evaluateScript(SCRIPT, values, 'draft', { lite: true }).parts[0];
  assert.equal(lite.layerColors?.length, 2);
  assert.equal(lite.vertexColors, undefined);
  assert.throws(() => evaluateScript("function build() { return H.hueforge('cat.jpg', { width: 50 }).shape; }", values, 'draft'), /no picture named "cat.jpg" \(pictures: "gradient.png"\)/);
  assert.throws(() => evaluateScript("function build() { return H.hueforge('gradient.png', {}).shape; }", values, 'draft'), /width must be > 0/);
});

test('simulateImage: the picture as printed, frame included', () => {
  const layers = stack(DEFAULT_FILAMENTS, [6]);
  const sim = simulateImage(gradient, layers, { width: 100, border: 5 });
  assert.deepEqual([sim.width, sim.height], [220, 120]); // 5 mm of a 100 mm, 200 px picture: 10 px
  const at = (x: number, y: number) => luma([sim.rgba[(y * sim.width + x) * 4] / 255, sim.rgba[(y * sim.width + x) * 4 + 1] / 255, sim.rgba[(y * sim.width + x) * 4 + 2] / 255]);
  assert.ok(at(25, 60) < at(110, 60) && at(110, 60) < at(205, 60), 'dark to bright');
  assert.equal(at(0, 0), at(209, 60)); // the frame is at full height, as bright as the brightest point
  // invert: dark areas high.
  const inv = simulateImage(gradient, layers, { width: 100, invert: true });
  assert.ok(inv.rgba[(60 * 200 + 5) * 4] > inv.rgba[(60 * 200 + 195) * 4]);
});
