import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenPath, parseTransform } from '../src/lib/svg';
import { evaluateScript } from '../shared/runtime';
import { newSvgFeature, parseSvgFeatures, SVG_KEY, type SvgDrawing } from '../shared/svgFeatures';

const area = (c: [number, number][]) => Math.abs(c.reduce((s, [x, y], i) => { const [x2, y2] = c[(i + 1) % c.length]; return s + x * y2 - x2 * y; }, 0)) / 2;

test('path data: lines, relative moves, shorthand curves and compact arc flags', () => {
  const [sq] = flattenPath('M0 0h10v10H0z', 0.01);
  assert.equal(area(sq), 100);
  const two = flattenPath('M0,0 L4,0 4,4 z m10,0 l4,0 0,4z', 0.01);
  assert.equal(two.length, 2);
  assert.deepEqual(two[1][0], [10, 0]);
  // A circle from two arcs (flags written without separators) has the area of a circle.
  const [circle] = flattenPath('M-5 0a5 5 0 1010 0 5 5 0 10-10 0', 0.001);
  assert.ok(Math.abs(area(circle) - Math.PI * 25) < 0.05, String(area(circle)));
  // A cubic curve ends on its end point.
  const [c] = flattenPath('M0 0C0 10 10 10 10 0Z', 0.01);
  assert.deepEqual(c.at(-1), [10, 0]);
});

test('transforms compose like SVG', () => {
  const m = parseTransform('translate(10 20) rotate(90) scale(2)');
  const apply = ([x, y]: [number, number]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]].map((v) => +v.toFixed(9));
  assert.deepEqual(apply([1, 0]), [10, 22]);
  assert.deepEqual(parseTransform('matrix(1 0 0 1 3 4)'), [1, 0, 0, 1, 3, 4]);
});

// A 1-unit square with a square hole (even-odd), centred, y up: as importSvg stores it.
const ring: SvgDrawing = {
  name: 'ring.svg', aspect: 1,
  shapes: [{ rule: 'EvenOdd', contours: [[[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]], [[-0.25, -0.25], [0.25, -0.25], [0.25, 0.25], [-0.25, 0.25]]] }],
};
const CUBE = 'function build() { return Manifold.cube([40, 40, 10], true).translate([0, 0, 5]); }';

test('an SVG drawing is raised or engraved on the part, holes included', () => {
  const raised = newSvgFeature('s1', ring, { size: 20, depth: 1 });
  const r = evaluateScript(CUBE, { [SVG_KEY]: JSON.stringify([raised]) }, 'draft');
  assert.equal(r.bbox!.max[2], 11);
  // 20 × 20 mm minus the 10 × 10 mm hole, 1 mm high (plus nothing below the surface).
  assert.ok(Math.abs(r.parts[0].volume - (16000 + 300)) < 1, String(r.parts[0].volume));
  const engraved = { ...raised, mode: 'engrave' as const };
  const e = evaluateScript(CUBE, { [SVG_KEY]: JSON.stringify([engraved]) }, 'draft');
  assert.ok(Math.abs(e.parts[0].volume - (16000 - 300)) < 1, String(e.parts[0].volume));
  assert.equal(r.parts[0].textBase!.max[2], 10);
});

test('saved drawings are checked', () => {
  assert.equal(parseSvgFeatures(JSON.stringify([{ id: 'a', drawing: { aspect: 1, shapes: [{ rule: 'NonZero', contours: [[[0, 0], [1, 0], ['x', 1]]] }] } }])).length, 0);
  assert.equal(parseSvgFeatures(JSON.stringify([{ id: 'b', drawing: { aspect: 1, shapes: [{ rule: 'NonZero', contours: [Array.from({ length: 50000 }, (_, i) => [i, i % 2])] }] } }])).length, 0);
  assert.equal(parseSvgFeatures(JSON.stringify([newSvgFeature('c', ring)])).length, 1);
});
