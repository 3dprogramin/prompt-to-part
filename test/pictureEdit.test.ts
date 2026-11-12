// A picture edit of AI artwork through the API, with a stand-in for the image model: the crop sent,
// the answer lined up and pasted only inside the mark, traced back into the drawing; the errors,
// the one-edit-per-design rule and the busy marker the Docker rebuild waits on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { encode as encodePng } from 'fast-png';
import { ASPECTS, decodeImage, type requestImage } from '../server/artwork';
import { cropAround, pasteMark } from '../server/pictureEdit/index';
import type { PictureEditRequest, PictureEditResponse } from '../shared/api';
import { ARTWORK_EDITS_KEY, parseArtworkEdits, type ArtworkStroke } from '../shared/artworkEdits';
import { drawingFingerprint } from '../shared/lineart/strokes';
import { markMask, PICTURE_MARKS_KEY, parsePictureMarks, type PictureMark } from '../shared/pictureEdit/mark';
import { renderDrawing } from '../shared/pictureEdit/render';
import { DRAWINGS_KEY, parseDrawings, type SvgDrawing } from '../shared/svgFeatures';
import type { Vec2 } from '../shared/types';
import type { Raster } from '../shared/meshFormats';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-picture-edit-test-'));
process.env.PTP_DATA = dataDir;
process.env.PTP_AUTH = 'subscription';
const savedKey = process.env.OPENROUTER_API_KEY;
// Only the stand-in below is ever asked: the key just lets the route through.
process.env.OPENROUTER_API_KEY = 'test';
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;

type Image = typeof requestImage;
type Call = { prompt: string; aspect: string; references: string[]; size?: string };
let calls: Call[] = [];
let answer: Image = async () => { throw new Error('no stand-in set'); };
let releaseReply = () => {};
const { createApp } = await import('../server/app');
server.on('request', createApp({
  port,
  image: (prompt, aspect, references, signal, onStatus, size) => {
    calls.push({ prompt, aspect, references: references ?? [], size });
    return answer(prompt, aspect, references, signal, onStatus, size);
  },
  // A stand-in for a reply: it runs until released or stopped.
  generate: (_req, send, abort) => new Promise((resolve) => {
    send({ type: 'live', text: 'working' });
    releaseReply = () => resolve();
    abort.signal.addEventListener('abort', () => resolve());
  }),
}));
after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
});

const A = `http://127.0.0.1:${port}`;
const W = { 'Content-Type': 'application/json', 'X-PTP': '1' };
const busyFile = (id: string) => path.join(os.tmpdir(), `ptp-busy-picture-edit-${id}`);
const post = (id: string, body: Partial<PictureEditRequest>, signal?: AbortSignal) =>
  fetch(`${A}/api/designs/${id}/picture-edit`, { method: 'POST', headers: W, body: JSON.stringify(body), signal });
const until = async (ok: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !ok();) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const BLACK = '#111111', WHITE = '#ffffff', RED = '#d01c1f', SKIN = '#e0a868', GOLD = '#c8a040';
const disc = (r: number, cx = 0, cy = 0, n = 96): Vec2[] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
const wobbly = (r: number, cx: number, cy: number, n: number): Vec2[] => Array.from({ length: n }, (_, i) => {
  const a = (2 * Math.PI * i) / n, k = r * (1 + 0.05 * Math.sin(7 * a + 0.3) + 0.01 * Math.sin(53 * a));
  return [cx + k * Math.cos(a), cy + k * Math.sin(a)];
});
const square = (h: number, cx = 0, cy = 0): Vec2[] => [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];

