import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pictureValues, withEditHistoryOf, withoutEditHistory } from '../src/app/designValues';
import { settingsChanged } from '../src/lib/settings';
import { describeChange, editsBefore, EDIT_HISTORY_KEY, historyFor, historyTime, MAX_HISTORY, parseEditHistory, recordChange, restorePoints, type HistoryEntry } from '../shared/editHistory';

type S = { mode: string; points: [number, number][]; color?: string };
type E = Record<string, { fp: string; strokes: S[] }>;
const st = (mode: string, x: number): S => ({ mode, points: [[x, x]] });
const ed = (strokes: S[], fp = 'fp1', name = 'cat'): E => (strokes.length ? { [name]: { fp, strokes } } : {});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test('the key', () => assert.equal(EDIT_HISTORY_KEY, '$editHistory'));

test('recordChange: an append-only change stores only where it starts', () => {
  const before = ed([st('paint', 1), st('paint', 2)]);
  const after = ed([st('paint', 1), st('paint', 2), st('erase', 3)]);
  const h = recordChange(undefined, before, after, '1 erased', 1000);
  assert.equal(h.length, 1);
  assert.equal(h[0].label, '1 erased');
  assert.equal(h[0].at, 1000);
  const c = h[0].changes.cat;
  assert.equal(c.prefix, 2);
  assert.deepEqual(c.removed, []);
  assert.equal(c.afterLen, 3);
  assert.equal(c.fp, 'fp1');
  assert.match(c.afterHash, /^[0-9a-f]{8}$/);
});

test('recordChange: undoing everything stores the strokes taken away', () => {
  const before = ed([st('paint', 1), st('paint', 2)]);
  const h = recordChange([], before, {}, 'x', 1);
  const c = h[0].changes.cat;
  assert.equal(c.prefix, 0);
  assert.deepEqual(c.removed, before.cat.strokes);
  assert.equal(c.afterLen, 0);
});

test('recordChange: no change leaves the history as it is', () => {
  const h: HistoryEntry[] = recordChange([], {}, ed([st('paint', 1)]), 'a', 1);
  const e = ed([st('paint', 1)]);
  assert.equal(recordChange(h, e, clone(e), 'b', 2), h);
});

test(`recordChange: at most ${MAX_HISTORY} entries, the oldest go`, () => {
  let h: HistoryEntry[] = [];
  let cur: E = {};
  for (let i = 0; i < 31; i++) {
    const next = ed([...(cur.cat?.strokes ?? []), st('paint', i)]);
    h = recordChange(h, cur, next, `v${i}`, i);
    cur = next;
  }
  assert.equal(h.length, 30);
  assert.equal(h[0].label, 'v1');
  assert.equal(h[29].label, 'v30');
});

test('editsBefore: back to before any of three visits', () => {
  const s0 = ed([st('paint', 1)]);
  const s1 = ed([st('paint', 1), st('paint', 2), st('erase', 3)]); // A: two added
  const s2 = ed([st('paint', 1)]); // B: two taken back
  const s3 = ed([st('paint', 1), st('draw', 9)]); // C: one added
  let h: HistoryEntry[] = [];
  h = recordChange(h, s0, s1, 'A', 1);
  h = recordChange(h, s1, s2, 'B', 2);
  h = recordChange(h, s2, s3, 'C', 3);
  assert.deepEqual(editsBefore(h, s3, 2), s2);
  assert.deepEqual(editsBefore(h, s3, 1), s1);
  assert.deepEqual(editsBefore(h, s3, 0), s0);
  assert.deepEqual(restorePoints(h, s3), [s0, s1, s2]);
  // Before A there were no edits at all: the drawing goes.
  const h2 = recordChange([], {}, s1, 'first', 1);
  assert.deepEqual(editsBefore(h2, s1, 0), {});
});

test('editsBefore: a change that was not recorded breaks the chain', () => {
  const s0 = ed([st('paint', 1)]);
  const s1 = ed([st('paint', 1), st('paint', 2)]);
  const s2 = ed([st('paint', 1), st('paint', 2), st('paint', 3)]);
  let h: HistoryEntry[] = [];
  h = recordChange(h, s0, s1, 'A', 1);
  h = recordChange(h, s1, s2, 'B', 2);
  // Same length, other strokes (the AI baked or changed them).
  const altered = ed([st('paint', 1), st('paint', 2), st('erase', 3)]);
  assert.equal(editsBefore(h, altered, 1), null);
  assert.equal(editsBefore(h, altered, 0), null);
  assert.deepEqual(restorePoints(h, altered), [null, null]);
  // Shorter: broken too.
  assert.equal(editsBefore(h, s1, 1), null);
});

test('editsBefore: two drawings in one visit, one added and one gone, round trip exact', () => {
  const before: E = { a: { fp: 'fa', strokes: [st('paint', 1), st('paint', 2)] }, b: { fp: 'fb', strokes: [st('erase', 5)] }, keep: { fp: 'fk', strokes: [st('paint', 7)] } };
  const after: E = { a: { fp: 'fa', strokes: [st('paint', 1), st('fill', 4)] }, c: { fp: 'fc', strokes: [st('draw', 8), st('draw', 9)] }, keep: { fp: 'fk', strokes: [st('paint', 7)] } };
  const h = recordChange([], before, after, 'x', 1);
  assert.deepEqual(Object.keys(h[0].changes).sort(), ['a', 'b', 'c']);
  assert.equal(h[0].changes.a.prefix, 1);
  assert.deepEqual(editsBefore(h, clone(after), 0), before);
  // A drawing whose fingerprint changed: its strokes are taken whole, with the old fingerprint.
  const swapped: E = { a: { fp: 'fa2', strokes: [st('paint', 1)] } };
  const h2 = recordChange([], { a: { fp: 'fa', strokes: [st('paint', 1)] } }, swapped, 'y', 1);
  assert.equal(h2[0].changes.a.prefix, 0);
  assert.deepEqual(editsBefore(h2, swapped, 0), { a: { fp: 'fa', strokes: [st('paint', 1)] } });
});

