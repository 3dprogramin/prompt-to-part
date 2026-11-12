// A picture edit of a LayerTone photo (the greyscale picture under $images), with a stand-in for
// the image model: only the marked area of the stored picture changes, byte for byte; automatic
// swap layers are kept as they were, so the built print outside the mark keeps its heights.
import './wasm';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { encode as encodePng } from 'fast-png';
import { ASPECTS, decodeImage, type requestImage } from '../server/artwork';
import { editPicture, PictureEditError } from '../server/pictureEdit/index';
import { cadTools } from '../server/cadTools';
import { geometry } from '../server/geometry';
import type { AgentEvent, PictureEditRequest } from '../shared/api';
import { autoSwaps, LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, layerToneLuma, parseLayerToneImages, parseLayerToneSetup, toBase64, type LayerToneFilament, type LayerToneImage } from '../shared/layertone';
import { markMask, PICTURE_MARKS_KEY, parsePictureMarks, type PictureMark } from '../shared/pictureEdit/mark';
import { photoFingerprint } from '../shared/pictureEdit/photo';
import { withSet } from '../shared/pictureEdit/set';
import { evaluateScript } from '../shared/runtime';
import type { Raster } from '../shared/meshFormats';
import type { ParamValues } from '../shared/types';

/** A 200 x 150 photo: a soft gradient with a few darker blobs and a brighter face in the middle. */
const W = 200, H = 150;
const photo = (() => {
  const bytes = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 60 + 120 * (x / W) + 30 * Math.sin(y / 9) + 20 * Math.cos((x + y) / 13);
    for (const [cx, cy, r, d] of [[40, 40, 18, -50], [160, 110, 22, -40], [150, 30, 12, 60], [100, 75, 28, 70]]) {
      const t = Math.hypot(x - cx, y - cy) / r;
      if (t < 1) v += d * (1 - t * t);
    }
    bytes[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return { name: 'photo-1', width: W, height: H, luma: toBase64(bytes) } satisfies LayerToneImage;
})();
const aspect = W / H;
/** The face in the middle of the picture (picture units: 1 = its height, centred, y up). */
const face: PictureMark = { strokes: [{ width: 0.4, points: [[0, 0]] }] };
const FILAMENTS: LayerToneFilament[] = [
  { name: 'PLA Basic Black', brand: 'Bambu Lab', color: '#000000', td: 0.2 },
  { name: 'PLA Basic Grey', brand: 'Bambu Lab', color: '#8e9089', td: 1.2 },
  { name: 'PLA Basic Jade White', brand: 'Bambu Lab', color: '#ffffff', td: 5.9 },
];
const SCRIPT = `function build() { return { name: 'Picture', ...H.layertone('photo-1', { width: 60, maxHeight: 1.6, filaments: ${JSON.stringify(FILAMENTS)} }) }; }`;
const values: ParamValues = {
  [LAYERTONE_IMAGES_KEY]: JSON.stringify({ 'photo-1': photo }),
  [PICTURE_MARKS_KEY]: JSON.stringify({ 'photo-1': { fp: photoFingerprint(photo), mark: face } }),
};

/** How the part was built, as the app sends it with the request. */
function builtWith(v: ParamValues): NonNullable<PictureEditRequest['layerTone']> {
  const part = evaluateScript(SCRIPT, v, 'draft').parts[0];
  const layers = part.layerColors!;
  return { options: part.layerTone!.options, filaments: layers.map((l) => ({ name: l.name ?? l.color, ...(l.brand ? { brand: l.brand } : {}), color: l.color, td: l.td })), swaps: layers.slice(1).map((l) => l.layer) };
}
const request = (extra: Partial<PictureEditRequest> = {}): PictureEditRequest =>
  ({ mode: 'layertone', picture: 'photo-1', values, mark: face, change: 'a darker face', photos: [], layerTone: builtWith(values), ...extra });

const raster = (url: string) => decodeImage(Buffer.from(url.split(',')[1], 'base64'));
const answerOf = (r: Raster) => ({ image: { data: Buffer.from(encodePng({ ...r, channels: 4 })).toString('base64'), mediaType: 'image/png' }, model: 'test/image', cost: 0.03 });
type Image = typeof requestImage;
type Call = { prompt: string; aspect: string; references: string[] };

/**
 * A stand-in that sends the crop back re-toned (x 0.9 + 15, as photos often come back) with the
 * area outlined in magenta (on the second picture) filled with dark grey, row by row.
 */
const darkInMark = (calls: Call[]): Image => async (prompt, aspectAsked, refs) => {
  calls.push({ prompt, aspect: aspectAsked, references: refs ?? [] });
  const crop = raster(refs![0]), outlined = raster(refs![1]), w = crop.width;
  const data = Uint8Array.from(crop.data, (v, i) => (i % 4 === 3 ? v : Math.round(v * 0.9 + 15)));
  for (let j = 0; j < crop.height; j++) {
    let lo = -1, hi = -1;
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4, d = outlined.data;
      if (d[o] > 200 && d[o + 1] < 80 && d[o + 2] > 200) { if (lo < 0) lo = i; hi = i; }
    }
    for (let i = lo; lo >= 0 && i <= hi; i++) data.set([30, 30, 30], (j * w + i) * 4);
  }
  return answerOf({ width: w, height: crop.height, data });
};
const edit = (r: PictureEditRequest, image: Image) => editPicture(r, { image });