/** Santa as the tracer leaves him: four colours, EvenOdd, darkest first. */
const santa: SvgDrawing = {
  name: 'santa.svg', aspect: 1,
  shapes: [
    { rule: 'EvenOdd', contours: [disc(0.45, 0, 0, 400)], color: BLACK },
    { rule: 'EvenOdd', contours: [disc(0.3, 0, 0.05, 200), square(0.04, 0.2, 0.15)], color: RED },
    { rule: 'EvenOdd', contours: [wobbly(0.1, 0.0317, -0.0213, 600)], color: SKIN },
    { rule: 'EvenOdd', contours: [disc(0.08, 0.25, -0.25)], color: WHITE },
  ],
};
/** Another drawing of the design, 1.2 times as wide as high. */
const other: SvgDrawing = {
  name: 'other.svg', aspect: 1.2,
  shapes: [
    { rule: 'EvenOdd', contours: [[[-0.55, -0.45], [0.55, -0.45], [0.55, 0.45], [-0.55, 0.45]]], color: BLACK },
    { rule: 'EvenOdd', contours: [disc(0.2, 0.1, 0)], color: GOLD },
  ],
};
/** The face. */
const face: PictureMark = { strokes: [{ width: 0.25, points: [[0, 0]] }] };
/** A white paint stroke across the face, and one on the other drawing. */
const across: ArtworkStroke = { mode: 'paint', color: WHITE, width: 0.05, points: [[-0.2, 0], [0.2, 0]] };
const onOther: ArtworkStroke = { mode: 'paint', color: GOLD, width: 0.05, points: [[-0.3, 0.2]] };
const otherEdits = { fp: drawingFingerprint(other), strokes: [onOther] };
const values = {
  [DRAWINGS_KEY]: JSON.stringify({ 'santa.svg': santa, 'other.svg': other }),
  [ARTWORK_EDITS_KEY]: JSON.stringify({ 'santa.svg': { fp: drawingFingerprint(santa), strokes: [across] }, 'other.svg': otherEdits }),
  [PICTURE_MARKS_KEY]: JSON.stringify({ 'santa.svg': { fp: drawingFingerprint(santa), mark: face }, 'other.svg': { fp: drawingFingerprint(other), mark: face } }),
};
const request = (extra: Partial<PictureEditRequest> = {}): PictureEditRequest =>
  ({ mode: 'artwork', picture: 'santa.svg', values, mark: face, change: 'a red face', photos: [], ...extra });

const pngUrl = (r: Raster) => `data:image/png;base64,${Buffer.from(encodePng({ ...r, channels: 4 })).toString('base64')}`;
const raster = (url: string) => decodeImage(Buffer.from(url.split(',')[1], 'base64'));
const answerOf = (r: Raster) => ({ image: { data: Buffer.from(encodePng({ ...r, channels: 4 })).toString('base64'), mediaType: 'image/png' }, model: 'test/image', cost: 0.03 });
const PHOTO = pngUrl({ width: 4, height: 4, data: new Uint8Array(64).fill(200) });

/** A stand-in that sends the crop back with the area outlined in magenta (on the second picture) filled with `colour`, row by row. */
const fillMarked = (colour: [number, number, number]): Image => async (_prompt, _aspect, refs) => {
  const crop = raster(refs![0]), outlined = raster(refs![1]), w = crop.width, data = new Uint8Array(crop.data);
  for (let j = 0; j < crop.height; j++) {
    let lo = -1, hi = -1;
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4, d = outlined.data;
      if (d[o] > 200 && d[o + 1] < 80 && d[o + 2] > 200) { if (lo < 0) lo = i; hi = i; }
    }
    for (let i = lo; lo >= 0 && i <= hi; i++) data.set(colour, (j * w + i) * 4);
  }
  return answerOf({ width: w, height: crop.height, data });
};
const ratio = (aspect: string) => { const [w, h] = aspect.split(':').map(Number); return w / h; };
/** The colour label at a point of a drawing (picture units), by a tiny render around it. */
const colourAt = (d: SvgDrawing, x: number, y: number) => {
  const r = renderDrawing(d, [], { x0: x - 0.005, y1: y + 0.005, w: 0.01, h: 0.01 }, 2);
  const l = r.labels[0];
  return l < 0 ? null : [...new Set(d.shapes.map((s) => s.color ?? ''))][l];
};

