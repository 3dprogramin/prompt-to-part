import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { pictureValues } from '../src/app/designValues';
import { evaluateScript } from '../shared/runtime';
import { DRAWINGS_KEY, describeDrawings, drawingSection, type SvgDrawing } from '../shared/svgFeatures';
import { drawingFingerprint } from '../shared/lineart/strokes';
import { ARTWORK_EDITS_KEY, MAX_ARTWORK_POINTS, MAX_CUT_POINTS, cutStrokes, parseArtworkEdits, splitLongStroke, strokeContours, withArtworkEdits, type ArtworkStroke } from '../shared/artworkEdits';
import { boxMark, markContours, type PictureMark } from '../shared/pictureEdit/mark';
import { describeSettings } from '../src/lib/settings';

const wasm = await Module();
wasm.setup();
const C = wasm.CrossSection;

const BLACK = '#111111', GOLD = '#e0a868';
const sq = (h: number): [number, number][] => [[-h, -h], [h, -h], [h, h], [-h, h]];
const d: SvgDrawing = {
  name: 't.svg', aspect: 1,
  shapes: [{ rule: 'NonZero', contours: [sq(0.5)], color: BLACK }, { rule: 'NonZero', contours: [sq(0.25)], color: GOLD }],
};
const area = (x: ReturnType<typeof drawingSection>) => (x ? x.area() : 0);
const stroke = (o: Partial<ArtworkStroke>): ArtworkStroke => ({ mode: 'paint', color: GOLD, width: 0.1, points: [[0, 0]], ...o });
const edited = (...s: ArtworkStroke[]) => withArtworkEdits({ t: d }, { t: { fp: drawingFingerprint(d), strokes: s } }).t;
const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol * b, `${a} ~ ${b}`);
const circleA = Math.PI * 25;

test('no edit shapes: same result as before', () => {
  for (const x of [d, withArtworkEdits({ t: d }, {}).t]) {
    assert.equal(area(drawingSection(x, 100, [GOLD], C)), 2500);
    assert.equal(area(drawingSection(x, 100, [BLACK], C)), 10000 - 2500);
  }
});

test('paint gold over a black spot', () => {
  const e = edited(stroke({ points: [[0.4, 0]] }));
  near(area(drawingSection(e, 100, [GOLD], C)), 2500 + circleA, 0.03);
  near(area(drawingSection(e, 100, [BLACK], C)), 7500 - circleA, 0.03);
});

test('erase gold leaves a hole and keeps black', () => {
  const e = edited(stroke({ mode: 'erase', points: [[0, 0]] }));
  near(area(drawingSection(e, 100, [GOLD], C)), 2500 - circleA, 0.03);
  near(area(drawingSection(e, 100, [BLACK], C)), 7500, 0.001);
});

test('erase X with colours [X, Y]', () => {
  const e = edited(stroke({ mode: 'erase', points: [[0, 0]] }));
  near(area(drawingSection(e, 100, [BLACK, GOLD], C)), 10000 - circleA, 0.03);
  const over = edited(stroke({ mode: 'erase', points: [[0.4, 0]] }));
  near(area(drawingSection(over, 100, [BLACK, GOLD], C)), 10000, 0.001);
});

test('paint outside the box is clipped', () => {
  const e = edited(stroke({ points: [[0.7, 0]], width: 0.2 }));
  assert.equal(drawingSection(e, 100, undefined, C)!.bounds().max[0], 50);
});

test('later strokes win', () => {
  const e = edited(stroke({ points: [[0.4, 0]] }), stroke({ color: BLACK, points: [[0.4, 0]] }));
  near(area(drawingSection(e, 100, [BLACK], C)), 7500, 0.01);
});

test('stale fingerprint ignored', () => {
  const r = withArtworkEdits({ t: d }, { t: { fp: 'x', strokes: [stroke({})] } });
  assert.equal(r.t, d);
});

test('unknown colour ignored', () => {
  assert.equal(edited(stroke({ color: '#00ff00' })).shapes.length, 2);
});

test('parseArtworkEdits', () => {
  const good = stroke({ shape: 'square' });
  const raw = { t: { fp: 'f', strokes: [good, { ...good, points: [] }, { ...good, width: 3 }, { ...good, mode: 'fill' }] } };
  for (const input of [raw, JSON.stringify(raw)]) {
    const r = parseArtworkEdits(input);
    assert.equal(r.t.strokes.length, 1);
    assert.equal(r.t.strokes[0].shape, 'square');
  }
});

