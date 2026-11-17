// Photos from earlier messages in the chat, and pictures sent while a reply runs, reach every
// image tool: generate_artwork, generate_line_art and generate_3d read the chat's photos (this
// message's first), and steerGeneration adds mid-run pictures to the references the tools hold.
import './wasm';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { encode } from 'fast-png';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-chat-photos-'));
process.env.PTP_DATA = dataDir;
const { cadTools } = await import('../server/cadTools');
const { geometry } = await import('../server/geometry');
const { Inbox, steering, steerGeneration } = await import('../server/generation/messages');
const { createMeshyMock } = await import('../server/meshyMock');
let clock = Date.now();
const sleep = async (ms: number) => { clock += Math.min(ms, 50); };
const mock = createMeshyMock({ pendingMs: 200, runMs: 800, now: () => clock });
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
after(() => { mock.close(); geometry.stop(); rmSync(dataDir, { recursive: true, force: true }); });

type Handler = (a: unknown, extra: unknown) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
const handlers = (cad: unknown) => (cad as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance._registeredTools;

// A small picture the image model "draws": a black ring on white (it traces as artwork and as line art).
const png = (() => {
  const W = 64, H = 64, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Math.abs(Math.hypot(x - 32, y - 32) - 18) < 3 ? 10 : 245;
    data.set([v, v, v, 255], (y * W + x) * 4);
  }
  return Buffer.from(encode({ width: W, height: H, data, channels: 4 }));
})();
const asked: { references?: string[] }[] = [];
const image = async (_prompt: string, _aspect: string, references?: string[]) => {
  asked.push({ references });
  return { image: { data: png.toString('base64'), mediaType: 'image/png' }, model: 'test/image-model', cost: 0.04 };
};

/** A saved design whose earlier user message has one stored photo: its data URL. */
function designWithPhoto(id: string): string {
  const name = `${'a'.repeat(31)}${id.at(-1)}.png`;
  mkdirSync(path.join(dataDir, 'designs', id), { recursive: true });
  writeFileSync(path.join(dataDir, 'designs', id, name), png);
  writeFileSync(path.join(dataDir, 'designs', `${id}.json`), JSON.stringify({ id, messages: [
    { id: 'm1', role: 'user', text: 'my dog', images: [`/api/designs/${id}/images/${name}`], createdAt: 1 },
    { id: 'm2', role: 'assistant', text: '', createdAt: 2 },
  ] }));
  return `data:image/png;base64,${png.toString('base64')}`;
}

test('a picture sent mid-run joins the references the image tools read', async () => {
  const references: string[] = ['data:image/png;base64,OLD'];
  const inbox = new Inbox();
  steering.set('d1', { inbox, emit: () => {}, references });
  steerGeneration('d1', 'use this face', [{ mediaType: 'image/jpeg', data: 'NEW' }, { mediaType: 'application/pdf', data: 'PDF' }]);
  // Appended: photo numbers (generate_3d photos: [n]) already given to the agent never shift.
  assert.deepEqual(references, ['data:image/png;base64,OLD', 'data:image/jpeg;base64,NEW']);
  steerGeneration('d1', 'again', [{ mediaType: 'image/jpeg', data: 'NEW' }]);
  assert.equal(references.length, 2);
  steerGeneration('d1', 'no picture this time');
  steering.delete('d1');
  inbox.close();
  const texts: string[] = [];
  for await (const m of inbox.drain()) {
    const first = (m.message.content as { type: string; text?: string }[])[0];
    texts.push(first.text!);
  }
  assert.match(texts[0], /\(with pictures\):\nuse this face The image tools can use these pictures now \(use_attached_photos \/ from_photo\)\. They are photo 2 \(photos are numbered in the order sent; earlier numbers stay the same\)\.$/);
  assert.doesNotMatch(texts[2], /image tools/);
});

