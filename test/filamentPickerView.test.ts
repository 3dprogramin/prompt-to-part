import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMON_FILAMENTS, FILAMENT_LIBRARY, filamentLines, pickerFilaments, type LibraryFilament, type MyFilament } from '../shared/filaments';
import { noMatch, pickerGroups, pickerLines, validLine } from '../src/components/filamentPickerView';

const lines = filamentLines();
const brands = [...new Set(lines.map((l) => l.brand))];
const multi = brands.find((b) => lines.filter((l) => l.brand === b).length > 1)!;
const brandLines = lines.filter((l) => l.brand === multi);
const mine: MyFilament[] = [{ name: 'Mine Red', brand: 'Acme', color: '#c12e1f', td: 1 }];
const none = { query: '', brand: '', line: '' };
const all = (g: ReturnType<typeof pickerGroups>) => g.flatMap((x) => x.filaments);

test('no brand chosen shows what the picker showed: mine, common, then every line', () => {
  const g = pickerGroups(none, mine);
  assert.deepEqual(g.map((x) => x.key), ['mine', 'common', ...lines.map((l) => l.key)]);
  assert.deepEqual(g[1].filaments, COMMON_FILAMENTS);
  assert.deepEqual(pickerGroups(none, []).map((x) => x.key)[0], 'common');
});
test('a brand chosen shows only that brand, a group per line', () => {
  const g = pickerGroups({ ...none, brand: multi }, mine);
  assert.deepEqual(g.map((x) => x.key), brandLines.map((l) => l.key));
  assert.ok(all(g).length > 0 && all(g).every((f) => f.brand === multi));
});
test('a line chosen shows only that line', () => {
  const l = brandLines[1];
  const g = pickerGroups({ ...none, brand: multi, line: l.key }, mine);
  assert.deepEqual(g.map((x) => x.key), [l.key]);
  assert.deepEqual(all(g), l.filaments);
});
test('the lines of a brand, and none without one', () => {
  assert.deepEqual(pickerLines('').map((l) => l.key), []);
  assert.deepEqual(pickerLines(multi).map((l) => l.key), brandLines.map((l) => l.key));
});
test('switching brand clears a line that is not the new brand\'s', () => {
  const other = brands.find((b) => b !== multi)!;
  assert.equal(validLine(other, brandLines[0].key), '');
  assert.equal(validLine(multi, brandLines[0].key), brandLines[0].key);
  assert.equal(validLine('', brandLines[0].key), '');
});
test('search with no brand: my filaments then the library matches, as before', () => {
  const g = pickerGroups({ ...none, query: 'red' }, mine);
  assert.equal(g.length, 1);
  assert.deepEqual(all(g), [mine[0], ...pickerFilaments('red')]);
});
test('search within a brand and a line stays inside them and leaves mine out', () => {
  const inBrand = all(pickerGroups({ ...none, query: 'red', brand: multi }, mine));
  assert.deepEqual(inBrand, pickerFilaments('red').filter((f) => f.brand === multi));
  assert.ok(!inBrand.includes(mine[0] as never));
  const l = brandLines[0];
  assert.deepEqual(all(pickerGroups({ ...none, query: '', brand: multi, line: l.key }, mine)), l.filaments);
  const q = all(pickerGroups({ ...none, query: 'a', brand: multi, line: l.key }, mine)) as LibraryFilament[];
  assert.ok(q.every((f) => f.brand === multi && f.line === l.line));
});
test('every library filament is reachable through its brand', () => {
  const n = brands.reduce((sum, b) => sum + all(pickerGroups({ ...none, brand: b }, [])).length, 0);
  assert.equal(n, FILAMENT_LIBRARY.length);
});

test('an empty search inside a brand names the brand and offers every brand when others match', () => {
  const other = brands.find((b) => b !== multi)!;
  const query = `${other} ${lines.find((l) => l.brand === other)!.filaments[0].name}`;
  const q = { query, brand: multi, line: '' };
  assert.equal(all(pickerGroups(q, mine)).length, 0, 'precondition: nothing in the chosen brand');
  const r = noMatch(q);
  assert.equal(r.text, `No ${multi} filament matches.`);
  assert.equal(r.everyBrand, true);
});
test('an empty search no brand has either says the library, and offers nothing', () => {
  const r = noMatch({ query: 'zzzz-no-such-colour', brand: multi, line: '' });
  assert.equal(r.text, `No ${multi} filament matches.`);
  assert.equal(r.everyBrand, false);
  assert.deepEqual(noMatch({ query: 'zzzz-no-such-colour', brand: '', line: '' }), { text: 'No filament in the library matches: use a custom colour.', everyBrand: false });
});
test('a chosen line is named too', () => {
  const l = brandLines[0];
  assert.equal(noMatch({ query: 'zzzz-no-such-colour', brand: multi, line: l.key }).text, `No ${l.key} filament matches.`);
});