test('square brush', () => {
  const e = edited(stroke({ points: [[0.4, 0]], shape: 'square' }));
  near(area(drawingSection(e, 100, [GOLD], C)), 2600, 0.01);
});

// An L along the top and right of the black ring (clear of the gold square), width 0.1.
const L: [number, number][] = [[-0.4, 0.4], [0.4, 0.4], [0.4, -0.4]];

test('multi-point square stroke', () => {
  // Two 90 x 10 bars sharing a 10 x 10 corner.
  const e = edited(stroke({ points: L, shape: 'square' }));
  near(area(drawingSection(e, 100, [GOLD], C)), 2500 + 1700, 1e-9);
  near(area(drawingSection(e, 100, [BLACK], C)), 7500 - 1700, 1e-9);
  near(area(drawingSection(e, 100, undefined, C)), 10000, 1e-9);
});

test('multi-point round stroke', () => {
  // Two 80 x 10 bars sharing a 5 x 5 corner, round ends (a whole circle) and the outer quarter at the turn.
  const capsule = 1575 + circleA * 1.25;
  const e = edited(stroke({ points: L }));
  near(area(drawingSection(e, 100, [GOLD], C)), 2500 + capsule, 0.01);
  near(area(drawingSection(e, 100, [BLACK], C)), 7500 - capsule, 0.01);
});

test('paint, erase and paint again apply in order', () => {
  const big = Math.PI * 100;
  // Black painted over the gold, then erased (a hole in both), then a smaller gold dot in it.
  const e = edited(stroke({ color: BLACK, width: 0.2 }), stroke({ mode: 'erase', color: BLACK, width: 0.2 }), stroke({}));
  near(area(drawingSection(e, 100, [GOLD], C)), 2500 - big + circleA, 0.03);
  near(area(drawingSection(e, 100, [BLACK], C)), 7500, 0.001);
  near(area(drawingSection(e, 100, undefined, C)), 10000 - big + circleA, 0.01);
  // Erasing black where gold covers it does nothing; black painted after it shows.
  const r = edited(stroke({ mode: 'erase', color: BLACK, width: 0.2 }), stroke({ color: BLACK, width: 0.2 }));
  near(area(drawingSection(r, 100, [GOLD], C)), 2500 - big, 0.03);
  near(area(drawingSection(r, 100, [BLACK], C)), 7500 + big, 0.01);
});

test('a colour no stroke reaches keeps its polygons', () => {
  const e = edited(stroke({ points: [[0, 0]] }));
  assert.deepEqual(drawingSection(e, 100, [BLACK], C)!.toPolygons(), drawingSection(d, 100, [BLACK], C)!.toPolygons());
  near(area(drawingSection(e, 100, [GOLD], C)), 2500, 0.001);
});

test('the same edits give the same section in a later build', () => {
  const s = [stroke({ points: L }), stroke({ mode: 'erase', color: BLACK, points: [[-0.4, 0.4]], width: 0.2 })];
  const first = area(drawingSection(edited(...s), 100, [BLACK], C));
  const copy = JSON.parse(JSON.stringify(d)) as SvgDrawing;
  const again = withArtworkEdits({ t: copy }, { t: { fp: drawingFingerprint(copy), strokes: JSON.parse(JSON.stringify(s)) } }).t;
  assert.equal(area(drawingSection(again, 100, [BLACK], C)), first);
});

test('a very long stroke is split, each part starting where the last ended', () => {
  const points = Array.from({ length: 4500 }, (_, i) => [i / 1e4, 0] as [number, number]);
  const parts = splitLongStroke(stroke({ points }));
  assert.deepEqual(parts.map((p) => p.points.length), [MAX_ARTWORK_POINTS, MAX_ARTWORK_POINTS, 502]);
  for (let i = 1; i < parts.length; i++) assert.deepEqual(parts[i].points[0], parts[i - 1].points.at(-1));
  assert.deepEqual(parts.at(-1)!.points.at(-1), points.at(-1));
  assert.equal(splitLongStroke(stroke({})).length, 1);
});

test('saving artwork edits as a version names them', () => {
  assert.equal(describeSettings({}, { [ARTWORK_EDITS_KEY]: '{"t":{}}' }, {}), 'Settings: artwork edits');
});

