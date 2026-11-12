import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeParams } from '../shared/params';
import { describeSettings, sameBuild, settingsChanged } from '../src/lib/settings';

const params = normalizeParams({ w: { value: 30, label: 'W' } });

test('only real changes count', () => {
  assert.equal(settingsChanged({}, { w: 30 }, params), false); // the default
  assert.equal(settingsChanged({}, { $scale: 1 }, params), false); // 100 %
  assert.equal(settingsChanged({}, { gone: 5 }, params), false); // not a param any more
  assert.equal(settingsChanged({}, { w: 31 }, params), true);
  assert.equal(settingsChanged({}, { $text: '[]x' }, params), true);
});

test('summary names the changes', () => {
  assert.match(describeSettings({}, { w: 40, $scale: 1.2 }, params), /^Settings: W 40 mm, Scale 120 %/);
});

test('LayerTone filaments count as a setting, its pictures do not', () => {
  assert.equal(settingsChanged({}, { $images: '{"photo":{}}' }, params), false);
  assert.equal(settingsChanged({}, { $layertone: '{"swaps":[3]}' }, params), true);
  assert.match(describeSettings({}, { $layertone: '{"swaps":[3]}' }, params), /LayerTone filaments/);
});

test('a picture mark is not a setting, and builds the same as without it', () => {
  const marks = '{"art":{"fp":"x","mark":{"strokes":[{"width":0.1,"points":[[0,0]]}]}}}';
  assert.equal(settingsChanged({}, { $pictureMarks: marks }, params), false);
  assert.equal(sameBuild({ w: 31 }, { w: 31, $pictureMarks: marks }), true);
  assert.equal(sameBuild({ w: 31, $pictureMarks: marks }, { w: 31 }), true);
  assert.equal(sameBuild({ w: 31 }, { w: 32, $pictureMarks: marks }), false);
  assert.equal(sameBuild({ w: 31 }, { w: 31, $drawings: '{}' }), false);
  assert.equal(sameBuild({ w: 31, $drawings: '{}' }, { w: 31, $text: '{}' }), false);
});

test('without marks, values build again whenever they are a new object (as before marks existed)', () => {
  const a = { w: 31, $drawings: '{}' };
  assert.equal(sameBuild(a, a), true);
  assert.equal(sameBuild(a, { ...a }), false);
  assert.equal(sameBuild({}, {}), false);
});
