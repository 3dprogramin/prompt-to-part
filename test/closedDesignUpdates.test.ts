import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Design } from '../shared/types';
import { HttpError } from '../src/lib/api';
import { closedDesignUpdates } from '../src/app/closedDesignUpdates';

const design = (id: string): Design => ({ id, name: id, photos: [] } as unknown as Design);
const addPhoto = (url: string) => (d: Design): Design => ({ ...d, photos: [...(d.photos ?? []), { url } as never] });
const photoUrls = (d: Design | undefined) => (d?.photos ?? []).map((p) => (p as { url: string }).url);

/** A stand-in server: load returns the last saved copy (each a little later, like a request). */
function fakeServer(ids: string[]) {
  const store = new Map(ids.map((id) => [id, design(id)]));
  const saved: Design[] = [];
  const later = () => new Promise((r) => setTimeout(r, 1));
  const load = async (id: string) => {
    await later();
    const d = store.get(id);
    if (!d) throw new HttpError('not found', 404);
    return d;
  };
  const save = async (d: Design) => {
    await later();
    store.set(d.id, d);
    saved.push(d);
  };
  return { store, saved, load, save };
}

test('a change for a closed design is loaded, applied and saved', async () => {
  const server = fakeServer(['a']);
  const closed = closedDesignUpdates({ load: server.load, save: server.save, applyInMemory: () => false });
  await closed.update('a', addPhoto('p1'));
  assert.equal(server.saved.length, 1);
  assert.deepEqual(photoUrls(server.store.get('a')), ['p1']);
});

test('three changes for the same closed design all land, in order', async () => {
  const server = fakeServer(['a']);
  const closed = closedDesignUpdates({ load: server.load, save: server.save, applyInMemory: () => false });
  const runs = [closed.update('a', addPhoto('p1')), closed.update('a', addPhoto('p2')), closed.update('a', addPhoto('p3'))];
  await Promise.all(runs);
  assert.deepEqual(photoUrls(server.store.get('a')), ['p1', 'p2', 'p3']);
});

test('a design opened meanwhile gets the change in memory, not a save', async () => {
  const server = fakeServer(['a']);
  const applied: string[] = [];
  const closed = closedDesignUpdates({
    load: server.load, save: server.save,
    applyInMemory: (id, fn) => { applied.push(photoUrls(fn(design(id))).join()); return true; },
  });
  await closed.update('a', addPhoto('p1'));
  assert.deepEqual(applied, ['p1']);
  assert.equal(server.saved.length, 0);
});

test('a deleted design is dropped quietly', async (t) => {
  const server = fakeServer(['b']);
  const warn = t.mock.method(console, 'warn', () => {});
  const closed = closedDesignUpdates({ load: server.load, save: server.save, applyInMemory: () => false });
  await closed.update('gone', addPhoto('p1'));
  assert.equal(server.saved.length, 0);
  assert.equal(warn.mock.callCount(), 1);
  await closed.update('b', addPhoto('p2'));
  assert.deepEqual(photoUrls(server.store.get('b')), ['p2']);
  // The failed step didn't break that design's queue: once it exists again, a change lands.
  server.store.set('gone', design('gone'));
  await closed.update('gone', addPhoto('p3'));
  assert.deepEqual(photoUrls(server.store.get('gone')), ['p3']);
});

test('a design the server no longer has (null) is dropped quietly', async () => {
  const saved: Design[] = [];
  const closed = closedDesignUpdates({ load: async () => null, save: async (d) => { saved.push(d); }, applyInMemory: () => false });
  await closed.update('gone', addPhoto('p1'));
  assert.equal(saved.length, 0);
});

test("pending(id) waits for that design's queued changes and not for other designs'", async () => {
  const server = fakeServer(['a', 'b']);
  // Saves of 'b' hang until released, so only a wait on 'b' would stall.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const save = async (d: Design) => { if (d.id === 'b') await held; await server.save(d); };
  const closed = closedDesignUpdates({ load: server.load, save, applyInMemory: () => false });
  await closed.pending('a'); // nothing queued: at once
  void closed.update('a', addPhoto('p1'));
  void closed.update('a', addPhoto('p2'));
  const b = closed.update('b', addPhoto('q1'));
  await closed.pending('a');
  assert.deepEqual(photoUrls(server.store.get('a')), ['p1', 'p2']);
  assert.deepEqual(photoUrls(server.store.get('b')), []);
  let bDone = false;
  const waitB = closed.pending('b').then(() => { bDone = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(bDone, false);
  release();
  await waitB;
  await b;
  assert.deepEqual(photoUrls(server.store.get('b')), ['q1']);
});