const GOLD_SCRIPT = `function build(){ return [{ name: 'Gold', shape: H.svg('art', { height: 100, colors: ['#e0a868'] }).extrude(1) }]; }`;
const eraseGold = (fp: string) => JSON.stringify({ art: { fp, strokes: [stroke({ mode: 'erase', points: [[0, 0]] })] } });
const goldVolume = (edits?: string) => {
  const r = evaluateScript(GOLD_SCRIPT, { [DRAWINGS_KEY]: JSON.stringify({ art: d }), ...(edits ? { [ARTWORK_EDITS_KEY]: edits } : {}) });
  return r.parts.find((p) => p.name === 'Gold')!.volume;
};

test('a build uses the edits', () => {
  near(goldVolume(eraseGold(drawingFingerprint(d))), 2500 - circleA, 0.03);
  assert.equal(Math.round(goldVolume()), 2500);
});

test('stale edits do nothing', () => {
  assert.equal(Math.round(goldVolume(eraseGold('old'))), 2500);
});

test('drawingsUsed reports the original fingerprint', () => {
  const r = evaluateScript(GOLD_SCRIPT, { [DRAWINGS_KEY]: JSON.stringify({ art: d }), [ARTWORK_EDITS_KEY]: eraseGold(drawingFingerprint(d)) });
  assert.deepEqual(r.drawingsUsed, [{ name: 'art', fp: drawingFingerprint(d) }]);
  const none = evaluateScript(`function build(){ return Manifold.cube([1,1,1]); }`, {});
  assert.equal(none.drawingsUsed, undefined);
});

test('describeDrawings mentions hand edits', () => {
  const art = { art: d };
  const cur = { art: { fp: drawingFingerprint(d), strokes: [stroke({})] } };
  assert.match(describeDrawings(art, cur), /1 hand edit by the user/);
  assert.doesNotMatch(describeDrawings(art, { art: { ...cur.art, fp: 'old' } }), /hand edit/);
  assert.doesNotMatch(describeDrawings(art), /hand edit/);
});

test('the client sends the artwork edits to the server', () => {
  assert.deepEqual(pictureValues({ '$artworkEdits': '{"a":1}', x: 1 }), { '$artworkEdits': '{"a":1}' });
});

// ---- Strokes that stop at an area (`cut`), for picture edits that replace the picture there.

/** A section's area, bounds, number of polygons and of points, and a hash of its polygons. */
const fingerprint = (x: ReturnType<typeof drawingSection>) => {
  const b = x!.bounds(), polys = x!.toPolygons() as [number, number][][];
  const j = JSON.stringify(polys);
  let h = 0x811c9dc5;
  for (let i = 0; i < j.length; i++) h = Math.imul(h ^ j.charCodeAt(i), 0x01000193) >>> 0;
  return [x!.area(), b.min[0], b.min[1], b.max[0], b.max[1], polys.length, polys.reduce((n, p) => n + p.length, 0), h];
};

test('strokes without a cut build the same sections as before cuts existed', () => {
  // Taken from the build before `cut` was added: per case, black, gold and all colours.
  const before: Record<string, number[][]> = {
    paint: [[7422.354286512176, -50, -50, 50, 50, 3, 32, 929987097], [2577.6457134878237, -25, -25, 45, 25, 2, 28, 2691450081], [10000, -50, -50, 50, 50, 1, 4, 2208953127]],
    square: [[5800, -50, -50, 50, 50, 3, 15, 1087697124], [4200, -45, -45, 45, 45, 2, 11, 1798164546], [10000, -50, -50, 50, 50, 1, 4, 2208953127]],
    mixed: [[5651.247940003919, -50, -50, 50, 50, 2, 51, 2338097124], [4172.05714185978, -45, -45, 45, 45, 2, 38, 154854765], [9823.305081863702, -50, -50, 50, 50, 1, 39, 1734085248]],
  };
  const cases: Record<string, ArtworkStroke[]> = {
    paint: [stroke({ points: [[0.4, 0]] })],
    square: [stroke({ points: L, shape: 'square' })],
    mixed: [stroke({ points: L }), stroke({ mode: 'erase', color: BLACK, points: [[-0.4, 0.4]], width: 0.2 }), stroke({ points: [[0.7, 0]], width: 0.2 })],
  };
  for (const [k, s] of Object.entries(cases)) {
    const e = edited(...s);
    assert.deepEqual([[BLACK], [GOLD], undefined].map((cols) => fingerprint(drawingSection(e, 100, cols, C))), before[k], k);
  }
});

