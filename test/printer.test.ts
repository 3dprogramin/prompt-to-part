import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedShift, clampFilaments, DEFAULT_PRINTER, fitProblem, layerHeights, maxPiece, printer, printerName, profileName, setPrinter, shortName, bambuProjectSupported } from '../shared/printer';
import { A1_DEFAULTS, cleanSettings, printDefaultsFor } from '../shared/print';

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

test('printDefaultsFor: the A1 0.4 baseline, layer heights from the nozzle until its template is built', () => {
  assert.deepEqual(printDefaultsFor(DEFAULT_PRINTER), A1_DEFAULTS);
  const fine = printDefaultsFor({ ...DEFAULT_PRINTER, nozzle: 0.2 });
  assert.deepEqual([fine.layerHeight, fine.firstLayerHeight], [0.1, 0.1]);
  const coarse = printDefaultsFor({ ...DEFAULT_PRINTER, nozzle: 0.8 });
  assert.deepEqual([coarse.layerHeight, coarse.firstLayerHeight], [0.4, 0.4]);
});

test('shortName and profileName keep the A1 labels and follow other printers', () => {
  assert.equal(shortName(DEFAULT_PRINTER), 'A1');
  assert.equal(profileName(DEFAULT_PRINTER), '0.20 mm Standard');
  const fine = { ...DEFAULT_PRINTER, name: 'Bambu Lab A1 (0.2 nozzle)', presets: { machine: 'x', process: '0.10mm Standard @BBL A1 0.2 nozzle', filament: 'y' } };
  assert.equal(shortName(fine), 'A1 (0.2 nozzle)');
  assert.equal(profileName(fine), '0.10 mm Standard');
  assert.equal(shortName({ ...DEFAULT_PRINTER, name: 'My A1' }), 'My A1');
  assert.equal(profileName({ ...DEFAULT_PRINTER, presets: null }), 'default profile');
});

test('the Bambu Studio project: one-nozzle printers with presets only', () => {
  assert.equal(bambuProjectSupported(DEFAULT_PRINTER), true);
  assert.equal(bambuProjectSupported({ ...DEFAULT_PRINTER, extruders: 2 }), false);
  assert.equal(bambuProjectSupported({ ...DEFAULT_PRINTER, presets: null }), false);
});