test('historyFor: the entries of one drawing, with only its changes', () => {
  const h = recordChange(recordChange([], {}, { a: { fp: 'fa', strokes: [st('paint', 1)] } }, 'A', 1),
    { a: { fp: 'fa', strokes: [st('paint', 1)] } }, { a: { fp: 'fa', strokes: [st('paint', 1)] }, b: { fp: 'fb', strokes: [st('paint', 2)] } }, 'B', 2);
  const forA = historyFor(h, 'a');
  assert.equal(forA.length, 1);
  assert.equal(forA[0].label, 'A');
  assert.deepEqual(Object.keys(forA[0].changes), ['a']);
});

test('describeChange: artwork', () => {
  const p = (x: number, color = '#f00'): S => ({ mode: 'paint', points: [[x, 0]], color });
  const e = (x: number): S => ({ mode: 'erase', points: [[x, 0]], color: '#f00' });
  assert.equal(describeChange(ed([p(0)]), ed([p(0), p(1), p(2), p(3), e(4)])), '3 painted, 1 erased');
  assert.equal(describeChange(ed([p(0), p(1), e(2), p(3)]), {}), '4 strokes taken back');
  assert.equal(describeChange(ed([p(0), p(1)]), ed([p(0), e(5)])), '1 erased, 1 stroke taken back');
});

test('describeChange: line art', () => {
  assert.equal(describeChange({}, ed([st('draw', 1), st('draw', 2), st('fill', 3)])), '2 lines drawn, 1 fill');
  assert.equal(describeChange({}, ed([st('draw', 1), st('paint', 2), st('fill', 3), st('fill', 4), st('erase', 5), st('restore', 6)])), '1 line drawn, 1 painted, 2 fills, 1 erased, 1 area cleared');
  // A clear here that drops two strokes and adds a restore: the strokes kept don't count.
  assert.equal(describeChange(ed([st('draw', 1), st('paint', 2), st('erase', 3)]), ed([st('draw', 1), st('restore', 9)])), '1 area cleared, 2 strokes taken back');
  // Only the fingerprint moved.
  assert.equal(describeChange(ed([st('draw', 1)], 'a'), ed([st('draw', 1)], 'b')), 'Hand edits changed');
});

test('parseEditHistory: junk goes, caps hold', () => {
  const good = recordChange([], {}, ed([st('paint', 1)]), 'ok', 5)[0];
  assert.deepEqual(parseEditHistory(undefined), {});
  assert.deepEqual(parseEditHistory('not json'), {});
  assert.deepEqual(parseEditHistory([1, 2]), {});
  const raw = {
    lineart: [good, null, 7, { at: 'x', label: 'a', changes: {} }, { ...good, label: 'L'.repeat(500) }, { ...good, changes: { cat: { ...good.changes.cat, prefix: -1 } } },
      { ...good, changes: { cat: { ...good.changes.cat, removed: 'no' } } }, { ...good, changes: { cat: { ...good.changes.cat, afterHash: 5 } } }, { ...good, changes: {} }],
    artwork: Array.from({ length: 45 }, (_, i) => ({ ...good, at: i })),
    other: [good],
  };
  const out = parseEditHistory(JSON.stringify(raw));
  assert.equal(out.lineart?.length, 2);
  assert.deepEqual(out.lineart?.[0], good);
  assert.equal(out.lineart?.[1].label.length, 120);
  assert.equal(out.artwork?.length, 30);
  assert.equal(out.artwork?.[0].at, 15);
  assert.equal('other' in out, false);
});

test('historyTime: the time today, the date before', () => {
  const now = new Date(2026, 10, 11, 18, 0).getTime();
  assert.equal(historyTime(new Date(2026, 10, 11, 14, 32).getTime(), now), '14:32');
  assert.equal(historyTime(new Date(2026, 10, 10, 9, 5).getTime(), now), '10 Nov 09:05');
  assert.equal(historyTime(new Date(2025, 0, 3, 9, 5).getTime(), now), '3 Jan 2025 09:05');
});

test('the restore points are no setting: not a change to save, not sent, kept when going to a version', () => {
  const h = JSON.stringify({ lineart: recordChange([], {}, ed([st('paint', 1)]), 'a', 1) });
  assert.equal(settingsChanged({}, { [EDIT_HISTORY_KEY]: h }, {}), false);
  assert.equal(pictureValues({ [EDIT_HISTORY_KEY]: h }), undefined);
  assert.deepEqual(withoutEditHistory({ $scale: 2, [EDIT_HISTORY_KEY]: h }), { $scale: 2 });
  assert.deepEqual(withEditHistoryOf({ $scale: 2, [EDIT_HISTORY_KEY]: 'old' }, { [EDIT_HISTORY_KEY]: h }), { $scale: 2, [EDIT_HISTORY_KEY]: h });
  assert.deepEqual(withEditHistoryOf({ [EDIT_HISTORY_KEY]: 'old' }, {}), {});
});
