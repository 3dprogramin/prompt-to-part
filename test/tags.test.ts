import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTag, cleanTagMap, cleanTags, hasTag, MAX_TAG_CHARS, MAX_TAGS, tagsProblem, withTag } from '../shared/tags';
import { ALL, cleanFilter, deletePlan, liveFilter, printedRows, shownDesigns, someNames, tagCounts, tagState } from '../src/lib/designList';
import { pickIds } from '../src/lib/picking';
import type { DesignSummary } from '../shared/types';

test('tags are trimmed, built-ins take their own spelling, each tag once, built-ins first', () => {
  assert.equal(cleanTag('  Line \t art\nperete '), 'Line art perete');
  assert.equal(cleanTag('product'), 'Product');
  assert.equal(cleanTag('TEMP'), 'Temp');
  assert.deepEqual(cleanTags(['Ornamente', 'temp', 'ornamente', 'Product', '', 5, 'x'.repeat(MAX_TAG_CHARS + 1)]), ['Product', 'Temp', 'Ornamente']);
  assert.deepEqual(cleanTags(['Crăciun', 'craciun']), ['Crăciun']);
  assert.deepEqual(cleanTags('Product'), []);
  assert.equal(cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, MAX_TAGS);
});

test('a page\'s tags are checked: words, not empty, short, not too many', () => {
  assert.equal(tagsProblem(['Product', 'Ornamente']), null);
  assert.match(tagsProblem('Product')!, /list/);
  assert.match(tagsProblem([3])!, /list/);
  assert.match(tagsProblem(['  '])!, /empty/);
  assert.match(tagsProblem(['x'.repeat(MAX_TAG_CHARS + 1)])!, /up to/);
  assert.match(tagsProblem(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`))!, /up to 12 tags/);
  // The same tag twice counts once.
  assert.equal(tagsProblem([...Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`), 'T0']), null);
});

test('withTag adds a tag once (keeping its spelling) or takes it away; the stored map drops bad entries', () => {
  assert.deepEqual(withTag(['Ornamente'], 'temp', true), ['Temp', 'Ornamente']);
  assert.deepEqual(withTag(['Ornamente'], 'ORNAMENTE', true), ['Ornamente']);
  assert.deepEqual(withTag(['Temp', 'Ornamente'], 'temp', false), ['Ornamente']);
  assert.deepEqual(withTag(undefined, 'Product', false), []);
  assert.ok(hasTag(['Crăciun'], 'craciun'));
  const ok = (id: string) => /^[a-z0-9-]{8,}$/.test(id);
  assert.deepEqual(cleanTagMap({ 'design-0001': ['temp', 'Temp'], 'bad id': ['x'], 'design-0002': [], 'design-0003': 'x' }, ok), { 'design-0001': ['Temp'] });
  assert.deepEqual(cleanTagMap(['x'], ok), {});
});

const d = (id: string, name: string, updatedAt: number, extra: Partial<DesignSummary> = {}): DesignSummary => ({ id, name, updatedAt, createdAt: 100 - updatedAt, versions: 1, ...extra });
const list = [
  d('a', 'Brad de Crăciun', 5, { tags: ['Product', 'Ornamente'], starred: true }),
  d('b', 'test cube', 9, { tags: ['Temp'] }),
  d('c', 'Another test', 7, { tags: ['Temp', 'Ornamente'] }),
  d('d', 'Line art car', 1),
];