test('a marked edit of artwork: the crop and its outline sent, only the mark changes, strokes cut, the mark goes', async () => {
  calls = [];
  answer = fillMarked([0xd0, 0x1c, 0x1f]);
  const res = await post('test-pe-00000001', request({ photos: [PHOTO] }));
  const body = await res.json() as PictureEditResponse;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.masked, true);
  assert.equal(body.outsideSame, true);
  assert.equal(body.model, 'test/image');
  assert.equal(body.cost, 0.03);
  assert.match(body.before, /^data:image\/png;base64,/);
  assert.match(body.after, /^data:image\/png;base64,/);
  assert.equal(body.offPalette, undefined);
  // How the answer was lined up: it came back as sent, so in place.
  const fit = body.align!;
  assert.ok(fit, 'align is set');
  assert.deepEqual(fit.answer, [raster(body.before).width, raster(body.before).height]);
  assert.ok(fit.error < 1, String(fit.error));
  assert.ok(fit.shift.every((v) => Math.abs(v) <= 0.5) && fit.scale.every((v) => Math.abs(v - 1) < 0.002), `${fit.shift} ${fit.scale}`);
  // The before / after pictures show the crop's window (to draw the mark's edge over them).
  assert.deepEqual(body.window, cropAround(santa, face).win);

  // Sent: the crop, the crop outlined, the whole picture, then the photo; the crop in an allowed shape at 1K.
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.references.length, 4);
  assert.equal(call.references[3], PHOTO);
  assert.equal(call.size, '1K');
  assert.ok((ASPECTS as readonly string[]).includes(call.aspect), call.aspect);
  const crop = raster(call.references[0]), outlined = raster(call.references[1]), whole = raster(call.references[2]);
  assert.ok(Math.abs(crop.width / crop.height / ratio(call.aspect) - 1) < 0.01, `${crop.width} x ${crop.height} for ${call.aspect}`);
  assert.ok(Math.abs(Math.max(crop.width, crop.height) - 1024) <= 20, `${crop.width} x ${crop.height}`);
  assert.equal(outlined.width, crop.width);
  assert.equal(Math.max(whole.width, whole.height), 1024);
  assert.equal(call.prompt, body.prompt);
  assert.match(call.prompt, /a red face/);
  assert.doesNotMatch(call.prompt, /padding/);

  // The drawing: same name, red inside the mark, as before outside it.
  const drawings = parseDrawings(body.set[DRAWINGS_KEY]);
  const d = drawings['santa.svg'];
  assert.equal(d.name, 'santa.svg');
  assert.equal(colourAt(santa, 0, 0), SKIN);
  assert.equal(colourAt(d, 0, 0), RED);
  assert.equal(colourAt(d, 0.03, -0.08), RED);
  assert.equal(colourAt(d, 0.25, -0.25), WHITE);
  assert.equal(colourAt(d, -0.35, 0), BLACK);
  // The other drawing is stored exactly as it was.
  assert.deepEqual(JSON.parse(body.set[DRAWINGS_KEY]!)['other.svg'], JSON.parse(values[DRAWINGS_KEY])['other.svg']);

  // The hand edits: on the new drawing, the stroke cut by the mark; the other drawing's untouched.
  const edits = parseArtworkEdits(body.set[ARTWORK_EDITS_KEY]);
  assert.equal(edits['santa.svg'].fp, drawingFingerprint(d));
  assert.equal(edits['santa.svg'].strokes.length, 1);
  assert.ok(edits['santa.svg'].strokes[0].cut?.length, 'the stroke has a cut');
  assert.deepEqual(JSON.parse(body.set[ARTWORK_EDITS_KEY]!)['other.svg'], otherEdits);

  // The mark on this picture is used up; the other picture's stays.
  const marks = parsePictureMarks(body.set[PICTURE_MARKS_KEY]);
  assert.equal(marks['santa.svg'], undefined);
  assert.ok(marks['other.svg']);
  assert.equal(existsSync(busyFile('test-pe-00000001')), false);
});

