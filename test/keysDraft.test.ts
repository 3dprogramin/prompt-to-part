import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS, type SettingRow } from '../shared/settings';
import { canSave, checkScope, claudeHint, claudeShown, draftProblems, isDirty, KEY_ROWS, pendingLabel, resetList, resetQuestion, runningNote, sourceBadge, sourceLabel, stage, toChange } from '../src/components/settings/keysDraft';

const rows: SettingRow[] = [
  { env: 'OPENROUTER_API_KEY', source: 'here', preview: 'sk-or-…77b2', editable: true },
  { env: 'PTP_COUNTRY', source: 'here', value: 'Romania', editable: true },
  { env: 'PTP_CURRENCY', source: 'env', value: 'USD', editable: true },
  { env: 'MESHY_API_KEY', source: 'unset', editable: true },
];
const label = (env: string) => SETTINGS.find((d) => d.env === env)!.label;

test('nothing staged is not dirty; a staged value or a back-to-env is', () => {
  assert.equal(isDirty({}), false); assert.equal(isDirty({ PTP_COUNTRY: 'X' }), true); assert.equal(isDirty({ PTP_COUNTRY: null }), true);
});
test('the change is cleaned, drops what is already saved here, and turns an emptied row into back-to-env', () => {
  assert.deepEqual(toChange({ PTP_COUNTRY: ' Romania ', PTP_CURRENCY: '"EUR"', MESHY_API_KEY: '  ', OPENROUTER_API_KEY: null }, rows), { PTP_CURRENCY: 'EUR', MESHY_API_KEY: null, OPENROUTER_API_KEY: null });
});
test('problems are per row and an emptied secret is not one', () => {
  assert.deepEqual(Object.keys(draftProblems({ PTP_EFFORT: 'huge', MESHY_API_KEY: '', PTP_BACK_TEXT: 'x'.repeat(41) })).sort(), ['PTP_BACK_TEXT', 'PTP_EFFORT']);
});
test('reset lists exactly the rows set here, by label', () => {
  assert.deepEqual(resetList(rows).sort(), [label('OPENROUTER_API_KEY'), label('PTP_COUNTRY')].sort());
});
test('source labels', () => { assert.deepEqual(rows.map(sourceLabel), ['set here', 'set here', '.env', 'not set']); });

test('the tab shows every setting once, in the settings order, and a one-field row is named like its setting', () => {
  assert.deepEqual(KEY_ROWS.flatMap((r) => r.envs), SETTINGS.map((d) => d.env));
  for (const r of KEY_ROWS.filter((k) => k.envs.length === 1)) assert.equal(r.label, label(r.envs[0]));
  assert.deepEqual(KEY_ROWS.map((r) => r.label), ['Claude runs on', 'Subscription token', 'Anthropic API key', 'OpenRouter key', 'Other provider token', 'Other provider address', 'Meshy key', 'ElevenLabs key', 'Chat starts with', 'Picture model, fallback', 'Currency, country', 'Back text']);
});

test('typing back what a row shows stages nothing; an emptied new key stages nothing; an emptied text row stages back-to-env', () => {
  assert.deepEqual(stage({ PTP_COUNTRY: 'Ro' }, rows[1], 'Romania'), {});
  assert.deepEqual(stage({}, rows[2], 'EUR'), { PTP_CURRENCY: 'EUR' });
  assert.deepEqual(stage({ MESHY_API_KEY: 'msy_1' }, rows[3], ''), {});
  assert.deepEqual(stage({}, rows[0], 'sk-or-new'), { OPENROUTER_API_KEY: 'sk-or-new' });
  assert.deepEqual(toChange(stage({}, rows[1], ''), rows), { PTP_COUNTRY: null });
});

test('the Claude choice shows what is staged, else what is saved; nothing set anywhere is Automatic and says what was inferred', () => {
  const unset: SettingRow = { env: 'PTP_CLAUDE', source: 'unset', editable: true };
  const env: SettingRow = { env: 'PTP_CLAUDE', source: 'env', value: 'openrouter', editable: true };
  assert.equal(claudeShown(unset, {}), null);
  assert.equal(claudeShown(env, {}), 'openrouter');
  assert.equal(claudeShown(env, { PTP_CLAUDE: 'anthropic' }), 'anthropic');
  assert.equal(claudeShown(env, { PTP_CLAUDE: null }), null);
  assert.match(claudeHint(unset, 'subscription', {})!, /^Automatic: .*Subscription/);
  assert.match(claudeHint(unset, null, {})!, /^Automatic: .*no key/);
  assert.equal(claudeHint(unset, 'subscription', { PTP_CLAUDE: 'custom' }), undefined);
  assert.equal(claudeHint(env, 'openrouter', {}), undefined);
});

test('a staged row says it is not saved yet, or that it goes back to .env on Save', () => {
  assert.equal(pendingLabel(undefined), undefined);
  assert.equal(pendingLabel('x'), 'Not saved yet');
  assert.equal(pendingLabel(null), 'Back to .env on Save');
  assert.equal(pendingLabel('  '), 'Back to .env on Save');
});

test('the check says it proves only that the service answers for the subscription and another provider', () => {
  assert.ok(checkScope('subscription')); assert.ok(checkScope('custom'));
  assert.equal(checkScope('anthropic'), undefined); assert.equal(checkScope('openrouter'), undefined); assert.equal(checkScope('none'), undefined);
});

test('the running replies note', () => {
  assert.equal(runningNote(0), undefined);
  assert.equal(runningNote(1), '1 reply is running: it keeps the sign-in it started with.');
  assert.equal(runningNote(3), '3 replies are running: they keep the sign-in they started with.');
});

test('the reset question names what goes back to .env, and warns about unsaved changes', () => {
  assert.equal(resetQuestion(rows, false), `These go back to .env: ${label('OPENROUTER_API_KEY')}, ${label('PTP_COUNTRY')}. Reset to defaults?`);
  assert.match(resetQuestion(rows, true), /not saved are dropped too/);
});

test('no copy uses the en or em dash', () => {
  const texts = [claudeHint({ env: 'PTP_CLAUDE', source: 'unset', editable: true }, 'custom', {}), claudeHint({ env: 'PTP_CLAUDE', source: 'unset', editable: true }, null, {}), checkScope('subscription'), runningNote(2), resetQuestion(rows, true), ...KEY_ROWS.map((r) => `${r.label} ${r.hint ?? ''}`)];
  for (const t of texts) assert.doesNotMatch(t ?? '', /[\u2013\u2014]/);
});

test('the Claude row has no source badge while it is Automatic (its hint says so); every other row keeps its badge', () => {
  const unset: SettingRow = { env: 'PTP_CLAUDE', source: 'unset', editable: true };
  assert.equal(sourceBadge(unset, {}), undefined);
  assert.equal(sourceBadge(unset, { PTP_CLAUDE: 'custom' }), 'not set');
  assert.equal(sourceBadge({ env: 'PTP_CLAUDE', source: 'env', value: 'openrouter', editable: true }, {}), '.env');
  assert.equal(sourceBadge(rows[3], {}), 'not set');
});

test('Save is possible only with a change that has no problem', () => {
  assert.equal(canSave({}), false);
  assert.equal(canSave({ PTP_COUNTRY: 'Italy' }), true);
  assert.equal(canSave({ PTP_COUNTRY: null }), true);
  assert.equal(canSave({ PTP_COUNTRY: 'Italy', PTP_EFFORT: 'huge' }), false);
});
