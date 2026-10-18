import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMyFilaments, colourFamilies, COMMON_FILAMENTS, estimatedTd, FILAMENT_LIBRARY, filamentLines, libraryFilament, myFilamentKey, myFilamentsProblem, pickerFilaments, searchMyFilaments } from '../shared/filaments';
import { replaceFilament, type LayerToneFilament } from '../shared/layertone';

const id = (f: { brand?: string; name: string }) => `${f.brand} ${f.name}`;

test('picker: the library in its lines, in library order', () => {
  const lines = filamentLines();
  assert.deepEqual(lines.map((l) => l.key), ['Bambu Lab PLA Basic', 'Bambu Lab PLA Matte', 'Bambu Lab PLA Silk+', 'eSUN PLA+']);
  assert.deepEqual(lines.flatMap((l) => l.filaments), FILAMENT_LIBRARY);
  assert.ok(lines.every((l) => l.filaments.every((f) => f.brand === l.brand && f.line === l.line)));
});

test('picker: the common colours are library filaments, one of each', () => {
  assert.ok(COMMON_FILAMENTS.length >= 10 && COMMON_FILAMENTS.length <= 11, 'one row in the picker at the usual side panel width');
  assert.equal(new Set(COMMON_FILAMENTS.map(id)).size, COMMON_FILAMENTS.length);
  assert.ok(COMMON_FILAMENTS.every((f) => FILAMENT_LIBRARY.includes(f)));
  const families = new Set(COMMON_FILAMENTS.flatMap((f) => colourFamilies(f.color)));
  for (const c of ['black', 'white', 'gray', 'beige', 'brown', 'red', 'blue', 'yellow', 'green']) assert.ok(families.has(c), c);
  assert.equal(id(COMMON_FILAMENTS[0]), 'Bambu Lab PLA Basic Black');
});

test('picker: search by name, brand, line and colour, within a line', () => {
  const names = (q: string, line?: string) => pickerFilaments(q, line).map(id);
  // Colour words find the filaments they name first, then others of that colour.
  assert.deepEqual(names('matte black'), ['Bambu Lab PLA Matte Charcoal']);
  assert.deepEqual(names('red').slice(0, 2), ['Bambu Lab PLA Basic Red', 'eSUN PLA+ Red']);
  assert.ok(names('red').includes('eSUN PLA+ Fire Engine Red'));
  assert.ok(names('skin').includes('Bambu Lab PLA Basic Beige'));
  assert.equal(names('esun').length, 24);
  assert.deepEqual(names('red', 'eSUN PLA+'), ['eSUN PLA+ Red', 'eSUN PLA+ Fire Engine Red']);
  assert.equal(names('', 'Bambu Lab PLA Silk+').length, 13);
  assert.deepEqual(names('unobtainium'), []);
});

test('picker: colour families', () => {
  assert.deepEqual(colourFamilies('#000000'), ['black']);
  assert.deepEqual(colourFamilies('#ffffff'), ['white']);
  assert.deepEqual(colourFamilies('#8e9089'), ['gray']);
  assert.deepEqual(colourFamilies('#c12e1f'), ['red']);
  assert.deepEqual(colourFamilies('#23529a'), ['blue']);
  assert.deepEqual(colourFamilies('#f4ee2a'), ['yellow']);
  assert.deepEqual(colourFamilies('#00ae42'), ['green']);
  assert.ok(colourFamilies('#f7e6de').includes('beige'));
  assert.ok(colourFamilies('#6f5034').includes('brown'));
});

test('picker: the library filament a stack filament is, and estimated TDs', () => {
  const black: LayerToneFilament = { name: 'PLA Basic Black', brand: 'Bambu Lab', color: '#000000', td: 0.2 };
  assert.equal(libraryFilament(black)?.td, 0.2);
  assert.equal(id(libraryFilament({ name: 'pla basic jade white', brand: 'bambu lab' })!), 'Bambu Lab PLA Basic Jade White');
  assert.equal(id(libraryFilament({ name: 'Black', brand: 'eSUN' })!), 'eSUN PLA+ Black');
  assert.equal(libraryFilament({ name: 'PLA Basic Black' }), undefined); // no brand: custom
  assert.equal(libraryFilament({ name: 'Galaxy Sparkle', brand: 'Bambu Lab' }), undefined);
  const dark = FILAMENT_LIBRARY.find((f) => f.name === 'PLA Basic Dark Gray')!;
  assert.ok(dark.unverified);
  assert.equal(estimatedTd(dark), true);
  assert.equal(estimatedTd({ ...dark, td: 0.6 }), false); // the user's own value
  assert.equal(estimatedTd(black), false);
});

test('picker: a filament is replaced in place, with only the stack\'s fields', () => {
  const list: LayerToneFilament[] = [
    { name: 'PLA Basic Black', brand: 'Bambu Lab', color: '#000000', td: 0.2 },
    { name: 'Mine', color: '#123456', td: 1 },
    { name: 'PLA Basic Jade White', brand: 'Bambu Lab', color: '#ffffff', td: 5.9 },
  ];
  const red = FILAMENT_LIBRARY.find((f) => f.name === 'PLA+ Red')!;
  const out = replaceFilament(list, 1, red);
  assert.deepEqual(out, [list[0], { name: 'PLA+ Red', brand: 'eSUN', color: '#c4402b', td: 3.5 }, list[2]]);
  assert.equal(list[1].name, 'Mine'); // not changed
  assert.deepEqual(replaceFilament(list, 0, { name: 'Grey', brand: undefined, color: '#808080', td: 1 })[0], { name: 'Grey', color: '#808080', td: 1 });
});

test('my filaments: what is wrong, cleaning, search', () => {
  const ok = { name: 'Teal', brand: 'Polymaker', color: '#33aa77', td: 2.5 };
  assert.equal(myFilamentsProblem([ok, { name: 'Grey', color: '#808080', td: 20 }]), undefined);
  assert.equal(myFilamentsProblem(ok), 'Send { filaments: [...] }');
  assert.match(myFilamentsProblem([ok, { ...ok, td: 0 }])!, /^Filament 2: TD/);
  assert.match(myFilamentsProblem([{ ...ok, color: 'red' }])!, /#rrggbb/);
  assert.deepEqual(cleanMyFilaments([{ ...ok, name: ' Teal ', brand: ' ' }, { bad: 1 }, null, { ...ok, color: '#33AA77' }]), [{ name: 'Teal', color: '#33aa77', td: 2.5 }, { name: 'Teal', brand: 'Polymaker', color: '#33aa77', td: 2.5 }]);
  assert.deepEqual(cleanMyFilaments('x'), []);
  assert.equal(myFilamentKey({ name: 'PLA Plus Grey', brand: 'eSun' }), myFilamentKey({ name: 'pla+ gray', brand: 'ESUN' }));
  const list = [ok, { name: 'Leftover', color: '#111111', td: 0.3 }];
  assert.deepEqual(searchMyFilaments(list, 'poly').map((f) => f.name), ['Teal']);
  assert.deepEqual(searchMyFilaments(list, 'black').map((f) => f.name), ['Leftover']);
  assert.deepEqual(searchMyFilaments(list, 'teal green').map((f) => f.name), ['Teal']);
  assert.deepEqual(searchMyFilaments(list, 'red'), []);
});