test('an edit wanting a colour the design has no filament for says so', async () => {
  answer = fillMarked([0x8b, 0x5a, 0x2b]);
  const res = await post('test-pe-00000002', request({ change: 'a tanned face' }));
  const body = await res.json() as PictureEditResponse;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.offPalette, 'offPalette is set');
  assert.ok(body.offPalette.share > 0.5, String(body.offPalette.share));
  assert.match(body.offPalette.note, /brown/);
  assert.match(body.offPalette.note, /no filament/);
  assert.ok(body.set[DRAWINGS_KEY], 'the edit is still offered');
});

test('without a mark the whole picture is sent, padded to an allowed shape, and replaced', async () => {
  calls = [];
  answer = async (_p, _a, refs) => answerOf(raster(refs![0]));
  const res = await post('test-pe-00000003', request({ picture: 'other.svg', mark: undefined }));
  const body = await res.json() as PictureEditResponse;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.masked, false);
  assert.equal(body.align, undefined);
  // No outside to compare: nothing claimed.
  assert.equal(body.outsideSame, false);
  // The pictures shown are the whole picture.
  assert.equal(body.window!.x0, -0.6);
  assert.equal(body.window!.y1, 0.5);
  assert.equal(body.window!.h, 1);
  assert.ok(Math.abs(body.window!.w - 1.2) < 0.002, String(body.window!.w));
  assert.equal(calls[0].references.length, 1);
  assert.equal(calls[0].aspect, '5:4');
  assert.match(calls[0].prompt, /white bands .* are only padding/);
  const sent = raster(calls[0].references[0]);
  assert.ok(Math.abs(sent.width / sent.height - 1.25) < 0.01, `${sent.width} x ${sent.height}`);
  // Back to the picture's own shape: what is shown is not padded.
  const before = raster(body.before), afterPic = raster(body.after);
  assert.ok(Math.abs(before.width / before.height - 1.2) < 0.01);
  assert.equal(afterPic.width, before.width);
  const d = parseDrawings(body.set[DRAWINGS_KEY])['other.svg'];
  assert.equal(colourAt(d, 0.1, 0), GOLD);
  assert.equal(colourAt(d, -0.4, 0.3), BLACK);
  // The other drawing's strokes are in the new picture now; Santa's stay.
  const edits = JSON.parse(body.set[ARTWORK_EDITS_KEY]!);
  assert.equal(edits['other.svg'], undefined);
  assert.equal(edits['santa.svg'].strokes.length, 1);
  assert.equal(parsePictureMarks(body.set[PICTURE_MARKS_KEY])['other.svg'], undefined);
});

test('an answer that is not the picture sent fails with the alignment message and changes nothing', async () => {
  answer = async (_p, _a, refs) => {
    const c = raster(refs![0]), data = new Uint8Array(c.data.length);
    let s = 12345;
    for (let i = 0; i < data.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; data[i] = i % 4 === 3 ? 255 : s & 255; }
    return answerOf({ width: c.width, height: c.height, data });
  };
  const res = await post('test-pe-00000004', request());
  const body = await res.json() as { error: string; set?: unknown };
  assert.equal(res.status, 502);
  assert.match(body.error, /drew a different picture/);
  assert.equal(body.set, undefined);
});

