import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActivityItem, ChatMessage } from '../shared/types';
import { blockDuration, thinkingSince, trimActivity, wasInterrupted } from '../src/lib/activity';

test('a saved transcript keeps thinking and text, and shortens long tool inputs and details', () => {
  const code = 'x'.repeat(30_000);
  const items: ActivityItem[] = [
    { kind: 'thinking', text: 'Planning a cube', at: 1 },
    { kind: 'tool', name: 'Write', label: 'Write', fields: { file_path: 'model.js', content: code }, at: 2 },
    { kind: 'step', step: { kind: 'tool', text: 'Rendered', detail: 'y'.repeat(10_000), image: 'data:image/png;base64,AA' } },
    { kind: 'text', text: 'Here is the cube.', at: 3 },
  ];
  const out = trimActivity(items);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], items[0]);
  assert.deepEqual(out[3], items[3]);
  const tool = out[1] as Extract<ActivityItem, { kind: 'tool' }>;
  assert.equal(tool.fields.file_path, 'model.js');
  assert.ok(tool.fields.content.length < 2100 && tool.fields.content.endsWith('(28,000 more characters, not saved)'));
  const step = out[2] as Extract<ActivityItem, { kind: 'step' }>;
  assert.ok(step.step.detail!.length < 2100);
  assert.equal(step.step.image, 'data:image/png;base64,AA');
  // The transcript in memory is unchanged.
  assert.equal((items[1] as Extract<ActivityItem, { kind: 'tool' }>).fields.content, code);
});

test('a transcript over the limit keeps its newest entries', () => {
  const items: ActivityItem[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'thinking', text: `${i}`.repeat(100), at: i }));
  const out = trimActivity(items, 350);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { kind: 'step', step: { kind: 'status', text: '… 7 earlier entries not saved' } });
  assert.deepEqual(out.slice(1), items.slice(7));
  assert.deepEqual(trimActivity(items, 1000), items);
});

test('a reply saved in progress shows as interrupted unless it is still being worked on', () => {
  const m: ChatMessage = { id: 'a', role: 'assistant', text: '', createdAt: 1, pending: true };
  assert.equal(wasInterrupted(m, false), true);
  assert.equal(wasInterrupted(m, true), false);
  assert.equal(wasInterrupted({ ...m, pending: undefined }, false), false);
  assert.equal(wasInterrupted({ ...m, error: 'Stopped.' }, false), false);
});

test('thinking has its own time: from its block\'s start until the next block starts', () => {
  const list: ActivityItem[] = [
    { kind: 'thinking', text: 'plan', at: 1000 },
    { kind: 'step', step: { kind: 'status', text: 'still thinking', at: 4000 } },
    { kind: 'tool', name: 'Write', label: 'Writing model.js', fields: {}, at: 9000 },
    { kind: 'thinking', text: 'check', at: 12000 },
    { kind: 'step', step: { kind: 'status', text: 'a status', at: 15000 } },
  ];
  // The newest block is thinking (steps logged meanwhile don't end it): it started 12 s in.
  assert.equal(thinkingSince(list), 12000);
  assert.equal(thinkingSince(list.slice(0, 3)), null);
  assert.equal(thinkingSince([]), null);
  // A finished thinking lasted until the tool call; the newest one until the last step after it.
  assert.equal(blockDuration(list, 0), 8000);
  assert.equal(blockDuration(list, 3), 3000);
  assert.equal(blockDuration(list.slice(0, 4), 3), undefined);
  assert.equal(blockDuration(list, 1), undefined);
});