/** The mark on the stored picture's pixels. */
const faceMask = () => markMask(face, { w: W, h: H, px: 1 / H, x0: -aspect / 2, y1: 0.5 });

test('a marked LayerTone edit: the crop, its outline and the whole photo sent; outside the mark the stored picture is byte for byte the same', async () => {
  const calls: Call[] = [];
  const r = await edit(request({ photos: [] }), darkInMark(calls));
  assert.equal(r.masked, true);
  assert.equal(r.outsideSame, true);
  assert.equal(r.offPalette, undefined);
  assert.ok(r.align && r.align.error < 3, JSON.stringify(r.align));
  // Sent: the crop (in an allowed shape, about 1024 pixels), the crop outlined, the whole picture.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].references.length, 3);
  assert.ok((ASPECTS as readonly string[]).includes(calls[0].aspect), calls[0].aspect);
  const sent = raster(calls[0].references[0]);
  assert.ok(Math.abs(Math.max(sent.width, sent.height) - 1024) <= 20, `${sent.width} x ${sent.height}`);
  // Grey: what is sent has no colour.
  for (let p = 0; p < sent.width * sent.height; p += 97) assert.ok(sent.data[p * 4] === sent.data[p * 4 + 1] && sent.data[p * 4 + 1] === sent.data[p * 4 + 2]);
  assert.match(calls[0].prompt, /a darker face/);
  assert.match(calls[0].prompt, /photo/);
  assert.equal(r.prompt, calls[0].prompt);

  // The picture: same name and size; every byte outside the mark as it was, the face darker.
  const next = parseLayerToneImages(r.set[LAYERTONE_IMAGES_KEY])['photo-1'];
  assert.ok(next, 'the picture is stored under the same name');
  assert.equal(next.width, W);
  assert.equal(next.height, H);
  const before = layerToneLuma(photo), after = layerToneLuma(next), mask = faceMask();
  let changed = 0;
  for (let p = 0; p < W * H; p++) {
    if (!mask[p]) assert.equal(after[p], before[p], `pixel ${p % W}, ${Math.floor(p / W)} outside the mark`);
    else if (after[p] !== before[p]) changed++;
  }
  assert.ok(changed > 0.8 * mask.reduce((n, v) => n + v, 0), `${changed} pixels of the mark changed`);
  assert.ok(after[75 * W + 100] < 50, `the face is dark: ${after[75 * W + 100]}`);
  // The before / after pictures show the crop; the mark is used up.
  assert.ok(r.window && r.window.w > 0.4 && r.window.h > 0.4);
  assert.equal(raster(r.before).width, raster(r.after).width);
  assert.equal(parsePictureMarks(r.set[PICTURE_MARKS_KEY])['photo-1'], undefined);
});