test('an answer that keeps the magenta guide outline fails and changes nothing', async () => {
  // The model edits the second picture (the outlined one) instead of the first: the change inside, the outline kept.
  const magenta = (d: Uint8Array, o: number) => d[o] > 200 && d[o + 1] < 80 && d[o + 2] > 200;
  answer = async (_p, _a, refs) => {
    const outlined = raster(refs![1]), w = outlined.width, data = new Uint8Array(outlined.data);
    for (let j = 0; j < outlined.height; j++) {
      let lo = -1, hi = -1;
      for (let i = 0; i < w; i++) if (magenta(data, (j * w + i) * 4)) { if (lo < 0) lo = i; hi = i; }
      for (let i = lo; lo >= 0 && i <= hi; i++) if (!magenta(data, (j * w + i) * 4)) data.set([0xd0, 0x1c, 0x1f], (j * w + i) * 4);
    }
    return answerOf({ width: w, height: outlined.height, data });
  };
  // One line of numbers per edit in the log, without the prompt or any picture.
  const logged: unknown[][] = [], log = console.log;
  console.log = (...a: unknown[]) => { if (a[0] === '[picture-edit]') logged.push(a); else log(...a); };
  let res: Response;
  try { res = await post('test-pe-00000014', request()); } finally { console.log = log; }
  const body = await res.json() as { error: string; set?: unknown };
  assert.equal(logged.length, 1);
  const line = JSON.parse(String(logged[0][1])) as Record<string, unknown>;
  assert.equal(line.id, 'test-pe-00000014');
  assert.equal(line.picture, 'santa.svg');
  assert.equal(line.masked, true);
  assert.equal(line.reason, 'outline left in');
  assert.match(String(line.answer), /^\d+x\d+$/);
  assert.equal(line.answer, line.sent);
  for (const k of ['error', 'shift', 'scale', 'offMark', 'outline', 'ms']) assert.ok(k in line, k);
  assert.ok((line.outline as number) > 0.2, String(line.outline));
  assert.doesNotMatch(JSON.stringify(logged), /red face|base64/);
  assert.equal(res.status, 502, JSON.stringify(body).slice(0, 200));
  assert.equal(body.error, 'The image model left the guide outline in the picture: try again');
  assert.equal(body.set, undefined);
});

test('the image model\'s refusal comes back as it is', async () => {
  answer = async () => { throw new Error('The image model refused: no faces today'); };
  const res = await post('test-pe-00000005', request());
  assert.equal(res.status, 502);
  assert.equal((await res.json() as { error: string }).error, 'The image model refused: no faces today');
});

test('one edit per design at a time, with a busy marker while it runs', async () => {
  calls = [];
  let release!: () => void;
  answer = () => new Promise((_, reject) => { release = () => reject(new Error('The image model refused: done')); });
  const first = post('test-pe-00000006', request());
  await until(() => calls.length === 1);
  assert.equal(existsSync(busyFile('test-pe-00000006')), true);
  const second = await post('test-pe-00000006', request());
  assert.equal(second.status, 409);
  assert.equal((await second.json() as { error: string }).error, 'A picture edit is already running for this design');
  // Another design is not held up.
  answer = async () => { throw new Error('The image model refused: other'); };
  assert.equal((await post('test-pe-00000007', request())).status, 502);
  release();
  assert.equal((await first).status, 502);
  assert.equal(existsSync(busyFile('test-pe-00000006')), false);
});

test('a stopped edit leaves no busy marker and frees the design', async () => {
  calls = [];
  answer = (_p, _a, _r, signal) => new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('Stopped'))));
  const stop = new AbortController();
  const pending = post('test-pe-00000008', request(), stop.signal).catch(() => null);
  await until(() => calls.length === 1);
  assert.equal(existsSync(busyFile('test-pe-00000008')), true);
  stop.abort();
  await pending;
  await until(() => !existsSync(busyFile('test-pe-00000008')));
  answer = async () => { throw new Error('The image model refused: again'); };
  // The design is free again (a running edit would answer 409).
  for (let k = 0; k < 50; k++) {
    const r = await post('test-pe-00000008', request());
    if (r.status !== 409) { assert.equal(r.status, 502); return; }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('the design stayed busy');
});

