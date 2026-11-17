// The built-in filament library: today's 92 entries are a frozen base, so what is built on them
// (line art's fallback TD, the colour paint palette, the agent's library list with no saved
// filaments) never moves when more brands are added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ADDED_FILAMENTS, BASE_FILAMENT_LIBRARY, FILAMENT_LIBRARY } from '../shared/filamentLibrary';
import { matchFilament, myFilamentKey, promptLibrary, type LibraryFilament } from '../shared/filaments';
import { filamentTd } from '../shared/lineart/depth';
import { PAINT_LIBRARY } from '../shared/meshColors';
import { DEFAULT_PRINTER, setPrinter } from '../shared/printer';
import { layerTone } from '../server/modes/layerTone';

// sha256 of JSON.stringify(FILAMENT_LIBRARY) at dev a69b05d, before the library was split.
const BASE_HASH = '547ca671937dbc4846f2721283e16f747fe7dc1c3695008b6908c13d974bce6a';
// filamentTd's answers at dev a69b05d, before the library was split.
const FILAMENT_TD_BEFORE: Record<string, { td: number; known: boolean }> = {
  '{"name":"Black","color":"#000000"}': { td: 0.2, known: true },
  '{"color":"#f4f4f0"}': { td: 3.9, known: false },
  '{"name":"No such thing","color":"#2255cc"}': { td: 2, known: false },
  '{"name":"PLA Basic Jade White","brand":"Bambu Lab","color":"#ffffff"}': { td: 5.9, known: true },
  '{"name":"Black","brand":"eSUN","color":"#000000"}': { td: 0.2, known: true },
  '{"name":"White","color":"#ffffff"}': { td: 7.2, known: true },
  '{"name":"Red","color":"#c12e1f"}': { td: 3.5, known: true },
  '{"name":"Matte Charcoal","color":"#000000"}': { td: 0.3, known: true },
  '{"color":"#c12e1f"}': { td: 3.8, known: false },
  '{"color":"#23529a"}': { td: 2, known: false },
  '{"color":"#00ae42"}': { td: 1.6, known: false },
  '{"color":"#f4ee2a"}': { td: 4.3, known: false },
  '{"color":"#5e43b7"}': { td: 3, known: false },
  '{"color":"#9d432c"}': { td: 2, known: false },
  '{"color":"#ff6a13"}': { td: 5, known: false },
  '{"color":"#f55a74"}': { td: 4, known: false },
  '{"color":"#808080"}': { td: 0.7, known: false },
  '{"color":"#000000"}': { td: 0.2, known: false },
  '{"color":"#eccab0"}': { td: 3, known: false },
  '{"name":"Panchroma Matte Charcoal Black","color":"#1a1a1a"}': { td: 0.2, known: false },
};

test('the base list is today\'s 92 entries, unchanged', () => {
  assert.equal(BASE_FILAMENT_LIBRARY.length, 92);
  assert.equal(createHash('sha256').update(JSON.stringify(BASE_FILAMENT_LIBRARY)).digest('hex'), BASE_HASH);
  assert.deepEqual(FILAMENT_LIBRARY.slice(0, 92), [...BASE_FILAMENT_LIBRARY]);
});