const WHITE = '#ffffff';
/** The left half of the picture (and well past it), counter-clockwise. */
const LEFT: [number, number][][] = [[[-2, -2], [0, -2], [0, 2], [-2, 2]]];
// A black square with a white one in it and a small gold square in a corner: paint may go anywhere in the black square.
const w: SvgDrawing = {
  name: 'w.svg', aspect: 1,
  shapes: [{ rule: 'NonZero', contours: [sq(0.5)], color: BLACK }, { rule: 'NonZero', contours: [sq(0.4)], color: WHITE },
    { rule: 'NonZero', contours: [[[-0.48, -0.48], [-0.45, -0.48], [-0.45, -0.45], [-0.48, -0.45]]], color: GOLD }],
};
const onW = (...s: ArtworkStroke[]) => withArtworkEdits({ w }, { w: { fp: drawingFingerprint(w), strokes: s } }).w;
// A capsule 60 x 20 (with round ends) across the white square, and the area of half of it.
const across = stroke({ width: 0.2, points: [[-0.3, 0], [0.3, 0]] });
const half = 600 + Math.PI * 100 / 2;

test('a paint stroke with a cut paints only outside it', () => {
  const e = onW({ ...across, cut: LEFT });
  near(area(drawingSection(e, 100, [GOLD], C)), 9 + half, 0.01);
  near(area(drawingSection(e, 100, [WHITE], C)), 6400 - half, 0.01);
  // Without the cut, the whole capsule.
  near(area(drawingSection(onW(across), 100, [GOLD], C)), 9 + 2 * half, 0.01);
});

test('an erase stroke with a cut leaves its colour inside it', () => {
  const e = edited(stroke({ mode: 'erase', width: 0.2, cut: LEFT }));
  near(area(drawingSection(e, 100, [GOLD], C)), 2500 - Math.PI * 100 / 2, 0.01);
  near(area(drawingSection(e, 100, [BLACK], C)), 7500, 0.001);
});

test('parseArtworkEdits keeps a valid cut and drops a malformed one, keeping the stroke', () => {
  const good = stroke({ cut: LEFT });
  const many = [Array.from({ length: MAX_CUT_POINTS + 1 }, (_, i) => [Math.cos(i), Math.sin(i)])];
  const cuts: unknown[] = [[[[0, 0], [1, 0]]], [[[0, 0], [1, 'x'], [1, 1]]], [[[0, 0], [1, null], [1, 1]]], 'x', [5], many, []];
  const r = parseArtworkEdits(JSON.stringify({ t: { fp: 'f', strokes: [good, ...cuts.map((cut) => ({ ...good, cut }))] } }));
  assert.equal(r.t.strokes.length, 1 + cuts.length);
  assert.deepEqual(r.t.strokes[0].cut, LEFT);
  for (const s of r.t.strokes.slice(1)) assert.equal('cut' in s, false);
});

test('the regions kept between builds tell strokes with different cuts apart', () => {
  const on = (cut?: [number, number][][]) => {
    const copy = JSON.parse(JSON.stringify(d)) as SvgDrawing;
    const st = stroke({ mode: 'erase', width: 0.2, ...(cut ? { cut } : {}) });
    return withArtworkEdits({ t: copy }, { t: { fp: drawingFingerprint(copy), strokes: [st] } }).t;
  };
  const whole = 2500 - Math.PI * 100;
  near(area(drawingSection(on(), 100, [GOLD], C)), whole, 0.01);
  near(area(drawingSection(on(LEFT), 100, [GOLD], C)), 2500 - Math.PI * 50, 0.01);
  near(area(drawingSection(on([[[-2, -2], [2, -2], [2, 2], [-2, 2]]]), 100, [GOLD], C)), 2500, 0.001);
  near(area(drawingSection(on(), 100, [GOLD], C)), whole, 0.01);
});

test('cutStrokes cuts the strokes that reach the mark and leaves the others as they are', () => {
  const mark = boxMark([0, 0, 0.5, 1], 1), right = boxMark([0.5, 0, 1, 1], 1);
  const far = stroke({ points: [[0.4, 0.4]] });
  const [a, b] = cutStrokes([across, far], mark, C);
  assert.deepEqual(a.cut, markContours(mark));
  assert.equal(b, far);
  assert.equal(across.cut, undefined);
  assert.equal(cutStrokes([across], { strokes: [] }, C)[0], across);
  // A later edit adds its mark to the cut.
  assert.deepEqual(cutStrokes([a], right, C)[0].cut, [...markContours(mark), ...markContours(right)]);
  // Built: only the gold outside the mark is left.
  near(area(drawingSection(onW(a), 100, [GOLD], C)), 9 + half, 0.01);
});

