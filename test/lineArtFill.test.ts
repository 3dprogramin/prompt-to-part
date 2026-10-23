import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import { withFonts } from '../shared/text';
import { loadFontBuffers } from '../server/fonts';
import { DRAWINGS_KEY, type SvgDrawing } from '../shared/svgFeatures';
import { cleanLineArtInfo, colourStrokes, drawingFingerprint, LINEART_DEPTH_KEY, LINEART_EDITS_KEY, parseLineArtEdits, type LineArtStroke } from '../shared/lineart';
import { withoutColours } from '../src/lib/lineArtEdit';
import type { PartMesh, Vec2 } from '../shared/types';
import { downAbove, holes, skins, slits } from './lineArtGeom';

// The frame of lineArtColour.test.ts: a 2:1 rectangle outline, 200 × 100 mm, its lines 2 mm wide
// (the top one from y 48 to 50 mm, 1 unit = 100 mm).
const box = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const frame: SvgDrawing = { name: 'frame', aspect: 2, shapes: [{ rule: 'EvenOdd', contours: [box(-1, -0.5, 1, 0.5), box(-0.98, -0.48, 0.98, 0.48)], color: '#000000' }] };
const fp = drawingFingerprint(frame);
const red = { color: '#ff0000', name: 'Red' }, blue = { color: '#0000ff', name: 'Blue' };
const fill = (y: number, x0: number, x1: number, filament?: typeof red, width = 8): LineArtStroke => ({ mode: 'fill', width, points: [[x0, y], [x1, y]], ...(filament ? { filament } : {}) });
const build = (strokes: LineArtStroke[], opts = "style: 'outline', width: 200", extra: Record<string, string> = {}) => evaluateScript(`function build() { return H.lineart('frame', { ${opts} }); }`,
  { [DRAWINGS_KEY]: JSON.stringify({ frame }), [LINEART_EDITS_KEY]: JSON.stringify({ frame: { fp, strokes } }), ...extra }, 'draft');
const total = (parts: PartMesh[]) => parts.reduce((v, p) => v + p.volume, 0);
const plain = build([]).parts[0];
// An 8 mm brush along y 45 mm from x −30 to 30 (its round ends 12-sided, as the draft quality
// builds them) reaches 1 mm into the top line: what it adds is the brush below y 48, 2 mm thick.
const segment = (r: number, d: number) => r * r * Math.acos(d / r) - d * Math.sqrt(r * r - d * d);
const added = (60 * 8 + 3 * 16 - (60 + segment(4, 3))) * 2;

test('fill strokes: parsed and checked like paint, old edits unchanged, kept when the drawing is redrawn', () => {
  const raw = { a: { fp: 'x', strokes: [
    { mode: 'fill', width: 4, points: [[0, 0], [0.1, 0]], filament: { color: '#FF0000', name: 'Red', extra: 1 } },
    { mode: 'fill', width: 99, points: [[0, 0]] },
    { mode: 'fill', points: [] },
  ] } };
  assert.deepEqual(parseLineArtEdits(raw).a.strokes, [
    { mode: 'fill', width: 4, points: [[0, 0], [0.1, 0]], filament: { color: '#ff0000', name: 'Red' } },
    { mode: 'fill', points: [[0, 0]] },
  ]);
  const old = { a: { fp: 'x', strokes: [{ mode: 'draw', width: 1.2, points: [[0, 0]] }, { mode: 'paint', points: [[0, 0]], filament: red }] } };
  assert.deepEqual(parseLineArtEdits(JSON.stringify(old)), old);
  // The image model gets no fills in its picture: they stay, and fill the new drawing.
  assert.deepEqual(colourStrokes([{ mode: 'erase', points: [[0, 0]] }, fill(0, 0, 1)]), [fill(0, 0, 1)]);
  // Remove colours keeps the material, in the piece's own filament.
  assert.deepEqual(withoutColours({ frame: { fp, strokes: [fill(0, 0, 1, red)] } }, ['frame']).frame.strokes, [fill(0, 0, 1)]);
  assert.equal(cleanLineArtInfo({ style: 'outline', sources: ['a'], size: [1, 1], thickness: 2, lineWidth: 1, longestBridge: 0, fillsLoose: 2 })?.fillsLoose, 2);
});

