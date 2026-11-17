// The back text on a LayerTone part: a mirrored line in the first layers, built with the picture.
import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import { FontMissingError, withFonts } from '../shared/text';
import { loadFontBuffers } from '../server/fonts';
import { BACK_TEXT_KEY, setBackTextDefault } from '../shared/backText';
import { LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, toLayerToneImage } from '../shared/layertone';
import type { ParamValues, PartMesh } from '../shared/types';

// A tiny 40 × 30 px gradient: black on the left, white on the right.
const rgba = new Uint8Array(40 * 30 * 4);
for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) {
  const p = (y * 40 + x) * 4;
  rgba[p] = rgba[p + 1] = rgba[p + 2] = Math.round((x / 39) * 255);
  rgba[p + 3] = 255;
}
const pic = toLayerToneImage('pic.png', 40, 30, rgba);
const values: ParamValues = { [LAYERTONE_IMAGES_KEY]: JSON.stringify({ 'pic.png': pic }), [LAYERTONE_KEY]: JSON.stringify({ baseHeight: 0.48 }) };
/** The tests below that check centring ask for the centre; the corner (the default) has its own test. */
const CENTRE = { [BACK_TEXT_KEY]: JSON.stringify({ position: 'centre' }) };
const SCRIPT = "function build() { return { name: 'Picture', ...H.layertone('pic.png', { width: 100 }) }; }";
const TWO = `function build() {
  const a = H.layertone('pic.png', { width: 100 }), b = H.layertone('pic.png', { width: 60 });
  return [{ name: 'A', ...a }, { name: 'B', ...b, shape: b.shape.translate([150, 20, 0]) }];
}`;

const run = (more: ParamValues = {}, script = SCRIPT) => withFonts(() => evaluateScript(script, { ...values, ...more }, 'draft'), loadFontBuffers);

function extent(pos: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  return { min, max };
}
const zs = (pos: Float32Array) => [...new Set(Array.from({ length: pos.length / 3 }, (_, i) => +pos[i * 3 + 2].toFixed(5)))].sort((a, b) => a - b);

/** The text spans size% of the part's width, or less when 25 % of its depth caps the height. */
function assertSized(p: PartMesh, size = 0.7) {
  const t = extent(p.backText!.positions);
  const W = p.bbox.max[0] - p.bbox.min[0], D = p.bbox.max[1] - p.bbox.min[1];
  const w = t.max[0] - t.min[0], h = t.max[1] - t.min[1];
  assert.ok(w <= size * W + 0.5, `width ${w} of ${W}`);
  assert.ok(Math.abs(w - size * W) < 0.5 || Math.abs(h - 0.25 * D) < 0.05, `width ${w} of ${W}, height ${h} of ${D}`);
  // Centred on the part.
  assert.ok(Math.abs((t.min[0] + t.max[0]) / 2 - (p.bbox.min[0] + p.bbox.max[0]) / 2) < 1e-3);
  assert.ok(Math.abs((t.min[1] + t.max[1]) / 2 - (p.bbox.min[1] + p.bbox.max[1]) / 2) < 1e-3);
}

test('a font not loaded yet stops the evaluation before the build (the font retry loads it), then the text is there', async () => {
  setBackTextDefault('shop.example');
  // The build would fail: the font is asked for first, so the relief isn't built twice.
  const failing = "function build() { H.layertone('pic.png', { width: 100 }); throw new Error('built'); }";
  assert.throws(() => evaluateScript(failing, values, 'draft'), FontMissingError);
  assert.throws(() => evaluateScript(SCRIPT, values, 'draft'), FontMissingError);
  const r = await run();
  assert.ok(r.parts[0].backText);
});

