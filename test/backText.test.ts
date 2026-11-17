// The back text decisions: whether the text is printed, in which filament, how many layers, and what to warn about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerTop, type LayerColor, type LayerToneFilament } from '../shared/layertone';
import { pictureValues } from '../src/app/designValues';
import { describeSettings } from '../src/lib/settings';
import { autoBackTextFilament, backTextDefault, backTextStatus, parseBackText, pinBackText, planBackText, setBackTextDefault } from '../shared/backText';

const R = { layerHeight: 0.08, firstLayerHeight: 0.16 };
const at = (layer: number, color: string, td: number, name: string): LayerColor => ({ z: layerTop(layer, R), layer, color, td, name });
const black = (layer = 0) => at(layer, '#000000', 0.2, 'Black');
const white = (layer: number) => at(layer, '#ffffff', 5.9, 'White');
const stack = [black(), white(5)];
const fil = (color: string, td: number): LayerToneFilament => ({ name: 'F', color, td });

test('disabled by an empty default, even with a text in the setting', () => {
  setBackTextDefault('');
  assert.deepEqual(planBackText({ text: 'x' }, stack, R), { on: false, reason: 'disabled' });
});

test('defaults: text, in the corner at size 30, two layers, topZ 0.24; the centre at size 70', () => {
  setBackTextDefault('shop.example');
  const p = planBackText({}, stack, R);
  assert.ok(p.on);
  if (p.on) assert.deepEqual([p.text, p.position, p.size, p.layers, p.topZ], ['shop.example', 'corner', 30, 2, 0.24]);
  const c = planBackText({ position: 'centre' }, stack, R);
  if (c.on) assert.deepEqual([c.position, c.size], ['centre', 70]);
  else assert.fail('centre is on');
  assert.deepEqual(parseBackText('{"position":"middle"}'), {}, 'an unknown position is the default');
});

test('off, empty, size clamp, text cut', () => {
  setBackTextDefault('shop.example');
  assert.deepEqual(planBackText({ off: true }, stack, R), { on: false, reason: 'off' });
  assert.deepEqual(planBackText({ text: '   ' }, stack, R), { on: false, reason: 'empty' });
  const s5 = planBackText({ size: 5 }, stack, R), s200 = planBackText({ size: 200 }, stack, R), long = planBackText({ text: 'a'.repeat(50) }, stack, R);
  assert.ok(s5.on && s200.on && long.on);
  if (s5.on && s200.on && long.on) assert.deepEqual([s5.size, s200.size, long.text.length], [20, 95, 40]);
});

test('thin first filament: fewer layers, or none', () => {
  setBackTextDefault('shop.example');
  const two = planBackText({}, [black(), white(2)], R);
  assert.ok(two.on);
  if (two.on) assert.deepEqual([two.layers, two.topZ], [1, 0.16]);
  assert.deepEqual(planBackText({}, [black(), white(1)], R), { on: false, reason: 'tooThin' });
  const one = planBackText({}, [black()], R);
  assert.ok(one.on);
  if (one.on) assert.equal(one.layers, 2);
});

test('autoBackTextFilament contrasts with the first filament', () => {
  const s1 = [black(), at(2, '#0a5fb4', 2.6, 'Blue'), at(4, '#b0b0b0', 3, 'Ash Gray'), at(6, '#f4f8ff', 5, 'Cold White')];
  assert.equal(autoBackTextFilament(s1).name, 'Cold White');
  assert.equal(autoBackTextFilament([white(0), black(5)]).name, 'Black');
  assert.deepEqual(autoBackTextFilament([black()]), { name: 'PLA Basic Jade White', brand: 'Bambu Lab', color: '#ffffff', td: 5.9 });
  assert.deepEqual(autoBackTextFilament([white(0)]), { name: 'PLA Basic Black', brand: 'Bambu Lab', color: '#000000', td: 0.2 });
});

test('notes: show-through and same colour', () => {
  setBackTextDefault('shop.example');
  const a = planBackText({}, stack, R);
  assert.ok(a.on);
  if (a.on) assert.deepEqual(a.notes, []);
  // 0.32 mm of white (TD 1.9) leaves 0.08 mm over the text: black shows through. At 0.48 mm the formula says it is hidden (dE below 2).
  const whiteBase: LayerColor[] = [at(0, '#ffffff', 1.9, 'White'), at(3, '#0a5fb4', 2.6, 'Blue')];
  const b = planBackText({ filament: fil('#000000', 0.2) }, whiteBase, R);
  assert.ok(b.on);
  if (b.on) assert.ok(b.notes.includes('showsThrough'));
  const thick = planBackText({ filament: fil('#000000', 0.2) }, [at(0, '#ffffff', 1.9, 'White'), at(5, '#0a5fb4', 2.6, 'Blue')], R);
  assert.ok(thick.on);
  if (thick.on) assert.ok(!thick.notes.includes('showsThrough'));
  const c = planBackText({ filament: fil('#000000', 0.2) }, stack, R);
  assert.ok(c.on);
  if (c.on) assert.ok(c.notes.includes('sameColour'));
  const d = planBackText({ filament: fil('#FFFFFF', 5.9) }, [at(0, '#ffffff', 5.9, 'W'), black(5)], R);
  assert.ok(d.on);
  if (d.on) assert.ok(d.notes.includes('sameColour'));
});

