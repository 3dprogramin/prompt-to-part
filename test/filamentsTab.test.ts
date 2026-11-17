import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colourFamilies, FILAMENT_LIBRARY, MAX_MY_FILAMENTS, myFilamentKey, rollsOf, type MyFilament } from '../shared/filaments';
import { addFromLibrary, cardLabel, libraryBrands, libraryCount, libraryLines, libraryView, shelfSaver, shelfSummary, shelfView, summaryText, withRolls, without } from '../src/components/settings/filamentsTab';
import { openSettings, setSettingsOpener } from '../src/components/settings/openSettings';

const mine: MyFilament[] = [
  { name: 'Jade White', brand: 'Bambu Lab', color: '#f4f4f0', td: 4.2, rolls: 2 },
  { name: 'Black', brand: 'Bambu Lab', color: '#000000', td: 0.6, rolls: 3 },
  { name: 'My blend', color: '#123456', td: 2 },
];
const lib = FILAMENT_LIBRARY;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('the shelf summary counts colours and rolls, a missing count as 1', () => {
  assert.deepEqual(shelfSummary(mine), { colours: 3, rolls: 6 });
});
test('the shelf summary reads "14 colours · 19 rolls", singular for one', () => {
  assert.equal(summaryText({ colours: 14, rolls: 19 }), '14 colours · 19 rolls');
  assert.equal(summaryText({ colours: 1, rolls: 1 }), '1 colour · 1 roll');
  assert.equal(summaryText({ colours: 0, rolls: 0 }), '0 colours · 0 rolls');
});
test('the shelf is in brand then name order, no brand last, and searchable', () => {
  assert.deepEqual(shelfView(mine, '').map((f) => f.name), ['Black', 'Jade White', 'My blend']);
  assert.deepEqual(shelfView(mine, 'jade').map((f) => f.name), ['Jade White']);
});
test('brands and lines come from the library', () => {
  assert.deepEqual(libraryBrands(lib), [...new Set(lib.map((f) => f.brand))].sort((a, b) => a.localeCompare(b)));
  const bambu = libraryLines('Bambu Lab', lib);
  assert.ok(bambu.length > 0 && bambu.every((l) => lib.some((f) => f.brand === 'Bambu Lab' && f.line === l)));
});
test('the lines of all brands, each once and in order', () => {
  const all = libraryLines(null, lib);
  assert.deepEqual(all, [...new Set(lib.flatMap((f) => (f.line ? [f.line] : [])))].sort((a, b) => a.localeCompare(b)));
  assert.ok(!libraryLines('eSUN', lib).includes('PLA Matte'));
});
test('the library view filters by brand, line and text, and marks what is owned', () => {
  const all = libraryView({ query: '', brand: null, line: null }, mine, lib);
  assert.equal(all.length, lib.length);
  const esun = libraryView({ query: '', brand: 'eSUN', line: null }, mine, lib);
  assert.ok(esun.length > 0 && esun.every((c) => c.filament.brand === 'eSUN'));
  const owned = lib.find((f) => f.brand === 'Bambu Lab')!;
  const withOwned = libraryView({ query: '', brand: null, line: null }, [{ name: owned.name.toUpperCase(), brand: 'bambu lab', color: owned.color, td: owned.td }], lib);
  assert.equal(withOwned.find((c) => c.key === myFilamentKey(owned))!.owned, true);
  assert.equal(withOwned.filter((c) => c.owned).length, 1);
  assert.deepEqual(libraryView({ query: 'zzzz-no-such', brand: null, line: null }, mine, lib), []);
});
test('with no search the library is in brand, line, name order', () => {
  const shuffled = [...lib].reverse();
  const names = libraryView({ query: '', brand: null, line: null }, [], shuffled).map((c) => `${c.filament.brand}|${c.filament.line}|${c.filament.name}`);
  const want = [...lib].sort((a, b) => a.brand.localeCompare(b.brand) || (a.line ?? '').localeCompare(b.line ?? '') || a.name.localeCompare(b.name)).map((f) => `${f.brand}|${f.line}|${f.name}`);
  assert.deepEqual(names, want);
});
test('a line narrows the library, within a brand or across brands', () => {
  const matte = libraryView({ query: '', brand: 'Bambu Lab', line: 'PLA Matte' }, [], lib);
  assert.ok(matte.length > 0 && matte.every((c) => c.filament.brand === 'Bambu Lab' && c.filament.line === 'PLA Matte'));
  assert.deepEqual(libraryView({ query: '', brand: 'eSUN', line: 'PLA Matte' }, [], lib), []);
  const plus = libraryView({ query: '', brand: null, line: 'PLA+' }, [], lib);
  assert.ok(plus.length > 0 && plus.every((c) => c.filament.line === 'PLA+'));
});
test('the library search finds by colour word, name, brand and line', () => {
  const keys = (query: string) => libraryView({ query, brand: null, line: null }, [], lib).map((c) => c.key);
  // A colour word also finds filaments of that colour whose name does not say it.
  const bluish = lib.find((f) => !/blue/i.test(f.name) && colourFamilies(f.color).includes('blue'))!;
  assert.ok(bluish, 'the library has a blue that is not named blue');
  assert.ok(keys('blue').includes(myFilamentKey(bluish)));
  // The ones named by the word come first.
  assert.match(libraryView({ query: 'blue', brand: null, line: null }, [], lib)[0].filament.name, /blue/i);
  assert.ok(keys('white').includes(myFilamentKey({ brand: 'Bambu Lab', name: 'PLA Basic Jade White' })));
  assert.ok(keys('jade').includes(myFilamentKey({ brand: 'Bambu Lab', name: 'PLA Basic Jade White' })));
  assert.ok(keys('esun').length > 0 && libraryView({ query: 'esun', brand: null, line: null }, [], lib).every((c) => c.filament.brand === 'eSUN'));
  assert.ok(libraryView({ query: 'silk', brand: null, line: null }, [], lib).every((c) => c.filament.line === 'PLA Silk+'));
  // The search and the brand together.
  assert.ok(libraryView({ query: 'blue', brand: 'eSUN', line: null }, [], lib).every((c) => c.filament.brand === 'eSUN'));
});
test('a card is named in full: what a click does, brand, TD, estimated, owned', () => {
  const jade = lib.find((f) => f.name === 'PLA Basic Jade White')!;
  assert.equal(cardLabel({ filament: jade, key: myFilamentKey(jade), owned: false }), 'Add PLA Basic Jade White, Bambu Lab, TD 5.9');
  assert.equal(cardLabel({ filament: jade, key: myFilamentKey(jade), owned: true }), 'PLA Basic Jade White, Bambu Lab, TD 5.9, owned');
  const est = lib.find((f) => f.unverified)!;
  assert.equal(cardLabel({ filament: est, key: myFilamentKey(est), owned: false }), `Add ${est.name}, ${est.brand}, TD ${est.td}, estimated`);
});
test('the library count says how many are shown of all', () => {
  assert.equal(libraryCount(92, 92), '92 colours');
  assert.equal(libraryCount(12, 92), '12 of 92 colours');
  assert.equal(libraryCount(1, 1), '1 colour');
});
test('adding from the library saves the plain filament with one roll, once', () => {
  const f = lib.find((x) => x.unverified !== true)!;
  const { list, problem } = addFromLibrary([], f);
  assert.equal(problem, undefined);
  assert.deepEqual(list, [{ name: f.name, brand: f.brand, color: f.color, td: f.td, rolls: 1 }]);
  assert.deepEqual(addFromLibrary(list, f), { list });
});
test('an estimated library filament is saved without its library notes', () => {
  const f = lib.find((x) => x.unverified === true)!;
  assert.deepEqual(addFromLibrary([], f).list, [{ name: f.name, brand: f.brand, color: f.color, td: f.td, rolls: 1 }]);
});
test('one already owned under another spelling or case is not added again', () => {
  const f = lib.find((x) => x.brand === 'Bambu Lab')!;
  const owned: MyFilament[] = [{ name: `  ${f.name.toLowerCase()} `, brand: 'BambuLab', color: f.color, td: f.td, rolls: 4 }];
  const r = addFromLibrary(owned, f);
  assert.equal(r.list, owned);
  assert.equal(r.problem, undefined);
  assert.equal(libraryView({ query: '', brand: null, line: null }, owned, lib).find((c) => c.key === myFilamentKey(f))!.owned, true);
});
test('a full shelf refuses another with a plain message', () => {
  const full = Array.from({ length: MAX_MY_FILAMENTS }, (_, i) => ({ name: `F${i}`, color: '#000000', td: 1 }));
  const r = addFromLibrary(full, lib[0]);
  assert.equal(r.list, full); assert.equal(r.problem, 'My filaments is full: 100 at most. Remove one first.');
});
test('a full shelf that already has the filament gives no message (a click on an owned card does nothing)', () => {
  const f = lib[0];
  const full: MyFilament[] = [{ name: f.name, brand: f.brand, color: f.color, td: f.td }, ...Array.from({ length: MAX_MY_FILAMENTS - 1 }, (_, i) => ({ name: `F${i}`, color: '#000000', td: 1 }))];
  assert.deepEqual(addFromLibrary(full, f), { list: full });
});
test('rolls are set clean, and removing takes one out', () => {
  const key = myFilamentKey(mine[1]);
  assert.equal(rollsOf(withRolls(mine, key, '250').find((f) => myFilamentKey(f) === key)!), 99);
  assert.equal(rollsOf(withRolls(mine, key, '').find((f) => myFilamentKey(f) === key)!), 0);
  assert.deepEqual(without(mine, key).map((f) => f.name), ['Jade White', 'My blend']);
});
test('a typed roll count becomes the nearest whole number from 0 to 99, never anything else', () => {
  const key = myFilamentKey(mine[1]);
  const rolls = (raw: unknown) => withRolls(mine, key, raw).find((f) => myFilamentKey(f) === key)!.rolls;
  assert.equal(rolls('abc'), 0);
  assert.equal(rolls('2.6'), 3);
  assert.equal(rolls('2.4'), 2);
  assert.equal(rolls('-4'), 0);
  assert.equal(rolls('99'), 99);
  assert.equal(rolls('100'), 99);
  assert.equal(rolls(' 7 '), 7);
  for (const raw of ['abc', '2.6', '-4', '', '1e9', 'NaN', 'Infinity']) {
    const n = rolls(raw);
    assert.ok(Number.isInteger(n) && n! >= 0 && n! <= 99, `${raw} gives ${n}`);
  }
});
test('a roll count that changes nothing gives the same list (nothing to save)', () => {
  const key = myFilamentKey(mine[0]);
  assert.equal(withRolls(mine, key, '2'), mine);
  // No count saved means 1: typing 1 keeps it that way.
  assert.equal(withRolls(mine, myFilamentKey(mine[2]), '1'), mine);
  assert.equal(withRolls(mine, 'no|such', '5'), mine);
  assert.notEqual(withRolls(mine, key, '5'), mine);
  assert.deepEqual(withRolls(mine, key, '5').map((f) => f.name), mine.map((f) => f.name));
});

