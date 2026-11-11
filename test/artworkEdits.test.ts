import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { pictureValues } from '../src/app/designValues';
import { evaluateScript } from '../shared/runtime';
import { DRAWINGS_KEY, describeDrawings, drawingSection, type SvgDrawing } from '../shared/svgFeatures';
import { drawingFingerprint } from '../shared/lineart/strokes';
import { ARTWORK_EDITS_KEY, MAX_ARTWORK_POINTS, parseArtworkEdits, splitLongStroke, withArtworkEdits, type ArtworkStroke } from '../shared/artworkEdits';
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
