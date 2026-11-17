import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colourFamilies, DUPLICATE_FILAMENT, FILAMENT_LIBRARY, MAX_MY_FILAMENTS, myFilamentKey, rollsOf, withMyFilament, type MyFilament } from '../shared/filaments';
import { mineStore, NOT_LOADED } from '../src/lib/mineStore';
import { addFromLibrary, brandOrder, cardLabel, libraryBrands, libraryCount, libraryLines, libraryView, linePills, shelfSaver, shelfSummary, shelfView, summaryText, withRolls, without } from '../src/components/settings/filamentsTab';
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
test('line pills: a chosen brand\'s lines only, none while every brand is shown', () => {
  assert.deepEqual(linePills(null, lib), []);
  for (const b of libraryBrands(lib)) assert.deepEqual(linePills(b, lib), libraryLines(b, lib));
  assert.ok(linePills('eSUN', lib).every((l) => lib.some((f) => f.brand === 'eSUN' && f.line === l)));
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
  assert.ok(libraryView({ query: 'silk', brand: null, line: null }, [], lib).every((c) => /silk/i.test(`${c.filament.line} ${c.filament.name}`)));
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
  const n = lib.length;
  assert.equal(libraryCount(n, n), `${n} colours`);
  assert.equal(libraryCount(12, n), `12 of ${n} colours`);
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

// ---- saves: one at a time, the newest list last (as the Printer tab does); every change applied to the newest list

function slowSaves() {
  const calls: MyFilament[][] = [];
  const settle: { ok: () => void; fail: (e: Error) => void }[] = [];
  const save = (list: MyFilament[]) => { calls.push(list); return new Promise<void>((ok, fail) => settle.push({ ok, fail })); };
  return { calls, settle, save };
}
const ready = (list: MyFilament[]) => () => list;

test('two quick roll edits are saved one at a time, the newest list last', async () => {
  const { calls, settle, save } = slowSaves();
  const saver = shelfSaver(save, async () => {}, ready(mine));
  const key = myFilamentKey(mine[1]);
  void saver.change((l) => withRolls(l, key, 5)); void saver.change((l) => withRolls(l, key, 7)); void saver.change((l) => withRolls(l, key, 9));
  assert.equal(calls.length, 1);
  assert.equal(rollsOf(calls[0].find((f) => myFilamentKey(f) === key)!), 5);
  assert.equal(rollsOf(saver.pending()!.find((f) => myFilamentKey(f) === key)!), 9);
  settle[0].ok();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(rollsOf(calls[1].find((f) => myFilamentKey(f) === key)!), 9);
  settle[1].ok();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(saver.pending(), null);
});

test('an add then a roll edit: the edit is made on the added list, and both are saved in order', async () => {
  const { calls, settle, save } = slowSaves();
  const saver = shelfSaver(save, async () => {}, ready(mine));
  const f = lib[0];
  void saver.change((l) => addFromLibrary(l, f));
  void saver.change((l) => withRolls(l, myFilamentKey(f), '4'));
  settle[0].ok();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 4);
  assert.equal(rollsOf(calls[1].find((x) => myFilamentKey(x) === myFilamentKey(f))!), 4);
  settle[1].ok();
  await tick();
});

test('a form save queued behind a tab save is not replaced by the next tab action: changes compose', async () => {
  const { calls, settle, save } = slowSaves();
  const saver = shelfSaver(save, async () => {}, ready(mine));
  const results: string[] = [];
  void saver.change((l) => withRolls(l, myFilamentKey(mine[0]), 6)).then(() => results.push('rolls saved'));
  const custom = { name: 'Smoke Orange', brand: 'Acme', color: '#ff8800', td: 2 };
  void saver.change((l) => withMyFilament(l, custom)).then(() => results.push('form saved'));
  void saver.change((l) => without(l, myFilamentKey(mine[2]))).then(() => results.push('remove saved'));
  // The pending list holds all three at once.
  assert.deepEqual(saver.pending()!.map((f) => f.name), ['Jade White', 'Black', 'Smoke Orange']);
  assert.equal(results.length, 0);
  settle[0].ok();
  await tick();
  assert.deepEqual(results, ['rolls saved'], 'the form is not told "saved" before its own change is');
  assert.deepEqual(calls[1].map((f) => f.name), ['Jade White', 'Black', 'Smoke Orange']);
  assert.equal(calls[1][0].rolls, 6);
  settle[1].ok();
  await tick();
  assert.deepEqual(results.sort(), ['form saved', 'remove saved', 'rolls saved']);
});

test('a change whose save fails is told so; one carried by a later save that works is told saved', async () => {
  const { settle, save } = slowSaves();
  let refreshed = 0;
  const saver = shelfSaver(save, async () => { refreshed++; }, ready(mine));
  const told: string[] = [];
  const report = (what: string, p: Promise<void>) => p.then(() => told.push(`${what} saved`), (e: Error) => told.push(`${what} failed: ${e.message}`));
  report('a', saver.change((l) => withRolls(l, myFilamentKey(mine[0]), 6)));
  report('b', saver.change((l) => withRolls(l, myFilamentKey(mine[1]), 8)));
  settle[0].fail(new Error('Busy'));
  await tick();
  assert.deepEqual(told, [], 'a is in the next save too: not told yet');
  settle[1].ok();
  await tick();
  assert.deepEqual(told.sort(), ['a saved', 'b saved']);
  report('c', saver.change((l) => withRolls(l, myFilamentKey(mine[0]), 7)));
  settle[2].fail(new Error('Disk full'));
  await tick();
  assert.deepEqual(told.slice(2), ['c failed: Disk full']);
  assert.equal(refreshed, 1);
  assert.equal(saver.pending(), null);
});

test('nothing is saved before the list was read, nor for a refused change', async () => {
  const { calls, save } = slowSaves();
  const unread = shelfSaver(save, async () => {}, () => null);
  await assert.rejects(unread.change((l) => addFromLibrary(l, lib[0])), { message: NOT_LOADED });
  const saver = shelfSaver(save, async () => {}, ready(mine));
  const full = Array.from({ length: MAX_MY_FILAMENTS }, (_, i) => ({ name: `F${i}`, color: '#000000', td: 1 }));
  const fullSaver = shelfSaver(save, async () => {}, ready(full));
  await assert.rejects(fullSaver.change((l) => addFromLibrary(l, lib[0])), { message: 'My filaments is full: 100 at most. Remove one first.' });
  // No change at all (already owned): nothing to send, done at once.
  await saver.change((l) => addFromLibrary(l, { ...lib[0], name: mine[0].name, brand: mine[0].brand! }));
  assert.equal(calls.length, 0);
  assert.equal(saver.pending(), null);
});

test('the saver tells its listeners at once when a change is queued, then started, then saved', async () => {
  const { settle, save } = slowSaves();
  const saver = shelfSaver(save, async () => {}, ready(mine));
  const events: string[] = [];
  const stop = saver.listen((e) => events.push(e.kind));
  const done = saver.change((l) => without(l, myFilamentKey(mine[2])));
  assert.deepEqual(events, ['queued', 'start']);
  settle[0].ok();
  await done;
  await tick();
  assert.deepEqual(events, ['queued', 'start', 'saved']);
  stop();
  void saver.change((l) => without(l, myFilamentKey(mine[1])));
  settle[1].ok();
  await tick();
  assert.equal(events.length, 3);
});

// ---- the store: never written from a list it has not read

function fakeServer(start: MyFilament[]) {
  const server = { list: start, reads: 0, writes: [] as MyFilament[][], failReads: false, holdReads: [] as (() => void)[], hold: false };
  const io = {
    read: async () => {
      server.reads++;
      if (server.hold) await new Promise<void>((r) => server.holdReads.push(r));
      if (server.failReads) throw new Error('Server down');
      return server.list;
    },
    write: async (list: MyFilament[]) => { server.writes.push(list); server.list = list; return list; },
  };
  return { server, io };
}

test('the store starts loading, and a save before the first read is refused with nothing written', async () => {
  const { server, io } = fakeServer(mine);
  const store = mineStore(io);
  assert.equal(store.get().status, 'loading');
  await assert.rejects(store.save([{ name: 'Only one', color: '#000000', td: 1 }]), { message: NOT_LOADED });
  assert.equal(server.writes.length, 0);
  await store.refresh();
  assert.deepEqual(store.get(), { list: mine, status: 'ready' });
});

test('a change asked for before the first read reads first and is made on what the server has', async () => {
  const { server, io } = fakeServer(mine);
  const store = mineStore(io);
  await store.change((l) => withMyFilament(l, { name: 'New one', color: '#123123', td: 1 }));
  assert.equal(server.writes.length, 1);
  assert.deepEqual(server.writes[0].map((f) => f.name), ['Jade White', 'Black', 'My blend', 'New one']);
  assert.equal(store.get().status, 'ready');
});

test('a failed read leaves the store "failed": changes are refused with a plain message until a read works', async () => {
  const { server, io } = fakeServer(mine);
  server.failReads = true;
  const store = mineStore(io);
  await assert.rejects(store.refresh());
  assert.equal(store.get().status, 'failed');
  await assert.rejects(store.change((l) => addFromLibrary(l, lib[0])), { message: NOT_LOADED });
  assert.equal(server.writes.length, 0);
  assert.equal(NOT_LOADED, 'Your filaments could not be loaded. Nothing was changed.');
  server.failReads = false;
  const retry = store.refresh();
  assert.equal(store.get().status, 'loading', 'Try again shows loading');
  await retry;
  assert.deepEqual(store.get(), { list: mine, status: 'ready' });
});

test('a read answered after a save that started later does not undo the save', async () => {
  const { server, io } = fakeServer(mine);
  const store = mineStore(io);
  await store.refresh();
  server.hold = true;
  const late = store.refresh();
  await tick();
  const saved = without(mine, myFilamentKey(mine[2]));
  await store.save(saved);
  server.list = mine; // (what the slow read saw)
  server.holdReads.forEach((r) => r());
  await late;
  assert.deepEqual(store.get().list, saved);
});

// ---- the custom form's save: change one in place, add one, never take another's brand and name

test('editing a saved filament keeps its place and rolls; renaming onto another saved one is refused', () => {
  const black = myFilamentKey(mine[1]);
  const renamed = withMyFilament(mine, { name: 'Black Two', brand: 'Bambu Lab', color: '#010101', td: 0.7 }, black);
  assert.equal(renamed.problem, undefined);
  assert.deepEqual(renamed.list.map((f) => f.name), ['Jade White', 'Black Two', 'My blend']);
  assert.equal(renamed.list[1].rolls, 3);
  const clash = withMyFilament(mine, { name: 'jade  white', brand: 'BambuLab', color: '#010101', td: 0.7 }, black);
  assert.equal(clash.list, mine);
  assert.equal(clash.problem, DUPLICATE_FILAMENT);
  assert.equal(DUPLICATE_FILAMENT, 'You already have a filament with this brand and name.');
});

test('"Save as mine" adds at the end, saves one again in place with its rolls, and refuses a 101st', () => {
  const added = withMyFilament(mine, { name: 'New', color: '#ffffff', td: 3 });
  assert.deepEqual(added.list.map((f) => f.name), ['Jade White', 'Black', 'My blend', 'New']);
  const again = withMyFilament(mine, { name: 'Black', brand: 'Bambu Lab', color: '#020202', td: 0.5 });
  assert.equal(again.problem, undefined);
  assert.deepEqual(again.list.map((f) => [f.name, f.color, f.rolls]), [['Jade White', '#f4f4f0', 2], ['Black', '#020202', 3], ['My blend', '#123456', undefined]]);
  const full = Array.from({ length: MAX_MY_FILAMENTS }, (_, i) => ({ name: `F${i}`, color: '#000000', td: 1 }));
  assert.deepEqual(withMyFilament(full, { name: 'One more', color: '#000000', td: 1 }), { list: full, problem: 'My filaments is full: 100 at most. Remove one first.' });
  assert.equal(withMyFilament(full, { name: 'F3', color: '#111111', td: 1 }).problem, undefined, 'changing one on a full shelf is fine');
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

// ---- the brand order: the user's own brands first
const alpha = [...new Set(lib.map((f) => f.brand))].sort((a, b) => a.localeCompare(b));
const own = (brand: string | undefined, n = 1): MyFilament[] => Array.from({ length: n }, (_, i) => ({ name: `Own ${brand ?? 'none'} ${i}`, ...(brand ? { brand } : {}), color: '#123456', td: 1 }));
test('brand order: no saved filaments is plain alphabetical', () => {
  assert.deepEqual(brandOrder([], lib), alpha);
  assert.deepEqual(libraryBrands(lib), alpha);
});
test('brand order: only custom filaments, or brands outside the library, change nothing', () => {
  assert.deepEqual(brandOrder([...own(undefined, 3), ...own('Acme No Such Brand', 2)], lib), alpha);
});
test('brand order: saved brands first, most filaments first, then the rest alphabetically', () => {
  const [few, many] = [alpha[alpha.length - 1], alpha[alpha.length - 2]];
  const got = brandOrder([...own(few, 1), ...own(many, 3)], lib);
  assert.deepEqual(got.slice(0, 2), [many, few]);
  assert.deepEqual(got.slice(2), alpha.filter((b) => b !== few && b !== many));
});
test('brand order: equal counts are alphabetical', () => {
  const [a, b] = [alpha[0], alpha[1]];
  assert.deepEqual(brandOrder([...own(b, 2), ...own(a, 2)], lib).slice(0, 2), [a, b]);
});
test('brand order: a brand spelled in another case counts for the library brand', () => {
  const last = alpha[alpha.length - 1], other = alpha[0];
  const got = brandOrder([...own(last.toUpperCase(), 1), ...own(` ${last.toLowerCase()}`, 1), ...own(other, 1)], lib);
  assert.deepEqual(got.slice(0, 2), [last, other]);
  assert.equal(new Set(got).size, alpha.length);
});
test('libraryBrands takes the user\'s filaments to order by', () => {
  const last = alpha[alpha.length - 1];
  assert.equal(libraryBrands(lib, own(last, 1))[0], last);
});