test('a LayerTone part gets the back text: 70 % wide, centred, in its first two layers, the part unchanged', async () => {
  setBackTextDefault('shop.example');
  const r = await run(CENTRE);
  const p = r.parts[0], bt = p.backText!;
  assert.ok(bt, 'backText');
  assert.equal(bt.text, 'shop.example');
  assert.equal(bt.layers, 2);
  assert.ok(Math.abs(bt.topZ - 0.24) < 1e-9);
  assert.ok(bt.indices.length > 0 && bt.indices.length % 3 === 0);
  assert.match(bt.color, /^#[0-9a-f]{6}$/i);
  assert.ok(bt.td > 0 && bt.name);
  assertSized(p);
  assert.deepEqual(zs(bt.positions), [+p.bbox.min[2].toFixed(5), +(p.bbox.min[2] + 0.24).toFixed(5)]);
  // The part's own mesh is the same as without the text.
  const off = (await run({ [BACK_TEXT_KEY]: '{"off":true}' })).parts[0];
  assert.equal(off.backText, undefined);
  assert.deepEqual([p.bbox, p.volume, p.triCount], [off.bbox, off.volume, off.triCount]);
});

test('mirrored: an "L" has its vertical stroke on the right', async () => {
  setBackTextDefault('shop.example');
  const pos = (await run({ [BACK_TEXT_KEY]: JSON.stringify({ text: 'L', position: 'centre' }) })).parts[0].backText!.positions;
  const t = extent(pos), H = t.max[1] - t.min[1];
  const ySpan = (x: number) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i] - x) < 1e-3) { lo = Math.min(lo, pos[i + 1]); hi = Math.max(hi, pos[i + 1]); }
    return hi - lo;
  };
  assert.ok(Math.abs(ySpan(t.max[0]) - H) < 1e-3, 'the right edge runs the full height');
  assert.ok(ySpan(t.min[0]) < H / 2, 'the left edge is only the foot');
});

test('$scale: the text follows the scaled part and its layers', async () => {
  setBackTextDefault('shop.example');
  const p = (await run({ $scale: 0.5, ...CENTRE })).parts[0];
  assertSized(p);
  assert.ok(Math.abs(p.backText!.topZ - 0.12) < 1e-9);
  assert.deepEqual(zs(p.backText!.positions), [+p.bbox.min[2].toFixed(5), +(p.bbox.min[2] + 0.12).toFixed(5)]);
});

test('no back text: the default is empty, or the design is not LayerTone', async () => {
  setBackTextDefault('');
  assert.equal((await run()).parts[0].backText, undefined);
  setBackTextDefault('shop.example');
  const cube = await run({}, 'function build() { return Manifold.cube([10, 10, 10]); }');
  assert.equal(cube.parts[0].backText, undefined);
  // A lite evaluation (sizes only) skips it.
  assert.equal(evaluateScript(SCRIPT, values, 'draft', { lite: true }).parts[0].backText, undefined);
});

test('two LayerTone parts: each gets its own text', async () => {
  setBackTextDefault('shop.example');
  const r = await run(CENTRE, TWO);
  assert.equal(r.parts.length, 2);
  for (const p of r.parts) {
    assert.ok(p.backText, p.name);
    assertSized(p);
  }
});

test('by default the text sits small in a corner: bottom-right seen from the back, 8 mm from the edges, at most 8 mm tall', async () => {
  setBackTextDefault('shop.example');
  const p = (await run()).parts[0];
  const t = extent(p.backText!.positions);
  const W = p.bbox.max[0] - p.bbox.min[0];
  // Seen from the back the picture is flipped left to right: its bottom-right is the model's bottom-left.
  assert.ok(Math.abs(t.min[0] - (p.bbox.min[0] + 8)) < 0.05, `left edge ${t.min[0]}`);
  assert.ok(Math.abs(t.min[1] - (p.bbox.min[1] + 8)) < 0.05, `bottom edge ${t.min[1]}`);
  const w = t.max[0] - t.min[0], h = t.max[1] - t.min[1];
  assert.ok(h <= 8 + 1e-3, `height ${h}`);
  assert.ok(w <= 0.3 * W + 0.05 && (Math.abs(w - 0.3 * W) < 0.05 || Math.abs(h - 8) < 1e-3), `width ${w} of ${W}`);
  // A long text in the corner is held to 8 mm letters.
  const long = (await run({ [BACK_TEXT_KEY]: JSON.stringify({ text: 'ab', size: 95 }) })).parts[0];
  const lt = extent(long.backText!.positions);
  assert.ok(lt.max[1] - lt.min[1] <= 8 + 1e-3);
});

test('a part too small for the corner (16 mm or less on either side) gets no back text, not a flipped or flat one', async () => {
  setBackTextDefault('shop.example');
  for (const width of [14, 16]) {
    const r = await run({}, `function build() { return { name: 'Picture', ...H.layertone('pic.png', { width: ${width} }) }; }`);
    assert.equal(r.parts[0].backText, undefined, `${width} mm wide`);
  }
  // Just above: 22 x 16.5 mm gets a small text.
  const above = await run({}, "function build() { return { name: 'Picture', ...H.layertone('pic.png', { width: 22 }) }; }");
  assert.ok(above.parts[0].backText?.indices.length);
  // The centre still has room.
  const centre = await run(CENTRE, "function build() { return { name: 'Picture', ...H.layertone('pic.png', { width: 14 }) }; }");
  assert.ok(centre.parts[0].backText);
});