test('every entry is well formed and unique by brand and name', () => {
  const seen = new Set<string>();
  for (const f of FILAMENT_LIBRARY) {
    assert.ok(f.brand && f.line && f.name.startsWith(f.line), f.name);
    assert.match(f.color, /^#[0-9a-f]{6}$/); assert.ok(f.td >= 0.05 && f.td <= 20, f.name);
    assert.ok(f.source, f.name);
    const k = myFilamentKey(f); assert.ok(!seen.has(k), k); seen.add(k);
  }
});

test('line art resolves a filament against the base list only', () => {
  const extra: LibraryFilament = { brand: 'Zzz', line: 'PLA', name: 'PLA Black', color: '#000000', td: 9.9, source: 'test' };
  assert.equal(matchFilament('', 'Black', [...BASE_FILAMENT_LIBRARY, extra])?.brand !== undefined, true);
  // The hazard: a brand added later can match a name with no brand that the base does not know.
  const charcoal: LibraryFilament = { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Charcoal Black', color: '#1a1a1a', td: 0.1, source: 'test' };
  assert.equal(matchFilament('', 'Panchroma Matte Charcoal Black', BASE_FILAMENT_LIBRARY), undefined);
  assert.equal(matchFilament('', 'Panchroma Matte Charcoal Black', [...BASE_FILAMENT_LIBRARY, charcoal]), charcoal);
  // filamentTd must not see `extra`: same answers as with the base alone, for named, unnamed and unknown
  // filaments, also while the full library holds the extras (as it will once brands are added).
  for (const key of Object.keys(FILAMENT_TD_BEFORE)) assert.deepEqual(filamentTd(JSON.parse(key)), FILAMENT_TD_BEFORE[key], key);
  const extras = [extra, charcoal, { ...extra, name: 'PLA Black 2', color: '#101010', td: 19 }, { ...extra, name: 'PLA Gray', color: '#808080', td: 19 }];
  FILAMENT_LIBRARY.push(...extras);
  try {
    for (const key of Object.keys(FILAMENT_TD_BEFORE)) assert.deepEqual(filamentTd(JSON.parse(key)), FILAMENT_TD_BEFORE[key], key);
  } finally {
    FILAMENT_LIBRARY.splice(-extras.length);
  }
  assert.equal(FILAMENT_LIBRARY.length, 92 + ADDED_FILAMENTS.length);
});

test('the paint palette is Bambu Lab PLA Basic and Matte from the base list', () => {
  assert.deepEqual(PAINT_LIBRARY, BASE_FILAMENT_LIBRARY.filter((f) => f.brand === 'Bambu Lab' && (f.line === 'PLA Basic' || f.line === 'PLA Matte')));
});

test('the agent is shown the brands the user owns, or the base list', () => {
  const lib = [...BASE_FILAMENT_LIBRARY, { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Charcoal Black', color: '#1a1a1a', td: 0.1, source: 'test' }];
  assert.deepEqual(promptLibrary([], lib), [...BASE_FILAMENT_LIBRARY]);
  assert.deepEqual(promptLibrary([{ brand: undefined }, { brand: 'My own' }], lib), [...BASE_FILAMENT_LIBRARY]);
  assert.deepEqual(promptLibrary([{ brand: 'polymaker' }], lib).map((f) => f.brand), ['Polymaker']);
  assert.deepEqual([...new Set(promptLibrary([{ brand: 'Bambu Lab' }, { brand: 'Polymaker' }], lib).map((f) => f.brand))], ['Bambu Lab', 'Polymaker']);
  // Spelled another way ("BambuLab"), a brand is still the library's.
  assert.deepEqual([...new Set(promptLibrary([{ brand: 'BambuLab' }], lib).map((f) => f.brand))], ['Bambu Lab']);
});

test('the LayerTone prompt lists the library lines of the brands the user owns', () => {
  setPrinter(DEFAULT_PRINTER);
  const prompt = (mine: { name: string; brand?: string; color: string; td: number }[]) => layerTone.system({ layerTone: { pictures: false, mine } } as Parameters<typeof layerTone.system>[0]);
  const library = (text: string) => text.split('\n').filter((l) => /^ {2}(Bambu Lab|eSUN) /.test(l)).map((l) => l.slice(2, l.indexOf(':')));
  assert.deepEqual(library(prompt([])), ['Bambu Lab PLA Basic', 'Bambu Lab PLA Matte', 'Bambu Lab PLA Silk+', 'eSUN PLA+']);
  // Only custom filaments: the base list, as with none.
  assert.deepEqual(library(prompt([{ name: 'Galaxy Sparkle', brand: 'My own', color: '#223344', td: 1 }])), ['Bambu Lab PLA Basic', 'Bambu Lab PLA Matte', 'Bambu Lab PLA Silk+', 'eSUN PLA+']);
  assert.deepEqual(library(prompt([{ name: 'PLA+ Black', brand: 'eSUN', color: '#000000', td: 0.2 }])), ['eSUN PLA+']);
});
