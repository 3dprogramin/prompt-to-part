import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addStroke, frameAt, inkAt, leanStroke, removeStroke, snapEnd, staleEdits, toDrawing, toPiece, type InkMask } from '../src/lib/lineArtEdit';

// Two drawings side by side: a 2:1 one 50 mm high centred at x = −50, and a square one at x = +50.
const frames = [{ name: 'car', k: 50, tx: -50, ty: 0, fp: 'a' }, { name: 'bike', k: 50, tx: 50, ty: 0, fp: 'b' }];
const aspect = (n: string) => (n === 'car' ? 2 : 1);

test('pointer ↔ drawing units, and the drawing a point belongs to', () => {
  assert.deepEqual(toDrawing(frames[0], [-25, 10]), [0.5, 0.2]);
  assert.deepEqual(toPiece(frames[0], [0.5, 0.2]), [-25, 10]);
  assert.equal(frameAt(frames, [-90, 0], aspect)?.name, 'car');
  assert.equal(frameAt(frames, [40, -20], aspect)?.name, 'bike');
  // Outside both: the nearest (x = 10 is 10 mm from the car's right edge, 15 mm from the bike's left).
  assert.equal(frameAt(frames, [10, 0], aspect)?.name, 'car');
});

test('leanStroke: a wobbly straight line becomes its two ends; close points go', () => {
  const pts: [number, number][] = Array.from({ length: 201 }, (_, i) => [i * 0.1, (i % 2) * 0.03]);
  assert.deepEqual(leanStroke(pts), [[0, 0], [20, 0]]);
  const corner: [number, number][] = [[0, 0], [0.05, 0], [5, 0], [5, 5]];
  assert.deepEqual(leanStroke(corner), [[0, 0], [5, 0], [5, 5]]);
});

test('snapEnd: an end near a line lands inside it, half the width in (at most its middle)', () => {
  // A vertical bar of ink 2 mm wide at x ∈ [10, 12], 0.1 mm cells.
  const w = 200, h = 200, data = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 100; i < 120; i++) data[j * w + i] = 1;
  const m: InkMask = { data, w, h, x0: 0, y1: 20, res: 0.1 };
  assert.ok(inkAt(m, [11, 5]) && !inkAt(m, [9, 5]));
  const s = snapEnd(m, [9, 5], [0, 5], 1, 1.5)!;
  assert.ok(Math.abs(s[0] - 10.5) < 1e-6 && Math.abs(s[1] - 5) < 1e-6, `snapped to ${s}`);
  // A thick brush ends on the middle of the line, not through it.
  const t = snapEnd(m, [9, 5], [0, 5], 4, 1.5)!;
  assert.ok(Math.abs(t[0] - 11) < 1e-6, `snapped to ${t}`);
  assert.equal(snapEnd(m, [7, 5], [0, 5], 1, 1.5), null); // too far
  assert.equal(snapEnd(m, [11, 5], [0, 5], 1, 1.5), null); // on the ink already
});

test('edits: add, undo, strokes of an earlier drawing', () => {
  const st = { mode: 'draw' as const, width: 1, points: [[0, 0], [0.1, 0]] as [number, number][] };
  let e = addStroke({ car: { fp: 'old', strokes: [st, st] } }, 'bike', 'b', st);
  assert.deepEqual(staleEdits(e, frames), { names: ['car'], strokes: 2 });
  e = addStroke(e, 'car', 'a', st);
  assert.deepEqual(e.car, { fp: 'a', strokes: [st] });
  e = removeStroke(removeStroke(e, 'car', st), 'bike', st);
  assert.deepEqual(e, {});
});