test('a marked edit of a picture with automatic swaps keeps them (set in the setup) and says so; the built print outside the mark keeps its heights', async () => {
  const sent = request();
  const r = await edit(sent, darkInMark([]));
  const auto = autoSwaps(photo, FILAMENTS, sent.layerTone!.options);
  assert.deepEqual(sent.layerTone!.swaps, auto, 'the parent was built with automatic swaps');
  const setup = parseLayerToneSetup(r.set[LAYERTONE_KEY]);
  assert.deepEqual(setup.swaps, auto);
  // The filaments stay the script's: only the swaps are set.
  assert.equal(setup.filaments, undefined);
  assert.deepEqual(r.swapsKept?.swaps, auto);
  assert.match(r.swapsKept!.note, new RegExp(`layers ${auto.join(', ')}`));
  assert.match(r.swapsKept!.note, /automatic/);
  // The edit changes the picture enough that automatic swaps on it would differ: the pin matters.
  const next = parseLayerToneImages(r.set[LAYERTONE_IMAGES_KEY])['photo-1'];
  assert.notDeepEqual(autoSwaps(next, FILAMENTS, sent.layerTone!.options), auto);

  // Built: the parent and the edit, height for height over the grid outside the mark (and a margin
  // of the cells that read the mark's pixels).
  const heights = (v: ParamValues) => {
    const part = evaluateScript(SCRIPT, v, 'draft').parts[0], P = part.positions, out = new Map<string, number>();
    for (let i = 0; i < P.length; i += 3) {
      const k = `${P[i].toFixed(3)},${P[i + 1].toFixed(3)}`;
      out.set(k, Math.max(out.get(k) ?? 0, P[i + 2]));
    }
    return { out, layers: part.layerColors!.map((l) => l.layer) };
  };
  const a = heights(values), b = heights(withSet(values, r.set));
  assert.deepEqual(b.layers, a.layers);
  const mmH = (60 * H) / W, mask = faceMask();
  const nearMark = (x: number, y: number) => {
    const px = Math.floor(((x + 30) / 60) * W), py = Math.floor(((mmH / 2 - y) / mmH) * H);
    for (let j = py - 4; j <= py + 4; j++) for (let i = px - 4; i <= px + 4; i++) if (i >= 0 && j >= 0 && i < W && j < H && mask[j * W + i]) return true;
    return false;
  };
  let compared = 0, inside = 0;
  for (const [k, z] of a.out) {
    const [x, y] = k.split(',').map(Number);
    if (nearMark(x, y)) { if (b.out.get(k) !== z) inside++; continue; }
    assert.equal(b.out.get(k), z, `height at ${k}`);
    compared++;
  }
  assert.ok(compared > 1000, `${compared} heights compared`);
  assert.ok(inside > 50, `${inside} heights changed in the mark`);
});

test('swaps that are not automatic are left alone: the user\'s own, or the script\'s', async () => {
  // The user's own swaps in the setup: nothing to keep.
  const own = { ...values, [LAYERTONE_KEY]: JSON.stringify({ swaps: [4, 9] }) };
  const r1 = await edit(request({ values: own, layerTone: builtWith(own) }), darkInMark([]));
  assert.equal(LAYERTONE_KEY in r1.set, false);
  assert.equal(r1.swapsKept, undefined);
  // Swaps the part was built with that are not the automatic ones are the script's: they don't depend on the picture
  // (these two lie below the relief, where automatic swaps never go).
  const r2 = await edit(request({ layerTone: { ...builtWith(values), swaps: [2, 3] } }), darkInMark([]));
  assert.equal(LAYERTONE_KEY in r2.set, false);
  assert.equal(r2.swapsKept, undefined);
});

