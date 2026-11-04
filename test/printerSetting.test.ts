import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Its own data folder, and no Bambu Studio on PATH (the built-in printer list).
const root = mkdtempSync(path.join(os.tmpdir(), 'ptp-printer-test-'));
const dataDir = path.join(root, 'data');
process.env.PTP_DATA = dataDir;
process.env.PATH = '';
delete process.env.BAMBU_STUDIO_PATH;
const { activePrinter, loadPrinterSetting, savePrinterSetting } = await import('../server/printerSetting');
const { BUILTIN_PRINTERS, DEFAULT_PRINTER, printer, setPrinter } = await import('../shared/printer');
after(() => { setPrinter(DEFAULT_PRINTER); rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { rmSync(dataDir, { recursive: true, force: true }); mkdirSync(dataDir, { recursive: true }); });

const FILE = path.join(dataDir, 'printer.json');
const LIST = BUILTIN_PRINTERS;

test('activePrinter: a saved printer that is in the list', () => {
  const r = activePrinter({ printerId: 'Bambu Lab P1S 0.4 nozzle', filaments: 8 }, LIST);
  assert.equal(r.printer.name, 'Bambu Lab P1S');
  assert.equal(r.printer.filaments, 8);
  assert.equal(r.missing, false);
});

test('activePrinter: an unknown id falls back to the A1 and keeps the count', () => {
  const r = activePrinter({ printerId: 'Gone', filaments: 1 }, LIST);
  assert.equal(r.printer.id, DEFAULT_PRINTER.id);
  assert.deepEqual(r.printer.presets, DEFAULT_PRINTER.presets);
  assert.equal(r.printer.filaments, 1);
  assert.equal(r.missing, true);
});

test('activePrinter: the A1 0.4 from a list without presets keeps its Bambu presets', () => {
  assert.deepEqual(activePrinter({ printerId: DEFAULT_PRINTER.id, filaments: 4 }, LIST).printer.presets, DEFAULT_PRINTER.presets);
});

test('a fresh install is a first start and nothing is written', async () => {
  const info = await loadPrinterSetting();
  assert.equal(info.firstStart, true);
  assert.equal(info.printer.id, DEFAULT_PRINTER.id);
  assert.equal(existsSync(FILE), false);
});

test('an existing install gets the A1 saved quietly, no first start', async () => {
  mkdirSync(path.join(dataDir, 'designs'));
  writeFileSync(path.join(dataDir, 'designs', 'x.json'), '{}');
  const info = await loadPrinterSetting();
  assert.equal(info.firstStart, false);
  assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')), { printerId: DEFAULT_PRINTER.id, filaments: 4 });
});

test('without Bambu Studio the built-in printers are listed', async () => {
  const info = await loadPrinterSetting();
  assert.deepEqual(info.printers.map((p) => p.id), BUILTIN_PRINTERS.map((p) => p.id));
});

test('a saved printer that is gone: the A1 for now, the saved choice kept', async () => {
  writeFileSync(FILE, JSON.stringify({ printerId: 'Gone', filaments: 2 }));
  const info = await loadPrinterSetting();
  assert.equal(info.missing, true);
  assert.equal(info.printer.id, DEFAULT_PRINTER.id);
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8')).printerId, 'Gone');
});

test('savePrinterSetting saves, sets the current printer, and rejects unknown ids', async () => {
  const info = await savePrinterSetting({ printerId: 'Bambu Lab A1 mini 0.4 nozzle', filaments: 40 });
  assert.equal(info.printer.name, 'Bambu Lab A1 mini');
  assert.equal(info.printer.filaments, 16);
  assert.equal(printer().name, 'Bambu Lab A1 mini');
  assert.equal(info.firstStart, false);
  await assert.rejects(savePrinterSetting({ printerId: 'Nope', filaments: 4 }), /Nope/);
  setPrinter(DEFAULT_PRINTER);
});
