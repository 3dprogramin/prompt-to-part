// The settings store: values saved in the data folder are laid over process.env.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS, cleanSettingValue, maskSecret } from '../shared/settings';
import { SettingsError, initSettings, resetSettings, saveSettings, settingRows } from '../server/settings';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const row = (env: string) => settingRows({ allowRestricted: false }).find((r) => r.env === env)!;

let dir = '';
let dir2 = '';
let envBefore: Record<string, string | undefined> = {};

test.beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-settings-'));
  dir2 = mkdtempSync(path.join(os.tmpdir(), 'ptp-settings-'));
  envBefore = Object.fromEntries(SETTINGS.map((d) => [d.env, process.env[d.env]]));
});
// Every key a test may touch is a setting, so restoring them all is the `finally` of each test.
test.afterEach(() => {
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

test('maskSecret shows at most a third and nothing of a short value', () => {
  assert.equal(maskSecret('msy_mock'), '••••');
  const m = maskSecret('sk-or-v1-0123456789abcdef0123456789abcdef');
  assert.match(m, /^sk-or-…[0-9a-f]{4}$/);
  assert.ok(m.replace('…', '').length <= 40 / 3);
});
test('cleanSettingValue trims and strips one pair of quotes', () => {
  assert.equal(cleanSettingValue('  "sk-abc"\n'), 'sk-abc');
  assert.equal(cleanSettingValue("'a b'"), 'a b');
  assert.equal(cleanSettingValue('   '), '');
});
test('a saved value overrides the environment and null gives the environment back', async () => {
  process.env.PTP_CURRENCY = 'USD';
  initSettings(dir);
  await saveSettings({ PTP_CURRENCY: 'RON' }, { allowRestricted: false });
  assert.equal(process.env.PTP_CURRENCY, 'RON');
  assert.equal(row('PTP_CURRENCY').source, 'here');
  await saveSettings({ PTP_CURRENCY: null }, { allowRestricted: false });
  assert.equal(process.env.PTP_CURRENCY, 'USD');
  assert.equal(row('PTP_CURRENCY').source, 'env');
});
test('a value the environment never had is unset again after reset', async () => {
  delete process.env.MESHY_API_KEY;
  initSettings(dir);
  await saveSettings({ MESHY_API_KEY: 'msy_0123456789abcdef' }, { allowRestricted: false });
  await resetSettings();
  assert.equal(process.env.MESHY_API_KEY, undefined);
  assert.equal(row('MESHY_API_KEY').source, 'unset');
});
test('secrets go to secrets.json (mode 600), never to settings.json, and a row never carries the value', async () => {
  initSettings(dir);
  await saveSettings({ OPENROUTER_API_KEY: KEY, PTP_COUNTRY: 'Romania' }, { allowRestricted: false });
  assert.ok(!readFileSync(path.join(dir, 'settings.json'), 'utf8').includes(KEY));
  assert.equal(statSync(path.join(dir, 'secrets.json')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(settingRows({ allowRestricted: false })).includes(KEY));
  assert.equal(row('OPENROUTER_API_KEY').preview, maskSecret(KEY));
});
test('the provider address is refused without allowRestricted and nothing else in that save is applied', async () => {
  initSettings(dir);
  await assert.rejects(saveSettings({ ANTHROPIC_BASE_URL: 'https://example.com', PTP_COUNTRY: 'X' }, { allowRestricted: false }), SettingsError);
  assert.notEqual(process.env.PTP_COUNTRY, 'X');
  await saveSettings({ ANTHROPIC_BASE_URL: 'https://example.com' }, { allowRestricted: true });
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://example.com');
});
test('invalid values are refused with a message that does not contain them', async () => {
  initSettings(dir);
  const changes: Record<string, string>[] = [{ PTP_EFFORT: 'huge' }, { PTP_CLAUDE: 'bedrock' }, { ANTHROPIC_BASE_URL: 'http://plain.example' }, { PTP_BACK_TEXT: 'x'.repeat(41) }, { OPENROUTER_API_KEY: 'has space inside' }, { NOT_A_SETTING: 'x' }];
  for (const change of changes)
    await assert.rejects(saveSettings(change, { allowRestricted: true }), (e: Error) => e instanceof SettingsError && !Object.values(change).some((v) => e.message.includes(v)));
});
test('saved values are applied again by a new start, and a damaged file starts on the environment alone', async (t) => {
  initSettings(dir);
  await saveSettings({ PTP_COUNTRY: 'Romania' }, { allowRestricted: false });
  delete process.env.PTP_COUNTRY;
  initSettings(dir);            // same folder: must re-read
  assert.equal(process.env.PTP_COUNTRY, 'Romania');
  writeFileSync(path.join(dir2, 'secrets.json'), '{ not json');
  const warn = t.mock.method(console, 'warn', () => {});
  initSettings(dir2);
  assert.equal(readFileSync(path.join(dir2, 'secrets.json'), 'utf8'), '{ not json');
  assert.equal(process.env.PTP_COUNTRY, undefined);
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments.join(' ')), ['[settings] Could not read secrets.json: SyntaxError']);
});
test('a pasted key with quotes and a newline is stored clean; an empty one means not set', async () => {
  initSettings(dir);
  await saveSettings({ MESHY_API_KEY: ' "msy_0123456789abcdef"\n' }, { allowRestricted: false });
  assert.equal(process.env.MESHY_API_KEY, 'msy_0123456789abcdef');
  await saveSettings({ MESHY_API_KEY: '   ' }, { allowRestricted: false });
  assert.equal(row('MESHY_API_KEY').source === 'here', false);
});