test('generate_artwork draws from a photo sent with an earlier message', async () => {
  const stored = designWithPhoto('chat-photo-art-1');
  const { server } = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), {}, { artwork: { references: [], designId: 'chat-photo-art-1' }, image });
  const out = await handlers(server).generate_artwork.handler({ name: 'dog', subject: 'the dog in the photo, sitting', use_attached_photos: true }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  assert.deepEqual(asked.at(-1)!.references, [stored]);
  const none = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), {}, { artwork: { references: [], designId: 'chat-photo-none-1' }, image });
  const refused = await handlers(none.server).generate_artwork.handler({ name: 'dog', subject: 'the dog in the photo, sitting', use_attached_photos: true }, {});
  assert.ok(refused.isError);
  assert.equal(refused.content[0].text, 'The user attached no photos in this chat.');
});

test('generate_line_art draws from a photo sent with an earlier message', async () => {
  const stored = designWithPhoto('chat-photo-line-2');
  const { server } = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), {}, { lineArt: { references: [], designId: 'chat-photo-line-2', style: 'outline', pictures: true }, image });
  const out = await handlers(server).generate_line_art.handler({ name: 'dog', subject: 'the dog in the photo, side view', use_attached_photos: true }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  assert.deepEqual(asked.at(-1)!.references, [stored]);
  const none = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), {}, { lineArt: { references: [], designId: 'chat-photo-none-2', style: 'outline', pictures: true }, image });
  const refused = await handlers(none.server).generate_line_art.handler({ name: 'dog', subject: 'the dog in the photo, side view', use_attached_photos: true }, {});
  assert.ok(refused.isError);
  assert.equal(refused.content[0].text, 'The user attached no photos in this chat.');
});

test('generate_3d builds from a photo sent with an earlier message', async () => {
  const stored = designWithPhoto('chat-photo-mesh-3');
  const client = { key: 'msy_test', baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/openapi`, sleep };
  const { server } = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), {}, { meshy: { client, designId: 'chat-photo-mesh-3', references: [] } });
  const out = await handlers(server).generate_3d.handler({ name: 'dog', from_photo: true }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  assert.equal(mock.created.at(-1)!.type, 'image-to-3d');
  assert.equal(mock.created.at(-1)!.body.image_url, stored);
  assert.match((await handlers(server).generate_3d.handler({ name: 'dog', from_photo: true, photos: [2] }, {})).content[0].text!, /no photo 2/);
  const none = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), {}, { meshy: { client, designId: 'chat-photo-none-3', references: [] } });
  const refused = await handlers(none.server).generate_3d.handler({ name: 'dog', from_photo: true }, {});
  assert.ok(refused.isError);
  assert.equal(refused.content[0].text, 'The user attached no photos in this chat.');
});

test('generate_3d builds only from this message\'s photos when it has some (earlier ones are another subject)', async () => {
  designWithPhoto('chat-photo-mesh-4');
  const current = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a04', 'hex').toString('base64')}`;
  const client = { key: 'msy_test', baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/openapi`, sleep };
  const { server } = cadTools(path.join(dataDir, 'model.js'), () => undefined, new Set(), {}, { meshy: { client, designId: 'chat-photo-mesh-4', references: [current] } });
  const out = await handlers(server).generate_3d.handler({ name: 'cat', from_photo: true }, {});
  assert.ok(!out.isError, JSON.stringify(out));
  assert.equal(mock.created.at(-1)!.type, 'image-to-3d');
  assert.equal(mock.created.at(-1)!.body.image_url, current);
});

test('a picture sent mid-run is numbered after the ones already attached, so photos: [1] keeps meaning the first', async () => {
  const references: string[] = ['data:image/png;base64,A', 'data:image/png;base64,B'];
  const inbox = new Inbox();
  steering.set('d2', { inbox, emit: () => {}, references });
  steerGeneration('d2', 'and this one', [{ mediaType: 'image/jpeg', data: 'C' }]);
  steering.delete('d2');
  inbox.close();
  assert.equal(references[0], 'data:image/png;base64,A');
  assert.equal(references[2], 'data:image/jpeg;base64,C');
  const texts: string[] = [];
  for await (const m of inbox.drain()) texts.push((m.message.content as { text?: string }[])[0].text!);
  assert.match(texts[0], /photo 3 /);
});
