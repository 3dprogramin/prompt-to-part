import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { evaluateScript } from '../shared/runtime';
import { DRAWINGS_KEY, type SvgDrawing } from '../shared/svgFeatures';
import { drawingFingerprint, LINEART_DEPTH_KEY, LINEART_EDITS_KEY, LINEART_SIZE_KEY, parseLineArtEdits, type LineArtStroke } from '../shared/lineart';
import { sliverFree } from '../src/geometry/sliverFree';
import type { Vec2 } from '../shared/types';

// The frame of lineArtFill.test.ts: 200 × 100 mm at the script's own size, its lines 2 mm wide.
const box = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const frame: SvgDrawing = { name: 'frame', aspect: 2, shapes: [{ rule: 'EvenOdd', contours: [box(-1, -0.5, 1, 0.5), box(-0.98, -0.48, 0.98, 0.48)], color: '#000000' }] };
const fp = drawingFingerprint(frame);
const red = { color: '#ff0000', name: 'Red' };
const build = (strokes: LineArtStroke[], size?: string) => evaluateScript(`function build() { return H.lineart('frame', { style: 'outline', width: 200 }); }`,
  { [DRAWINGS_KEY]: JSON.stringify({ frame }), [LINEART_EDITS_KEY]: JSON.stringify({ frame: { fp, strokes } }), [LINEART_DEPTH_KEY]: '3', ...(size ? { [LINEART_SIZE_KEY]: size } : {}) }, 'draft').parts;

test('resizing the whole piece: the paint stays where it was drawn, as wide on the drawing', () => {
  // A 6 mm stroke across the top line (2 mm wide, from 48 to 50 mm), ending on it: red over its whole width.
  const paint: LineArtStroke = { mode: 'paint', width: 6, points: [[-0.3, 0.49], [0.3, 0.49]], filament: red };
  const red1 = build([paint])[1].volume, red2 = build([paint], '400x')[1].volume, half = build([paint], '100x')[1].volume;
  // Twice the size: the area 4 times, as thick (the top 3 layers).
  assert.ok(Math.abs(red2 / red1 - 4) < 0.1, `twice the size: ${(red2 / red1).toFixed(2)} × the red, 4`);
  assert.ok(Math.abs(half / red1 - 0.25) < 0.02, `half the size: ${(half / red1).toFixed(3)} × the red, 0.25`);
  // Drawn at twice the size (its k), shown at the script's own: half as wide on the piece.
  const k = build([paint], '400x')[0].lineArt!.frames[0].k;
  assert.ok(Math.abs(build([{ ...paint, width: 12, k }])[1].volume - red1) / red1 < 0.03, 'a stroke drawn at another size keeps its width on the drawing');
  assert.equal(parseLineArtEdits({ a: { fp: 'x', strokes: [{ ...paint, k: 2.5 }] } }).a.strokes[0].k, 2.5);
});

test('the view without slivers: no line across a flat face from a triangle of no area in it, still closed', () => {
  // A flat 10 mm square (two triangles) on a box, the top's front side split by a point on it (5, 0):
  // one triangle of three points on a line, as booleans leave them.
  const p: number[][] = [[0, 0, 1], [10, 0, 1], [10, 10, 1], [0, 10, 1], [5, 0, 1], [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
  const tris = [[0, 4, 2], [4, 1, 2], [0, 2, 3], [4, 0, 1], // the top, and the sliver 4 0 1 on its front side
    [5, 7, 6], [5, 8, 7], [1, 0, 5], [1, 5, 6], [2, 1, 6], [2, 6, 7], [3, 2, 7], [3, 7, 8], [0, 3, 8], [0, 8, 5]];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p.flat(), 3));
  g.setIndex(tris.flat());
  const length = (e: THREE.BufferGeometry) => { const a = e.getAttribute('position').array; let L = 0; for (let i = 0; i < a.length; i += 6) L += Math.hypot(a[i + 3] - a[i], a[i + 4] - a[i + 1], a[i + 5] - a[i + 2]); return L; };
  // The box's 12 edges: 4 × 10 mm at the top and the bottom, 4 × 1 mm up the sides.
  assert.ok(length(new THREE.EdgesGeometry(g, 30)) > 84 + 1, 'three.js draws the sliver');
  const clean = sliverFree(g);
  assert.ok(Math.abs(length(new THREE.EdgesGeometry(clean, 30)) - 84) < 1e-4, `${length(new THREE.EdgesGeometry(clean, 30))} mm of lines, 84`);
  // Closed: every side of a triangle shared by one other, the other way round.
  const I = clean.getIndex()!.array, sides = new Map<string, number>();
  for (let t = 0; t < I.length; t += 3) for (let j = 0; j < 3; j++) { const k = `${I[t + j]},${I[t + ((j + 1) % 3)]}`; sides.set(k, (sides.get(k) ?? 0) + 1); }
  assert.ok([...sides.keys()].every((k) => sides.get(k) === 1 && sides.get(k.split(',').reverse().join(',')) === 1), 'closed');
});
