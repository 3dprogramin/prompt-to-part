import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'ptp-template-test-'));
const dataDir = path.join(root, 'data');
process.env.PTP_DATA = dataDir;
const { bambuTemplate, cachedPrintDefaults, templateFile } = await import('../server/bambu');
const { DEFAULT_PRINTER, BUILTIN_PRINTERS } = await import('../shared/printer');
after(() => rmSync(root, { recursive: true, force: true }));

const P1S = { ...BUILTIN_PRINTERS.find((p) => p.model === 'Bambu Lab P1S')!, presets: { machine: 'Bambu Lab P1S 0.4 nozzle', process: '0.20mm Standard @BBL X1C', filament: 'Bambu PLA Basic @BBL P1S 0.4 nozzle' } };

test('templateFile is per printer', () => {
  assert.match(templateFile(DEFAULT_PRINTER), /[\\/]bambu[\\/]templates[\\/]bambu-lab-a1-0-4-nozzle\.json$/);
  assert.notEqual(templateFile(DEFAULT_PRINTER), templateFile(P1S));
});

test('the old single template becomes the A1 0.4 entry', async () => {
  mkdirSync(path.join(dataDir, 'bambu'), { recursive: true });
  writeFileSync(path.join(dataDir, 'bambu', 'template.json'), JSON.stringify({ version: '2.8', settings: { wall_loops: '3' }, perFilament: [], perFilamentPlus2: [] }));
  assert.equal((await cachedPrintDefaults(DEFAULT_PRINTER))?.walls, 3);
  assert.ok(existsSync(templateFile(DEFAULT_PRINTER)));
});

test('another printer has no cached defaults until its template is built', async () => {
  assert.equal(await cachedPrintDefaults(P1S), null);
});

test('a two-nozzle printer gets a clear "not supported yet" instead of a failing slice', async () => {
  await assert.rejects(bambuTemplate({ ...P1S, id: 'Bambu Lab H2D 0.4 nozzle', name: 'Bambu Lab H2D', extruders: 2 }), /isn't supported for the Bambu Lab H2D yet/);
});
