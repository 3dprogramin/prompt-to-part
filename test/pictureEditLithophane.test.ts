// A picture edit of a lithophane's photo (the same greyscale picture store as LayerTone's), with a
// stand-in for the image model: only the marked area of the stored picture changes, byte for byte,
// and the built panel's thickness outside the mark is the parent's: each pixel maps to its own
// thickness, so there is nothing to pin (no swap layers).
import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode as encodePng } from 'fast-png';
import { decodeImage, type requestImage } from '../server/artwork';
import { editPicture, PictureEditError } from '../server/pictureEdit/index';
import { pictureEditPrompt } from '../server/pictureEdit/prompt';
import type { PictureEditRequest } from '../shared/api';
import { LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, layerToneLuma, parseLayerToneImages, toBase64, type LayerToneImage } from '../shared/layertone';
import { markMask, type PictureMark } from '../shared/pictureEdit/mark';
import { withSet } from '../shared/pictureEdit/set';
import { evaluateScript } from '../shared/runtime';
import type { Raster } from '../shared/meshFormats';
import type { ParamValues } from '../shared/types';

/** A `w` x `h` photo: a soft gradient with a few blobs and a brighter face in the middle. */
function makePhoto(w: number, h: number): LayerToneImage {
  const bytes = new Uint8Array(w * h), k = w / 200;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 60 + 120 * (x / w) + 30 * Math.sin(y / (9 * k)) + 20 * Math.cos((x + y) / (13 * k));
    for (const [cx, cy, r, d] of [[0.2, 0.27, 18, -50], [0.8, 0.73, 22, -40], [0.5, 0.5, 28, 70]]) {
      const t = Math.hypot(x - cx * w, y - cy * h) / (r * k);
      if (t < 1) v += d * (1 - t * t);
    }
    bytes[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return { name: 'photo-1', width: w, height: h, luma: toBase64(bytes) };
}
const face: PictureMark = { strokes: [{ width: 0.4, points: [[0, 0]] }] };
const SCRIPT = "function build() { return { name: 'Lithophane', ...H.lithophane('photo-1', { width: 60, border: 0 }) }; }";
const valuesFor = (photo: LayerToneImage): ParamValues => ({ [LAYERTONE_IMAGES_KEY]: JSON.stringify({ 'photo-1': photo }) });

const raster = (url: string) => decodeImage(Buffer.from(url.split(',')[1], 'base64'));
const answerOf = (r: Raster) => ({ image: { data: Buffer.from(encodePng({ ...r, channels: 4 })).toString('base64'), mediaType: 'image/png' }, model: 'test/image', cost: 0.03 });
type Image = typeof requestImage;
/** A stand-in that sends the crop back with the area outlined in magenta (the second picture) filled with dark grey. */
const darkInMark = (prompts: string[] = []): Image => async (prompt, _aspect, refs) => {
  prompts.push(prompt);
  const crop = raster(refs![0]), outlined = raster(refs![1]), w = crop.width;
  const data = Uint8Array.from(crop.data);
  for (let j = 0; j < crop.height; j++) for (let i = 0; i < w; i++) {
    const o = (j * w + i) * 4, d = outlined.data;
    if (d[o] > 200 && d[o + 1] < 80 && d[o + 2] > 200) data.set([30, 30, 30], o);
  }
  return answerOf({ width: w, height: crop.height, data });
};
const request = (photo: LayerToneImage, extra: Partial<PictureEditRequest> = {}): PictureEditRequest =>
  ({ mode: 'lithophane', picture: 'photo-1', values: valuesFor(photo), mark: face, change: 'a darker face', photos: [], ...extra });

/** Per grid point of the panel (x, z), the vertex depth (y) that carries the thickness, and the lit colour's luma. */
function panel(values: ParamValues) {
  const part = evaluateScript(SCRIPT, values, 'draft').parts[0], P = part.positions, out = new Map<string, number>();
  for (let i = 0; i < P.length; i += 3) {
    const k = `${P[i].toFixed(3)},${P[i + 2].toFixed(3)}`;
    out.set(k, Math.max(out.get(k) ?? -1e9, -P[i + 1]));
  }
  return { out, part };
}

for (const [w, h] of [[200, 150], [157, 113]]) {
  test(`a marked lithophane edit (${w} x ${h} picture): the stored picture and the built panel are the same outside the mark, no swaps set`, async () => {
    const photo = makePhoto(w, h), aspect = w / h;
    const r = await editPicture(request(photo), { image: darkInMark() });
    assert.equal(r.masked, true);
    assert.equal(r.outsideSame, true);
    assert.equal(r.swapsKept, undefined);
    assert.equal(LAYERTONE_KEY in r.set, false);
    const next = parseLayerToneImages(r.set[LAYERTONE_IMAGES_KEY])['photo-1'];
    assert.equal(next.width, w);
    assert.equal(next.height, h);
    const mask = markMask(face, { w, h, px: 1 / h, x0: -aspect / 2, y1: 0.5 });
    const before = layerToneLuma(photo), after = layerToneLuma(next);
    let changed = 0;
    for (let p = 0; p < w * h; p++) {
      if (!mask[p]) assert.equal(after[p], before[p], `pixel ${p % w}, ${Math.floor(p / w)} outside the mark`);
      else if (after[p] !== before[p]) changed++;
    }
    assert.ok(changed > 100, `${changed} pixels changed in the mark`);

    // Built: the panel's thickness over the grid outside the mark (and a margin of cells that read the mark's pixels).
    const a = panel(valuesFor(photo)), b = panel(withSet(valuesFor(photo), r.set));
    // (No frame: the picture fills the panel's box, z up from the bed.)
    const { min, max } = a.part.bbox, mmW = max[0] - min[0], mmH = max[2] - min[2];
    const nearMark = (x: number, z: number) => {
      const px = Math.floor(((x - min[0]) / mmW) * w), py = Math.floor(((max[2] - z) / mmH) * h);
      for (let j = py - 4; j <= py + 4; j++) for (let i = px - 4; i <= px + 4; i++) if (i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i]) return true;
      return false;
    };
    let compared = 0, inside = 0;
    for (const [k, y] of a.out) {
      const [x, z] = k.split(',').map(Number);
      if (nearMark(x, z)) { if (b.out.get(k) !== y) inside++; continue; }
      assert.equal(b.out.get(k), y, `thickness at ${k}`);
      compared++;
    }
    assert.ok(compared > 1000, `${compared} thicknesses compared`);
    assert.ok(inside > 50, `${inside} thicknesses changed in the mark`);
  });
}

