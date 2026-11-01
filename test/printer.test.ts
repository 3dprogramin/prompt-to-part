import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedShift, clampFilaments, DEFAULT_PRINTER, fitProblem, layerHeights, maxPiece, printer, printerName, setPrinter } from '../shared/printer';
import { cleanSettings } from '../shared/print';

test('printerName shows the nozzle only when it is not 0.4', () => {
  assert.equal(printerName('Bambu Lab A1', 0.4), 'Bambu Lab A1');
  assert.equal(printerName('Bambu Lab A1', 0.2), 'Bambu Lab A1 (0.2 nozzle)');
});

test('layerHeights follow the nozzle', () => {
  assert.deepEqual(layerHeights(0.4), [0.08, 0.12, 0.16, 0.2, 0.24, 0.28]);
  assert.deepEqual(layerHeights(0.2), [0.06, 0.08, 0.1, 0.12, 0.14]);
  assert.deepEqual(layerHeights(0.8), [0.24, 0.32, 0.4, 0.48, 0.56]);
  assert.deepEqual(layerHeights(0.5), layerHeights(0.4)); // nearest
});

test('setPrinter changes fitProblem, bedShift and maxPiece', () => {
  const mini = { ...DEFAULT_PRINTER, id: 'Bambu Lab A1 mini 0.4 nozzle', name: 'Bambu Lab A1 mini', bed: [180, 180] as [number, number], height: 180 };
  setPrinter(mini);
  try {
    assert.match(fitProblem({ min: [0, 0, 0], max: [200, 10, 10] })!, /A1 mini/);
    assert.equal(maxPiece(), 174);
    assert.deepEqual(bedShift([{ min: [0, 0, 0], max: [10, 10, 10] }]), [85, 85, -0]);
  } finally { setPrinter(DEFAULT_PRINTER); }
});

test('the default is the A1 0.4 with 4 filaments', () => {
  assert.equal(printer().name, 'Bambu Lab A1');
  assert.equal(maxPiece(), 250);
  assert.equal(printer().filaments, 4);
});

test('clampFilaments: 1 to 16, default 4', () => {
  assert.equal(clampFilaments(0), 1);
  assert.equal(clampFilaments(40), 16);
  assert.equal(clampFilaments('x'), 4);
  assert.equal(clampFilaments(2.6), 3);
});

test('cleanSettings snaps layer height to the current nozzle', () => {
  setPrinter({ ...DEFAULT_PRINTER, nozzle: 0.2 });
  try { assert.equal(cleanSettings({ layerHeight: 0.2 }).layerHeight, 0.14); } finally { setPrinter(DEFAULT_PRINTER); }
});