test('fill inside an outline: material only where there was none, in its filament, the outline untouched', () => {
  const r = build([fill(0.45, -0.3, 0.3, red)]);
  assert.deepEqual(r.parts.map((p) => [p.name, p.color]), [['Line art', '#1d1d1f'], ['Line art (Red)', '#ff0000']]);
  const [own, col] = r.parts;
  assert.ok(Math.abs(col.volume - added) / added < 0.01, `red ${col.volume.toFixed(1)} mm³, about ${added.toFixed(1)}`);
  assert.ok(Math.abs(own.volume - plain.volume) < 0.05, `the outline ${own.volume.toFixed(2)} mm³ as it was (${plain.volume.toFixed(2)})`);
  assert.ok(col.bbox.max[1] <= own.bbox.max[1] - 2 + 1e-3, 'not over the top line');
  assert.ok(Math.abs(col.bbox.max[2] - 2) < 1e-6 && Math.abs(col.bbox.min[2]) < 1e-6, 'as thick as the lines');
  assert.equal(own.lineArt?.components, 1, 'one piece with the line it touches');
  assert.equal(col.components, 1);
  assert.deepEqual(own.lineArt?.colours, [red]);
  assert.equal(skins(own, col), 0, 'no wall of one part on the other');
  // In the piece's own filament: the same material, one part.
  const black = build([fill(0.45, -0.3, 0.3)]).parts;
  assert.equal(black.length, 1);
  assert.ok(Math.abs(black[0].volume - plain.volume - added) / added < 0.01);
  assert.ok(skins(plain, black[0]) > 0, 'the check sees parts on one another');
  // Over a line: nothing to fill.
  const on = build([fill(0.49, -0.3, 0.3, red, 1.5)]).parts;
  assert.deepEqual(on.map((p) => p.name), ['Line art']);
  assert.ok(Math.abs(on[0].volume - plain.volume) < 1e-6);
});

test('fill: a loose island goes, later strokes in order (erase, fill again, paint, the own filament)', () => {
  // In the middle of the frame, touching nothing: it would fall off.
  const island = build([fill(0, -0.1, 0.1, red)]);
  assert.deepEqual(island.parts.map((p) => p.name), ['Line art']);
  assert.equal(island.parts[0].lineArt?.fillsLoose, 1);
  // Joined to the top line by a second fill: kept, both red.
  const joined = build([fill(0, -0.1, 0.1, red), { ...fill(0, 0, 0, red, 4), points: [[0, 0], [0, 0.47]] }]).parts;
  assert.equal(joined.length, 2);
  assert.equal(joined[0].lineArt?.fillsLoose, undefined);
  assert.equal(joined[1].components, 1);
  // An erase across it after: the part cut off the line goes (it would fall off), the strip on the line stays.
  const cut: LineArtStroke = { mode: 'erase', width: 1, points: [[-0.35, 0.465], [0.35, 0.465]] };
  const erased = build([fill(0.45, -0.3, 0.3, red), cut]).parts;
  assert.equal(erased[0].lineArt?.fillsLoose, 1);
  assert.ok(erased[1].volume < 0.2 * added && erased[1].volume > 0.05 * added, `${erased[1].volume.toFixed(1)} mm³ left red`);
  // Filled again after the erase: whole again.
  const again = build([fill(0.45, -0.3, 0.3, red), cut, fill(0.465, -0.3, 0.3, red, 1.4)]).parts;
  assert.equal(again[0].lineArt?.fillsLoose, undefined);
  assert.ok(Math.abs(again[1].volume - added) / added < 0.03, `${again[1].volume.toFixed(1)} mm³ red again`);
  // Paint over the fill recolours it; paint in the piece's own filament takes its colour off (the material stays).
  const blued = build([fill(0.45, -0.3, 0.3, red), { mode: 'paint', width: 4, points: [[0, 0.42], [0, 0.44]], filament: blue }]).parts;
  assert.deepEqual(blued.map((p) => p.name), ['Line art', 'Line art (Red)', 'Line art (Blue)']);
  assert.ok(Math.abs(blued[1].volume + blued[2].volume - added) / added < 0.01, 'red and blue are the fill');
  assert.ok(Math.abs(blued[0].volume - plain.volume) < 0.05);
  const off = build([fill(0.45, -0.3, 0.3, red), { mode: 'paint', width: 10, points: [[-0.3, 0.45], [0.3, 0.45]] }]).parts;
  assert.equal(off.length, 1);
  assert.ok(Math.abs(off[0].volume - plain.volume - added) / added < 0.01);
});

