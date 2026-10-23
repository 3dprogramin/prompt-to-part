import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import { withFonts } from '../shared/text';
import { loadFontBuffers } from '../server/fonts';
import { DRAWINGS_KEY, type SvgDrawing } from '../shared/svgFeatures';
import { colourStrokes, drawingFingerprint, drawingPicture, LINEART_EDITS_KEY, parseLineArtEdits, type LineArtStroke } from '../shared/lineart';
import { clearArea } from '../src/lib/lineArtEdit';
import type { PartMesh, Vec2 } from '../shared/types';

// The frame of lineArtFill.test.ts: a 2:1 rectangle outline, 200 × 100 mm, its lines 2 mm wide.
const box = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const frame: SvgDrawing = { name: 'frame', aspect: 2, shapes: [{ rule: 'EvenOdd', contours: [box(-1, -0.5, 1, 0.5), box(-0.98, -0.48, 0.98, 0.48)], color: '#000000' }] };
const fp = drawingFingerprint(frame);
const red = { color: '#ff0000', name: 'Red' };
const build = (strokes: LineArtStroke[], opts = "style: 'outline', width: 200") => evaluateScript(`function build() { return H.lineart('frame', { ${opts} }); }`,
  { [DRAWINGS_KEY]: JSON.stringify({ frame }), [LINEART_EDITS_KEY]: JSON.stringify({ frame: { fp, strokes } }) }, 'draft');
const total = (parts: PartMesh[]) => parts.reduce((v, p) => v + p.volume, 0);
const close = (a: number, b: number, what: string, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(2)} mm³, want ${b.toFixed(2)}`);
// Strokes on the left and the right half of the frame: a line drawn, the top line erased, paint, a fill.
const left: LineArtStroke[] = [
  { mode: 'draw', width: 2, points: [[-0.6, -0.48], [-0.6, 0.48]] },
  { mode: 'erase', width: 4, points: [[-0.4, 0.49], [-0.3, 0.49]] },
  { mode: 'paint', width: 4, points: [[-0.99, -0.2], [-0.99, 0.2]], filament: red },
  { mode: 'fill', width: 8, points: [[-0.8, 0.45], [-0.7, 0.45]], filament: red },
];
const right: LineArtStroke[] = [{ mode: 'draw', width: 2, points: [[0.6, -0.48], [0.6, 0.48]], filament: red }];
// A 50 mm brush down and up the left half: all of it from x -110 to -20 mm (widths in mm, points in units of 100 mm).
const clearLeft: LineArtStroke = { mode: 'restore', width: 50, points: [[-0.85, -0.6], [-0.85, 0.6], [-0.45, 0.6], [-0.45, -0.6]] };

test('restore strokes: parsed without a filament, kept when the drawing is redrawn, the drawing as it was in its picture', () => {
  assert.deepEqual(parseLineArtEdits({ a: { fp: 'x', strokes: [{ mode: 'restore', width: 6, points: [[0, 0]], filament: red }] } }).a.strokes, [{ mode: 'restore', width: 6, points: [[0, 0]] }]);
  // (Kept after the colours before it, so they stay off there.)
  const paint: LineArtStroke = { mode: 'paint', points: [[0, 0]], filament: red };
  assert.deepEqual(colourStrokes([paint, clearLeft]), [paint, clearLeft]);
  assert.deepEqual(colourStrokes([{ mode: 'erase', points: [[0, 0]] }, clearLeft]), []);
  // Drawn and erased, then cleared: the picture is the drawing's own.
  const pic = (strokes: LineArtStroke[]) => drawingPicture(frame, strokes, 64, 100, 2).rgba;
  assert.deepEqual(pic([...left, clearLeft]), pic([]));
  assert.notDeepEqual(pic(left), pic([]));
});

test('restore: under it the piece is as Jig made it, elsewhere the edits stay, later strokes apply', () => {
  const plain = build([]).parts;
  // All of the left half's edits taken back: as with no edits at all, in one filament.
  const none = build([...left, clearLeft]).parts;
  assert.deepEqual(none.map((p) => p.name), ['Line art']);
  close(none[0].volume, plain[0].volume, 'cleared');
  assert.equal(none[0].lineArt?.edits, 4, 'a clear is no hand edit');
  // The right half's line in red stays.
  const kept = build([...right, ...left, clearLeft]).parts, only = build(right).parts;
  assert.deepEqual(kept.map((p) => p.name), only.map((p) => p.name));
  close(total(kept), total(only), 'the right line kept');
  close(kept[1].volume, only[1].volume, 'still red');
  // A brush over half the erased gap brings that half back.
  const gap = build([left[1]]).parts[0].volume, half = build([left[1], { mode: 'restore', width: 6, points: [[-0.3, 0.49], [-0.25, 0.49]] }]).parts[0].volume;
  assert.ok(half > gap + 0.5 && half < plain[0].volume - 0.5, `half the gap back: ${gap.toFixed(1)} < ${half.toFixed(1)} < ${plain[0].volume.toFixed(1)}`);
  // A stroke after the clear applies.
  const after = build([...left, clearLeft, left[0]]).parts, drawn = build([left[0]]).parts;
  close(after[0].volume, drawn[0].volume, 'drawn again');
});

test('restore on a split piece: each piece as Jig made it', async () => {
  const opts = "style: 'outline', width: 400, split: 'auto'";
  const plain = await withFonts(() => build([], opts), loadFontBuffers);
  // (1 unit = 200 mm here: the 50 mm brush in four passes.)
  const wide: LineArtStroke = { mode: 'restore', width: 50, points: [-0.95, -0.75, -0.55, -0.35].flatMap((x, i): [number, number][] => (i % 2 ? [[x, 0.6], [x, -0.6]] : [[x, -0.6], [x, 0.6]])) };
  const r = await withFonts(() => build([...left, wide], opts), loadFontBuffers);
  assert.deepEqual(r.parts.map((p) => p.name), plain.parts.map((p) => p.name));
  close(total(r.parts), total(plain.parts), 'cleared', 0.2);
});

test('clearArea: a restore per selection stroke after the edits, less the strokes all under it and a restore touching nothing', () => {
  // Radii in the drawing's units (1 unit = 100 mm).
  const reach = (st: LineArtStroke) => (st.width ?? 3) / 2 / 100;
  const [line, gap, paint, fill] = left;
  // All of the left half's edits under it: none left, nor the restore.
  assert.deepEqual(clearArea(left, [clearLeft], reach), []);
  // The right half's line stays, with no restore (it touched only what went).
  assert.deepEqual(clearArea([...right, ...left], [clearLeft], reach), right);
  // Half the erased gap: the erase stays, the restore after it.
  const half: LineArtStroke = { mode: 'restore', width: 6, points: [[-0.3, 0.49], [-0.25, 0.49]] };
  assert.deepEqual(clearArea([line, gap], [half], reach), [line, gap, half]);
  // Nowhere near an edit: nothing changes.
  assert.deepEqual(clearArea([paint, fill], [{ mode: 'restore', width: 6, points: [[0.5, 0]] }], reach), [paint, fill]);
});