test('the Designs menu filters by tag, stars or no tag, searches names and sorts', () => {
  const ids = (l: DesignSummary[]) => l.map((x) => x.id);
  assert.deepEqual(ids(shownDesigns(list, ALL, '', 'updated')), ['b', 'c', 'a', 'd']);
  assert.deepEqual(ids(shownDesigns(list, ALL, '', 'created')), ['d', 'a', 'c', 'b']);
  assert.deepEqual(ids(shownDesigns(list, ALL, '', 'name')), ['c', 'a', 'd', 'b']);
  assert.deepEqual(ids(shownDesigns(list, { kind: 'tag', tag: 'temp' }, '', 'updated')), ['b', 'c']);
  assert.deepEqual(ids(shownDesigns(list, { kind: 'tag', tag: 'Temp' }, 'ANOTHER', 'updated')), ['c']);
  assert.deepEqual(ids(shownDesigns(list, { kind: 'starred' }, '', 'updated')), ['a']);
  assert.deepEqual(ids(shownDesigns(list, { kind: 'untagged' }, '', 'updated')), ['d']);
  assert.deepEqual(ids(shownDesigns(list, ALL, 'craciun', 'updated')), ['a']);
  assert.deepEqual(tagCounts(list), [{ tag: 'Product', count: 1 }, { tag: 'Temp', count: 2 }, { tag: 'Ornamente', count: 2 }]);
  // The built-ins are offered even when no design has them; a user tag that's gone shows every design.
  assert.deepEqual(tagCounts([]).map((c) => c.tag), ['Product', 'Temp']);
  assert.deepEqual(liveFilter({ kind: 'tag', tag: 'Gone' }, list), ALL);
  assert.deepEqual(liveFilter({ kind: 'tag', tag: 'Temp' }, []), { kind: 'tag', tag: 'Temp' });
  assert.deepEqual(cleanFilter({ kind: 'tag', tag: 'Temp' }), { kind: 'tag', tag: 'Temp' });
  assert.deepEqual(cleanFilter({ kind: 'tag', tag: 3 }), ALL);
  assert.deepEqual(cleanFilter(null), ALL);
  assert.equal(tagState(list.slice(1, 3), 'Temp'), 'all');
  assert.equal(tagState(list.slice(0, 2), 'Ornamente'), 'some');
  assert.equal(tagState(list.slice(1, 2), 'Product'), 'none');
});

test('picking: a click picks or drops one, a shift-click a range from the last one clicked; hidden ones drop out', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  const one = pickIds(order, new Set(), 'b', null, false);
  assert.deepEqual([...one], ['b']);
  const range = pickIds(order, one, 'e', 'b', true);
  assert.deepEqual([...range].sort(), ['b', 'c', 'd', 'e']);
  // Shift-clicking a picked one drops the range.
  assert.deepEqual([...pickIds(order, range, 'c', 'e', true)].sort(), ['b']);
  // Shift without an earlier click picks just the one.
  assert.deepEqual([...pickIds(order, new Set(), 'd', null, true)], ['d']);
  // An item no longer shown doesn't stay picked.
  assert.deepEqual([...pickIds(['a', 'b'], new Set(['x', 'a']), 'b', null, false)].sort(), ['a', 'b']);
});

test('a bulk delete asks once, naming the designs, and leaves the ones still being worked on', () => {
  const plan = deletePlan(list.slice(0, 3), (id) => id === 'b');
  assert.deepEqual(plan.remove.map((x) => x.id), ['a', 'c']);
  assert.deepEqual(plan.busy.map((x) => x.id), ['b']);
  assert.match(plan.question!, /^Delete these 2 designs permanently/);
  assert.match(plan.question!, /- Brad de Crăciun\n- Another test/);
  assert.match(plan.question!, /still being worked on: "test cube"/);
  assert.equal(deletePlan(list.slice(1, 2), () => true).question, null);
  const many = deletePlan(Array.from({ length: 15 }, (_, i) => d(`id${i}`, `n${i}`, i)), () => false);
  assert.match(many.question!, /- n11\nand 3 more$/);
  assert.equal(someNames(['a', 'b', 'c', 'd'], 2), '"a", "b" and 2 more');
});

test('the Printed filter lists versions, newest first, and searches names', () => {
  const mark = (v: number, at: number) => ({ v, at, file: true, settings: false });
  const l = [d('a', 'Alpha', 1, { printed: [mark(1, 5), mark(4, 9)] }), d('b', 'Brad', 2, { printed: [mark(0, 7)] }), d('c', 'Plain', 3)];
  const key = (r: ReturnType<typeof printedRows>) => r.map((x) => `${x.design.id}${x.v}`);
  assert.deepEqual(key(printedRows(l, '')), ['a4', 'b0', 'a1']);
  assert.deepEqual(key(printedRows(l, 'brad')), ['b0']);
  assert.deepEqual(cleanFilter({ kind: 'printed' }), { kind: 'printed' });
});

test('bulk delete keeps designs with printed versions', () => {
  const a = d('a', 'Alpha', 1, { printed: [{ v: 0, at: 1, file: true, settings: false }] }), b = d('b', 'Brad', 2);
  const plan = deletePlan([a, b], () => false);
  assert.deepEqual(plan.remove.map((x) => x.id), ['b']);
  assert.deepEqual(plan.printed.map((x) => x.id), ['a']);
  assert.match(plan.question!, /Kept, it has printed versions: "Alpha"/);
});