test('fill in the top layers, and on a split piece: each piece fills its part, in its colour', async () => {
  const top = build([fill(0.45, -0.3, 0.3, red)], undefined, { [LINEART_DEPTH_KEY]: '3' }).parts;
  assert.equal(top.length, 2);
  assert.ok(Math.abs(top[1].bbox.min[2] - 1.4) < 1e-6, 'the top 3 layers red');
  assert.ok(Math.abs(total(top) - plain.volume - added) / added < 0.01, 'the fill is as thick as the lines, its own filament under the red');
  assert.ok(downAbove(top[0]) < 1e-3, 'its own filament one body, its layers joined (no face left between them)');
  // Paint ending across the top line: no slit in the piece's own filament where it ends.
  const across = build([{ mode: 'paint', width: 3, points: [[0, 0.49], [0.1, 0.495]], filament: red }], undefined, { [LINEART_DEPTH_KEY]: '3' }).parts;
  assert.equal(slits(across[0]), 0, 'no slit where the red ends');
  // 400 mm wide, in two pieces; the fill runs across the middle, where the seam is (lines 4 mm, the top one from 96 mm).
  const r = await withFonts(() => build([fill(0.47, -0.3, 0.3, red)], "style: 'outline', width: 400, split: 'auto'"), loadFontBuffers);
  assert.deepEqual(r.parts.map((p) => p.name), ['A1', 'A1 (Red)', 'A2', 'A2 (Red)']);
  const whole = await withFonts(() => build([], "style: 'outline', width: 400, split: 'auto'"), loadFontBuffers);
  const reds = r.parts.filter((p) => p.lineArt?.paintedIn).reduce((v, p) => v + p.volume, 0);
  const want = (120 * 8 + 3 * 16 - (240 + segment(4, 2))) * 2;
  assert.ok(Math.abs(reds - want) / want < 0.03, `red ${reds.toFixed(0)} mm³ over the pieces, about ${want.toFixed(0)}`);
  assert.ok(Math.abs(total(r.parts) - total(whole.parts) - reds) < 1, 'only the fill added');
});

test('fill up to a round line: no crack between them, no skin of one part on the other', () => {
  // A ring (like a bottle's outline) filled inside: where the fill ends on its round edge.
  const circle = (r: number): Vec2[] => Array.from({ length: 96 }, (_, k) => [r * Math.cos((k / 96) * 2 * Math.PI), r * Math.sin((k / 96) * 2 * Math.PI)]);
  const ring: SvgDrawing = { name: 'ring', aspect: 1, shapes: [{ rule: 'EvenOdd', contours: [circle(0.45), circle(0.4)], color: '#000000' }] };
  const run = (strokes: LineArtStroke[]) => evaluateScript(`function build() { return H.lineart('ring', { style: 'outline', width: 60 }); }`,
    { [DRAWINGS_KEY]: JSON.stringify({ ring }), [LINEART_EDITS_KEY]: JSON.stringify({ ring: { fp: drawingFingerprint(ring), strokes } }) }, 'draft').parts;
  // Brushed in rows 2 mm apart with a 4 mm brush, each row's ends a little over the ring, as by hand.
  const rows: LineArtStroke[] = [];
  for (let y = -22; y <= 22; y += 2) { const x = Math.sqrt(24 * 24 - y * y) - 1.5; rows.push({ mode: 'fill', width: 4, points: [[-x / 60, y / 60], [x / 60, y / 60 + 0.004]], filament: red }); }
  const parts = run(rows);
  assert.deepEqual(parts.map((p) => p.name), ['Line art', 'Line art (Red)']);
  assert.equal(parts[0].components, 1, 'the ring in one body (a crack along the fill left a sliver of it)');
  // (Less a seal 0.2 µm deep along the ring, where the fill meets it.)
  assert.ok(Math.abs(parts[0].volume - run([])[0].volume) < 0.1, 'the ring as it was');
  // (A few specks of walls, a fraction of a mm long, where a hair of the ring went to the fill.)
  assert.ok(skins(parts[0], parts[1]) <= 6);
});

test('fill up to the lines: no pinhole left where it ends on them', () => {
  // By the frame's top-left corner, in the piece's own filament (rounder than a draft, as the view
  // builds it: there a disc's opening left a hole where the brush's end meets the top line).
  const run = (strokes: LineArtStroke[]) => evaluateScript(`function build() { return H.lineart('frame', { style: 'outline', width: 200 }); }`,
    { [DRAWINGS_KEY]: JSON.stringify({ frame }), [LINEART_EDITS_KEY]: JSON.stringify({ frame: { fp, strokes } }) }, 'normal').parts;
  assert.equal(holes(run([fill(0.45, -0.99, -0.92)])[0]), holes(run([])[0]), 'no hole more than the frame has');
});
