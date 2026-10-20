import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import { withFonts } from '../shared/text';
import { loadFontBuffers } from '../server/fonts';
import { DRAWINGS_KEY, type SvgDrawing } from '../shared/svgFeatures';
import { cleanLineArtInfo, drawingFingerprint, isLineArt, lineArtMask, LINE_ART_STYLES, LINEART_EDITS_KEY, parseLineArtEdits, rasterize, traceMask, type LineArtGrid } from '../shared/lineart';
import type { Vec2 } from '../shared/types';

const circle = (cx: number, cy: number, r: number, n = 48): Vec2[] => Array.from({ length: n }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]);
const ring = (cx: number, cy: number, r: number, w: number) => [circle(cx, cy, r + w / 2), circle(cx, cy, r - w / 2)];
const box = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// A "bike" 2 units wide, 1 high: two wheels joined by a frame bar, a loose hub in each wheel (to be
// bridged) and a speck too small to print (to be dropped). Lines are 0.015 units (1.5 mm at 100 mm high).
const bike: SvgDrawing = {
  name: 'bike', aspect: 2,
  shapes: [
    { rule: 'EvenOdd', contours: [...ring(-0.6, -0.1, 0.38, 0.015), ...ring(0.6, -0.1, 0.38, 0.015), circle(-0.6, -0.1, 0.04), circle(0.6, -0.1, 0.04), circle(0, 0, 0.003)], color: '#000000' },
    { rule: 'NonZero', contours: [box(-0.6, 0.3, 0.6, 0.315), box(-0.6075, 0.27, -0.5925, 0.31), box(0.5925, 0.27, 0.6075, 0.31)], color: '#000000' },
  ],
};
const values = { [DRAWINGS_KEY]: JSON.stringify({ bike }) };
const run = (opts: string) => evaluateScript(`function build() { return H.lineart('bike', { ${opts} }); }`, values, 'draft');

test('lineArtMask: even lines, loose bits bridged to the frame, specks dropped, one piece', () => {
  const g: LineArtGrid = { px: 0.2, x0: -12, y1: 12, w: 120, h: 120 };
  const art = rasterize([...ring(0, 0, 6, 2), circle(0, 0, 1.5), circle(4, 0, 0.2)], g);
  const frame = rasterize([box(-11, -11, 11, 11), box(-9, -9, 9, 9)], g);
  const m = lineArtMask(art, frame, g, { lineWidth: 1, fill: 3, minIsland: 4, lines: 'even' });
  // The ring to the frame and the hub (7 mm²) to the ring; the 0.13 mm² speck goes.
  assert.equal(m.bridges, 2);
  assert.equal(m.dropped, 1);
  assert.ok(m.longestBridge > 1 && m.longestBridge < 4, `longest bridge ${m.longestBridge}`);
  // The 2 mm ring is redrawn about 1 mm wide: a row through its side crosses ~5 pixels.
  const row = 60 * g.w, xs = [];
  for (let i = 0; i < 60; i++) if (m.mask[row + i]) xs.push(i);
  const ringPx = xs.filter((i) => i > 20 && i < 40).length;
  assert.ok(ringPx >= 4 && ringPx <= 7, `ring ${ringPx} px wide`);
  const loops = traceMask(m.mask, g, 0.07);
  assert.ok(loops.length >= 2 && loops.every((l) => l.length >= 3));
});

test('lineArtMask: a dangling line is joined to the line ahead of it', () => {
  const g: LineArtGrid = { px: 0.2, x0: -12, y1: 9, w: 120, h: 90 };
  // A rectangle outline with a line from its left side that stops 3.5 mm short of the right side.
  const art = () => rasterize([box(-10, -6, 10, 6), box(-9, -5, 9, 5), box(-9.2, -0.5, 5.5, 0.5)], g);
  const joined = lineArtMask(art(), null, g, { lineWidth: 1, fill: 3, minIsland: 4, lines: 'keep', joinEnds: 8 });
  assert.equal(joined.endsJoined, 1);
  assert.equal(joined.endsFree, 0);
  // The join runs on to the right side: the row through the line is solid from it to the edge.
  const row = Math.round((9 - 0) / 0.2 - 0.5) * g.w;
  for (let x = 6; x < 9; x += 0.4) assert.equal(joined.mask[row + Math.floor((x + 12) / 0.2)], 1, `joined at x = ${x.toFixed(1)}`);
  const off = lineArtMask(art(), null, g, { lineWidth: 1, fill: 3, minIsland: 4, lines: 'keep', joinEnds: 0 });
  assert.equal(off.endsJoined, 0);
});

