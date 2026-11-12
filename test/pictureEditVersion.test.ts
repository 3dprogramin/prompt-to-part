import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { applyPictureEdit, linesUp, pictureChangedSince, pictureEditNotes, versionNote } from '../src/lib/pictureEdit';
import type { PictureEditResponse } from '../shared/api';
import type { Box3, Design, DesignVersion } from '../shared/types';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-picver-test-'));
process.env.PTP_DATA = dataDir;
process.env.PTP_AUTH = 'subscription';
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const { createApp } = await import('../server/app');
server.on('request', createApp({ port }));
after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const box = (d = 0): Box3 => ({ min: [0, 0, 0], max: [40 + d, 30, 5] });
const ok = { masked: true, outsideSame: true };

test('linesUp: identical boxes line up, 0.02 mm apart does not', () => {
  assert.equal(linesUp(ok, box(), box()), true);
  assert.equal(linesUp(ok, box(), box(0.005)), true);
  assert.equal(linesUp(ok, box(), box(0.02)), false);
});

test('linesUp: needs a mask, an unchanged outside and two boxes', () => {
  assert.equal(linesUp({ masked: false, outsideSame: true }, box(), box()), false);
  assert.equal(linesUp({ masked: true, outsideSame: false }, box(), box()), false);
  assert.equal(linesUp(ok, null, box()), false);
  assert.equal(linesUp(ok, box(), null), false);
});

const v = (extra: Partial<DesignVersion> = {}): DesignVersion => ({ code: 'x', summary: 's', createdAt: 1, source: 'ai', ...extra });
const edit = { picture: 'p', change: 'c', masked: true, parent: 2, linesUp: true, cost: null };

test('versionNote: versions without a picture edit keep today\'s words', () => {
  assert.equal(versionNote(v({ source: 'manual' })), 'your code edit');
  assert.equal(versionNote(v({ source: 'settings' })), 'your saved settings');
  assert.equal(versionNote(v({ source: 'ai' })), 'from the chat');
});

test('versionNote: a picture edit says whether it lines up, 1-based', () => {
  assert.equal(versionNote(v({ source: 'manual', pictureEdit: edit })), 'your picture edit, lines up with v3');
  assert.equal(versionNote(v({ source: 'manual', pictureEdit: { ...edit, linesUp: false } })), 'your picture edit');
  assert.equal(versionNote(v({ source: 'manual', pictureEdit: { ...edit, masked: false } })), 'your picture edit');
});

test('versionNote: a picture edit made in the chat is from the chat, not the user\'s', () => {
  assert.equal(versionNote(v({ pictureEdit: edit })), 'from the chat, picture edit, lines up with v3');
  assert.equal(versionNote(v({ pictureEdit: { ...edit, linesUp: false } })), 'from the chat, picture edit');
  assert.equal(versionNote(v({ pictureEdit: { ...edit, parent: -1 } }), 3), 'from the chat, picture edit');
  assert.equal(versionNote(v({ pictureEdit: edit }), 2), 'from the chat, picture edit');
});

test('versionNote: a missing, malformed or stale parent is not named', () => {
  const note = (pe: unknown, count?: number) => versionNote(v({ source: 'manual', pictureEdit: pe as DesignVersion['pictureEdit'] }), count);
  assert.equal(note({}), 'your picture edit');
  assert.equal(note({ masked: true, linesUp: true }), 'your picture edit');
  assert.equal(note({ ...edit, parent: -1 }), 'your picture edit');
  assert.equal(note({ ...edit, parent: '2' }), 'your picture edit');
  assert.equal(note({ ...edit, parent: null }), 'your picture edit');
  assert.equal(note({ ...edit, parent: 1.5 }), 'your picture edit');
  assert.equal(note(edit, 3), 'your picture edit, lines up with v3');
  assert.equal(note(edit, 2), 'your picture edit');
});