// ---- saves: one at a time, the newest list last (as the Printer tab does)

function slowSaves() {
  const calls: MyFilament[][] = [];
  const releases: (() => void)[] = [];
  const save = (list: MyFilament[]) => { calls.push(list); return new Promise<void>((r) => releases.push(r)); };
  return { calls, releases, save };
}

test('two quick roll edits are saved one at a time, the newest list last', async () => {
  const { calls, releases, save } = slowSaves();
  const saver = shelfSaver(save, async () => {});
  const key = myFilamentKey(mine[1]);
  const a = withRolls(mine, key, 5), b = withRolls(a, key, 7), c = withRolls(b, key, 9);
  void saver.save(a); void saver.save(b); void saver.save(c);
  assert.deepEqual(calls, [a]);
  assert.equal(saver.pending(), c);
  releases[0]();
  await tick();
  assert.deepEqual(calls, [a, c]);
  assert.equal(saver.pending(), c);
  releases[1]();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(saver.pending(), null);
});

test('an add then a roll edit: the edit is made on the added list, and both are saved in order', async () => {
  const { calls, releases, save } = slowSaves();
  const saver = shelfSaver(save, async () => {});
  const f = lib[0];
  const added = addFromLibrary(mine, f).list;
  void saver.save(added);
  // The tab builds the next change on what it sent, not on the store the server has not answered yet.
  const edited = withRolls(saver.pending() ?? mine, myFilamentKey(f), '4');
  void saver.save(edited);
  releases[0]();
  await tick();
  assert.deepEqual(calls, [added, edited]);
  assert.equal(rollsOf(calls[1].find((x) => myFilamentKey(x) === myFilamentKey(f))!), 4);
  releases[1]();
  await tick();
});

