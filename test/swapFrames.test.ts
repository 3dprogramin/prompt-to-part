import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropBox, deleteTemporary, plaqueBounds, temporaryDesign, transitions } from '../scripts/swap-frames';
import type { DesignVersion } from '../shared/types';

const version = (pictureEdit?: { parent: number; linesUp: boolean }): DesignVersion => ({
  code: '', values: {}, createdAt: 0, ...(pictureEdit ? { pictureEdit: { picture: 'p', change: 'c', masked: true, cost: null, ...pictureEdit } } : {}),
} as unknown as DesignVersion);

test('a swap that lines up with the original fades, a redraw slides, and the loop back follows the same rule', () => {
  const versions = [version(), version({ parent: 0, linesUp: true }), version({ parent: 0, linesUp: false })];
  assert.deepEqual(transitions(versions, [0, 1, 2]), ['fade', 'slideleft', 'slideleft']);
  assert.deepEqual(transitions(versions, [0, 1]), ['fade', 'fade'], 'first and last line up: the loop back fades too');
  assert.deepEqual(transitions(versions, [0, 2]), ['slideleft', 'slideleft']);
  assert.deepEqual(transitions(versions, [1, 0]), ['fade', 'fade'], 'either direction');
});

test('a version lines up only with its own parent', () => {
  const versions = [version(), version(), version({ parent: 0, linesUp: true })];
  assert.deepEqual(transitions(versions, [1, 2]), ['slideleft', 'slideleft']);
});

test('versions line up through a chain of lined-up edits, a break in the chain slides, siblings line up', () => {
  const chain = [version(), version({ parent: 0, linesUp: true }), version({ parent: 1, linesUp: true })];
  assert.deepEqual(transitions(chain, [0, 1, 2]), ['fade', 'fade', 'fade'], 'v3 lines up with v1 through v2');
  const broken = [version(), version({ parent: 0, linesUp: true }), version({ parent: 1, linesUp: false }), version({ parent: 2, linesUp: true })];
  assert.deepEqual(transitions(broken, [0, 1, 2]), ['fade', 'slideleft', 'slideleft']);
  assert.deepEqual(transitions(broken, [0, 3]), ['slideleft', 'slideleft'], 'the break separates 0 from 3');
  const siblings = [version(), version({ parent: 0, linesUp: true }), version({ parent: 0, linesUp: true })];
  assert.deepEqual(transitions(siblings, [1, 2]), ['fade', 'fade'], 'two lined-up edits of one parent line up');
  const cycle = [version({ parent: 1, linesUp: true }), version({ parent: 0, linesUp: true }), version({ parent: 9, linesUp: true })];
  assert.deepEqual(transitions(cycle, [0, 1, 2]), ['fade', 'slideleft', 'slideleft'], 'cycles and bad parents are safe');
});

test('plaqueBounds finds the non-background pixels, ignoring near-background noise', () => {
  const w = 10, h = 8;
  const blank = () => { const a = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) a.set([0xf4, 0xf6, 0xfa, 255], i * 4); return a; };
  const rgba = blank();
  rgba.set([0xf2, 0xf6, 0xfa, 255], 0);
  for (let y = 2; y <= 4; y++) for (let x = 3; x <= 6; x++) rgba.set([10, 20, 30, 255], (y * w + x) * 4);
  assert.deepEqual(plaqueBounds(rgba, w, h), { x: 3, y: 2, w: 4, h: 3 });
  assert.equal(plaqueBounds(blank(), w, h), null);
});

test('cropBox centres on the plaque and stays inside the frame', () => {
  assert.deepEqual(cropBox({ x: 340, y: 340, w: 400, h: 400 }, 900), { x: 90, y: 90, w: 900, h: 900 });
  assert.deepEqual(cropBox({ x: 0, y: 0, w: 100, h: 100 }, 900), { x: 0, y: 0, w: 900, h: 900 });
  assert.deepEqual(cropBox({ x: 1000, y: 1000, w: 80, h: 80 }, 900), { x: 180, y: 180, w: 900, h: 900 });
});

test('the temporary copy of a version is not marked as a picture edit', () => {
  const v = { ...version({ parent: 0, linesUp: true }), code: 'cube(1);', values: { a: '1' } } as DesignVersion;
  const body = temporaryDesign(v, 'tmp-id', 5);
  assert.equal(body.id, 'tmp-id');
  assert.equal(body.code, 'cube(1);');
  assert.deepEqual(body.values, { a: '1' });
  assert.equal(body.versions.length, 1);
  assert.equal('pictureEdit' in body.versions[0], false);
  assert.ok(v.pictureEdit, 'the version itself is left as it was');
});

test('a temporary design that could not be deleted is named in a warning', async () => {
  const warned: string[] = [], warn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.join(' ')); };
  try {
    const calls: [string, RequestInit | undefined][] = [];
    const ok = (async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response(null, { status: 200 }); }) as typeof fetch;
    assert.equal(await deleteTemporary('http://app', { Authorization: 'x' }, 'id-ok', ok), true);
    assert.equal(calls[0][0], 'http://app/api/designs/id-ok');
    assert.equal(calls[0][1]?.method, 'DELETE');
    assert.deepEqual(warned, []);
    const refused = (async () => new Response(null, { status: 409 })) as typeof fetch;
    assert.equal(await deleteTemporary('http://app', {}, 'id-409', refused), false);
    const down = (async () => { throw new Error('connection refused'); }) as typeof fetch;
    assert.equal(await deleteTemporary('http://app', {}, 'id-down', down), false);
    assert.equal(warned.length, 2);
    assert.match(warned[0], /id-409/);
    assert.match(warned[0], /409/);
    assert.match(warned[1], /id-down/);
    assert.match(warned[1], /connection refused/);
  } finally { console.warn = warn; }
});
