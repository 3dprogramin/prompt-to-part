// edit_picture and show_picture, the chat's picture edits in AI artwork mode: the region (the
// user's saved mark, a box, the whole picture), the photos, what the tool writes and says; and the
// app's side: the values set, the version the reply makes, the editor's edits named in follow-ups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode as encodePng } from 'fast-png';
import { decodeImage, type requestImage } from '../server/artwork';
import { cadTools } from '../server/cadTools';
import { editPictureTools } from '../server/tools/editPicture';
import type { ToolContext } from '../server/tools/context';
import type { editPicture } from '../server/pictureEdit/index';
import type { AgentEvent, PictureEditRequest, PictureEditResponse } from '../shared/api';
import { ARTWORK_EDITS_KEY } from '../shared/artworkEdits';
import { drawingFingerprint, LINEART_EDITS_KEY } from '../shared/lineart';
import { boxMark, PICTURE_MARKS_KEY, type PictureMark } from '../shared/pictureEdit/mark';
import { DRAWINGS_KEY, parseDrawings, type SvgDrawing } from '../shared/svgFeatures';
import { LAYERTONE_IMAGES_KEY, toBase64 } from '../shared/layertone';
import { photoFingerprint } from '../shared/pictureEdit/photo';
import type { Design, DesignVersion, ParamValues, Vec2 } from '../shared/types';
import type { Raster } from '../shared/meshFormats';
import { addReplyEdit, replyModel, withPictureEdited, withReplyVersion } from '../src/app/replyVersion';
import { editorEditsSince } from '../src/lib/pictureEdit';

const disc = (r: number, cx = 0, cy = 0, n = 96): Vec2[] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
/** A face on a dark disc, 1.5 times as wide as high. */
const santa: SvgDrawing = {
  name: 'santa.svg', aspect: 1.5,
  shapes: [
    { rule: 'EvenOdd', contours: [disc(0.45)], color: '#111111' },
    { rule: 'EvenOdd', contours: [disc(0.15, 0.1, 0)], color: '#e0a868' },
  ],
};
const face: PictureMark = { strokes: [{ width: 0.3, points: [[0.1, 0]] }] };
const valuesWith = (marks: unknown = { 'santa.svg': { fp: drawingFingerprint(santa), mark: face } }): ParamValues => ({
  [DRAWINGS_KEY]: JSON.stringify({ 'santa.svg': santa }),
  ...(marks ? { [PICTURE_MARKS_KEY]: JSON.stringify(marks) } : {}),
});

const png = (r: Raster) => `data:image/png;base64,${Buffer.from(encodePng({ ...r, channels: 4 })).toString('base64')}`;
const plain = (w: number, h: number, v = 200): Raster => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(v) });
const PHOTO = png(plain(4, 4));

type Handler = (a: unknown, x: unknown) => Promise<{ isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] }>;
const SET = { [DRAWINGS_KEY]: '{"santa.svg":"new"}', [PICTURE_MARKS_KEY]: null };

/** The two tools on `base`, with a stand-in for the picture edit that records each request and answers `answer`. */
function setup(base: ParamValues, { references = [] as string[], answer = {} as Partial<PictureEditResponse> | Error } = {}) {
  const events: AgentEvent[] = [];
  const requests: PictureEditRequest[] = [];
  const edit = (async (r: PictureEditRequest) => {
    requests.push(structuredClone(r));
    if (answer instanceof Error) throw answer;
    return { set: SET, before: png(plain(30, 20, 255)), after: png(plain(30, 20, 0)), masked: !!r.mark, outsideSame: !!r.mark, prompt: 'the prompt', model: 'test/image', cost: 0.04, ...answer };
  }) as typeof editPicture;
  const ctx = { base, emit: (e: AgentEvent) => events.push(e), drawImage: (async () => { throw new Error('not asked'); }) as typeof requestImage } as unknown as ToolContext;
  const [show, editTool] = editPictureTools(ctx, { references }, edit).map((t) => t.handler as unknown as Handler);
  return { events, requests, show, edit: editTool };
}

