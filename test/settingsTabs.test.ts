import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialTab, SETTINGS_TABS } from '../src/components/settings/settingsTabs';

test('the dialog opens on the tab asked for, else the remembered one, else Printer', () => {
  assert.equal(initialTab('keys', 'filaments'), 'keys');
  assert.equal(initialTab(undefined, 'filaments'), 'filaments');
  assert.equal(initialTab(undefined, 'nonsense'), 'printer');
  assert.equal(initialTab(undefined, null), 'printer');
  assert.deepEqual(SETTINGS_TABS.map((t) => t.label), ['Printer', 'Filaments', 'Keys and services']);
});