test('linesUp: a box missing min or max is false, not a throw', () => {
  const bad = { min: [0, 0, 0] } as unknown as Box3;
  assert.equal(linesUp(ok, bad, box()), false);
  assert.equal(linesUp(ok, box(), bad), false);
  assert.equal(linesUp(ok, box(), {} as Box3), false);
});

test('a design with and without pictureEdit round-trips through save and load unchanged', async () => {
  const W = { 'Content-Type': 'application/json', 'X-PTP': '1' };
  const id = 'test-picver-0001';
  const d = { id, name: 't', createdAt: 1, updatedAt: 1000, messages: [], currentVersion: 1, code: 'x', values: {},
    versions: [v(), v({ pictureEdit: edit })] };
  const A = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${A}/api/designs/${id}`, { method: 'PUT', headers: W, body: JSON.stringify(d) })).status, 200);
  const got = await (await fetch(`${A}/api/designs/${id}`, { headers: W })).json();
  assert.deepEqual(got.versions, d.versions);
  assert.equal('pictureEdit' in got.versions[0], false);
});

// ---- Keeping a picture edit from the editor: the values it sets, a new version and a chat entry.

const response = (extra: Partial<PictureEditResponse> = {}): PictureEditResponse => ({
  set: { $drawings: '{"art":"new"}', $artworkEdits: '{"art":"cut"}', $pictureMarks: null },
  before: 'data:image/png;base64,AAAA', after: 'data:image/png;base64,BBBB', masked: true, outsideSame: true,
  prompt: 'p', model: 'test/image', cost: 0.04, ...extra,
});
const design = (): Design => ({ id: 'd1', name: 'n', createdAt: 1, updatedAt: 1, code: 'code v2', currentVersion: 1,
  versions: [v({ code: 'code v1' }), v({ code: 'code v2' })], messages: [{ id: 'm1', role: 'user', text: 'hi', createdAt: 1 }],
  values: { size: 3, $drawings: '{"art":"old"}', $artworkEdits: '{"art":"strokes"}', $pictureMarks: '{"art":"mark"}', $editHistory: '{"artwork":[]}' } });
const info = { picture: 'art', change: '  make him look like the man in the photo  ', masked: true, cost: 0.04 };
const stored = { photos: ['/api/designs/d1/images/photo.jpg'], render: '/api/designs/d1/images/both.png' };

test('applyPictureEdit: the values merged (null deletes), a version after the current one, lines up not yet measured', () => {
  const d = design();
  const out = applyPictureEdit(d, response(), info, stored);
  assert.deepEqual(out.values, { size: 3, $drawings: '{"art":"new"}', $artworkEdits: '{"art":"cut"}', $editHistory: '{"artwork":[]}' });
  assert.equal(out.versions.length, 3);
  assert.equal(out.currentVersion, 2);
  const nv = out.versions[2];
  assert.equal(nv.code, 'code v2');
  assert.equal(nv.source, 'manual');
  assert.equal(nv.summary, 'Picture edit: make him look like the man in the photo');
  // The version's values leave out the restore points, as every version's do.
  assert.deepEqual(nv.values, { size: 3, $drawings: '{"art":"new"}', $artworkEdits: '{"art":"cut"}' });
  assert.deepEqual(nv.pictureEdit, { picture: 'art', change: 'make him look like the man in the photo', masked: true, parent: 1, linesUp: false, cost: 0.04 });
  // The design passed in is not changed.
  assert.equal(d.versions.length, 2);
  assert.equal(d.values.$drawings, '{"art":"old"}');
});

test('applyPictureEdit: a long change is trimmed in the summary only', () => {
  const change = 'x'.repeat(200);
  const out = applyPictureEdit(design(), response(), { ...info, change }, stored);
  assert.ok(out.versions[2].summary.length <= 'Picture edit: '.length + 80, out.versions[2].summary);
  assert.equal(out.versions[2].pictureEdit!.change, change);
});

test('applyPictureEdit: the chat gets the change with its photos, and the result with its version, before / after and cost', () => {
  const out = applyPictureEdit(design(), response(), info, stored);
  assert.equal(out.messages.length, 3);
  const [, user, reply] = out.messages;
  assert.equal(user.role, 'user');
  assert.equal(user.text, 'Picture edit: make him look like the man in the photo');
  assert.deepEqual(user.images, stored.photos);
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.versionIndex, 2);
  assert.match(reply.text, /^Picture edit kept as v3\. Outside the mark: unchanged\. Cost \$0\.04\.$/);
  assert.deepEqual(reply.steps, [{ kind: 'render', ok: true, text: 'Before / after', image: stored.render }]);
  assert.notEqual(user.id, reply.id);
  // Never a data URL in the messages: the pictures are stored with the design.
  assert.doesNotMatch(JSON.stringify(out.messages), /data:/);
});

test('applyPictureEdit: no photos, no cost; the warnings go in the reply', () => {
  const r = response({ outsideSame: false, cost: null, offPalette: { share: 0.4, colour: '#8b5a2b', note: 'The change wants brown, a colour the design has no filament for.' } });
  const out = applyPictureEdit(design(), r, { ...info, cost: null }, { photos: [], render: stored.render });
  const [, user, reply] = out.messages;
  assert.equal(user.images, undefined);
  assert.doesNotMatch(reply.text, /Cost/);
  assert.match(reply.text, /Outside the mark: changed too/);
  assert.match(reply.text, /no filament for\./);
  // A whole-picture edit says nothing about an outside.
  const whole = applyPictureEdit(design(), response({ masked: false, outsideSame: false }), { ...info, masked: false }, stored);
  assert.doesNotMatch(whole.messages[2].text, /Outside the mark/);
});

test('pictureChangedSince: a result is refused when the drawings or hand edits changed after the request, or for another design', () => {
  const d = design();
  const sent = { designId: 'd1', drawings: d.values.$drawings, edits: d.values.$artworkEdits };
  assert.equal(pictureChangedSince(d, sent), false);
  // A slider or a mark moved meanwhile changes nothing the edit depends on.
  assert.equal(pictureChangedSince({ ...d, values: { ...d.values, size: 9, $pictureMarks: '{}' } }, sent), false);
  assert.equal(pictureChangedSince({ ...d, values: { ...d.values, $drawings: '{"art":"from a reply"}' } }, sent), true);
  assert.equal(pictureChangedSince({ ...d, values: { ...d.values, $artworkEdits: '{"art":"painted"}' } }, sent), true);
  const { $artworkEdits: _gone, ...noEdits } = d.values;
  assert.equal(pictureChangedSince({ ...d, values: noEdits }, sent), true);
  assert.equal(pictureChangedSince({ ...d, id: 'd2' }, sent), true);
});

test('pictureEditNotes: outside unchanged only for a masked edit, warnings marked', () => {
  assert.deepEqual(pictureEditNotes(response()), [{ text: 'Outside the mark: unchanged' }]);
  assert.equal(pictureEditNotes(response({ outsideSame: false }))[0].warn, true);
  assert.deepEqual(pictureEditNotes(response({ masked: false, outsideSame: false })), []);
  // Swap layers not kept: the picture is the same outside the mark, the print may not be (a warning, not "unchanged").
  const swaps = pictureEditNotes(response({ swapsNotKept: { note: 'Swaps not kept.' } }));
  assert.deepEqual(swaps, [{ text: 'The picture is unchanged outside the mark; the print there may change (swap layers not kept)', warn: true }, { text: 'Swaps not kept.', warn: true }]);
  const notes = pictureEditNotes(response({ simplified: true, offPalette: { share: 0.3, colour: '#8b5a2b', note: 'Brown wanted.' } }));
  assert.deepEqual(notes.map((n) => !!n.warn), [false, true, true]);
});
