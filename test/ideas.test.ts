import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STARTERS, ideaModes, pickStarters, cleanIdeaText, parseIdeas, topUp, ideasPrompt, type IdeaMode } from '../shared/ideas';

const ALL: IdeaMode[] = ['off', 'artwork', 'layertone', 'lithophane', 'lineart', 'figure'];

test('ideaModes: off always, picture modes with artwork, figure with meshy', () => {
  assert.deepEqual(ideaModes({ artwork: false, meshy: false }), ['off']);
  assert.deepEqual([...ideaModes({ artwork: true, meshy: false })].sort(), ['artwork', 'layertone', 'lineart', 'lithophane', 'off']);
  assert.deepEqual([...ideaModes({ artwork: true, meshy: true })].sort(), [...ALL].sort());
});

test('pickStarters: one per mode in preference order, then more 3D model ones', () => {
  assert.deepEqual(pickStarters(ALL).map((i) => i.mode), ['off', 'layertone', 'lithophane', 'lineart']);
  const off = pickStarters(['off']);
  assert.equal(off.length, 4);
  assert.ok(off.every((i) => i.mode === 'off'));
  assert.equal(new Set(off.map((i) => i.text)).size, 4);
});

test('STARTERS: short, plain, distinct, every mode covered', () => {
  for (const s of STARTERS) {
    assert.ok(s.text.length <= 120, s.text);
    assert.ok(!/[\u2013\u2014]/.test(s.text), s.text);
  }
  assert.equal(new Set(STARTERS.map((s) => s.text.toLowerCase())).size, STARTERS.length);
  for (const m of ALL) assert.ok(STARTERS.some((s) => s.mode === m), m);
  assert.ok(STARTERS.filter((s) => s.mode === 'off').length >= 4);
});

test('cleanIdeaText: marker, quotes, dashes, whitespace, length', () => {
  assert.equal(cleanIdeaText('1. "A moon lamp \u2013 10 cm"'), 'A moon lamp, 10 cm');
  assert.equal(cleanIdeaText('- A box\u2014lid'), 'A box-lid');
  assert.equal(cleanIdeaText('  *  A   box \n with lid '), 'A box with lid');
  const long = cleanIdeaText('word '.repeat(40));
  assert.ok(long.length <= 120);
  assert.ok(long.endsWith('word'));
});

test('parseIdeas drops unavailable modes', () => {
  const t = 'Here: [{"text":"Dragon","mode":"figure"},{"text":"Moon","mode":"lithophane"},{"text":"Box","mode":"off"}]';
  assert.deepEqual(parseIdeas(t, ['off', 'lithophane']), [{ text: 'Moon', mode: 'lithophane' }, { text: 'Box', mode: 'off' }]);
});

test('parseIdeas drops duplicates and non-strings, caps at 4, throws without an array', () => {
  const arr = [{ text: 'A', mode: 'off' }, { text: 'a', mode: 'off' }, { text: 5, mode: 'off' }, { text: 'B', mode: 'off' }, { text: 'C', mode: 'off' }, { text: 'D', mode: 'off' }, { text: 'E', mode: 'off' }];
  assert.deepEqual(parseIdeas(JSON.stringify(arr), ['off']).map((i) => i.text), ['A', 'B', 'C', 'D']);
  assert.throws(() => parseIdeas('no json', ['off']), /did not come up with ideas/);
  assert.throws(() => parseIdeas('[{oops]', ['off']), /did not come up with ideas/);
});

test('topUp fills from the starters, skipping avoided texts', () => {
  const r = topUp([{ text: 'Box', mode: 'off' }], ['off'], [STARTERS[0].text]);
  assert.equal(r.length, 4);
  assert.equal(r[0].text, 'Box');
  assert.ok(r.every((i) => i.text !== STARTERS[0].text));
});

test('ideasPrompt names the bed, the allowed modes and what was shown', () => {
  const p = ideasPrompt({ modes: ['off', 'lithophane'], bed: [256, 256], height: 256, printerName: 'Bambu A1', shown: ['A moon', 'A box'] });
  assert.ok(p.includes('256 x 256'));
  assert.ok(p.includes('off') && p.includes('lithophane'));
  assert.ok(p.includes('A moon') && p.includes('A box'));
  for (const m of ['artwork', 'layertone', 'lineart', 'figure']) assert.ok(!p.includes(m), m);
});
