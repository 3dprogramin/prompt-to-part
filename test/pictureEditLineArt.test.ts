// A picture edit of a line-art drawing (one black shape for H.lineart), with a stand-in for the image
// model: outside the mark the drawing is the same, inside it the traced answer, joined into one
// piece where lines cross the mark's edge; the hand edits outside the mark stay, those inside are
// taken back (restore strokes: the model saw them drawn in), and the paint and fills under it come
// back after that (it never saw them). Without a mark the whole drawing is
// redrawn the way generate_line_art's edit does it.
import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { encode as encodePng } from 'fast-png';
import { decodeImage, type requestImage } from '../server/artwork';
import { editPicture, PictureEditError } from '../server/pictureEdit/index';
import { pictureEditPrompt } from '../server/pictureEdit/prompt';
import type { PictureEditRequest } from '../shared/api';
import { drawingFingerprint, drawingPicture, LINEART_EDITS_KEY, MAX_LINEART_STROKES, parseLineArtEdits, type LineArtStroke } from '../shared/lineart';
import { markContours, PICTURE_MARKS_KEY, type PictureMark } from '../shared/pictureEdit/mark';
import { wholeWindow } from '../shared/pictureEdit/render';
import { withSet } from '../shared/pictureEdit/set';
import { evaluateScript } from '../shared/runtime';
import { DRAWINGS_KEY, drawingSection, parseDrawings, type SvgDrawing } from '../shared/svgFeatures';
import type { Raster } from '../shared/meshFormats';
import type { ParamValues, PartMesh, Vec2 } from '../shared/types';

const wasm = await Module();
wasm.setup();
const C = wasm.CrossSection;

const box = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
/** A 2:1 frame (lines 0.03 of its height: 3 mm at 200 mm wide) with a bar across its middle, one black EvenOdd shape as traceLineArt makes. */
const panel: SvgDrawing = { name: 'panel', aspect: 2, shapes: [{ rule: 'EvenOdd', color: '#000000', contours: [box(-1, -0.5, 1, 0.5), box(-0.97, -0.47, 0.97, 0.47), box(-0.97, -0.015, 0.97, 0.015)] }] };
/** A disc in the middle: the bar crosses its edge on both sides. */
const middle: PictureMark = { strokes: [{ width: 0.3, points: [[0, 0]] }] };
const SCRIPT = "function build() { return H.lineart('panel', { style: 'outline', width: 200 }); }";
const FRAME = { k: 100, k0: 100, lineWidth: 1, style: 'outline' as const, width: 200 };
const valuesFor = (strokes: LineArtStroke[] = []): ParamValues => ({
  [DRAWINGS_KEY]: JSON.stringify({ panel }),
  ...(strokes.length ? { [LINEART_EDITS_KEY]: JSON.stringify({ panel: { fp: drawingFingerprint(panel), strokes } }) } : {}),
  [PICTURE_MARKS_KEY]: JSON.stringify({ panel: { fp: drawingFingerprint(panel), mark: middle } }),
});
const request = (extra: Partial<PictureEditRequest> = {}): PictureEditRequest =>
  ({ mode: 'lineart', picture: 'panel', values: valuesFor(), mark: middle, change: 'a round knob in the middle of the bar', photos: [], lineArt: FRAME, ...extra });

const raster = (url: string) => decodeImage(Buffer.from(url.split(',')[1], 'base64'));
const answerOf = (r: Raster) => ({ image: { data: Buffer.from(encodePng({ ...r, channels: 4 })).toString('base64'), mediaType: 'image/png' }, model: 'test/image', cost: 0.03 });
type Image = typeof requestImage;
const nearMagenta = (d: ArrayLike<number>, o: number) => d[o] > 200 && d[o + 1] < 80 && d[o + 2] > 200;

/** A stand-in that answers with the crop sent, changed by `draw` (given the outlined picture's magenta box: its centre and half width, crop pixels). */
const answering = (draw: (data: Uint8Array, w: number, h: number, at: { cx: number; cy: number; r: number; inside: (i: number, j: number) => boolean }) => void, asked: { prompt: string; references: string[] }[] = []): Image =>
  async (prompt, _aspect, refs) => {
    asked.push({ prompt, references: refs! });
    const crop = raster(refs![0]), outlined = raster(refs![1]), w = crop.width, h = crop.height, data = Uint8Array.from(crop.data);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const rows: [number, number][] = Array.from({ length: h }, () => [-1, -1]);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if (!nearMagenta(outlined.data, (j * w + i) * 4)) continue;
      x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j);
      if (rows[j][0] < 0) rows[j][0] = i;
      rows[j][1] = i;
    }
    const inside = (i: number, j: number) => rows[j][0] >= 0 && i >= rows[j][0] && i <= rows[j][1];
    draw(data, w, h, { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, r: (x1 - x0) / 2, inside });
    return answerOf({ width: w, height: h, data });
  };