test('H.lineart: every style builds one connected piece', async () => {
  for (const style of LINE_ART_STYLES) {
    const r = await withFonts(() => run(`style: '${style}', width: 210${style === 'sign' ? ", text: 'Garage'" : ''}`), loadFontBuffers);
    const piece = r.parts[0];
    assert.equal(piece.components, 1, `${style}: one piece`);
    assert.equal(r.parts.length, style === 'stand' ? 2 : 1, `${style}: parts`);
    const la = piece.lineArt!;
    assert.equal(la.style, style);
    assert.equal(la.bridges >= 2, true, `${style}: hubs bridged (${la.bridges})`);
    assert.equal(la.dropped, 1, `${style}: speck dropped`);
    assert.ok(Math.abs(piece.bbox.max[0] - piece.bbox.min[0] - 210) < 1.5, `${style}: ${piece.bbox.max[0] - piece.bbox.min[0]} mm wide`);
    assert.ok(piece.bbox.min[2] === 0);
    assert.equal(r.print.infill, 100);
  }
});

test('H.lineart: key holder pegs, thickness and a helpful error', () => {
  const r = run("style: 'keyholder', width: 210, thickness: 2, hookLength: 15");
  assert.equal(r.parts[0].lineArt!.hooks, 3);
  assert.ok(Math.abs(r.parts[0].bbox.max[2] - 19) < 0.01, 'bar 4 mm + 15 mm pegs');
  assert.throws(() => evaluateScript("function build() { return H.lineart('car', {}); }", values, 'draft'), /no drawing named "car" \(drawings: "bike"\)/);
});

test('hand edits: drawn lines join, erasing has the last word, frames map the drawing into the piece', () => {
  const fp = drawingFingerprint(bike);
  const edit = (strokes: unknown[]) => evaluateScript("function build() { return H.lineart('bike', { style: 'outline', width: 210 }); }", { ...values, [LINEART_EDITS_KEY]: JSON.stringify({ bike: { fp, strokes } }) }, 'draft');
  const plain = run("style: 'outline', width: 210").parts[0].lineArt!;
  // A line from the left hub up to its wheel: one bridge fewer.
  const drawn = edit([{ mode: 'draw', points: [[-0.6, -0.1], [-0.6, 0.27]] }]).parts[0];
  assert.equal(drawn.lineArt!.edits, 1);
  assert.equal(drawn.lineArt!.bridges, plain.bridges - 1);
  assert.equal(drawn.components, 1);
  // Erasing across the frame bar between the wheels cuts the piece in two, whatever Jig bridged.
  const cut = edit([{ mode: 'erase', width: 4, points: [[0, 0.25], [0, 0.4]] }]).parts[0];
  assert.equal(cut.components, 2);
  // Frames: the drawing's (−0.6, −0.1) hub centre maps into the piece where the left hub is.
  const f = cut.lineArt!.frames[0];
  assert.equal(f.fp, fp);
  const hx = -0.6 * f.k + f.tx;
  assert.ok(hx < -50 && hx > -100, `hub at x = ${hx}`);
  // Edits for another drawing (an old fingerprint) are left out.
  const stale = evaluateScript("function build() { return H.lineart('bike', { style: 'outline', width: 210 }); }", { ...values, [LINEART_EDITS_KEY]: JSON.stringify({ bike: { fp: 'old', strokes: [{ mode: 'erase', points: [[0, 0.3]] }] } }) }, 'draft');
  assert.equal(stale.parts[0].lineArt!.edits, 0);
  assert.deepEqual(parseLineArtEdits('{"x":{"fp":"a","strokes":[{"mode":"paint","points":[[0,0]]},{"mode":"draw","width":99,"points":[[0,0],[1,"y"]]}]}}'), { x: { fp: 'a', strokes: [{ mode: 'draw', points: [[0, 0]] }] } });
});

test('line-art info: cleaned and scaled; isLineArt', () => {
  const info = cleanLineArtInfo({ style: 'framed', sources: ['a'], size: [100, 80], thickness: 2, lineWidth: 1, lines: 'even', bridges: 3, longestBridge: 4, dropped: 1, hooks: 0 }, 2);
  assert.deepEqual(info?.size, [200, 160]);
  assert.equal(info?.lineWidth, 2);
  assert.equal(cleanLineArtInfo({ style: 'nope', sources: [], size: [1, 1] }), undefined);
  assert.ok(isLineArt("return H.lineart('x', {})") && !isLineArt('H.svg("x")'));
});