test('parseBackText tolerates JSON and junk', () => {
  assert.deepEqual(parseBackText('{"text":"a","size":50}'), { text: 'a', size: 50 });
  assert.deepEqual(parseBackText({ off: true }), { off: true });
  assert.deepEqual(parseBackText('nope'), {});
  assert.deepEqual(parseBackText(7), {});
});

test('pinBackText writes out the setting in effect', () => {
  setBackTextDefault('shop.example');
  const v = { a: 1 };
  assert.equal(pinBackText(v, false), v);
  const pinned = pinBackText(v, true);
  assert.equal(pinned.$backText, JSON.stringify({ text: backTextDefault(), size: 30, position: 'corner' }));
  assert.equal(pinBackText(pinned, true), pinned, 'already pinned: the same object');
  // Only some of it said: the rest is filled in, so a later default can't change the print.
  assert.equal(pinBackText({ $backText: '{"size":50}' }, true).$backText, JSON.stringify({ text: 'shop.example', size: 50, position: 'corner' }));
  assert.equal(pinBackText({ $backText: '{"position":"centre"}' }, true).$backText, JSON.stringify({ text: 'shop.example', size: 70, position: 'centre' }));
  const filament = { name: 'Black', color: '#000000', td: 0.2 };
  assert.equal(pinBackText({ $backText: JSON.stringify({ filament, text: ' Mine ' }) }, true).$backText, JSON.stringify({ text: 'Mine', size: 30, position: 'corner', filament }));
  // Off, or an empty text: off, whatever else it says.
  assert.equal(pinBackText({ $backText: JSON.stringify({ off: true, size: 50 }) }, true).$backText, JSON.stringify({ off: true }));
  assert.equal(pinBackText({ $backText: '{"text":"  "}' }, true).$backText, JSON.stringify({ off: true }));
  // The same setting in another key order: unchanged.
  const reordered = { $backText: JSON.stringify({ position: 'corner', size: 50, text: 'Mine' }) };
  assert.equal(pinBackText(reordered, true), reordered);
  // No default: nothing printed, so off, even with a text of its own.
  setBackTextDefault('');
  assert.equal(pinBackText(v, true).$backText, JSON.stringify({ off: true }));
  assert.equal(pinBackText({ $backText: '{"text":"X"}' }, true).$backText, JSON.stringify({ off: true }));
  const off = { $backText: '{"off":true}' };
  assert.equal(pinBackText(off, true), off);
});

test('the back text goes to the server with the pictures (the chat keeps it and builds with it)', () => {
  assert.deepEqual(pictureValues({ $backText: '{"size":50}', w: 1 }), { $backText: '{"size":50}' });
});

test('a version saved with a back text change says "back text"', () => {
  assert.equal(describeSettings({}, { $backText: '{"off":true}' }, {}), 'Settings: back text');
});

test('backTextStatus: printed only when the built part has the text; no room when it has none', () => {
  setBackTextDefault('shop.example');
  const plan = planBackText({}, stack, R), P = { oneColour: false, project: true };
  assert.equal(backTextStatus(plan, 2, true, P), 'printed');
  // Planned, but the part came out without it (a part too small for the corner).
  assert.equal(backTextStatus(plan, 2, false, P), 'noRoom');
  assert.equal(backTextStatus(plan, 0, false, P), 'tooThin', 'scaled onto the print\'s layers: none left');
  assert.equal(backTextStatus(planBackText({}, [black(), white(1)], R), 0, false, P), 'tooThin');
  assert.equal(backTextStatus(planBackText({ text: '  ' }, stack, R), 0, false, P), null);
});

test('backTextStatus: not printed in one colour or in a plain 3MF (the text is only in a Bambu project with colours)', () => {
  setBackTextDefault('shop.example');
  const plan = planBackText({}, stack, R);
  const project = { oneColour: false, project: true };
  assert.equal(backTextStatus(plan, 2, true, project), 'printed');
  assert.equal(backTextStatus(plan, 2, true, { oneColour: true, project: true }), 'oneColour');
  assert.equal(backTextStatus(plan, 2, true, { oneColour: false, project: false }), 'noProject');
  // One colour says it first: raising the first filament would not bring the text back.
  assert.equal(backTextStatus(planBackText({}, [black(), white(1)], R), 0, false, { oneColour: true, project: true }), 'oneColour');
  assert.equal(backTextStatus(planBackText({ text: '  ' }, stack, R), 0, false, { oneColour: true, project: false }), null);
});