test('a marked lithophane edit needs no build from the app; a missing picture or a lineart mode is refused', async () => {
  const photo = makePhoto(120, 90);
  // (No `layerTone` in the request: a lithophane has nothing to pin.)
  await editPicture(request(photo), { image: darkInMark() });
  await assert.rejects(editPicture(request(photo, { picture: 'nope' }), { image: darkInMark() }), (e: unknown) => e instanceof PictureEditError && /no picture "nope"/i.test((e as Error).message));
  await assert.rejects(editPicture(request(photo, { picture: 'constructor' }), { image: darkInMark() }), PictureEditError);
  await assert.rejects(editPicture(request(photo, { mode: 'lineart' }), { image: darkInMark() }), /not yet supported/);
});

test('the lithophane prompt asks for a realistic photo with a full tonal range; the LayerTone one does not', async () => {
  const prompts: string[] = [];
  await editPicture(request(makePhoto(120, 90)), { image: darkInMark(prompts) });
  assert.match(prompts[0], /lithophane/);
  assert.match(prompts[0], /lit from behind/);
  assert.match(prompts[0], /full range of tones/);
  assert.match(prompts[0], /realistic photo/);
  assert.match(prompts[0], /Keep everything else exactly as it is/);
  assert.doesNotMatch(prompts[0], /LayerTone/);
  assert.doesNotMatch(pictureEditPrompt({ mode: 'layertone', change: 'x y z', masked: true, photos: 0 }), /lithophane|tonal range/);
});