test('at start the server clears the busy markers of picture edits that no longer run', () => {
  // Left by a server that died mid-edit (its process is gone, or it came back as this very process),
  // or unreadable; a marker of another server that is running stays.
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  const files = { gone: busyFile('test-pe-stale-gone'), own: busyFile('test-pe-stale-own'), junk: busyFile('test-pe-stale-junk'), live: busyFile('test-pe-live-other') };
  writeFileSync(files.gone, `${gone}\n`);
  writeFileSync(files.own, `${process.pid}\n`);
  writeFileSync(files.junk, '');
  writeFileSync(files.live, `${process.ppid}\n`);
  try {
    createApp({ port });
    assert.equal(existsSync(files.gone), false, 'a process that is gone');
    assert.equal(existsSync(files.own), false, 'this process, before it ran any edit');
    assert.equal(existsSync(files.junk), false, 'unreadable');
    assert.equal(existsSync(files.live), true, 'another running server');
  } finally {
    for (const f of Object.values(files)) rmSync(f, { force: true });
  }
});

test('requests that cannot be edited are refused before the image model is asked', async () => {
  calls = [];
  const bad = async (body: Partial<PictureEditRequest>, why: RegExp) => {
    const res = await post('test-pe-00000009', body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match((await res.json() as { error: string }).error, why);
  };
  await bad(request({ picture: 'nope.svg' }), /no drawing "nope.svg"/);
  // Names an object has from its prototype are not drawings.
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) await bad(request({ picture: name }), /no drawing/);
  await bad(request({ change: ' ' }), /what to change/i);
  await bad(request({ mode: 'lineart' }), /not yet/);
  await bad(request({ photos: ['https://example.com/a.png'] }), /photo/i);
  await bad(request({ photos: [PHOTO, PHOTO, PHOTO, PHOTO, PHOTO] }), /at most 4/);
  await bad(request({ mark: { strokes: [{ width: 0.1, points: [[3, 3]] }] } }), /outside the picture/);
  // A crafted mark: too many points in all (11 strokes of 2000), or a stroke wider than twice the picture.
  const many = Array.from({ length: 11 }, () => ({ width: 0.01, points: Array.from({ length: 2000 }, (_, i): [number, number] => [-0.4 + i * 0.0004, 0]) }));
  await bad(request({ mark: { strokes: many } }), /too many points/);
  await bad(request({ mark: { strokes: [{ width: 2.01, points: [[0, 0]] }] } }), /wider than/);
  const named = { ...santa, shapes: santa.shapes.map((s, i) => (i ? s : { ...s, color: 'black' })) };
  await bad(request({ values: { ...values, [DRAWINGS_KEY]: JSON.stringify({ 'santa.svg': named }) } }), /#rrggbb/);
  assert.equal(calls.length, 0);
});

test('without an OpenRouter key a picture edit says what is missing', async () => {
  delete process.env.OPENROUTER_API_KEY;
  try {
    const res = await post('test-pe-00000010', request());
    assert.equal(res.status, 503);
    assert.match((await res.json() as { error: string }).error, /OPENROUTER_API_KEY/);
  } finally { process.env.OPENROUTER_API_KEY = 'test'; }
});

test('a running reply and a running picture edit keep each other off the design, and a design being edited is not deleted', async () => {
  const id = 'test-pe-00000011';
  const reply = () => fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: id, prompt: 'a cube' }) });
  const del = () => fetch(`${A}/api/designs/${id}`, { method: 'DELETE', headers: W });
  // A reply first: no picture edit.
  const first = await reply();
  assert.equal(first.status, 200);
  calls = [];
  const blocked = await post(id, request());
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json() as { error: string }).error, /reply is being written/);
  assert.equal(calls.length, 0);
  releaseReply();
  await first.text();

  // A picture edit first: no reply, no delete.
  let release!: () => void;
  answer = () => new Promise((_, reject) => { release = () => reject(new Error('The image model refused: done')); });
  const edit = post(id, request());
  await until(() => calls.length === 1);
  assert.equal((await reply()).status, 409);
  assert.equal((await del()).status, 409);
  release();
  assert.equal((await edit).status, 502);
  // Free again.
  assert.equal((await del()).status, 200);
});

