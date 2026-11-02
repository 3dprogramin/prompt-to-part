import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../server/systemPrompt';
import { DEFAULT_PRINTER, setPrinter, type ActivePrinter } from '../shared/printer';
import { printDefaultsFor } from '../shared/print';

const P1S: ActivePrinter = { ...DEFAULT_PRINTER, id: 'Bambu Lab P1S 0.4 nozzle', name: 'Bambu Lab P1S', model: 'Bambu Lab P1S', height: 250, structure: 'corexy', presets: { machine: 'Bambu Lab P1S 0.4 nozzle', process: '0.20mm Standard @BBL X1C', filament: 'Bambu PLA Basic @BBL P1S 0.4 nozzle' } };
const MINI: ActivePrinter = { ...DEFAULT_PRINTER, id: 'Bambu Lab A1 mini 0.4 nozzle', name: 'Bambu Lab A1 mini', model: 'Bambu Lab A1 mini', bed: [180, 180], height: 180 };
const all = (base = printDefaultsFor(DEFAULT_PRINTER)) => buildSystemPrompt({ workspaceFile: 'w.js', webSearch: false, printBase: base, artwork: true, layerTone: { pictures: true }, lithophane: { pictures: true }, meshes: { figure: true, meshy: true }, lineArt: { pictures: true } });
const withPrinter = <T>(p: ActivePrinter, f: () => T): T => { setPrinter(p); try { return f(); } finally { setPrinter(DEFAULT_PRINTER); } };

test('the A1 prompt keeps its wording', () => {
  const p = all();
  assert.match(p, /The user's printer is a Bambu Lab A1 \(FDM bed-slinger, 0\.4 mm nozzle, PLA\/PETG, build volume 256 × 256 × 256 mm\)/);
  assert.match(p, /The Bambu Lab A1 is a bed-slinger \(the bed moves in Y\)/);
  assert.match(p, /0\.08\/0\.12\/0\.16\/0\.20\/0\.24\/0\.28/);
  assert.match(p, /with the "0\.20mm Standard @BBL A1" profile/);
  assert.match(p, /Keep layerHeight at 0\.20 unless/);
});

test('a CoreXY printer gets no bed-slinger advice', () => {
  const p = withPrinter(P1S, () => all());
  assert.doesNotMatch(p, /bed-slinger/);
  assert.match(p, /The user's printer is a Bambu Lab P1S \(FDM CoreXY, 0\.4 mm nozzle, PLA\/PETG, build volume 256 × 256 × 250 mm\)/);
  assert.match(p, /The Bambu Lab P1S is a CoreXY printer/);
  assert.match(p, /"0\.20mm Standard @BBL X1C" profile/);
});

test('a 0.2 nozzle: the layer heights and baseline follow it', () => {
  const fine = { ...DEFAULT_PRINTER, nozzle: 0.2, name: 'Bambu Lab A1 (0.2 nozzle)' };
  const p = withPrinter(fine, () => all(printDefaultsFor(fine)));
  assert.match(p, /0\.06\/0\.08\/0\.10\/0\.12\/0\.14/);
  assert.match(p, /Keep layerHeight at 0\.10 unless/);
  assert.match(p, /0\.2 mm nozzle/);
});

test('a smaller bed: sizes in every mode follow it', () => {
  const p = withPrinter(MINI, () => all());
  assert.match(p, /build volume 180 × 180 × 180 mm/);
  assert.doesNotMatch(p, /\b25[06]\b/, 'no A1 bed size left');
  assert.match(p, /174 × 174 mm/, 'LayerTone default size');
});

test('the filament count replaces the A1 AMS lite in every mode', () => {
  const p = withPrinter({ ...P1S, filaments: 8 }, () => all());
  assert.doesNotMatch(p, /AMS lite/);
  assert.match(p, /Bambu Lab P1S loads 8 filaments at once/);
  assert.doesNotMatch(p, /\bA1\b(?! poster)(?!, A2)(?! top left)(?! \(Red\))(?!\))/, 'no other A1 mention');
  const none = withPrinter({ ...P1S, filaments: 1 }, () => all());
  assert.match(none, /no AMS/);
  assert.match(all(), /Bambu Lab A1 loads 4 filaments at once/);
});

test('mode sections follow the geometry API', () => {
  const p = buildSystemPrompt({ workspaceFile: 'w.js', webSearch: false, printBase: printDefaultsFor(DEFAULT_PRINTER), lineArt: { pictures: true } });
  assert.ok(p.indexOf('# Line art mode') > p.indexOf('# Geometry API'), 'line art section after the geometry API');
  const start = p.indexOf('# Dimensions of real products');
  const dims = p.slice(start, p.indexOf('\n# ', start + 1));
  assert.doesNotMatch(dims, /mode is ON/);
});

const base = { workspaceFile: 'w.js', webSearch: false };
test('picture modes get no sculpting rules', () => {
  const modes = { artwork: { artwork: true }, layerTone: { layerTone: { pictures: true } }, lithophane: { lithophane: { pictures: true } }, lineArt: { lineArt: { pictures: true } } };
  for (const [name, opt] of Object.entries(modes)) {
    const p = buildSystemPrompt({ ...base, ...opt });
    assert.doesNotMatch(p, /Organic shapes/, name);
    assert.doesNotMatch(p, /Holding a phone/, name);
    assert.match(p, /# Dimensions of real products/, name);
    assert.match(p, /Fitting purchased parts/, name);
  }
});

test('plain and figure keep them', () => {
  for (const opt of [{}, { meshes: { figure: true, meshy: true } }]) {
    const p = buildSystemPrompt({ ...base, ...opt });
    assert.match(p, /Organic shapes/);
    assert.match(p, /Holding a phone/);
  }
});
