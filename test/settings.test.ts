import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeParams } from '../shared/params';
import { describeSettings, settingsChanged } from '../src/lib/settings';

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
