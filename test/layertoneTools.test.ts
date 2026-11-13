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
