// "Edit this picture" on a LayerTone picture drawn for a filament stack: the colour picture is
// edited with the strip attached, the mark is re-snapped to strip positions, everything outside it
// stays byte for byte, and the stack's swaps are left alone.
import './wasm';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encode as encodePng } from 'fast-png';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-edit-strip-'));
process.env.PTP_DATA = dataDir;
const { decodeImage } = await import('../server/artwork');
const { editPicture } = await import('../server/pictureEdit/index');
const { LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, layerToneLuma, parseLayerToneImages, stripColors, stripSwaps, toStripImage } = await import('../shared/layertone');
const { markMask, PICTURE_MARKS_KEY } = await import('../shared/pictureEdit/mark');
const { photoFingerprint } = await import('../shared/pictureEdit/photo');
after(() => rmSync(dataDir, { recursive: true, force: true }));

const ID = 'design-edit-strip-1';
const W = 200, H = 150, aspect = W / H;
const FILAMENTS = [{ name: 'Black', color: '#000000', td: 0.6 }, { name: 'Blue', color: '#1a3fbf', td: 1 }, { name: 'White', color: '#ffffff', td: 1.6 }];
const O = { width: 100, maxHeight: 1.6, baseHeight: 0.48 };
const stack = { filaments: FILAMENTS, swaps: stripSwaps(FILAMENTS, O), maxHeight: 1.6, baseHeight: 0.48 };
const strip = stripColors(stack, O);

/** A colour picture in strip colours: a left-to-right ramp along the strip, with a lighter disc (the "face") in the middle. */
function colourPicture() {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inFace = Math.hypot(x - W / 2, y - H / 2) < 30;
    const c = strip[inFace ? 230 : Math.round((x / (W - 1)) * 180)];
    data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
  }
  return { width: W, height: H, data };
}
const colour = colourPicture();
const png = encodePng({ ...colour, channels: 4 });
const colourName = `${'c'.repeat(32)}.png`;
mkdirSync(path.join(dataDir, 'designs', ID), { recursive: true });
writeFileSync(path.join(dataDir, 'designs', ID, colourName), png);
const picture = { ...toStripImage('portrait', W, H, colour.data, stack, O), colour: `/api/designs/${ID}/images/${colourName}` };
const face = { strokes: [{ width: 0.4, points: [[0, 0]] as [number, number][] }] };
const values = {
  [LAYERTONE_IMAGES_KEY]: JSON.stringify({ portrait: picture }),
  [LAYERTONE_KEY]: JSON.stringify({ filaments: FILAMENTS, swaps: stack.swaps }),
  [PICTURE_MARKS_KEY]: JSON.stringify({ portrait: { fp: photoFingerprint(picture), mark: face } }),
};
const layerTone = { options: { width: 60, layerHeight: 0.08, firstLayerHeight: 0.16, baseHeight: 0.48, maxHeight: 1.6, border: 0, invert: false, gamma: 1, resolution: 0.6 }, filaments: FILAMENTS, swaps: stack.swaps, pictures: ['portrait'] };

const raster = (url: string) => decodeImage(Buffer.from(url.split(',')[1], 'base64'));
type Call = { prompt: string; references: string[] };
/** A stand-in that sends the crop back with the outlined (magenta) area filled with a dark strip colour. */
const darkInMark = (calls: Call[]) => async (prompt: string, _aspect: string, refs?: string[]) => {
  calls.push({ prompt, references: refs ?? [] });
  const crop = raster(refs![0]), outlined = raster(refs![1]), w = crop.width;
  const data = Uint8Array.from(crop.data);
  const dark = strip[20];
  for (let j = 0; j < crop.height; j++) {
    let lo = -1, hi = -1;
    for (let i = 0; i < w; i++) { const o = (j * w + i) * 4, d = outlined.data; if (d[o] > 200 && d[o + 1] < 80 && d[o + 2] > 200) { if (lo < 0) lo = i; hi = i; } }
    for (let i = lo; lo >= 0 && i <= hi; i++) data.set(dark, (j * w + i) * 4);
  }
  return { image: { data: Buffer.from(encodePng({ width: w, height: crop.height, data, channels: 4 })).toString('base64'), mediaType: 'image/png' }, model: 'test/image', cost: 0.03 };
};
const request = (v = values) => ({ mode: 'layertone' as const, picture: 'portrait', values: v, mark: face, change: 'a darker face', photos: [], layerTone });

test('strip picture edit keeps the outside', async () => {
  const calls: Call[] = [];
  const r = await editPicture(request(), { image: darkInMark(calls) });
  assert.equal(calls.length, 1);
  // The strip goes last, and the prompt asks for strip colours only.
  const last = raster(calls[0].references.at(-1)!);
  assert.equal(last.width, 512);
  assert.match(calls[0].prompt, /strip/);
  // What is sent is the colour picture, not grey.
  const sent = raster(calls[0].references[0]);
  let coloured = 0;
  for (let p = 0; p < sent.width * sent.height; p += 37) if (Math.abs(sent.data[p * 4] - sent.data[p * 4 + 2]) > 20) coloured++;
  assert.ok(coloured > 10, 'colour sent');
  const next = parseLayerToneImages(r.set[LAYERTONE_IMAGES_KEY]).portrait;
  assert.equal(next.positions, true);
  assert.deepEqual(next.stack, stack);
  assert.notEqual(next.colour, picture.colour);
  assert.match(next.colour!, new RegExp(`^/api/designs/${ID}/images/[0-9a-f]{32}\\.png$`));
  const before = layerToneLuma(picture), after = layerToneLuma(next);
  const mask = markMask(face, { w: W, h: H, px: 1 / H, x0: -aspect / 2, y1: 0.5 });
  let changed = 0;
  for (let p = 0; p < W * H; p++) {
    if (!mask[p]) assert.equal(after[p], before[p], `pixel ${p % W}, ${Math.floor(p / W)} outside the mark`);
    else if (after[p] !== before[p]) changed++;
  }
  assert.ok(changed > 0, 'the face changed');
  assert.ok(after[(H / 2) * W + W / 2] < 80, `the face is low on the strip: ${after[(H / 2) * W + W / 2]}`);
  // The stack's swaps are not touched.
  assert.equal(r.set[LAYERTONE_KEY], undefined);
});

test('missing colour file falls back to strip colours', async () => {
  const gone = { ...picture, colour: `/api/designs/${ID}/images/${'d'.repeat(32)}.png` };
  const v = { ...values, [LAYERTONE_IMAGES_KEY]: JSON.stringify({ portrait: gone }), [PICTURE_MARKS_KEY]: JSON.stringify({ portrait: { fp: photoFingerprint(gone), mark: face } }) };
  const calls: Call[] = [];
  const r = await editPicture(request(v), { image: darkInMark(calls) });
  const next = parseLayerToneImages(r.set[LAYERTONE_IMAGES_KEY]).portrait;
  assert.equal(next.positions, true);
  assert.equal(r.outsideSame, true);
});
