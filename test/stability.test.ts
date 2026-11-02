import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPose, footprint, formatPose, stabilityLines, meshCentroid, partMass, PLA_DENSITY } from '../shared/stability';

/** Closed, outward-facing meshes of boxes (x, y, z, w, d, h), merged into one. */
const T = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
function boxes(...bs: number[][]) {
  const pos: number[] = [], idx: number[] = [];
  for (const [x, y, z, w, d, h] of bs) {
    const o = pos.length / 3;
    for (const dz of [0, h]) for (const [px, py] of [[0, 0], [w, 0], [w, d], [0, d]]) pos.push(x + px, y + py, z + dz);
    for (const t of T) idx.push(...t.map((i) => o + i));
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
const near = (a: number[], b: number[], eps = 1e-6) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${a} vs ${b}`));
const settings = (infill: number, walls = 2) => ({ walls, infill }) as Parameters<typeof partMass>[2];

/** Four 2 mm posts at the corners of a 40 mm square under a plate 10 mm up, lifted by dz. */
function table(dz = 0) {
  return boxes(...[[0, 0], [38, 0], [0, 38], [38, 38]].map(([x, y]) => [x, y, dz, 2, 2, 10]), [0, 0, 10 + dz, 40, 40, 2]);
}
const square = (w: number): [number, number][] => [[0, 0], [w, 0], [w, w], [0, w]];

test('centroid of an offset cube', () => {
  const c = boxes([5, 0, 0, 10, 10, 10]);
  near(meshCentroid(c.positions, c.indices), [10, 5, 5]);
});

test('mass of a solid cube at 100 % infill', () => {
  assert.ok(Math.abs(partMass(1000, 600, settings(100), 0.4) - PLA_DENSITY) < 1e-9);
});

test('mass with walls and 15 % infill', () => {
  const g = partMass(8000, 2400, settings(15), 0.4);
  assert.ok(Math.abs(g - 1.24 * (2112 + 0.15 * 5888) / 1000) < 1e-6);
  assert.ok(Math.abs(g - 3.71) < 0.01);
});

test('footprint of four feet', () => {
  const h = footprint([table()]);
  assert.equal(h.length, 4);
  const xs = h.map((p) => p[0]), ys = h.map((p) => p[1]);
  assert.equal(Math.max(...xs) - Math.min(...xs), 40);
  assert.equal(Math.max(...ys) - Math.min(...ys), 40);
});

test('footprint of a raised model', () => {
  assert.deepEqual(footprint([table(7)]), footprint([table()]));
});

test('stable cube', () => {
  const c = checkPose('default', [{ name: 'body', mass: 10, at: [20, 20, 20] }], square(40));
  assert.equal(c.ok, true);
  assert.ok(Math.abs(c.edgeMm - 20) < 1e-9);
  assert.ok(c.tiltDeg > 40 && c.tiltDeg < 50);
  assert.match(formatPose(c), /stable/);
});

test('centre outside the base', () => {
  const c = checkPose('tilt 60° back', [{ name: 'body', mass: 10, at: [44, 20, 20] }], square(40));
  assert.equal(c.ok, false);
  assert.ok(Math.abs(c.edgeMm + 4) < 1e-9);
  assert.equal(c.tiltDeg, 0);
  assert.match(formatPose(c), /4\.0 mm outside/);
  assert.equal(formatPose(c), 'tilt 60° back: tips, centre of mass 4.0 mm outside the base');
});

test('inside but within the 15 % margin', () => {
  const c = checkPose('default', [{ name: 'body', mass: 10, at: [1, 20, 20] }], square(40));
  assert.equal(c.ok, false);
  assert.ok(c.edgeMm > 0);
});

test('load outside the bounding box counts', () => {
  const c = checkPose('default', [{ name: 'base', mass: 50, at: [20, 20, 5] }, { name: 'phone', mass: 200, at: [70, 20, 5] }], square(40));
  assert.equal(c.ok, false);
  assert.ok(c.com[0] > 40);
});

test('no mass or no base is an error, not a pass', () => {
  assert.equal(checkPose('default', [], square(40)).ok, false);
  assert.ok(checkPose('default', [{ name: 'a', mass: 1, at: [0, 0, 1] }], []).error);
});

test('stability lines', () => {
  const a = checkPose('default', [{ name: 'body', mass: 10, at: [20, 20, 20] }], square(40));
  const b = checkPose('tilt 60° back', [{ name: 'body', mass: 10, at: [44, 20, 20] }], square(40));
  const lines = stabilityLines({ poses: [a, b], loads: [], explanation: 'screwed to the wall' });
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'Explained: screwed to the wall');
  assert.equal(lines[2], formatPose(b));
  assert.equal(stabilityLines({ poses: [a], loads: [] }).length, 1);
});