test('the saver tells its listeners: started, then saved; the promise settles with the newest save', async () => {
  const { releases, save } = slowSaves();
  const saver = shelfSaver(save, async () => {});
  const events: string[] = [];
  const stop = saver.listen((e) => events.push(e.kind));
  const done = saver.save(mine);
  releases[0]();
  await done;
  assert.deepEqual(events, ['start', 'saved']);
  stop();
  void saver.save(mine);
  releases[1]();
  await tick();
  assert.deepEqual(events, ['start', 'saved']);
});

test('a failed save says why and reads the list again from the server', async () => {
  let refreshed = 0;
  const saver = shelfSaver(async () => { throw new Error('Disk full'); }, async () => { refreshed++; });
  const events: string[] = [];
  saver.listen((e) => events.push(e.kind === 'failed' ? `failed ${e.error.message}` : e.kind));
  await assert.rejects(saver.save(mine), /Disk full/);
  assert.deepEqual(events, ['start', 'failed Disk full']);
  assert.equal(refreshed, 1);
  assert.equal(saver.pending(), null);
});

test('the picker opens Settings on a tab through the opener the app registers', () => {
  assert.equal(openSettings('filaments'), false);
  const asked: (string | undefined)[] = [];
  const stop = setSettingsOpener((tab) => asked.push(tab));
  assert.equal(openSettings('filaments'), true);
  assert.deepEqual(asked, ['filaments']);
  stop();
  assert.equal(openSettings('filaments'), false);
});
