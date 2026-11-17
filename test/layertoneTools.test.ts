// generate_picture in LayerTone mode with a filament stack: the strip goes to the image model,
// the picture is stored by strip position with its colour picture kept, and the strip's swaps
// are fixed in the LayerTone setup. Lithophane pictures stay as they were.
import './wasm';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encode } from 'fast-png';
import type { AgentEvent } from '../shared/api';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-layertone-tools-'));
process.env.PTP_DATA = dataDir;
const { cadTools } = await import('../server/cadTools');
const { geometry } = await import('../server/geometry');
const { LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, parseLayerToneImages, parseLayerToneSetup } = await import('../shared/layertone');
after(() => { geometry.stop(); rmSync(dataDir, { recursive: true, force: true }); });

type Handler = (a: unknown, extra: unknown) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
const handlers = (cad: unknown) => (cad as { instance: { _registeredTools: Record<string, { handler: Handler; inputSchema?: unknown }> } }).instance._registeredTools;

// A stand-in image model: an 8 x 8 picture, half dark, half light; it records what it was sent.
const asked: { prompt: string; references?: string[] }[] = [];
const picture = (() => {
  const data = new Uint8Array(8 * 8 * 4);
  for (let p = 0; p < 64; p++) { const v = p % 8 < 4 ? 20 : 230; data.set([v, v, v, 255], p * 4); }
  return Buffer.from(encode({ width: 8, height: 8, data, channels: 4 })).toString('base64');
})();
const image = async (prompt: string, _aspect: string, references?: string[]) => {
  asked.push({ prompt, references });
  return { image: { data: picture, mediaType: 'image/png' }, model: 'test/image-model', cost: 0.04 };
};
const FILAMENTS = [{ name: 'Black', color: '#000000', td: 0.6 }, { name: 'Blue', color: '#1a3fbf', td: 1 }, { name: 'White', color: '#ffffff', td: 1.6 }];

test('generate_picture with filaments: strip sent last, picture stored by strip position, colour kept, swaps fixed', async () => {
  const events: AgentEvent[] = [];
  const base: Record<string, string> = {};
  const { server: cad } = cadTools(path.join(dataDir, 'model.js'), (e) => events.push(e), new Set(), base,
    { pictures: { references: [], designId: 'design-strip-0001' }, layerTone: true, image });
  const out = await handlers(cad).generate_picture.handler({ name: 'portrait', subject: 'a lighthouse at dusk', filaments: FILAMENTS, max_height: 2.4 }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  const sent = asked.at(-1)!;
  assert.match(sent.prompt, /only colours from the strip/);
  assert.match(sent.references!.at(-1)!, /^data:image\/png;base64,/);
  const stored = parseLayerToneImages(base[LAYERTONE_IMAGES_KEY]).portrait;
  assert.equal(stored.positions, true);
  assert.equal(stored.stack!.maxHeight, 2.4);
  assert.deepEqual(stored.stack!.filaments.map((f) => f.name), ['Black', 'Blue', 'White']);
  const setup = parseLayerToneSetup(base[LAYERTONE_KEY]);
  assert.deepEqual(setup.swaps, stored.stack!.swaps);
  assert.deepEqual(setup.filaments!.map((f) => f.name), ['Black', 'Blue', 'White']);
  const m = /^\/api\/designs\/design-strip-0001\/images\/([0-9a-f]{32}\.png)$/.exec(stored.colour!);
  assert.ok(m, String(stored.colour));
  assert.ok(existsSync(path.join(dataDir, 'designs', 'design-strip-0001', m![1]!)));
  assert.ok(events.some((e) => e.type === 'layerToneSetup'));
  assert.match(out.content.at(-1)!.text!, /maxHeight: 2\.4/);
});

test('generate_picture repaints an attached photo for the stack', async () => {
  const base: Record<string, string> = {};
  const photo = `data:image/png;base64,${picture}`;
  const { server: cad } = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), base,
    { pictures: { references: [photo], designId: 'design-strip-0002' }, layerTone: true, image });
  const out = await handlers(cad).generate_picture.handler({ name: 'photo-1-toned', subject: 'the family in the photo', use_attached_photos: true, filaments: FILAMENTS }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  const sent = asked.at(-1)!;
  assert.deepEqual(sent.references!.slice(0, 1), [photo]);
  assert.equal(sent.references!.length, 2);
  assert.match(sent.prompt, /likeness/);
  assert.equal(parseLayerToneImages(base[LAYERTONE_IMAGES_KEY])['photo-1-toned'].positions, true);
});

test('LayerTone generate_picture needs the filaments; a lithophane one stays a plain picture', async () => {
  const base: Record<string, string> = {};
  const lt = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), base, { pictures: { references: [], designId: 'design-strip-0003' }, layerTone: true, image });
  assert.ok((await handlers(lt.server).generate_picture.handler({ name: 'p', subject: 'a lighthouse at dusk' }, {})).isError);
  const litho = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), base, { pictures: { references: [], designId: 'design-strip-0003' }, lithophane: true, image });
  const out = await handlers(litho.server).generate_picture.handler({ name: 'q', subject: 'a lighthouse at dusk' }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  const stored = parseLayerToneImages(base[LAYERTONE_IMAGES_KEY]).q;
  assert.equal(stored.positions, undefined);
  assert.equal(stored.colour, undefined);
  assert.doesNotMatch(asked.at(-1)!.prompt, /strip/);
});