test('while a picture edit runs its design can\'t be marked printed; once marked, the design is kept from a delete', async () => {
  const id = 'test-pe-00000012';
  const code = 'function build() { return Manifold.cube([10, 10, 10]); }';
  const put = await fetch(`${A}/api/designs/${id}`, { method: 'PUT', headers: W, body: JSON.stringify({ id, name: 'Printed', createdAt: 1, updatedAt: 1, code, values, messages: [], currentVersion: 0,
    versions: [{ code, summary: 'A cube', createdAt: 1, source: 'manual', values }] }) });
  assert.equal(put.status, 200, await put.text());
  const mark = () => fetch(`${A}/api/designs/${id}/printed/0`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PTP': '1' }, body: new Uint8Array(0) });
  let release!: () => void;
  calls = [];
  answer = () => new Promise((_, reject) => { release = () => reject(new Error('The image model refused: done')); });
  const edit = post(id, request());
  await until(() => calls.length === 1);
  const refused = await mark();
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /being worked on/);
  release();
  assert.equal((await edit).status, 502);
  assert.equal((await mark()).status, 200);
  const del = await fetch(`${A}/api/designs/${id}`, { method: 'DELETE', headers: W });
  assert.equal(del.status, 409);
  assert.match((await del.json() as { error: string }).error, /printed versions \(v1\)/);
});

test('a crop that fits no allowed shape is padded to the one asked for and cut back', async () => {
  // A picture 4 times as wide as high, a strip 3.5 wide: its crop is 3.5:1, wider than 21:9.
  const wide: SvgDrawing = {
    name: 'wide.svg', aspect: 4,
    shapes: [
      { rule: 'EvenOdd', contours: [[[-1.95, -0.45], [1.95, -0.45], [1.95, 0.45], [-1.95, 0.45]]], color: BLACK },
      { rule: 'EvenOdd', contours: [[[-1.5, -0.2], [1.5, -0.2], [1.5, 0.2], [-1.5, 0.2]]], color: GOLD },
    ],
  };
  const strip: PictureMark = { strokes: [{ width: 0.1, points: [[-1.7, 0], [1.7, 0]] }] };
  calls = [];
  // The model fills the strip and also scribbles over the padding (a band of 1/6 the height at the
  // top and the bottom: the outer 10 % of rows lie in it): only the crop's own outside lines it up.
  answer = async (prompt, aspect, refs, signal) => {
    const out = await fillMarked([0x11, 0x11, 0x11])(prompt, aspect, refs, signal);
    const filled = decodeImage(Buffer.from(out.image.data, 'base64'));
    const { width: w, height: h } = filled, data = new Uint8Array(filled.data);
    let s = 7;
    for (let j = 0; j < h; j++) {
      if (j >= 0.1 * h && j < 0.9 * h) continue;
      for (let i = 0; i < w * 4; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; if (i % 4 !== 3) data[j * w * 4 + i] = s & 255; }
    }
    return answerOf({ width: w, height: h, data });
  };
  const res = await post('test-pe-00000012', request({ picture: 'wide.svg', mark: strip, values: { [DRAWINGS_KEY]: JSON.stringify({ 'wide.svg': wide }) } }));
  const body = await res.json() as PictureEditResponse;
  assert.equal(res.status, 200, JSON.stringify(body));
  const [call] = calls;
  assert.equal(call.aspect, '21:9');
  const sent = raster(call.references[0]), outlined = raster(call.references[1]);
  assert.ok(Math.abs(sent.width / sent.height / ratio('21:9') - 1) < 0.01, `${sent.width} x ${sent.height}`);
  assert.equal(outlined.height, sent.height);
  assert.match(call.prompt, /only padding/);
  // What is shown is the crop itself, not padded.
  const before = raster(body.before), afterPic = raster(body.after);
  assert.ok(before.width / before.height > 3, `${before.width} x ${before.height}`);
  assert.equal(afterPic.height, before.height);
  assert.equal(body.outsideSame, true);
  // The strip is black now, the gold outside it as it was.
  const d = parseDrawings(body.set[DRAWINGS_KEY])['wide.svg'];
  assert.equal(colourAt(d, 0, 0), BLACK);
  assert.equal(colourAt(d, 1, 0.15), GOLD);
  assert.equal(colourAt(d, -1, -0.15), GOLD);
});

