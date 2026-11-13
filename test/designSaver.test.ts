import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Design } from '../shared/types';
import { HttpError } from '../src/lib/api';
import { createDesignSaver, type SaverDeps } from '../src/lib/designSaver';

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

const design = (id: string, name: string, rev?: number): Design => ({ id, name, rev } as unknown as Design);

/** A stand-in server: each design with its revision, refusing a save based on an older one (as server/routes/designs.ts does). */
function fakeServer() {
  const store = new Map<string, Design & { rev: number }>();
  const gone = new Set<string>();
  const saves: { name: string; base: number }[] = [];
  const save = async (d: Design, base: number): Promise<Design> => {
    if (gone.has(d.id)) throw new HttpError('deleted', 410);
    const cur = store.get(d.id);
    if (cur && cur.rev !== base) throw new HttpError('conflict', 409, { rev: cur.rev });
    const saved = { ...d, rev: (cur?.rev ?? 0) + 1 };
    store.set(d.id, saved);
    saves.push({ name: d.name, base });
    return saved;
  };
  const load = async (id: string) => store.get(id) ?? null;
  return { store, gone, saves, save, load };
}

function setup(running = false) {
  const server = fakeServer();
  const conflicts: Design[] = [];
  const goneIds: string[] = [];
  let errors: Record<string, string> = {};
  const deps: SaverDeps = {
    save: server.save,
    load: server.load,
    isRunning: () => running,
    tell: () => {},
    onSaved: () => {},
    onConflict: (fresh) => conflicts.push(fresh),
    onGone: (id) => goneIds.push(id),
    onErrors: (e) => { errors = e; },
  };
  return { server, conflicts, goneIds, errors: () => errors, saver: createDesignSaver(deps) };
}

/** Let the awaited saves settle (they are promises, not timers). */
const settle = () => new Promise<void>((r) => setImmediate(r));

test('a debounced save waits 600 ms and saves the newest copy', async () => {
  const { server, saver } = setup();
  saver.saveSoon(design('a', 'first'));
  mock.timers.tick(300);
  saver.saveSoon(design('a', 'second'));
  mock.timers.tick(599);
  await settle();
  assert.equal(server.saves.length, 0);
  assert.equal(saver.isUnsaved('a'), true);
  mock.timers.tick(1);
  await settle();
  assert.deepEqual(server.saves.map((s) => s.name), ['second']);
  assert.equal(saver.isUnsaved('a'), false);
});

test('after a save conflict, a pending autosave of the stale copy never reaches the server', async () => {
  const { server, conflicts, saver } = setup();
  server.store.set('a', { ...design('a', 'theirs'), rev: 2 });
  const conflicting = saver.saveNow(design('a', 'local', 1));
  saver.saveSoon(design('a', 'local edited', 1));
  await conflicting;
  mock.timers.tick(1000);
  await settle();
  assert.equal(server.store.get('a')!.name, 'theirs');
  assert.deepEqual(conflicts.map((d) => d.name), ['theirs']);
  assert.equal(saver.isUnsaved('a'), false);
});

test('a conflict on a design kept in the background reports the fresh copy', async () => {
  const { server, conflicts, errors, saver } = setup();
  server.store.set('b', { ...design('b', 'theirs'), rev: 5 });
  await saver.saveNow(design('b', 'background copy', 3));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].name, 'theirs');
  assert.equal(conflicts[0].rev, 5);
  assert.deepEqual(errors(), {});
});

test('a running generation keeps its own copy on conflict', async () => {
  const { server, conflicts, saver } = setup(true);
  server.store.set('a', { ...design('a', 'theirs'), rev: 2 });
  await saver.saveNow(design('a', 'generating', 1));
  assert.equal(server.store.get('a')!.name, 'generating');
  assert.deepEqual(server.saves.at(-1), { name: 'generating', base: 2 });
  assert.equal(conflicts.length, 0);
});

test('a save already queued when a conflict arrives is skipped', async () => {
  const { server, conflicts, errors, saver } = setup();
  server.store.set('a', { ...design('a', 'theirs'), rev: 2 });
  const conflicting = saver.saveNow(design('a', 'local', 1));
  const queued = saver.saveNow(design('a', 'local edited', 1));
  await Promise.all([conflicting, queued]);
  assert.equal(server.store.get('a')!.name, 'theirs');
  assert.equal(server.saves.length, 0);
  assert.deepEqual(conflicts.map((d) => d.name), ['theirs']);
  assert.deepEqual(errors(), {});
  // Changes made after the conflict (on the fresh copy) still save.
  await saver.saveNow(design('a', 'after', 2));
  assert.equal(server.store.get('a')!.name, 'after');
});

test('a deleted design (410) stops saving and calls onGone', async () => {
  const { server, goneIds, saver } = setup();
  server.gone.add('a');
  await saver.saveNow(design('a', 'mine'));
  assert.deepEqual(goneIds, ['a']);
  assert.equal(saver.isUnsaved('a'), false);
  server.gone.delete('a');
  saver.saveSoon(design('a', 'again'));
  mock.timers.tick(1000);
  await saver.saveNow(design('a', 'again'));
  assert.equal(server.saves.length, 0);
});
