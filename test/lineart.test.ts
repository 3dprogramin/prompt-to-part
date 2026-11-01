import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import { withFonts } from '../shared/text';
import { loadFontBuffers } from '../server/fonts';
import { DRAWINGS_KEY, type SvgDrawing } from '../shared/svgFeatures';
import { cleanLineArtInfo, drawingFingerprint, isLineArt, lineArtMask, LINE_ART_STYLES, LINEART_EDITS_KEY, LINEART_ENDS_KEY, LINEART_LAYOUT_KEY, LINEART_SIZE_KEY, LINEART_SPLIT_KEY, parseLineArtEdits, parseLineArtEnds, rasterize, traceMask, type LineArtGrid } from '../shared/lineart';
import { keepTogether, parseSplitSpec, pieceLabel, routeSeam, seamAt, splitGrid } from '../shared/split';
import type { Vec2 } from '../shared/types';
import { DEFAULT_PRINTER, maxPiece, setPrinter } from '../shared/printer';

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
  // Off, it is still counted (left loose); a reach shorter than the gap leaves it loose too.
  assert.equal(off.endsFree, 1);
  const short = lineArtMask(art(), null, g, { lineWidth: 1, fill: 3, minIsland: 4, lines: 'keep', joinEnds: 2 });
  assert.deepEqual([short.endsJoined, short.endsFree], [0, 1]);
});

