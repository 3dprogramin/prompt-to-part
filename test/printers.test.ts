import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { scanPrinters } from '../server/printers';

const FIX = path.join(import.meta.dirname, 'fixtures', 'bambu-profiles');
const USER = [path.join(FIX, 'user', 'default')];

test('scanPrinters lists BBL nozzle presets and BBL-based user presets', async () => {
  const list = await scanPrinters(FIX, USER);
  assert.deepEqual(list.map((p) => p.name), ['Bambu Lab A1 (0.2 nozzle)', 'Bambu Lab A1', 'Bambu Lab H2D', 'Bambu Lab P1S', 'My A1']);
  const a1 = list.find((p) => p.id === 'Bambu Lab A1 0.4 nozzle')!;
  assert.deepEqual({ bed: a1.bed, origin: a1.origin, height: a1.height, structure: a1.structure, nozzle: a1.nozzle, custom: a1.custom, presets: a1.presets },
    { bed: [256, 256], origin: [0, 0], height: 256, structure: 'bedslinger', nozzle: 0.4, custom: false, presets: { machine: 'Bambu Lab A1 0.4 nozzle', process: '0.20mm Standard @BBL A1', filament: 'Bambu PLA Basic @BBL A1' } });
  const p1s = list.find((p) => p.model === 'Bambu Lab P1S')!;
  assert.equal(p1s.structure, 'corexy');
  assert.equal(p1s.height, 250);
  assert.equal(p1s.extruders, 1);
  assert.equal(list.find((p) => p.model === 'Bambu Lab H2D')?.extruders, 2);
  const mine = list.find((p) => p.name === 'My A1')!;
  assert.equal(mine.custom, true);
  assert.equal(mine.height, 250);
  assert.equal(mine.structure, 'bedslinger');
  assert.equal(mine.presets?.machine, 'My A1');
  assert.equal(mine.presets?.process, '0.20mm Standard @BBL A1');
});

test('a user preset whose parent is missing, or not a Bambu printer, is skipped, not fatal', async () => {
  const names = (await scanPrinters(FIX, USER)).map((p) => p.name);
  assert.ok(!names.includes('Ender'));
  assert.ok(!names.includes('Custom'));
});

test('scanPrinters with a missing user dir still lists the built-in presets', async () => {
  assert.equal((await scanPrinters(FIX, ['/nonexistent'])).length, 4);
});