test('LayerTone with the image model can ask about the filaments even with Ask first off', () => {
  const lt = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), {}, { pictures: { references: [], designId: 'design-strip-0004' }, layerTone: true, image, askFirst: false });
  assert.ok(handlers(lt.server).ask_questions, 'LayerTone gets ask_questions');
  const other = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), {}, { pictures: { references: [], designId: 'design-strip-0004' }, lithophane: true, image, askFirst: false });
  assert.equal(handlers(other.server).ask_questions, undefined);
});

test('stale strip picture is pointed out', async () => {
  const { staleStripNotes } = await import('../server/modes/layerTone');
  const { stripSwaps, toStripImage } = await import('../shared/layertone');
  const o = { width: 100, maxHeight: 1.6, baseHeight: 0.48 };
  const stack = { filaments: FILAMENTS, swaps: stripSwaps(FILAMENTS, o), maxHeight: 1.6, baseHeight: 0.48 };
  const img = toStripImage('portrait', 1, 1, [0, 0, 0, 255], stack, o);
  const setup = JSON.stringify({ filaments: FILAMENTS, swaps: stack.swaps });
  assert.deepEqual(staleStripNotes({ portrait: img }, { [LAYERTONE_KEY]: setup }, { maxHeight: 1.6 }), []);
  const higher = staleStripNotes({ portrait: img }, { [LAYERTONE_KEY]: setup }, { maxHeight: 2.4 });
  assert.equal(higher.length, 1);
  assert.match(higher[0], /"portrait"[\s\S]*offer to repaint/);
  const other = JSON.stringify({ filaments: [FILAMENTS[0], FILAMENTS[2]], swaps: [stack.swaps[0]] });
  assert.equal(staleStripNotes({ portrait: img }, { [LAYERTONE_KEY]: other }, {}).length, 1);
});

test('a stale strip note ignores swaps moved with a raised base', async () => {
  const { staleStripNotes } = await import('../server/modes/layerTone');
  const { stripSwaps, toStripImage } = await import('../shared/layertone');
  const o = { width: 100, maxHeight: 1.6, baseHeight: 0.48 };
  const stack = { filaments: FILAMENTS, swaps: stripSwaps(FILAMENTS, o), maxHeight: 1.6, baseHeight: 0.48 };
  const img = toStripImage('portrait', 1, 1, [0, 0, 0, 255], stack, o);
  // 0.8 mm is 4 layers more than 0.48 mm.
  const raised = JSON.stringify({ filaments: FILAMENTS, swaps: stack.swaps.map((s) => s + 4), baseHeight: 0.8 });
  assert.deepEqual(staleStripNotes({ portrait: img }, { [LAYERTONE_KEY]: raised }, { maxHeight: 1.6 }), []);
  const moved = JSON.stringify({ filaments: FILAMENTS, swaps: stack.swaps.map((s) => s + 5), baseHeight: 0.8 });
  assert.equal(staleStripNotes({ portrait: img }, { [LAYERTONE_KEY]: moved }, { maxHeight: 1.6 }).length, 1);
});

test('generate_picture keeps a raised base and fixes the strip swaps moved with it', async () => {
  const { stripSwaps } = await import('../shared/layertone');
  const base: Record<string, string> = { [LAYERTONE_KEY]: JSON.stringify({ baseHeight: 0.8 }) };
  const { server: cad } = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), base, { pictures: { references: [], designId: 'design-strip-0005' }, layerTone: true, image });
  const out = await handlers(cad).generate_picture.handler({ name: 'p', subject: 'a lighthouse at dusk', filaments: FILAMENTS }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  const setup = parseLayerToneSetup(base[LAYERTONE_KEY]);
  assert.equal(setup.baseHeight, 0.8);
  assert.deepEqual(setup.swaps, stripSwaps(FILAMENTS, { width: 100, maxHeight: 1.6, baseHeight: 0.48 }).map((s) => s + 4));
});

test('set_layertone sets the base height, moves the swaps with it, and reset clears it', async () => {
  const base: Record<string, string> = { [LAYERTONE_KEY]: JSON.stringify({ filaments: FILAMENTS, swaps: [5, 9], baseHeight: 0.48 }) };
  const { server: cad } = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), base, { layerTone: true });
  const set = handlers(cad).set_layertone.handler;
  let out = await set({ base_height: 1.2 }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  assert.match(out.content[0].text!, /1\.2 mm/);
  assert.deepEqual(parseLayerToneSetup(base[LAYERTONE_KEY]), { filaments: FILAMENTS, swaps: [14, 18], baseHeight: 1.2 });
  // Swaps the setup has without a known base: the AI must say where they go.
  base[LAYERTONE_KEY] = JSON.stringify({ filaments: FILAMENTS, swaps: [5, 9] });
  assert.ok((await set({ base_height: 1.2 }, {})).isError);
  out = await set({ base_height: 1.2, swaps: [14, 18] }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  out = await set({ reset: true }, {});
  assert.equal(base[LAYERTONE_KEY], undefined);
});