test('edit_picture with region "mark" edits inside the user\'s saved mark and writes what it sets', async () => {
  const base = valuesWith();
  const { events, requests, edit } = setup(base);
  const r = await edit({ picture: 'santa.svg', change: 'a smiling face', region: 'mark' }, {});
  assert.ok(!r.isError, r.content.map((c) => c.text).join());
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].mark, face);
  assert.equal(requests[0].mode, 'artwork');
  assert.equal(requests[0].change, 'a smiling face');
  assert.deepEqual(requests[0].photos, []);
  // The set is written into the generation's values: a key set, a null deleted.
  assert.equal(base[DRAWINGS_KEY], SET[DRAWINGS_KEY]);
  assert.equal(PICTURE_MARKS_KEY in base, false);
  // The app gets the values and what the version records, and a before / after step.
  const ev = events.find((e) => e.type === 'pictureEdited');
  assert.deepEqual(ev, { type: 'pictureEdited', set: SET, info: { picture: 'santa.svg', change: 'a smiling face', masked: true, outsideSame: true, cost: 0.04 } });
  const step = events.flatMap((e) => (e.type === 'step' && e.step.kind === 'render' ? [e.step] : []))[0];
  assert.ok(step?.image, 'a render step with the before / after picture');
  const both = decodeImage(Buffer.from(step.image!.split(',')[1], 'base64'));
  assert.equal(both.height, 20);
  assert.ok(both.width > 60, `${both.width}: before and after side by side`);
  // The model gets the after picture and what to do next.
  assert.equal(r.content[0].type, 'image');
  assert.equal(r.content[0].mimeType, 'image/png');
  const text = r.content.find((c) => c.type === 'text')!.text!;
  assert.match(text, /unchanged/);
  assert.match(text, /keep the script unchanged/);
  assert.match(text, /render_model/);
  assert.match(text, /\$0\.04/);
});

test('edit_picture with a box edits inside boxMark of it; without a region, the whole picture', async () => {
  const base = valuesWith();
  const { requests, edit } = setup(base);
  const box: [number, number, number, number] = [0.5, 0.3, 0.8, 0.7];
  assert.ok(!(await edit({ picture: 'santa.svg', change: 'a smiling face', region: box }, {})).isError);
  assert.deepEqual(requests[0].mark, boxMark(box, santa.aspect));
  const whole = setup(valuesWith());
  const r = await whole.edit({ picture: 'santa.svg', change: 'make it a winter scene' }, {});
  assert.ok(!r.isError);
  assert.equal(whole.requests[0].mark, undefined);
  assert.match(r.content.find((c) => c.type === 'text')!.text!, /whole picture/);
});

