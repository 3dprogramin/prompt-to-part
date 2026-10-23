import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import { DRAWINGS_KEY, type SvgDrawing } from '../shared/svgFeatures';
import { drawingFingerprint, drawingPicture, LINEART_DEPTH_KEY, LINEART_EDITS_KEY, parseLineArtEdits, type LineArtStroke } from '../shared/lineart';
import { clearArea, removeStroke } from '../src/lib/lineArtEdit';
import type { Vec2 } from '../shared/types';
import { downAbove, holes, skins, slits } from './lineArtGeom';

// The frame of lineArtFill.test.ts: a 2:1 rectangle outline, 200 × 100 mm, its lines 2 mm wide
// (the top one from y 48 to 50 mm, the left one from x −100 to −98 mm; 1 unit = 100 mm).
const box = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const frame: SvgDrawing = { name: 'frame', aspect: 2, shapes: [{ rule: 'EvenOdd', contours: [box(-1, -0.5, 1, 0.5), box(-0.98, -0.48, 0.98, 0.48)], color: '#000000' }] };
const fp = drawingFingerprint(frame);
const red = { color: '#ff0000', name: 'Red' };
const stroke = (mode: LineArtStroke['mode'], width: number, points: [number, number][], square = true, filament?: typeof red): LineArtStroke =>
  ({ mode, width, points, ...(filament ? { filament } : {}), ...(square ? { shape: 'square' as const } : {}) });
const build = (strokes: LineArtStroke[], quality: 'draft' | 'normal' = 'draft', depth?: string) => evaluateScript(`function build() { return H.lineart('frame', { style: 'outline', width: 200 }); }`,
  { [DRAWINGS_KEY]: JSON.stringify({ frame }), [LINEART_EDITS_KEY]: JSON.stringify({ frame: { fp, strokes } }), ...(depth ? { [LINEART_DEPTH_KEY]: depth } : {}) }, quality).parts;
const plain = build([])[0];

test('square brush: parsed and kept per stroke, a drawn line always round, old strokes unchanged', () => {
  const raw = { a: { fp: 'x', strokes: [
    { mode: 'paint', width: 3, points: [[0, 0]], shape: 'square', filament: red },
    { mode: 'fill', points: [[0, 0]], shape: 'square' },
    { mode: 'erase', points: [[0, 0]], shape: 'square' },
    { mode: 'restore', points: [[0, 0]], shape: 'square' },
    { mode: 'draw', points: [[0, 0]], shape: 'square' },
    { mode: 'paint', points: [[0, 0]], shape: 'star' },
  ] } };
  assert.deepEqual(parseLineArtEdits(raw).a.strokes.map((st) => st.shape ?? 'round'), ['square', 'square', 'square', 'square', 'round', 'round']);
  const old = { a: { fp: 'x', strokes: [{ mode: 'draw', width: 1.2, points: [[0, 0]] }, { mode: 'paint', points: [[0, 0]], filament: red }, { mode: 'fill', width: 4, points: [[0, 0], [0.1, 0]] }] } };
  assert.deepEqual(parseLineArtEdits(JSON.stringify(old)), old);
  // Undo tells a square stroke from a round one on the same path.
  const sq = stroke('paint', 3, [[0, 0]]), rd = stroke('paint', 3, [[0, 0]], false);
  assert.deepEqual(removeStroke({ a: { fp: 'x', strokes: [rd, sq] } }, 'a', { ...rd }).a.strokes, [sq]);
  // Clear edits here: a square's corners reach past the round it fits in.
  const reach = (st: LineArtStroke) => (st.width ?? 3) / 2;
  const sel = [stroke('restore', 10, [[0, 0]], false)];
  assert.equal(clearArea([stroke('paint', 6, [[0, 0]], false)], sel, reach).length, 0, 'a round stroke under the selection goes (the selection with it)');
  assert.equal(clearArea([stroke('paint', 6, [[0, 0]])], sel, reach).length, 2, 'a square one sticks out of it: kept, cleared there');
});