/** A design whose first message had two photos (a scene, then a face); returns their data URLs. */
async function designWithEarlierPhotos(id: string) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = path.join(dataDir, 'designs', id);
  mkdirSync(dir, { recursive: true });
  const names = ['a'.repeat(32) + '.png', 'b'.repeat(32) + '.png'];
  const bytes = names.map((_, i) => Buffer.from(encode({ width: 2, height: 2, data: new Uint8Array(16).fill(i ? 200 : 40), channels: 4 })));
  names.forEach((n, i) => writeFileSync(path.join(dir, n), bytes[i]));
  writeFileSync(path.join(dataDir, 'designs', `${id}.json`), JSON.stringify({ id, messages: [
    { role: 'user', text: 'the scene (1) with my face (2)', images: names.map((n) => `/api/designs/${id}/images/${n}`) },
    { role: 'assistant', text: 'Which filaments?' },
  ] }));
  return bytes.map((b) => `data:image/png;base64,${b.toString('base64')}`);
}

test('generate_picture repaints the photos from an earlier message when this one has none (an answer to the filament question)', async () => {
  const id = 'design-strip-0010';
  const photos = await designWithEarlierPhotos(id);
  const base: Record<string, string> = {};
  const { server: cad } = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), base, { pictures: { references: [], designId: id }, layerTone: true, image });
  const out = await handlers(cad).generate_picture.handler({ name: 'photo-1-toned', subject: 'the scene with the face from photo 2', use_attached_photos: true, filaments: FILAMENTS }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  assert.deepEqual(asked.at(-1)!.references!.slice(0, 2), photos);
});

test('edit_picture shows the image model the photos from an earlier message when this one has none', async () => {
  const id = 'design-strip-0011';
  const photos = await designWithEarlierPhotos(id);
  const { editPictureTools } = await import('../server/tools/editPicture');
  const { toBase64 } = await import('../shared/layertone');
  const base = { [LAYERTONE_IMAGES_KEY]: JSON.stringify({ portrait: { name: 'portrait', width: 1, height: 1, luma: toBase64(Uint8Array.of(9)) } }) };
  const seen: string[][] = [];
  const fake = (async (r: { photos?: string[] }) => { seen.push(r.photos ?? []); throw new Error('stop here'); }) as never;
  const ctx = { base, emit: () => undefined, state: { submitted: false, meshyCalls: 0, newConcepts: new Set<string>(), asked: false }, drawImage: image as never, readModel: async () => null, v: () => base };
  const tool = editPictureTools(ctx, { references: [], designId: id }, fake, { mode: 'layertone', built: async () => null }).find((t) => t.name === 'edit_picture')!;
  await tool.handler({ picture: 'portrait', change: 'the face from photo 2', region: undefined, use_attached_photos: true }, {});
  assert.deepEqual(seen, [photos]);
});

test('set_layertone back_text: false stores off, a string sets the text, "" returns to the default', async () => {
  const { BACK_TEXT_KEY, parseBackText } = await import('../shared/backText');
  const events: AgentEvent[] = [];
  const filament = { name: 'Blue', color: '#1a3fbf', td: 1 };
  const base: Record<string, string> = { [BACK_TEXT_KEY]: JSON.stringify({ filament, size: 50 }) };
  const { server: cad } = cadTools(path.join(dataDir, 'model.js'), (e) => events.push(e), new Set(), base, { layerTone: true });
  const run = (a: unknown) => handlers(cad).set_layertone.handler(a, {});
  const last = () => events.filter((e) => e.type === 'backText').at(-1) as { value: string | null };

  const off = await run({ back_text: false });
  assert.ok(!off.isError, JSON.stringify(off));
  assert.deepEqual(parseBackText(base[BACK_TEXT_KEY]), { off: true, filament, size: 50 });
  assert.equal(last().value, base[BACK_TEXT_KEY]);
  assert.match(off.content[0].text!, /Back text: off/);

  await run({ back_text: 'Shop' });
  assert.deepEqual(parseBackText(base[BACK_TEXT_KEY]), { text: 'Shop', filament, size: 50 });
  assert.equal(last().value, base[BACK_TEXT_KEY]);

  await run({ back_text: '' });
  assert.deepEqual(parseBackText(base[BACK_TEXT_KEY]), { filament, size: 50 });

  delete base[BACK_TEXT_KEY];
  await run({ back_text: 'Shop' });
  await run({ back_text: '' });
  assert.ok(!(BACK_TEXT_KEY in base));
  assert.equal(last().value, null);

  process.env.PTP_BACK_TEXT = '';
  const none = await run({ back_text: 'Shop' });
  assert.match(none.content[0].text!, /no back text at all/);
  process.env.PTP_BACK_TEXT = 'shop.example';
  const dflt = await run({ back_text: '' });
  assert.match(dflt.content[0].text!, /Back text: "shop.example" \(the default\)/);
  delete process.env.PTP_BACK_TEXT;
});
