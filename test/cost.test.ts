import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCostSettings, costOf, duration } from '../shared/cost';
import { parseSliceInfo } from '../server/slicer';
import { parseSuggestion } from '../server/pricing';

const stats = { seconds: 2 * 3600, grams: 50, filaments: [{ color: '#FF0000', grams: 50 }] };

test('filament from the slice; electricity only with a measured power and a price', () => {
  assert.deepEqual(costOf(stats, {}), { filament: null, electricity: null, kwh: null, total: 0 });
  const filamentOnly = costOf(stats, { filamentPerKg: 100, electricityPerKwh: 1.2 });
  assert.equal(filamentOnly.filament, 5);
  assert.equal(filamentOnly.electricity, null);
  const all = costOf(stats, { filamentPerKg: 100, electricityPerKwh: 1.5, averageWatts: 120 });
  assert.ok(Math.abs(all.kwh! - 0.24) < 1e-9);
  assert.ok(Math.abs(all.electricity! - 0.36) < 1e-9);
  assert.ok(Math.abs(all.total - 5.36) < 1e-9);
});

test('settings keep only positive numbers', () => {
  assert.deepEqual(cleanCostSettings({ filamentPerKg: '99.5', electricityPerKwh: -1, averageWatts: 'x', extra: 5 }), { filamentPerKg: 99.5 });
  assert.deepEqual(cleanCostSettings(null), {});
});

test('durations read like Bambu Studio', () => {
  assert.equal(duration(14003), '3 h 53 min');
  assert.equal(duration(1500), '25 min');
});

test("Bambu Studio's slice info: time, total and per-filament grams", () => {
  const xml = `<config><plate><metadata key="prediction" value="14003"/><metadata key="weight" value="54.66"/>
    <filament id="1" type="PLA" color="#FF0000" used_m="3.17" used_g="9.60" />
    <filament id="2" type="PLA" color="#00FF00" used_m="7.58" used_g="22.96" /></plate></config>`;
  assert.deepEqual(parseSliceInfo(xml), { seconds: 14003, grams: 54.66, filaments: [{ color: '#FF0000', grams: 9.6 }, { color: '#00FF00', grams: 22.96 }] });
  assert.throws(() => parseSliceInfo('<config/>'), /no print time/);
});

test("Claude's price answer is read and checked", () => {
  assert.deepEqual(parseSuggestion('Here: {"price": 45, "low": 35, "high": 60, "reasoning": "Small, quick print."}'),
    { price: 45, low: 35, high: 60, reasoning: 'Small, quick print.', currency: 'RON' });
  assert.throws(() => parseSuggestion('About 40 lei.'), /did not answer/);
  assert.throws(() => parseSuggestion('{"price": "a lot"}'), /did not answer/);
});