test('square brush: a fill and a paint cover their squares, erasing takes a square out', () => {
  // A 8 mm square along y 45 mm from x −30 to 30: below the top line (from y 48) it adds 68 × 7 mm, 2 mm thick.
  const fill = build([stroke('fill', 8, [[-0.3, 0.45], [0.3, 0.45]], true, red)]);
  assert.deepEqual(fill.map((p) => p.name), ['Line art', 'Line art (Red)']);
  assert.ok(Math.abs(fill[1].volume - 68 * 7 * 2) < 1, `red ${fill[1].volume.toFixed(2)} mm³, ${68 * 7 * 2} for the square`);
  assert.ok(Math.abs(fill[0].volume - plain.volume) < 0.05, 'the outline as it was');
  assert.equal(skins(fill[0], fill[1]), 0);
  // Round, the same stroke has round ends: less.
  const round = build([stroke('fill', 8, [[-0.3, 0.45], [0.3, 0.45]], false, red)])[1];
  assert.ok(round.volume < fill[1].volume - 20, `round ${round.volume.toFixed(1)} mm³`);
  // A 4 mm square on the top line, from x −10 to 10 mm: 24 mm of it red, through.
  const paint = build([stroke('paint', 4, [[-0.1, 0.49], [0.1, 0.49]], true, red)]);
  assert.ok(Math.abs(paint[1].volume - 24 * 2 * 2) < 1, `red ${paint[1].volume.toFixed(2)} mm³, ${24 * 2 * 2} for the square`);
  assert.ok(Math.abs(paint[0].volume + paint[1].volume - plain.volume) < 0.05, 'paint adds nothing');
  // Shift's straight line slanted, up to the top line: the square swept along it (a hexagon, 4² +
  // 4 × (40 + 4.5) mm²), less its bit over the line (from x 13.6 mm, 0.5 mm high).
  const slant = build([stroke('fill', 4, [[-0.2, 0.42], [0.2, 0.465]], true, red)])[1];
  const hexagon = (16 + 4 * (40 + 4.5) - (0.5 * (4 + 22 - (-22 + 40 * (4 / 4.5)))) / 2) * 2;
  assert.ok(Math.abs(slant.volume - hexagon) / hexagon < 0.02, `slanted ${slant.volume.toFixed(1)} mm³, ${hexagon.toFixed(1)} for the square swept`);
  // Erasing across the top line with a 6 mm square at x 0: that much of the line goes.
  const erased = build([stroke('erase', 6, [[0, 0.49]])])[0];
  assert.ok(Math.abs(plain.volume - erased.volume - 6 * 2 * 2) < 2, `${(plain.volume - erased.volume).toFixed(1)} mm³ erased, ${6 * 2 * 2} for the square`);
});

test('square brush: the image model picture has the square erased', () => {
  // A solid square drawing, 100 px high, erased in its middle with a 20 mm brush (1 px a mm).
  const blob: SvgDrawing = { name: 'blob', aspect: 1, shapes: [{ rule: 'EvenOdd', contours: [box(-0.5, -0.5, 0.5, 0.5)], color: '#000000' }] };
  const white = (strokes: LineArtStroke[]) => { const p = drawingPicture(blob, strokes, 100, 100); let n = 0; for (let i = 0; i < p.rgba.length; i += 4) n += p.rgba[i] > 127 ? 1 : 0; return n; };
  const sq = white([stroke('erase', 20, [[0, 0]])]), rd = white([stroke('erase', 20, [[0, 0]], false)]);
  assert.ok(Math.abs(sq - 400) < 30, `square ${sq} px white, 400`);
  assert.ok(Math.abs(rd - 100 * Math.PI) < 30, `round ${rd} px white, ${(100 * Math.PI).toFixed(0)}`);
});

test('square brush in corners and across lines: no slit, hole or skin, the own filament one body', () => {
  const frameHoles = holes(build([], 'normal')[0]);
  // A square fill into the frame's top-left corner, over the lines' inner corner and exactly up to
  // them, through and in the top 3 layers. (The holes counted from the mesh through only: in the
  // top layers its points split where the slot meets the lines, though it is one body with one hole.)
  for (const depth of [undefined, '3']) {
    for (const st of [stroke('fill', 8, [[-0.96, 0.46], [-0.9, 0.46]], true, red), stroke('fill', 6, [[-0.95, 0.45], [-0.9, 0.45]], true, red)]) {
      const parts = build([st], 'normal', depth), own = parts[0], what = `${st.width} mm fill, ${depth ?? 'through'}`;
      assert.equal(parts.length, 2, what);
      assert.equal(slits(own), 0, `${what}: no slit`);
      if (!depth) assert.equal(holes(own), frameHoles, `${what}: no hole more than the frame has`);
      assert.ok(downAbove(own) < 1e-3, `${what}: its own filament one body (${downAbove(own).toFixed(4)} mm² looking down)`);
      if (!depth) assert.equal(skins(own, parts[1]), 0, `${what}: no skin`);
      assert.equal(parts[1].components, 1, `${what}: the fill one piece`);
    }
  }
  // A square paint ending across the top line, in the top 3 layers.
  const across = build([stroke('paint', 3, [[0, 0.49], [0.1, 0.495]], true, red)], 'normal', '3');
  assert.equal(across.length, 2);
  assert.equal(slits(across[0]), 0, 'no slit where the red ends');
  assert.ok(downAbove(across[0]) < 1e-3, `its own filament one body (${downAbove(across[0]).toFixed(4)} mm² looking down)`);
});