test('edit_picture: region "mark" without a saved mark (or one made on another picture) is an error naming the fix', async () => {
  for (const marks of [null, { 'santa.svg': { fp: 'an older picture', mark: face } }, { 'other.svg': { fp: drawingFingerprint(santa), mark: face } }]) {
    const base = valuesWith(marks);
    const before = { ...base };
    const { requests, edit, events } = setup(base);
    const r = await edit({ picture: 'santa.svg', change: 'a smiling face', region: 'mark' }, {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text!, /no saved mark on "santa\.svg"/);
    assert.match(r.content[0].text!, /Select \(C\)/);
    assert.match(r.content[0].text!, /show_picture/);
    assert.equal(requests.length, 0);
    assert.deepEqual(base, before);
    assert.equal(events.some((e) => e.type === 'pictureEdited'), false);
  }
});

test('edit_picture: an empty box is an error naming the fix', async () => {
  const { requests, edit } = setup(valuesWith());
  for (const region of [[0.5, 0.3, 0.5, 0.7], [0.8, 0.3, 0.5, 0.7], [1.2, 0.3, 1.5, 0.7]]) {
    const r = await edit({ picture: 'santa.svg', change: 'a smiling face', region }, {});
    assert.equal(r.isError, true, JSON.stringify(region));
    assert.match(r.content[0].text!, /x0 < x1 and y0 < y1/);
  }
  assert.equal(requests.length, 0);
});

test('edit_picture: the attached photos go along when asked; asked without any is an error', async () => {
  const none = setup(valuesWith());
  const r = await none.edit({ picture: 'santa.svg', change: 'the face of the man in the photo', region: 'mark', use_attached_photos: true }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text!, /attached no photos/);
  assert.equal(none.requests.length, 0);

  const some = setup(valuesWith(), { references: [PHOTO, 'data:image/gif;base64,R0lGOD', PHOTO, PHOTO, PHOTO, PHOTO] });
  assert.ok(!(await some.edit({ picture: 'santa.svg', change: 'the face of the man in the photo', region: 'mark', use_attached_photos: true }, {})).isError);
  // PNG, JPEG or WebP only, at most four (the picture edit's own limits).
  assert.deepEqual(some.requests[0].photos, [PHOTO, PHOTO, PHOTO, PHOTO]);
  // Not asked for: none sent.
  const unasked = setup(valuesWith(), { references: [PHOTO] });
  await unasked.edit({ picture: 'santa.svg', change: 'a smiling face', region: 'mark' }, {});
  assert.deepEqual(unasked.requests[0].photos, []);
});

test('edit_picture: an unknown picture or a failed edit is an error, and nothing is written', async () => {
  const base = valuesWith(), before = { ...base };
  const { edit, requests } = setup(base);
  const r = await edit({ picture: 'nope.svg', change: 'a smiling face' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text!, /no drawing "nope\.svg"/);
  assert.equal(requests.length, 0);
  const failing = setup(base, { answer: new Error('The image model refused: no faces today') });
  const f = await failing.edit({ picture: 'santa.svg', change: 'a smiling face', region: 'mark' }, {});
  assert.equal(f.isError, true);
  assert.equal(f.content[0].text, 'The image model refused: no faces today');
  assert.deepEqual(base, before);
  assert.equal(failing.events.some((e) => e.type === 'pictureEdited'), false);
});

test('edit_picture says when the change wants a colour the design has no filament for', async () => {
  const note = 'The change wants brown (#6b4423) on 30 % of the marked area, a colour the design has no filament for.';
  const { edit } = setup(valuesWith(), { answer: { offPalette: { share: 0.3, colour: '#6b4423', note } } });
  const r = await edit({ picture: 'santa.svg', change: 'a darker face', region: 'mark' }, {});
  assert.ok(r.content.find((c) => c.type === 'text')!.text!.includes(note));
});

test('edit_picture: swap layers that could not be kept are said, and the version is not taken to line up', async () => {
  const note = 'Swap layers not kept: this design has more than one LayerTone picture, which share them, so the print outside the mark may change.';
  const { edit, events } = setup(valuesWith(), { answer: { swapsNotKept: { note } } });
  const r = await edit({ picture: 'santa.svg', change: 'a darker face', region: 'mark' }, {});
  assert.ok(r.content.find((c) => c.type === 'text')!.text!.includes(note));
  const ev = events.find((e) => e.type === 'pictureEdited');
  assert.ok(ev && ev.type === 'pictureEdited' && ev.info.masked && ev.info.outsideSame === false);
});

/** The pixel (RGBA) at (i, j). */
const at = (r: Raster, i: number, j: number) => [...r.data.subarray((j * r.width + i) * 4, (j * r.width + i) * 4 + 4)];

test('show_picture: the drawing about 1024 pixels wide with a grid every 0.1, and the saved mark outlined', async () => {
  const { show } = setup(valuesWith());
  const r = await show({ picture: 'santa.svg' }, {});
  assert.ok(!r.isError);
  const img = decodeImage(Buffer.from(r.content[0].data!, 'base64'));
  assert.ok(Math.abs(img.width - 1024) <= 1, `${img.width}`);
  assert.equal(img.height, Math.round(1024 / 1.5));
  // White paper away from the lines, grid colour on them (a tenth of the width, on white).
  const y = Math.round(0.05 * img.height);
  assert.deepEqual(at(img, Math.round(0.05 * img.width), y), [255, 255, 255, 255]);
  const line = at(img, Math.round(0.1 * img.width), y);
  assert.ok(line[2] > 200 && line[0] < 150, `grid line ${line}`);
  // The mark (centre x 0.1, radius 0.15 in picture units) outlined in magenta: along a radius to the
  // right, magenta near its edge only, none inside and none past it.
  const px = img.height, cx = Math.round((0.1 + 1.5 / 2) * px), cy = Math.round(0.5 * px), rad = 0.15 * px;
  const magenta = (i: number) => [-3, 0, 3].some((dj) => at(img, i, cy + dj).slice(0, 3).join() === '255,0,255');
  const along = (from: number, to: number) => Array.from({ length: Math.round((to - from) * rad) }, (_, k) => magenta(cx + Math.round(from * rad) + k));
  assert.ok(along(0.85, 1.05).some(Boolean), 'magenta at the mark\'s edge');
  assert.ok(!along(0, 0.7).some(Boolean), 'no magenta inside the mark');
  assert.ok(!along(1.2, 1.6).some(Boolean), 'no magenta past the mark');
  const text = r.content.find((c) => c.type === 'text')!.text!;
  assert.match(text, /every 0\.1/);
  assert.match(text, /\[x0, y0, x1, y1\]/);
  assert.match(text, /magenta/);

  const noMark = setup(valuesWith(null));
  assert.match((await noMark.show({ picture: 'santa.svg' }, {})).content.find((c) => c.type === 'text')!.text!, /no saved mark/);
  assert.equal((await noMark.show({ picture: 'nope.svg' }, {})).isError, true);
});

test('edit_picture and show_picture come with the artwork tools only, and edit with the image model given to cadTools', async () => {
  const names = (extra: Parameters<typeof cadTools>[4]) => Object.keys((cadTools('/nonexistent/model.js', () => {}, new Set(), {}, extra).server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  assert.ok(names({ artwork: { references: [] } }).includes('edit_picture'));
  assert.ok(names({ artwork: { references: [] } }).includes('show_picture'));
  assert.equal(names({}).includes('edit_picture'), false);
  // A mode with no pictures (a plain 3D model) has none; a lithophane with the image model has them (its own test below).
  assert.equal(names({ designImage: undefined }).includes('edit_picture'), false);
  assert.ok(names({ pictures: { references: [] }, lithophane: true }).includes('edit_picture'));
  assert.ok(names({ pictures: { references: [] }, lithophane: true }).includes('show_picture'));
  assert.equal(names({ lithophane: true }).includes('edit_picture'), false, 'no image model: no edit_picture');
  // (LayerTone with the image model has them too: its own test below.)

  // The real picture edit, with a stand-in image model that sends the crop back unchanged.
  const asked: string[] = [];
  const image = (async (_prompt: string, aspect: string, references?: string[]) => {
    asked.push(aspect);
    return { image: { data: references![0].split(',')[1], mediaType: 'image/png' }, model: 'test/image', cost: 0.02 };
  }) as typeof requestImage;
  const base = valuesWith();
  const events: AgentEvent[] = [];
  const { server } = cadTools('/nonexistent/model.js', (e) => events.push(e), new Set(), base, { artwork: { references: [] }, image });
  const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
  const r = await tools.edit_picture.handler({ picture: 'santa.svg', change: 'the same face', region: 'mark' }, {});
  assert.ok(!r.isError, r.content.map((c) => c.text).join());
  assert.equal(asked.length, 1);
  assert.ok(parseDrawings(base[DRAWINGS_KEY])['santa.svg'], 'the drawing is still there under its name');
  // The mark is used up.
  assert.equal(PICTURE_MARKS_KEY in base, false);
  const ev = events.find((e) => e.type === 'pictureEdited');
  assert.ok(ev && ev.type === 'pictureEdited' && ev.info.masked && ev.info.outsideSame && ev.info.cost === 0.02);
});

/** A LayerTone photo, 1.5 times as wide as high: dark left, bright right. */
const photo = { name: 'photo-1', width: 30, height: 20, luma: toBase64(Uint8Array.from({ length: 600 }, (_, i) => Math.round(((i % 30) / 29) * 255))) };
const photoValues = (marks: unknown = { 'photo-1': { fp: photoFingerprint(photo), mark: face } }): ParamValues => ({
  [LAYERTONE_IMAGES_KEY]: JSON.stringify({ 'photo-1': photo }),
  ...(marks ? { [PICTURE_MARKS_KEY]: JSON.stringify(marks) } : {}),
});
const BUILT = { options: { width: 150, layerHeight: 0.08, firstLayerHeight: 0.16, baseHeight: 0.48, maxHeight: 1.6, border: 0, invert: false, gamma: 1, resolution: 0.35 }, filaments: [{ name: 'Black', color: '#000000', td: 0.2 }, { name: 'White', color: '#ffffff', td: 5.9 }], swaps: [11] };

test('edit_picture and show_picture in LayerTone mode: the photo greyscale with a grid, a marked edit sent with how its part is built, the swaps kept said', async () => {
  const names = (extra: Parameters<typeof cadTools>[4]) => Object.keys((cadTools('/nonexistent/model.js', () => {}, new Set(), {}, extra).server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  assert.ok(names({ pictures: { references: [] }, layerTone: true }).includes('edit_picture'));
  assert.ok(names({ pictures: { references: [] }, layerTone: true }).includes('show_picture'));
  // Without the image model, none.
  assert.equal(names({ layerTone: true }).includes('edit_picture'), false);

  const events: AgentEvent[] = [];
  const requests: PictureEditRequest[] = [];
  const note = 'Swap layers kept as they were (layer 11), so the print outside the mark stays the same: set them back to automatic in the Print tab if you like.';
  const set = { [LAYERTONE_IMAGES_KEY]: '{"photo-1":"new"}', $layertone: '{"swaps":[11]}', [PICTURE_MARKS_KEY]: null };
  const edit = (async (r: PictureEditRequest) => {
    requests.push(structuredClone(r));
    return { set, before: png(plain(30, 20, 255)), after: png(plain(30, 20, 0)), masked: !!r.mark, outsideSame: !!r.mark, swapsKept: { swaps: [11], note }, prompt: 'the prompt', model: 'test/image', cost: 0.04 };
  }) as typeof editPicture;
  const built: string[] = [];
  const tools = (base: ParamValues, answer: PictureEditRequest['layerTone'] | null = BUILT) => {
    const ctx = { base, emit: (e: AgentEvent) => events.push(e), drawImage: (async () => { throw new Error('not asked'); }) as typeof requestImage } as unknown as ToolContext;
    return editPictureTools(ctx, { references: [] }, edit, { mode: 'layertone', built: async (p) => { built.push(p); return answer; } }).map((t) => t.handler as unknown as Handler);
  };

  // show_picture: the stored photo, grey, about 1024 wide, the saved mark outlined.
  const [show, editTool] = tools(photoValues());
  const shown = await show({ picture: 'photo-1' }, {});
  const pic = decodeImage(Buffer.from(shown.content[0].data!, 'base64'));
  assert.equal(pic.height, Math.round(1024 / 1.5));
  assert.ok(Math.abs(pic.width - 1024) <= 1, String(pic.width));
  // Grey: the photo's own tones (red, green and blue alike) away from the grid lines.
  const [r0, g0, b0] = pic.data.subarray((300 * pic.width + 30) * 4);
  assert.ok(r0 === g0 && g0 === b0, `${r0} ${g0} ${b0}`);
  assert.match(shown.content[1].text!, /^Picture "photo-1"/);
  assert.match(shown.content[1].text!, /outlined in magenta/);
  assert.equal((await show({ picture: 'nope' }, {})).isError, true);

  // A marked edit: the photo's mode and how its part is built go along; the model is told the swaps were kept.
  const r = await editTool({ picture: 'photo-1', change: 'a smiling face', region: 'mark' }, {});
  assert.ok(!r.isError, r.content.map((c) => c.text).join());
  assert.deepEqual(built, ['photo-1']);
  assert.equal(requests[0].mode, 'layertone');
  assert.deepEqual(requests[0].mark, face);
  assert.deepEqual(requests[0].layerTone, BUILT);
  const text = r.content.find((c) => c.type === 'text')!.text!;
  assert.match(text, /Outside the region the picture is unchanged\./);
  assert.ok(text.includes(note));
  assert.match(text, /The picture is updated under the same name/);
  const ev = events.find((e) => e.type === 'pictureEdited');
  assert.deepEqual(ev, { type: 'pictureEdited', set, info: { picture: 'photo-1', change: 'a smiling face', masked: true, outsideSame: true, cost: 0.04 } });

  // A marked edit with no part built from the picture says what to do; the whole picture needs none.
  const [, unbuilt] = tools(photoValues(), null);
  const u = await unbuilt({ picture: 'photo-1', change: 'a smiling face', region: [0.2, 0.2, 0.6, 0.6] }, {});
  assert.equal(u.isError, true);
  assert.match(u.content[0].text!, /No part of the model is built from "photo-1"/);
  const whole = await unbuilt({ picture: 'photo-1', change: 'a winter scene' }, {});
  assert.ok(!whole.isError);
  assert.equal(requests.at(-1)!.layerTone, undefined);
  // A mark made on another picture is not used.
  const [, stale] = tools(photoValues({ 'photo-1': { fp: 'an older picture', mark: face } }));
  assert.match((await stale({ picture: 'photo-1', change: 'a smiling face', region: 'mark' }, {})).content[0].text!, /picture editor/);
});

/** A line-art drawing: a 2:1 frame (one black shape), and a line drawn by hand down its right part. */
const box = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const frameArt: SvgDrawing = { name: 'frame', aspect: 2, shapes: [{ rule: 'EvenOdd', contours: [box(-1, -0.5, 1, 0.5), box(-0.9, -0.4, 0.9, 0.4)], color: '#000000' }] };
const lineValues = (marks: unknown = { frame: { fp: drawingFingerprint(frameArt), mark: face } }): ParamValues => ({
  [DRAWINGS_KEY]: JSON.stringify({ frame: frameArt }),
  [LINEART_EDITS_KEY]: JSON.stringify({ frame: { fp: drawingFingerprint(frameArt), strokes: [{ mode: 'draw', width: 4, k: 100, points: [[0.6, -0.4], [0.6, 0.4]] }] } }),
  ...(marks ? { [PICTURE_MARKS_KEY]: JSON.stringify(marks) } : {}),
});
const LINE_FRAME = { k: 100, k0: 100, lineWidth: 1, style: 'outline' as const, width: 200 };

test('edit_picture and show_picture in line art mode: the drawing with its hand edits and a grid, an edit sent with where the drawing sits in the piece, the joins note said', async () => {
  const names = (extra: Parameters<typeof cadTools>[4]) => Object.keys((cadTools('/nonexistent/model.js', () => {}, new Set(), {}, extra).server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  assert.ok(names({ lineArt: { references: [], style: 'outline', pictures: true } }).includes('edit_picture'));
  assert.ok(names({ lineArt: { references: [], style: 'outline', pictures: true } }).includes('show_picture'));
  // Without the image model, none.
  assert.equal(names({ lineArt: { references: [], style: 'outline', pictures: false } }).includes('edit_picture'), false);

  const events: AgentEvent[] = [];
  const requests: PictureEditRequest[] = [];
  const note = 'Joins and bridges are worked out again for the whole piece: check them near the mark.';
  const set = { [DRAWINGS_KEY]: '{"frame":"new"}', [LINEART_EDITS_KEY]: '{"frame":"re-keyed"}', [PICTURE_MARKS_KEY]: null };
  const edit = (async (r: PictureEditRequest) => {
    requests.push(structuredClone(r));
    return { set, before: png(plain(30, 20, 255)), after: png(plain(30, 20, 0)), masked: !!r.mark, outsideSame: !!r.mark, ...(r.mark ? { lineArtJoins: { note } } : {}), prompt: 'the prompt', model: 'test/image', cost: 0.04 };
  }) as typeof editPicture;
  const frames: string[] = [];
  const tools = (base: ParamValues, answer: PictureEditRequest['lineArt'] | null = LINE_FRAME) => {
    const ctx = { base, emit: (e: AgentEvent) => events.push(e), drawImage: (async () => { throw new Error('not asked'); }) as typeof requestImage } as unknown as ToolContext;
    return editPictureTools(ctx, { references: [] }, edit, { mode: 'lineart', frame: async (p) => { frames.push(p); return answer; } }).map((t) => t.handler as unknown as Handler);
  };

  // show_picture: the drawing black on white with the hand-drawn line in, 1024 wide, the saved mark outlined.
  const [show, editTool] = tools(lineValues());
  const shown = await show({ picture: 'frame' }, {});
  const pic = decodeImage(Buffer.from(shown.content[0].data!, 'base64'));
  assert.deepEqual([pic.width, pic.height], [1024, 512]);
  const at = (x: number, y: number) => pic.data[(Math.round(y) * pic.width + Math.round(x)) * 4];
  assert.ok(at(1024 * 0.8, 512 * 0.35) < 60, 'the line drawn by hand is in (black)');
  assert.ok(at(1024 * 0.25, 512 * 0.35) > 200, 'inside the frame: white');
  assert.match(shown.content[1].text!, /^Drawing "frame"/);
  assert.match(shown.content[1].text!, /outlined in magenta/);
  assert.equal((await show({ picture: 'nope' }, {})).isError, true);

  // A marked edit: line art mode and where the drawing sits go along; the model is told about the joins.
  const r = await editTool({ picture: 'frame', change: 'a round window', region: 'mark' }, {});
  assert.ok(!r.isError, r.content.map((c) => c.text).join());
  assert.deepEqual(frames, ['frame', 'frame']);
  assert.equal(requests[0].mode, 'lineart');
  assert.deepEqual(requests[0].mark, face);
  assert.deepEqual(requests[0].lineArt, LINE_FRAME);
  const text = r.content.find((c) => c.type === 'text')!.text!;
  assert.match(text, /Outside the region the drawing is unchanged\./);
  assert.ok(text.includes(note));
  const ev = events.find((e) => e.type === 'pictureEdited');
  assert.deepEqual(ev, { type: 'pictureEdited', set, info: { picture: 'frame', change: 'a round window', masked: true, outsideSame: true, cost: 0.04 } });

  // A model that does not use the drawing yet: no frame sent (the picture edit draws the hand edits at its defaults).
  const [, unbuilt] = tools(lineValues(), null);
  assert.ok(!(await unbuilt({ picture: 'frame', change: 'a winter scene' }, {})).isError);
  assert.equal(requests.at(-1)!.lineArt, undefined);
  assert.equal(requests.at(-1)!.mark, undefined);
  // A mark made on another drawing is not used, and the fix is named.
  const [, stale] = tools(lineValues({ frame: { fp: 'an older drawing', mark: face } }));
  assert.match((await stale({ picture: 'frame', change: 'a round window', region: 'mark' }, {})).content[0].text!, /Edit drawing brush/);
});

// ---- The app's side

const version = (extra: Partial<DesignVersion> = {}): DesignVersion => ({ code: 'old', summary: 's', createdAt: 1, source: 'ai', values: {}, ...extra });
const design = (extra: Partial<Design> = {}): Design => ({
  id: 'd1', name: 'n', createdAt: 1, updatedAt: 1, messages: [{ id: 'a1', role: 'assistant', text: '', createdAt: 1 }],
  versions: [version(), version()], currentVersion: 1, code: 'old', values: { [PICTURE_MARKS_KEY]: 'm', [ARTWORK_EDITS_KEY]: 'e', $scale: 2 }, ...extra,
});
const modelEvent = { type: 'model' as const, code: 'new', summary: 'Swapped the face', sources: [] };

test('a pictureEdited then a model event make a version with the picture edit, its parent the version current when the reply started', () => {
  const start = design({ currentVersion: 0 });
  const parent = start.currentVersion;
  const info = { picture: 'santa.svg', change: 'a smiling face', masked: true, outsideSame: true, cost: 0.04 };
  let d = withPictureEdited(start, { [DRAWINGS_KEY]: 'new drawing', [PICTURE_MARKS_KEY]: null });
  assert.equal(d.values[DRAWINGS_KEY], 'new drawing');
  assert.equal(PICTURE_MARKS_KEY in d.values, false);
  assert.equal(d.values[ARTWORK_EDITS_KEY], 'e');
  const edit = addReplyEdit(null, info);
  d = withReplyVersion(d, modelEvent, 'a1', { edit, parent });
  assert.equal(d.versions.length, 3);
  assert.equal(d.currentVersion, 2);
  const v = d.versions[2];
  assert.equal(v.source, 'ai');
  assert.equal(v.code, 'new');
  assert.equal(v.values![DRAWINGS_KEY], 'new drawing');
  assert.deepEqual(v.pictureEdit, { picture: 'santa.svg', change: 'a smiling face', masked: true, parent: 0, linesUp: false, cost: 0.04 });
  assert.equal(d.messages[0].versionIndex, 2);
  // A reply without a picture edit makes the version it always did.
  const plainVersion = withReplyVersion(start, modelEvent, 'a1');
  assert.equal(plainVersion.versions[2].pictureEdit, undefined);
  assert.deepEqual(Object.keys(plainVersion.versions[2]).sort(), ['code', 'createdAt', 'source', 'sources', 'summary', 'values']);
});

test('a reply that submits again: the edit goes to the version that took it only; a later edit starts from that version', () => {
  const info = { picture: 'santa.svg', change: 'a smiling face', masked: true, outsideSame: true, cost: 0.04 };
  const start = design({ currentVersion: 0 });
  // The edit, then a submit: the version records it, and nothing is pending after it.
  let r = replyModel(withPictureEdited(start, { [DRAWINGS_KEY]: 'new' }), modelEvent, 'a1', { edit: addReplyEdit(null, info), parent: 0 });
  assert.equal(r.design.versions[2].pictureEdit?.parent, 0);
  assert.deepEqual(r.pending, { edit: null, parent: 2 });
  // A second submit without a new edit: a plain version.
  r = replyModel(r.design, { ...modelEvent, summary: 'Tidied' }, 'a1', r.pending);
  assert.equal(r.design.versions[3].pictureEdit, undefined);
  assert.deepEqual(r.pending, { edit: null, parent: 3 });
  // Another edit, then a submit: its parent is the reply's last version.
  r = replyModel(r.design, modelEvent, 'a1', { ...r.pending, edit: addReplyEdit(r.pending.edit, { ...info, change: 'a hat' }) });
  assert.equal(r.design.versions[4].pictureEdit?.parent, 3);
  assert.equal(r.design.versions[4].pictureEdit?.change, 'a hat');
});

test('several picture edits in one reply: the last one\'s picture and change, masked only if all were, the costs summed', () => {
  const a = { picture: 'a.svg', change: 'first', masked: true, outsideSame: true, cost: 0.04 };
  const b = { picture: 'b.svg', change: 'second', masked: true, outsideSame: false, cost: 0.03 };
  assert.deepEqual(addReplyEdit(addReplyEdit(null, a), b), { picture: 'b.svg', change: 'second', masked: true, outsideSame: false, cost: 0.07 });
  assert.equal(addReplyEdit(addReplyEdit(null, a), { ...b, masked: false }).masked, false);
  assert.equal(addReplyEdit(addReplyEdit(null, { ...a, masked: false }), b).masked, false);
  // An unknown cost leaves the known ones; none known stays unknown.
  assert.equal(addReplyEdit(addReplyEdit(null, a), { ...b, cost: null }).cost, 0.04);
  assert.equal(addReplyEdit(addReplyEdit(null, { ...a, cost: null }), { ...b, cost: null }).cost, null);
});

test('the picture edits kept in the brush editor since the chat\'s last version, for the follow-up', () => {
  const kept = (picture: string, change: string, masked = true): Partial<DesignVersion> => ({ source: 'manual', pictureEdit: { picture, change, masked, parent: 0, linesUp: false, cost: 0.04 } });
  const versions = [version(), version(kept('a.svg', 'before the chat')), version(), version(kept('a.svg', 'a smile')), version({ source: 'manual' }), version(kept('b.svg', 'a hat', false))];
  assert.deepEqual(editorEditsSince(versions), [
    { picture: 'a.svg', change: 'a smile', masked: true, version: 4 },
    { picture: 'b.svg', change: 'a hat', masked: false, version: 6 },
  ]);
  // A chat version with a picture edit (edit_picture) is the chat's own.
  assert.deepEqual(editorEditsSince([version({ ...kept('a.svg', 'x'), source: 'ai' })]), []);
  assert.deepEqual(editorEditsSince([version(kept('a.svg', 'x'))]), [{ picture: 'a.svg', change: 'x', masked: true, version: 1 }]);
  assert.deepEqual(editorEditsSince([]), []);
});

test('a line-art design with the menu on AI artwork gets the line-art edit_picture, and artwork\'s notes leave out its own', async () => {
  const registered = (extra: Parameters<typeof cadTools>[4]) => (cadTools('/nonexistent/model.js', () => {}, new Set(), {}, extra).server.instance as unknown as { _registeredTools: Record<string, { description: string }> })._registeredTools;
  const both = registered({ artwork: { references: [] }, lineArt: { references: [], style: 'outline', pictures: true } });
  assert.match(both.edit_picture.description, /line-art drawings/, 'the line-art variant');
  assert.match(both.show_picture.description, /line-art drawings/);
  assert.ok(both.generate_artwork, 'artwork\'s other tools stay');
  // Artwork alone keeps its own.
  assert.doesNotMatch(registered({ artwork: { references: [] } }).edit_picture.description, /line-art/);
  const { artwork } = await import('../server/modes/artwork');
  const ctx = { req: { designId: 'd', prompt: 'x' }, pictureValues: {}, drawings: { cat: { name: 'cat', aspect: 1, shapes: [] } } } as unknown as Parameters<typeof artwork.turnNotes>[0];
  const modes = (lineArt: boolean) => ({ artwork: true, lineArt }) as Parameters<typeof artwork.turnNotes>[1];
  assert.ok(artwork.turnNotes(ctx, modes(false)).some((n) => /use edit_picture/.test(n)));
  assert.equal(artwork.turnNotes(ctx, modes(true)).some((n) => /use edit_picture/.test(n)), false);
});