test('the whole LayerTone picture: sent padded to an allowed shape, the answer back at the stored size, no swaps kept', async () => {
  const calls: Call[] = [];
  const image: Image = async (prompt, aspectAsked, refs) => {
    calls.push({ prompt, aspect: aspectAsked, references: refs ?? [] });
    const sent = raster(refs![0]);
    // Every pixel a little darker.
    return answerOf({ ...sent, data: Uint8Array.from(sent.data, (v, i) => (i % 4 === 3 ? v : Math.max(0, v - 40))) });
  };
  const r = await edit(request({ mark: undefined, layerTone: undefined }), image);
  assert.equal(r.masked, false);
  assert.equal(r.outsideSame, false);
  assert.equal(calls[0].references.length, 1);
  assert.equal(calls[0].aspect, '4:3');
  const next = parseLayerToneImages(r.set[LAYERTONE_IMAGES_KEY])['photo-1'];
  assert.equal(next.width, W);
  assert.equal(next.height, H);
  const before = layerToneLuma(photo), after = layerToneLuma(next);
  assert.ok(Math.abs(after[75 * W + 20] - Math.max(0, before[75 * W + 20] - 40)) <= 3, `${before[75 * W + 20]} -> ${after[75 * W + 20]}`);
  assert.equal(LAYERTONE_KEY in r.set, false);
  assert.deepEqual(r.window, { x0: -aspect / 2, y1: 0.5, w: aspect, h: 1 });
});

test('a LayerTone edit that cannot be done says why', async () => {
  const bad = async (r: PictureEditRequest, why: RegExp, status = 400) => {
    await assert.rejects(edit(r, async () => { throw new Error('not asked'); }), (e: unknown) => e instanceof PictureEditError && e.status === status && why.test(e.message));
  };
  await bad(request({ picture: 'nope' }), /no picture "nope"/);
  for (const name of ['constructor', '__proto__']) await bad(request({ picture: name }), /no picture/);
  // A marked edit needs how the part was built (to keep its swap layers).
  await bad(request({ layerTone: undefined }), /built/);
  await bad(request({ layerTone: { options: { width: -1 } as never, filaments: FILAMENTS } }), /built/);
  await bad(request({ mark: { strokes: [{ width: 0.1, points: [[3, 3]] }] } }), /outside the picture/);
});

test('edit_picture in the chat (LayerTone mode): the part as model.js builds it now goes along, its automatic swaps are kept', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-layertone-edit-'));
  after(() => { geometry.stop(); rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'model.js');
  writeFileSync(file, SCRIPT);
  const base: ParamValues = { ...values }, events: AgentEvent[] = [], calls: Call[] = [];
  const { server } = cadTools(file, (e) => events.push(e), new Set(), base, { pictures: { references: [] }, layerTone: true, image: darkInMark(calls) });
  const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler: (a: unknown, x: unknown) => Promise<{ isError?: boolean; content: { text?: string }[] }> }> })._registeredTools;
  const r = await tools.edit_picture.handler({ picture: 'photo-1', change: 'a darker face', region: 'mark' }, {});
  assert.ok(!r.isError, r.content.map((c) => c.text).join());
  assert.equal(calls.length, 1);
  const auto = autoSwaps(photo, FILAMENTS, builtWith(values).options);
  assert.deepEqual(parseLayerToneSetup(base[LAYERTONE_KEY]).swaps, auto);
  assert.ok(r.content.some((c) => c.text?.includes(`Swap layers kept as they were (layers ${auto.join(', ')})`)));
  assert.notEqual(base[LAYERTONE_IMAGES_KEY], values[LAYERTONE_IMAGES_KEY]);
  assert.ok(events.some((e) => e.type === 'pictureEdited' && e.info.masked && e.info.outsideSame));
});
