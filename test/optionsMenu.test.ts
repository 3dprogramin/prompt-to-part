import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionsSummary, type ChatOption } from '../src/components/chat/OptionsMenu';

const make = (on: Record<string, boolean>): ChatOption[] =>
  (['web', 'ask', 'image', 'view', 'sounds'] as const).map((key) => ({
    key, on: !!on[key], label: { web: 'Web search', ask: 'Ask first', image: 'Image tool', view: 'Send my view', sounds: 'Sounds' }[key], line: '', title: '',
  }));

test('optionsSummary names what is on', () => {
  assert.deepEqual(optionsSummary(make({ web: true, sounds: true })), { count: 2, title: 'Options: web search and sounds are on' });
  assert.deepEqual(optionsSummary(make({ web: true, ask: true, sounds: true })), { count: 3, title: 'Options: web search, ask first and sounds are on' });
  assert.deepEqual(optionsSummary(make({})), { count: 0, title: 'Options: all off' });
  assert.deepEqual(optionsSummary(make({ sounds: true })), { count: 1, title: 'Options: sounds is on' });
});