/** A heavy mark: a scribble over the left half of the picture. */
const scribble: PictureMark = { strokes: [{ width: 0.06, points: Array.from({ length: 600 }, (_, i): [number, number] => [-0.25 + 0.22 * Math.sin(i / 7), 0.45 * Math.cos(i / 41)]) }] };
const pointsIn = (cut?: [number, number][][]) => (cut ?? []).reduce((n, c) => n + c.length, 0);
const section = (contours: [number, number][][]) => (contours.length ? new C(contours.map((c) => c.map(([x, y]) => [x * 100, y * 100] as [number, number])), 'NonZero') : C.compose([]));

/** How a stroke's cut lies against the mark: the area it cuts, and the area it cuts outside the mark (both at height 100). */
const cutAgainst = (st: ArtworkStroke, mark: PictureMark) => {
  const s = section(strokeContours(st)), inCut = s.intersect(section(st.cut ?? []));
  return { stroke: s.area(), covered: s.intersect(section(markContours(mark))).area(), cut: inCut.area(), outside: inCut.subtract(section(markContours(mark))).area() };
};

test('cutStrokes keeps a heavy mark under the point limit, inside the mark', () => {
  assert.ok(pointsIn(markContours(scribble)) > 4 * MAX_CUT_POINTS);
  // The mark's outline where the stroke reaches: it cuts about what the mark covers, and nothing outside it.
  const exact = cutStrokes([across], scribble, C)[0];
  assert.ok(pointsIn(exact.cut) > 0 && pointsIn(exact.cut) <= MAX_CUT_POINTS, `${pointsIn(exact.cut)}`);
  const a = cutAgainst(exact, scribble);
  near(a.cut, a.covered, 0.02);
  assert.ok(a.outside < 0.001 * a.stroke, `${a.outside}`);
  // And what it had already stays within the limit.
  assert.ok(pointsIn(cutStrokes([exact], scribble, C)[0].cut) <= MAX_CUT_POINTS);
  // A wide stroke over most of the scribble: its outline there.
  const wide = cutStrokes([stroke({ width: 0.8, points: [[-0.3, 0], [-0.2, 0]] })], scribble, C)[0];
  assert.ok(pointsIn(wide.cut) <= MAX_CUT_POINTS, `${pointsIn(wide.cut)}`);
  const b = cutAgainst(wide, scribble);
  near(b.cut, b.covered, 0.01);
  assert.ok(b.outside < 0.001 * b.stroke, `${b.outside}`);
});

test('cutStrokes on many small rings: never cuts outside them, and an empty cut leaves the stroke as it is', () => {
  // A grid of small rings (each an outline with a hole).
  const ring = (cx: number, cy: number, r: number, width: number) => ({ width, points: Array.from({ length: 25 }, (_, i): [number, number] => [cx + r * Math.cos(i / 12 * Math.PI), cy + r * Math.sin(i / 12 * Math.PI)]) });
  const rings = (n: number, r: number, width: number): PictureMark => ({ strokes: Array.from({ length: n * n }, (_, k) => ring(-0.3 + 0.6 * (k % n) / (n - 1), -0.3 + 0.6 * Math.floor(k / n) / (n - 1), r, width)) });
  const big = stroke({ width: 0.8 });
  // (The 8x8 grids, about 9,000 points as they are, need shrinking and cannot all fit: the cut is the largest it can keep.)
  for (const [mark, share] of [[rings(3, 0.02, 0.008), 0.99], [rings(8, 0.02, 0.008), 0.7], [rings(8, 0.01, 0.001), 0.4]] as const) {
    const st = cutStrokes([big], mark, C)[0];
    assert.ok(st.cut!.length > 0 && pointsIn(st.cut) <= MAX_CUT_POINTS, `${pointsIn(st.cut)}`);
    const a = cutAgainst(st, mark);
    assert.ok(a.cut > share * a.covered, `${a.cut} of ${a.covered}`);
    assert.ok(a.outside < 0.001 * a.stroke, `${a.outside}`);
  }
  // Pieces whose boxes reach the stroke but not the pieces themselves (100 circles), more than fit: no `cut: []`, the stroke itself.
  const corner: PictureMark = { strokes: [{ width: 0.02, points: Array.from({ length: 100 }, (): [number, number] => [0.11, 0.11]) }] };
  const small = stroke({ width: 0.2 });
  assert.ok(pointsIn(markContours(corner)) > MAX_CUT_POINTS);
  assert.equal(cutStrokes([small], corner, C)[0], small);
});