test('the padding of a crop does not count as outside the mark', async () => {
  // A square brush covering all but 2 % of its crop (3.5 x 1 of a 4:1 picture, padded to 21:9: a
  // third of what is sent is padding). The answer is the picture sent, unchanged.
  const wide: SvgDrawing = { name: 'wide.svg', aspect: 4, shapes: [{ rule: 'EvenOdd', contours: [[[-1.95, -0.45], [1.95, -0.45], [1.95, 0.45], [-1.95, 0.45]]], color: BLACK }] };
  const block: PictureMark = { strokes: [{ width: 0.98, points: [[-1.26, 0], [1.26, 0]], shape: 'square' }] };
  calls = [];
  answer = async (_p, _a, refs) => answerOf(raster(refs![0]));
  const res = await post('test-pe-00000013', request({ picture: 'wide.svg', mark: block, values: { [DRAWINGS_KEY]: JSON.stringify({ 'wide.svg': wide }) } }));
  assert.equal(calls[0].aspect, '21:9');
  assert.equal(res.status, 502);
  assert.match((await res.json() as { error: string }).error, /mark covers nearly all/);
});

test('the paste ramps in from every edge of the mark that is not the picture\'s own border', () => {
  const w = 10, h = 10, black = new Uint8Array(w * h * 4), white = new Uint8Array(w * h * 4).fill(255);
  for (let p = 0; p < w * h; p++) black[p * 4 + 3] = 255;
  // The mark: the left half, touching the crop's left, top and bottom.
  const mask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < 5; i++) mask[j * w + i] = 1;
  const at = (r: Raster, i: number, j: number) => r.data[(j * w + i) * 4];
  const orig = { width: w, height: h, data: black }, edited = { width: w, height: h, data: white };
  // The crop's left side inside the picture: the mark goes on past it, so it is an edge there.
  const open = pasteMark(orig, edited, mask, 4, { left: true, top: false, right: true, bottom: false });
  assert.equal(at(open, 0, 5), Math.round(255 / 4));
  assert.equal(at(open, 2, 0), Math.round((255 * 3) / 4));
  assert.equal(at(open, 5, 5), 0);
  // At the picture's own border it is not an edge.
  const border = pasteMark(orig, edited, mask, 4, { left: false, top: false, right: true, bottom: false });
  assert.equal(at(border, 0, 5), 255);
  assert.equal(at(border, 4, 5), Math.round(255 / 4));
});

test('a mark wider than every allowed shape is cropped at its own ends, which are open sides', () => {
  // On a picture 4 times as wide as high, a strip 3.8 wide: no aspect holds it with any margin.
  const strip: PictureMark = { strokes: [{ width: 0.1, points: [[-1.85, 0], [1.85, 0]] }] };
  const c = cropAround({ ...santa, aspect: 4 }, strip);
  assert.ok(c.win.x0 > -2 && c.win.x0 + c.win.w < 2, JSON.stringify(c.win));
  assert.equal(c.open.left, true);
  assert.equal(c.open.right, true);
  const m = markMask(strip, { w: c.width, h: c.height, px: c.win.h / c.height, x0: c.win.x0, y1: c.win.y1 });
  // The mark reaches the crop's left side (its first or second column: pixels are in by their centres).
  let atLeft = 0;
  for (let j = 0; j < c.height; j++) atLeft += m[j * c.width] + m[j * c.width + 1];
  assert.ok(atLeft > 0, 'the mark reaches the crop\'s left side');
});