test('Join loose ends (LINEART_ENDS_KEY): parsed, 0 turns it off, a longer reach joins more; wins over the script', () => {
  assert.equal(parseLineArtEnds('0'), 0);
  assert.equal(parseLineArtEnds('12.5'), 12.5);
  for (const raw of ['', undefined, '-1', '60', 'x']) assert.equal(parseLineArtEnds(raw), undefined, String(raw));
  // A frame with a line from its left side stopping 12.5 mm short of the right one (100 mm wide).
  const tail: SvgDrawing = { name: 'tail', aspect: 2, shapes: [{ rule: 'EvenOdd', contours: [box(-1, -0.5, 1, 0.5), box(-0.95, -0.45, 0.95, 0.45)], color: '#000000' }, { rule: 'NonZero', contours: [box(-0.96, -0.02, 0.7, 0.02)], color: '#000000' }] };
  const la = (ends: string | null, opts = '', more = {}) => evaluateScript(`function build() { return H.lineart('tail', { style: 'outline', width: 100${opts} }); }`, { [DRAWINGS_KEY]: JSON.stringify({ tail }), ...(ends != null ? { [LINEART_ENDS_KEY]: ends } : {}), ...more }, 'draft').parts[0].lineArt!;
  const def = la(null);
  assert.deepEqual([def.endsJoined, def.endsFree, def.joinEnds], [0, 1, 8], 'the default 8 mm does not reach');
  const far = la('20');
  assert.deepEqual([far.endsJoined, far.endsFree, far.joinEnds], [1, 0, 20]);
  const off = la('0', ', joinEnds: 20');
  assert.deepEqual([off.endsJoined, off.endsFree, off.joinEnds], [0, 1, 0], "off wins over the script's joinEnds");
  // Where: the join from the line's end (x 35 mm) to the frame's inner side (x 47.5 mm), the end left loose at 35 mm.
  const near = (p: [number, number] | undefined, x: number, what: string) => assert.ok(p && Math.abs(p[0] - x) < 1.5 && Math.abs(p[1]) < 1, `${what}: ${p}`);
  assert.equal(far.joins?.length, 1);
  near(far.joins![0][0], 35, 'the loose end');
  near(far.joins![0][1], 47.5, 'where it joined');
  assert.equal(far.loose, undefined);
  assert.equal(def.joins, undefined);
  near(def.loose?.[0], 35, 'left loose');
  // Kept and scaled by cleanLineArtInfo (broken ones dropped); a join erased by hand leaves its end loose.
  assert.deepEqual(cleanLineArtInfo(far, 2)!.joins, far.joins!.map((j) => j.map(([x, y]) => [2 * x, 2 * y])));
  assert.equal(cleanLineArtInfo({ ...far, joins: [[[1, 2], [NaN, 0]], [[1, 2]]] })!.joins, undefined);
  const strokes = [{ mode: 'erase', width: 3, points: [[0.83, 0]] }];
  const erased = la('20', '', { [LINEART_EDITS_KEY]: JSON.stringify({ tail: { fp: drawingFingerprint(tail), strokes } }) });
  assert.equal(erased.joins, undefined);
  near(erased.loose?.[0], 35, 'erased, loose again');
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

test('H.lineart: a typed W × H makes a frame or medallion exactly that size; a width alone follows the drawing', () => {
  const sized = (style: string, size: string) => evaluateScript(`function build() { return H.lineart('bike', { style: '${style}' }); }`, { ...values, [LINEART_SIZE_KEY]: size }, 'draft').parts[0];
  const dims = (p: { bbox: { min: number[]; max: number[] } }) => [p.bbox.max[0] - p.bbox.min[0], p.bbox.max[1] - p.bbox.min[1]].map((v) => +v.toFixed(1));
  // The bike is 2:1: a 200 × 160 box leaves room above and below it, a 240 × 80 one beside it.
  assert.deepEqual(dims(sized('framed', '200x160')), [200, 160]);
  assert.deepEqual(dims(sized('framed', '240x80')), [240, 80]);
  assert.deepEqual(dims(sized('medallion', '200x160')), [200, 160]);
  assert.deepEqual(dims(sized('medallion', '150x150')), [150, 150]);
  const free = dims(sized('framed', '200x'));
  assert.equal(free[0], 200);
  assert.ok(free[1] < 110, `height follows the drawing (${free[1]})`);
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
  assert.deepEqual(parseLineArtEdits('{"x":{"fp":"a","strokes":[{"mode":"smudge","points":[[0,0]]},{"mode":"draw","width":99,"points":[[0,0],[1,"y"]]}]}}'), { x: { fp: 'a', strokes: [{ mode: 'draw', points: [[0, 0]] }] } });
});

test('line-art info: cleaned and scaled; isLineArt', () => {
  const info = cleanLineArtInfo({ style: 'framed', sources: ['a'], size: [100, 80], thickness: 2, lineWidth: 1, lines: 'even', bridges: 3, longestBridge: 4, dropped: 1, hooks: 0 }, 2);
  assert.deepEqual(info?.size, [200, 160]);
  assert.equal(info?.lineWidth, 2);
  assert.equal(cleanLineArtInfo({ style: 'nope', sources: [], size: [1, 1] }), undefined);
  assert.ok(isLineArt("return H.lineart('x', {})") && !isLineArt('H.svg("x")'));
});

test('split: choices parsed, grids picked, pieces named', () => {
  assert.equal(parseSplitSpec('auto'), 'auto');
  assert.equal(parseSplitSpec('off'), 'off');
  assert.equal(parseSplitSpec('4'), 4);
  assert.deepEqual(parseSplitSpec('3x2'), [3, 2]);
  assert.equal(parseSplitSpec([1, 1]), 'off');
  assert.equal(parseSplitSpec('lots'), undefined);
  assert.deepEqual(splitGrid(600, 229, 'auto'), { cols: 3, rows: 1 });
  assert.deepEqual(splitGrid(600, 400, 6), { cols: 3, rows: 2 });
  assert.deepEqual(splitGrid(600, 200, 3), { cols: 3, rows: 1 });
  assert.deepEqual([pieceLabel(0, 0), pieceLabel(2, 1), pieceLabel(0, 26)], ['A1', 'B3', 'AA1']);
});

test('split: a seam goes round a line instead of cutting along it', () => {
  const g = { px: 0.25, x0: -10, y1: 10, w: 80, h: 80 };
  // A vertical line right on the ideal cut, and a gap in a horizontal line beside it.
  const ink = rasterize([box(-0.5, -10, 0.5, 10), box(-10, -0.5, 3, 0.5), box(6, -0.5, 10, 0.5)], g);
  const s = routeSeam(g, { ink }, 'v', 0, 10, 1);
  assert.equal(s.crossings, 0);
  assert.ok(s.points.every(([x]) => Math.abs(x) > 1), 'clear of the vertical line');
  const x = seamAt(s.points, 0, 1);
  assert.ok(x > 3 && x < 6, `through the gap (x = ${x})`);
});

test('H.lineart split: pieces fit the bed, each one piece, dovetails on the bar, names on the back; off is unchanged', async () => {
  const opts = "style: 'keyholder', width: 420, split: 'auto', layout: 'assembled'";
  const r = await withFonts(() => run(opts), loadFontBuffers);
  const sp = r.parts[0].lineArt!.split!;
  assert.deepEqual([sp.cols, sp.rows], [2, 1]);
  for (const p of r.parts) {
    assert.equal(p.components, 1, `${p.name}: one piece`);
    assert.ok(p.bbox.max[0] - p.bbox.min[0] <= 250 && p.bbox.max[1] - p.bbox.min[1] <= 250, `${p.name} fits the bed`);
  }
  assert.equal(sp.joints.length, 1);
  assert.equal(sp.joints[0].tab, 'A1');
  assert.ok(sp.pieces.filter((p) => p.label === 'A1' || p.label === 'A2').every((p) => p.labelSize >= 5), 'names on the bar');
  assert.deepEqual(r.parts.map((p) => p.plate), r.parts.map((_, i) => i + 1));
  assert.equal(r.assembly.length, r.parts.length - 1);
  // The user's choice wins over the script's; off builds exactly the piece as before.
  const plain = run("style: 'keyholder', width: 420");
  const off = evaluateScript(`function build() { return H.lineart('bike', { ${opts} }); }`, { ...values, [LINEART_SPLIT_KEY]: 'off' }, 'draft');
  assert.equal(off.parts.length, 1);
  assert.equal(off.parts[0].volume, plain.parts[0].volume);
  assert.equal(off.parts[0].triCount, plain.parts[0].triCount);
});

test('split: a bit a seam cuts off goes to the piece it carries on into, the seam stepping round it', () => {
  const g = { px: 1, x0: 0, y1: 60, w: 100, h: 60 };
  // A blob in each piece, and a line from the right one reaching 7 mm past the seam (x = 50).
  const ink = rasterize([box(5, 20, 20, 40), box(60, 20, 90, 40), box(43, 29, 61, 31)], g);
  const seam = { dir: 'v' as const, col: 1, row: 0, points: [[50, 60], [50, 0]] as Vec2[], crossings: 1, runs: [] };
  const r = keepTogether({ g, ink, anchor: null, seams: [seam], cols: 2, rows: 1, box: [0, 100, 60, 0], maxBridge: 10, minPart: 50, maxPiece: 200 });
  assert.equal(r.moved.length, 1);
  assert.deepEqual([r.moved[0].from, r.moved[0].to], [0, 1]);
  const s = r.seams[0].points;
  assert.ok(seamAt(s, 30, 1) < 43, `round the line's end (x = ${seamAt(s, 30, 1)})`);
  assert.equal(seamAt(s, 50, 1), 50, 'straight elsewhere');
  assert.equal(r.seams[0].crossings, 0);
});

// A line across the lower half, a dot in two corners, and a disc 22 mm under the top frame.
const marks: SvgDrawing = {
  name: 'marks', aspect: 2,
  shapes: [{ rule: 'NonZero', contours: [box(-1, -0.21, 1, -0.19), circle(-0.98, 0.48, 0.02), circle(0.98, -0.48, 0.02), circle(-0.5, 0.33, 0.06)], color: '#000000' }],
};
const framed = (split: string, more: Record<string, string> = {}) => withFonts(() => evaluateScript("function build() { return H.lineart('marks', { style: 'framed', width: 420, frameWidth: 8 }); }", { [DRAWINGS_KEY]: JSON.stringify({ marks }), [LINEART_SPLIT_KEY]: split, ...more }, 'draft'), loadFontBuffers);
/** The part whose top (seen from above) covers point p of the wall, each part put back by its layout offset; -1 for none. */
const partAt = (parts: { positions: Float32Array; indices: Uint32Array; lineArt?: { piece?: { offset: [number, number] } } }[], [x, y]: Vec2) => parts.findIndex((q) => {
  const [dx, dy] = q.lineArt?.piece?.offset ?? [0, 0], P = q.positions, I = q.indices;
  for (let t = 0; t + 2 < I.length; t += 3) {
    const [ax, ay, bx, by, cx, cy] = [I[t], I[t + 1], I[t + 2]].flatMap((k) => [P[k * 3] - dx, P[k * 3 + 1] - dy]);
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (d <= 1e-9) continue;
    const u = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / d, v = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / d;
    if (u >= 0 && v >= 0 && u + v <= 1) return true;
  }
  return false;
});
/** How far point p is from polylines `lines`. */
const distTo = (lines: Vec2[][], [x, y]: Vec2) => Math.min(...lines.flatMap((l) => l.slice(1).map((b, k) => {
  const a = l[k], dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
})));

test("H.lineart split: a bit near its piece's frame is bridged to it; strips of frame with nothing on them join up", async () => {
  const two = await framed('auto');
  assert.deepEqual(two.parts.map((p) => p.name), ['A1', 'A2']);
  for (const p of two.parts) assert.equal(p.components, 1, `${p.name}: one piece`);
  const a1 = two.parts[0].lineArt!.split!.pieces[0];
  assert.ok(a1.longestBridge > 15 && a1.longestBridge < 30, `the disc bridged to the frame (${a1.longestBridge} mm)`);
  // Cut in eight, bare strips of frame side by side join (the dovetail between them filled in).
  const eight = await framed('4x2');
  for (const p of eight.parts) assert.equal(p.components, 1, `${p.name}: one piece`);
  const pieces = eight.parts[0].lineArt!.split!.pieces;
  assert.ok(pieces.some((p) => p.size[0] > 180 && p.size[1] < 12), `a long strip of frame: ${pieces.map((p) => `${p.label} ${p.size.map((v) => v.toFixed(0)).join('×')}`).join(', ')}`);
  assert.ok(pieces.every((p) => Math.max(...p.size) > 40), 'no short sliver');
  // Seams are drawn only where two pieces meet: not across a joined strip of frame.
  const sp = eight.parts[0].lineArt!.split!, strip = pieces.find((p) => p.size[0] > 180 && p.size[1] < 12)!;
  const ym = (strip.box[1] + strip.box[3]) / 2;
  const inside = sp.seams.filter((m) => m.dir === 'v' && seamAt(m.points, ym, 1) > strip.box[0] + 5 && seamAt(m.points, ym, 1) < strip.box[2] - 5);
  assert.ok(inside.length > 0, 'a seam ran through the strip');
  for (const m of inside) assert.ok(distTo(m.cuts!, [seamAt(m.points, ym, 1), ym]) > 3, 'not drawn through the joined strip');
});

test('H.lineart split: hand edits land on every piece in every layout – a drawn line cut at the seam, an erase on both sides of it', async () => {
  const fp = drawingFingerprint(marks);
  // A line from frame to frame across the seam, and an erase across the seam over the drawing's line.
  const strokes = [{ mode: 'draw', width: 2, points: [[-1.05, 0.1], [1.05, 0.1]] }, { mode: 'erase', width: 6, points: [[-0.02, -0.2], [0.02, -0.2]] }];
  const edits = { [LINEART_EDITS_KEY]: JSON.stringify({ marks: { fp, strokes } }) };
  const seen: number[][] = [];
  for (const layout of ['print', 'assembled', 'exploded']) {
    const r = await framed('auto', { ...edits, [LINEART_LAYOUT_KEY]: layout });
    const la = r.parts[0].lineArt!, f = la.frames[0], sp = la.split!;
    assert.equal(la.edits, 2);
    assert.equal(sp.layout, layout);
    for (const p of r.parts) assert.equal(p.components, 1, `${layout} ${p.name}: one piece`);
    const at = (u: number, v: number): Vec2 => [u * f.k + f.tx, v * f.k + f.ty];
    const yd = at(0, 0.1)[1], ye = at(0, -0.2)[1], xd = seamAt(sp.seams[0].points, yd, 1), xe = at(0, 0)[0];
    // The drawn line on both pieces, cut at the seam.
    const drawn = [partAt(r.parts, [xd - 1, yd]), partAt(r.parts, [xd + 1, yd])];
    assert.deepEqual(drawn.map((i) => r.parts[i]?.name), ['A1', 'A2'], `${layout}: drawn line`);
    // Erased 7 mm either side of the drawing's middle, across the seam; the line goes on beyond.
    assert.ok(Math.abs(seamAt(sp.seams[0].points, ye, 1) - xe) < 4, 'the erase crosses the seam');
    const erased = [-6, -2, 2, 6].map((d) => partAt(r.parts, [xe + d, ye]));
    assert.deepEqual(erased, [-1, -1, -1, -1], `${layout}: erased`);
    assert.deepEqual([-10, 10].map((d) => r.parts[partAt(r.parts, [xe + d, ye])]?.name), ['A1', 'A2'], `${layout}: the line goes on`);
    seen.push([...drawn, ...erased]);
  }
  assert.deepEqual(seen[1], seen[0]);
  assert.deepEqual(seen[2], seen[0]);
});

test('H.lineart split follows the chosen printer: an A1 mini bed splits a 220 mm piece', async () => {
  const opts = "style: 'keyholder', width: 220, split: 'auto', layout: 'assembled'";
  setPrinter({ ...DEFAULT_PRINTER, id: 'Bambu Lab A1 mini 0.4 nozzle', name: 'Bambu Lab A1 mini', model: 'Bambu Lab A1 mini', bed: [180, 180], height: 180 });
  try {
    const r = await withFonts(() => run(opts), loadFontBuffers);
    const sp = r.parts[0].lineArt!.split!;
    assert.ok(sp.cols * sp.rows >= 2, 'split into pieces');
    for (const p of r.parts) assert.ok(p.bbox.max[0] - p.bbox.min[0] <= maxPiece() && p.bbox.max[1] - p.bbox.min[1] <= maxPiece(), `${p.name} fits the A1 mini`);
  } finally { setPrinter(DEFAULT_PRINTER); }
});
