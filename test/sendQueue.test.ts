import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueReady } from '../src/app/sendQueue';

// Design "a" has a message queued for after its reply, which ended while design "b" was open.
const idle = { queued: 1, paused: false, running: false, remoteRunning: false, designId: 'a' };

test("opening a design with a queued message waits for its own model, not the last design's", () => {
  // The first render after opening "a" still has b's model (its sliders and the view a screenshot takes), built and idle.
  assert.equal(queueReady({ ...idle, shownFor: 'b', busy: false }), false);
  // Then a's model builds, and the queue goes out once it is in.
  assert.equal(queueReady({ ...idle, shownFor: 'a', busy: true }), false);
  assert.equal(queueReady({ ...idle, shownFor: 'a', busy: false }), true);
});

test('a queue waits for a reply, a paused queue for "Send now", and an empty one sends nothing', () => {
  const ready = { ...idle, shownFor: 'a', busy: false };
  assert.equal(queueReady({ ...ready, running: true }), false);
  assert.equal(queueReady({ ...ready, remoteRunning: true }), false);
  assert.equal(queueReady({ ...ready, paused: true }), false);
  assert.equal(queueReady({ ...ready, queued: 0 }), false);
});
