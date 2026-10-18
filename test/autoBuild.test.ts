import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalText, autoBuildAfter, autoBuildText, withView } from '../src/lib/autoBuild';
import { currentModelContext } from '../server/agent';
import type { AgentEvent, GenerateRequest } from '../shared/api';

const reply = { designId: 'd1', messageId: 'm1', concepts: [{ name: 'hero', color: false }], completed: true, error: false, openDesignId: 'd1', waitForOk: false, queued: false, now: 1000 };

test('the countdown starts only after a finished reply with new concept pictures, on the open design, with "Wait for my OK" off', () => {
  assert.deepEqual(autoBuildAfter(reply), { designId: 'd1', messageId: 'm1', concepts: [{ name: 'hero', color: false }], until: 11_000 });
  assert.equal(autoBuildAfter({ ...reply, waitForOk: true }), null);
  assert.equal(autoBuildAfter({ ...reply, concepts: [] }), null);
  assert.equal(autoBuildAfter({ ...reply, error: true }), null);
  assert.equal(autoBuildAfter({ ...reply, completed: false }), null); // stopped
  assert.equal(autoBuildAfter({ ...reply, openDesignId: 'd2' }), null); // finished in the background
  assert.equal(autoBuildAfter({ ...reply, queued: true }), null); // the user's queued message answers it
  // A picture drawn again counts once, as it was drawn last.
  assert.deepEqual(autoBuildAfter({ ...reply, concepts: [{ name: 'hero', color: false }, { name: 'cat', color: false }, { name: 'hero', color: true }] })?.concepts,
    [{ name: 'cat', color: false }, { name: 'hero', color: true }]);
});

test('the countdown says the credits (the total for several) and the approval reads as one', () => {
  assert.equal(autoBuildText([{ name: 'hero', color: false }], 10), 'Building with Meshy in 10 s · 25 credits');
  assert.equal(autoBuildText([{ name: 'hero', color: true }], 3), 'Building with Meshy in 3 s · 35 credits');
  assert.equal(autoBuildText([{ name: 'a', color: false }, { name: 'b', color: true }], 7), 'Building 2 figures ("a", "b") with Meshy in 7 s · 60 credits');
  assert.equal(approvalText([{ name: 'hero', color: false }]), 'Approved – build it.');
  assert.equal(approvalText([{ name: 'a', color: false }, { name: 'b', color: false }, { name: 'c', color: false }]), 'Approved – build "a", "b" and "c".');
});

test('"Send my view" off: no screenshot and no four-view render in the request, and none on the server', async () => {
  const view = { mediaType: 'image/jpeg', data: 'AAAA' };
  const ctx = { currentView: view, renderValues: { w: 3 }, scale: 2, versionNote: 'restored v1' };
  assert.deepEqual(withView(ctx, true), ctx);
  assert.deepEqual(withView(ctx, false), { scale: 2, versionNote: 'restored v1' });

  const req: GenerateRequest = { designId: 'test-view-0001', prompt: 'make it taller', code: 'function build() {}' };
  let renders = 0;
  const render = async () => { renders++; return { ok: true, png: 'UE5H', gridStep: 10 } as never; };
  const events: AgentEvent[] = [];
  const off = await currentModelContext(req, (e) => events.push(e), render);
  assert.deepEqual(off.content, []);
  assert.equal(renders, 0);
  assert.deepEqual(events.filter((e) => e.type === 'step'), []);
  assert.match(off.notes.join('\n'), /No picture of the current model[\s\S]*render_model/);

  // On (today's behaviour): the view comes as a step with its picture.
  const on = await currentModelContext({ ...req, currentView: view }, (e) => events.push(e), render);
  assert.equal(on.content.filter((c) => c.type === 'image').length, 1);
  assert.ok(events.some((e) => e.type === 'step' && e.step.text === 'Jig got your current view'));
});