/** A black disc a third of the mark's size in its middle (on the bar). */
const knob = (asked?: { prompt: string; references: string[] }[]) => answering((data, w, h, { cx, cy, r }) => {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (Math.hypot(i - cx, j - cy) < r / 3) data.set([0, 0, 0], (j * w + i) * 4);
}, asked);
/** Everything in the mark white (the drawing and the hand edits there taken out). */
const whiteInMark = answering((data, w, h, { inside }) => {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (inside(i, j)) data.set([255, 255, 255], (j * w + i) * 4);
});

const section = (d: SvgDrawing) => drawingSection(d, 1, undefined, C)!;
const build = (values: ParamValues) => evaluateScript(SCRIPT, values, 'draft').parts as (PartMesh & { lineArt: NonNullable<PartMesh['lineArt']> })[];
const close = (a: number, b: number, what: string, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(2)} mm³, want ${b.toFixed(2)}`);

test('a marked line-art edit: outside the mark the same drawing, inside the traced answer, one piece across the mark\'s edge', async () => {
  const asked: { prompt: string; references: string[] }[] = [];
  const r = await editPicture(request(), { image: knob(asked) });
  assert.equal(r.masked, true);
  assert.equal(r.outsideSame, true);
  assert.match(r.lineArtJoins?.note ?? '', /Joins and bridges are worked out again/);
  // Sent: the crop, the crop outlined, the whole drawing (no photos).
  assert.equal(asked.length, 1);
  assert.equal(asked[0].references.length, 3);
  assert.match(asked[0].prompt, /black line art/);
  assert.match(asked[0].prompt, /outlined in magenta/);
  assert.match(asked[0].prompt, /a round knob in the middle of the bar/);
  const d = parseDrawings(r.set[DRAWINGS_KEY]).panel;
  assert.equal(d.name, 'panel');
  assert.equal(d.aspect, 2);
  assert.deepEqual([...new Set(d.shapes.map((s) => s.color))], ['#000000'], 'one colour, the drawing\'s');
  // The frame never reaches the mark: its outlines are the same arrays of points.
  assert.deepEqual(d.shapes[0].contours.slice(0, 2), panel.shapes[0].contours.slice(0, 2));
  // Outside the mark (less a hair at its edge) the same area of ink, inside the knob added.
  const M = new C(markContours(middle), 'NonZero'), out = M.offset(1e-4, 'Round');
  const was = section(panel), now = section(d);
  assert.ok(Math.abs(now.subtract(out).area() - was.subtract(out).area()) < 1e-9, 'outside the mark the same ink');
  assert.ok(now.intersect(M).area() > was.intersect(M).area() + 0.003, `the knob: ${now.intersect(M).area()} vs ${was.intersect(M).area()}`);
  // One connected piece, as before: the bar runs on across the mark's edge on both sides.
  assert.equal(was.decompose().length, 1);
  assert.equal(now.decompose().length, 1, 'one piece');
  // Built: one piece without a bridge, the same size, and the mark is used up.
  const [a] = build(valuesFor()), [b] = build(withSet(valuesFor(), r.set));
  assert.equal(b.components, 1);
  assert.equal(b.lineArt.bridges, a.lineArt.bridges);
  for (const k of ['min', 'max'] as const) for (let i = 0; i < 3; i++) assert.ok(Math.abs(a.bbox[k][i] - b.bbox[k][i]) < 0.01, `bbox ${k}[${i}]`);
  assert.equal(r.set[PICTURE_MARKS_KEY], null);
  // No hand edits: none to take back.
  assert.equal(LINEART_EDITS_KEY in r.set, false);
});

test('a marked line-art edit keeps the hand edits outside the mark and takes back those inside it', async () => {
  // Lines drawn by hand (3 mm wide at 100 mm per unit): one down from the bar far right of the mark, one inside it.
  const outside: LineArtStroke = { mode: 'draw', width: 3, k: 100, points: [[0.6, 0], [0.6, -0.3]] };
  const inside: LineArtStroke = { mode: 'draw', width: 3, k: 100, points: [[0, 0], [0, -0.1]] };
  const r = await editPicture(request({ values: valuesFor([outside, inside]) }), { image: whiteInMark });
  assert.equal(r.outsideSame, true);
  const d = parseDrawings(r.set[DRAWINGS_KEY]).panel;
  const edits = parseLineArtEdits(r.set[LINEART_EDITS_KEY]).panel;
  // On the new drawing: the strokes as they were, then the mark as a clear (in drawing units, k 1).
  assert.equal(edits.fp, drawingFingerprint(d));
  assert.deepEqual(edits.strokes, [outside, inside, { mode: 'restore', width: 0.3, k: 1, points: [[0, 0]] }]);
  // Built: as the new drawing with only the outside line; the outside line is there.
  const as = (strokes: LineArtStroke[]) => build({ [DRAWINGS_KEY]: JSON.stringify({ panel: d }), ...(strokes.length ? { [LINEART_EDITS_KEY]: JSON.stringify({ panel: { fp: drawingFingerprint(d), strokes } }) } : {}) });
  const kept = build(withSet(valuesFor([outside, inside]), r.set))[0].volume;
  close(kept, as([outside])[0].volume, 'the inside line taken back');
  assert.ok(kept > as([])[0].volume + 50, 'the outside line stays');
  assert.ok(as([outside, inside])[0].volume > kept + 20, 'without the clear the inside line would be built');
});

test('a marked line-art edit keeps the paint and the fills under the mark', async () => {
  const red = { color: '#ff0000', name: 'Red' }, blue = { color: '#0000ff', name: 'Blue' };
  const strokes: LineArtStroke[] = [
    { mode: 'paint', width: 4, k: 100, points: [[-0.05, 0], [0.05, 0]], filament: red },
    { mode: 'paint', width: 4, k: 100, points: [[0.5, 0], [0.7, 0]], filament: red },
    { mode: 'fill', width: 10, k: 100, points: [[-0.1, 0.03], [0.1, 0.03]], filament: blue },
  ];
  // The image model answers with the crop it was sent: a no-op edit, the colours never drawn in it.
  const identity: Image = async (_p, _a, refs) => answerOf(raster(refs![0]));
  const volumes = (v: ParamValues) => Object.fromEntries(evaluateScript(SCRIPT, v, 'draft').parts.map((p: PartMesh) => [p.name, p.volume]));
  const before = volumes(valuesFor(strokes));
  assert.ok(before['Line art (Red)'] > 0 && before['Line art (Blue)'] > 0);
  const r = await editPicture(request({ values: valuesFor(strokes) }), { image: identity });
  const after = volumes(withSet(valuesFor(strokes), r.set));
  for (const name of ['Line art (Red)', 'Line art (Blue)']) {
    assert.ok(after[name] > 0, `${name} is still there`);
    assert.ok(Math.abs(after[name] - before[name]) / before[name] < 0.01, `${name} volume ${after[name]} vs ${before[name]}`);
  }
});

test('a marked edit whose hand edits plus mark plus kept colours pass the stroke limit is refused before the image model is asked', async () => {
  const paints = Array.from({ length: MAX_LINEART_STROKES - 3 }, (_, i): LineArtStroke => ({ mode: 'paint', width: 1, k: 100, points: [[-0.9 + i * 0.004, 0.4]], filament: { color: '#ff0000', name: 'Red' } }));
  const mark: PictureMark = { strokes: [{ width: 0.1, points: [[0, 0]] }, { width: 0.1, points: [[0.1, 0]] }] };
  let asked = 0;
  const never: Image = async () => { asked++; throw new Error('the image model was asked'); };
  await assert.rejects(editPicture(request({ values: valuesFor(paints), mark }), { image: never }), (e: unknown) => e instanceof PictureEditError && e.status === 400 && /hand edits/.test((e as Error).message));
  assert.equal(asked, 0);
});

test('a whole line-art drawing edited without a mark goes the way generate_line_art\'s edit goes: the hand edits baked, their colours kept', async () => {
  const red = { color: '#ff0000', name: 'Red' };
  const strokes: LineArtStroke[] = [{ mode: 'draw', width: 3, k: 100, points: [[0.6, 0], [0.6, -0.3]] }, { mode: 'paint', width: 4, k: 100, points: [[-0.98, 0.2]], filament: red }];
  // A ring, as an image model would draw it, in a 16:9 picture.
  const W = 320, H = 180, data = new Uint8Array(W * H * 4).fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.abs(Math.hypot(x - 160, y - 90) - 60) < 4) data.set([0, 0, 0], (y * W + x) * 4);
  const asked: { prompt: string; aspect: string; references: string[] }[] = [];
  const image: Image = async (prompt, aspect, refs) => { asked.push({ prompt, aspect, references: refs! }); return answerOf({ width: W, height: H, data }); };
  const r = await editPicture(request({ values: valuesFor(strokes), mark: undefined, change: 'make it a ring' }), { image });
  assert.equal(r.masked, false);
  assert.equal(r.outsideSame, false);
  assert.equal(r.lineArtJoins, undefined);
  // The drawing as it is, hand edits drawn in, and lineArtEditPrompt, as generate_line_art sends them.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].references.length, 1);
  assert.equal(asked[0].aspect, '16:9');
  assert.match(asked[0].prompt, /^Edit the attached picture: it is black line art for a one-piece wall cut-out, about 200 mm wide/);
  assert.match(asked[0].prompt, /Change only this: make it a ring/);
  assert.equal(r.prompt, asked[0].prompt);
  const sent = raster(asked[0].references[0]), want = drawingPicture(panel, strokes, 1024, 100, 1, 100);
  assert.deepEqual([sent.width, sent.height], [want.width, want.height]);
  assert.deepEqual(sent.data, want.rgba, 'the drawing with its hand edits drawn in');
  // The answer traced: the ring, at the answer's shape.
  const d = parseDrawings(r.set[DRAWINGS_KEY]).panel;
  assert.equal(d.shapes.length, 1);
  assert.equal(d.aspect, W / H);
  // The line drawn is in the new picture; the paint stays, on the new drawing.
  assert.deepEqual(parseLineArtEdits(r.set[LINEART_EDITS_KEY]).panel, { fp: drawingFingerprint(d), strokes: [strokes[1]] });
  assert.equal(r.set[PICTURE_MARKS_KEY], null);
});

test('line-art edits that cannot be made are refused before the image model is asked', async () => {
  const never: Image = async () => { throw new Error('the image model was asked'); };
  const refused = (r: PictureEditRequest, why: RegExp) => assert.rejects(editPicture(r, { image: never }), (e: unknown) => e instanceof PictureEditError && e.status === 400 && why.test((e as Error).message));
  const two: SvgDrawing = { ...panel, shapes: [...panel.shapes, { rule: 'EvenOdd', color: '#ff0000', contours: [box(0.5, 0.2, 0.6, 0.3)] }] };
  await refused(request({ values: { [DRAWINGS_KEY]: JSON.stringify({ panel: two }) } }), /one colour/);
  await refused(request({ picture: 'nope' }), /no drawing "nope"/);
  // The mark's strokes go after the hand edits: together at most MAX_LINEART_STROKES.
  const many = Array.from({ length: MAX_LINEART_STROKES }, (_, i): LineArtStroke => ({ mode: 'erase', width: 1, k: 100, points: [[-0.9 + i * 0.004, 0.4]] }));
  await refused(request({ values: valuesFor(many) }), /hand edits/);
  // Without a mark the strokes are baked, so as many as there are is fine (only the limit to send applies).
  assert.equal(pictureEditPrompt({ mode: 'lineart', change: 'x y z', masked: false, photos: 0, style: 'outline' }).startsWith('Edit the attached picture: it is black line art'), true);
});

test('drawingPicture of a window is that part of the whole picture', () => {
  const strokes: LineArtStroke[] = [{ mode: 'draw', width: 3, k: 100, points: [[0.6, 0], [0.6, -0.3]] }, { mode: 'erase', width: 4, k: 100, points: [[-0.5, 0]] }];
  const whole = drawingPicture(panel, strokes, 200, 100, 1, 100);
  assert.deepEqual(drawingPicture(panel, strokes, 200, 100, 1, 100, wholeWindow(panel)), whole, 'the whole window is the whole picture');
  // Pixels 300..400 across, 40..140 down of the 400 x 200 whole.
  const part = drawingPicture(panel, strokes, 100, 100, 1, 100, { x0: -1 + 300 / 200, y1: 0.5 - 40 / 200, w: 0.5, h: 0.5 });
  assert.deepEqual([part.width, part.height], [100, 100]);
  let differ = 0;
  for (let j = 0; j < 100; j++) for (let i = 0; i < 100; i++) if (Math.abs(part.rgba[(j * 100 + i) * 4] - whole.rgba[((j + 40) * 400 + i + 300) * 4]) > 1) differ++;
  assert.equal(differ, 0);
});
