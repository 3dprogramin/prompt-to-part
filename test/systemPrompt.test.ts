import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../server/systemPrompt';
import { DEFAULT_PRINTER, setPrinter, type ActivePrinter } from '../shared/printer';
import { printDefaultsFor } from '../shared/print';
import type { LayerToneFilament } from '../shared/layertone';

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
    assert.match(p, /no text, names, labels or logos/, name);
    assert.match(p, /# Dimensions of real products/, name);
    assert.doesNotMatch(p, /Fitting purchased parts/, name);
  }
});

test('a 3D figure keeps the sculpting rules even in a picture mode', () => {
  const p = buildSystemPrompt({ ...base, lineArt: { pictures: true }, meshes: { figure: true, meshy: true } });
  assert.match(p, /Organic shapes/);
});

test('plain and figure keep them', () => {
  for (const opt of [{}, { meshes: { figure: true, meshy: true } }]) {
    const p = buildSystemPrompt({ ...base, ...opt });
    assert.match(p, /Organic shapes/);
    assert.match(p, /Holding a phone/);
    assert.match(p, /no text, names, labels or logos/);
  }
});

test('no leftovers from the first test designs', () => {
  const p = buildSystemPrompt({ workspaceFile: '/w/model.js', webSearch: false });
  for (const word of ['cork', 'Wine', 'bottle neck', 'Scooby', 'cartoon dog']) assert.ok(!p.includes(word), word);
  assert.ok(p.includes('taper candle'));
});

test('brim is set in print, not left to the slicer', () => {
  const p = buildSystemPrompt({ workspaceFile: '/w/model.js', webSearch: false });
  assert.ok(!p.includes('adds a brim in the slicer'));
  assert.ok(p.includes("set a brim in `print` instead"));
});

test('picture modes leave out the product-fitting blocks', () => {
  for (const o of [{ layerTone: { pictures: true } }, { lineArt: { pictures: true } }, { artwork: true }, { lithophane: { pictures: true } }]) {
    const p = buildSystemPrompt({ ...base, ...o });
    assert.ok(!p.includes('Fitting purchased parts'), JSON.stringify(o));
    assert.ok(!p.includes('Holding a phone, tablet'), JSON.stringify(o));
  }
});

test('3D designs and figures keep them', () => {
  for (const o of [{}, { meshes: { figure: true, meshy: true }, layerTone: { pictures: true } }]) {
    const p = buildSystemPrompt({ ...base, ...o });
    assert.ok(p.includes('Fitting purchased parts'));
    assert.ok(p.includes('Holding a phone, tablet'));
  }
});

test('small changes stay small, in every mode', () => {
  for (const o of [{}, { layerTone: { pictures: true } }]) {
    assert.ok(buildSystemPrompt({ ...base, ...o }).includes('change it by a small step'), JSON.stringify(o));
  }
});

const lt = (mine: LayerToneFilament[] = [], pictures = true) => buildSystemPrompt({ workspaceFile: '/w/model.js', webSearch: false, layerTone: { pictures, mine } });
test('LayerTone: the example has no Max height slider', () => {
  assert.ok(!lt().includes("maxHeight: { label: 'Max height'"));
});
test('LayerTone: without the image model the example keeps its Max height slider', () => {
  assert.ok(lt([], false).includes("maxHeight: { label: 'Max height'"));
});
test('LayerTone: a named colour is the user\'s own filament first', () => {
  const p = lt([{ name: 'PLA Matte Scarlet Red', brand: 'Bambu Lab', color: '#de4343', td: 2.2 }]);
  assert.ok(p.includes('A colour the user names ("red", "brown") means their own filament of that colour'));
});
test('LayerTone: colours come from the stack', () => {
  assert.ok(lt().includes('never a separate coloured part'));
  assert.ok(lt().includes('A colour meant for one area only'));
  assert.ok(lt().includes('this is the one reason to change the swap layers that came with the picture'));
  assert.ok(lt().includes("A filament that is not one of the user's own comes from the library below"));
});
test('LayerTone: one filament more than the AMS holds, when it clearly helps', () => {
  assert.ok(lt().includes('One more than that (5) is worth it'));
  assert.ok(lt().includes('Never more than 5 unless the user asks'));
});
test('LayerTone: slot sharing only with an AMS', () => {
  assert.ok(lt().includes('can share its AMS slot'));
  assert.ok(!withPrinter({ ...DEFAULT_PRINTER, filaments: 1 }, () => lt()).includes('can share its AMS slot'));
});
test('LayerTone: set_layertone and the 2.4 mm rule are each explained once', () => {
  const p = lt();
  assert.ok(!p.includes('Once the model exists, change filaments'));
  assert.ok(!p.includes('maxHeight around 2.4'));
  assert.ok(p.includes('ONLY with set_layertone'));
  assert.ok(p.includes('max_height (2.4 when'));
});

const MINE: LayerToneFilament[] = [{ name: 'PLA+ Gold', brand: 'eSUN', color: '#f4c93f', td: 5.3 }];
test('artwork and line art list the saved filaments', () => {
  for (const o of [{ artwork: true }, { lineArt: { pictures: true } }]) {
    const p = buildSystemPrompt({ workspaceFile: '/w/model.js', webSearch: false, ...o, myFilaments: MINE });
    assert.ok(p.includes("The user's own filaments"), JSON.stringify(o));
    assert.ok(p.includes('PLA+ Gold (eSUN) #f4c93f'));
  }
});
test('line art lists the saved filaments without the TD', () => {
  const p = buildSystemPrompt({ workspaceFile: '/w/model.js', webSearch: false, lineArt: { pictures: true }, myFilaments: MINE });
  assert.ok(p.includes('PLA+ Gold (eSUN) #f4c93f'));
  assert.ok(!p.includes('PLA+ Gold (eSUN) #f4c93f 5.3'));
});
test('without saved filaments those sections are unchanged', () => {
  for (const o of [{ artwork: true }, { lineArt: { pictures: true } }]) {
    const p = buildSystemPrompt({ workspaceFile: '/w/model.js', webSearch: false, ...o });
    assert.ok(!p.includes("The user's own filaments"));
  }
});
const ltSection = (p: string) => { const i = p.indexOf('# LayerTone mode'); const end = p.indexOf('\n# ', i + 1); return p.slice(i, end < 0 ? undefined : end); };
test('LayerTone without the image model names no picture tools', () => {
  const s = ltSection(lt([], false));
  assert.ok(!s.includes('generate_picture'));
  assert.ok(!s.includes('edit_picture'));
  assert.ok(s.includes('it has to be in the photo'));
  assert.ok(s.includes('maxHeight around 2.4'));
});
test('LayerTone with the image model: picture tools, swap exception and the slicer note', () => {
  const s = ltSection(lt());
  for (const t of ['with edit_picture once the picture exists', 'part of your own check before you submit', 'one exception: a colour that shows where it should not', 'When the message names none', "Bambu Studio's preview paints each area", 'maxHeight: 1.6']) assert.ok(s.includes(t), t);
});
