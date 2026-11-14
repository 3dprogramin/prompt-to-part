// The final review's findings on pictures drawn for a filament stack (strip pictures), each pinned.
import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, layerToneLayers, layerToneRgba, resolveLayerToneOptions, stripColors, stripSwaps, toLayerToneImage, toStripImage } from '../shared/layertone';
import { evaluateScript } from '../shared/runtime';

const FILAMENTS = [{ name: 'Black', color: '#000000', td: 0.6 }, { name: 'Yellow', color: '#f2c200', td: 2.5 }, { name: 'Blue', color: '#1a3fbf', td: 1 }, { name: 'White', color: '#ffffff', td: 1.6 }];
const O = { width: 100, maxHeight: 1.6, baseHeight: 0.48 };
const stack = { filaments: FILAMENTS, swaps: stripSwaps(FILAMENTS, O), maxHeight: 1.6, baseHeight: 0.48 };
const strip = stripColors(stack, O);
const pic = toStripImage('portrait', 4, 1, Uint8Array.from([strip[0], strip[90], strip[170], strip[255]].flatMap((c) => [...c, 255])), stack, O);

test('importing the picture edit module does not fix the data folder before a test sets PTP_DATA', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-lazy-data-'));
  const script = `await import('./server/pictureEdit/index.ts'); process.env.PTP_DATA = ${JSON.stringify(dir)}; const s = await import('./server/routes/store.ts'); console.log(s.DESIGNS);`;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.ok(out.trim().startsWith(dir), out);
});

test('a strip picture with no swaps in the setup prints with its own stack swaps, not automatic ones', () => {
  const layers = layerToneLayers(pic, { ...O, filaments: FILAMENTS }, { filaments: FILAMENTS, baseHeight: O.baseHeight });
  assert.deepEqual(layers.slice(1).map((l) => l.layer), stack.swaps);
  // With the 1.6 mm default first filament they move up with it (0.48 → 1.6 mm: 14 layers).
  const raised = layerToneLayers(pic, { ...O, filaments: FILAMENTS }, { filaments: FILAMENTS });
  assert.deepEqual(raised.slice(1).map((l) => l.layer), stack.swaps.map((s) => s + 14));
});

test('stale notes: an empty setup (panel Reset) is not reported as changed filaments', async () => {
  const { staleStripNotes } = await import('../server/modes/layerTone');
  assert.deepEqual(staleStripNotes({ portrait: pic }, {}, {}), []);
});

test('the model report warns when the part is built at another max height than its picture was drawn for', () => {
  const values = { [LAYERTONE_IMAGES_KEY]: JSON.stringify({ portrait: pic }), [LAYERTONE_KEY]: JSON.stringify({ filaments: FILAMENTS, swaps: stack.swaps }) };
  const at = (h: number) => evaluateScript(`function build() { return { name: 'Picture', ...H.layertone('portrait', { width: 40, maxHeight: ${h}, filaments: ${JSON.stringify(FILAMENTS)} }) }; }`, values, 'draft');
  const off = at(2.4).warnings.join('\n');
  assert.match(off, /"portrait" was drawn for max height 1\.6 mm/);
  assert.match(off, /maxHeight: 1\.6/);
  assert.doesNotMatch(at(1.6).warnings.join('\n'), /was drawn for/);
});

test('a strip picture shows in its strip colours; a plain one in grey', () => {
  const rgba = layerToneRgba(pic);
  assert.deepEqual([...rgba.slice(4, 7)], [...strip[90]]);
  const grey = layerToneRgba(toLayerToneImage('g', 1, 1, [100, 100, 100, 255]));
  assert.equal(grey[0], grey[1]);
  assert.equal(grey[1], grey[2]);
  assert.equal(grey[3], 255);
  void resolveLayerToneOptions;
});

test('edit_picture from the chat passes the design id, so a new colour picture is kept with this design', async () => {
  const { editPictureTools } = await import('../server/tools/editPicture');
  const seen: (string | undefined)[] = [];
  const fake = (async (_r: unknown, deps: { id?: string }) => { seen.push(deps.id); throw new Error('stop here'); }) as never;
  const base = { [LAYERTONE_IMAGES_KEY]: JSON.stringify({ portrait: pic }) };
  const ctx = { base, emit: () => undefined, state: { submitted: false, meshyCalls: 0, newConcepts: new Set<string>(), asked: false }, drawImage: (async () => { throw new Error('unused'); }) as never, readModel: async () => null, v: () => base };
  const tools = editPictureTools(ctx, { references: [], designId: 'design-current-1' }, fake, { mode: 'layertone', built: async () => null });
  const tool = tools.find((t) => t.name === 'edit_picture')!;
  await tool.handler({ picture: 'portrait', change: 'a darker sky', region: undefined, use_attached_photos: undefined }, {});
  assert.deepEqual(seen, ['design-current-1']);
});

test('the first-turn note asks about filaments; a follow-up never does', async () => {
  const { layerTone } = await import('../server/modes/layerTone');
  const ctx = (isFollowUp: boolean) => ({ req: {} as never, isFollowUp, pictureValues: {}, drawings: {}, refs: [], layerToneImages: {}, newPictures: [], meshes: {}, concepts: {}, attachedMeshes: [], references: [], images: true, lineArtStyle: 'outline' as const });
  assert.match(layerTone.turnNotes(ctx(false), {} as never).join('\n'), /ask_questions/);
  assert.doesNotMatch(layerTone.turnNotes(ctx(true), {} as never).join('\n'), /ask_questions/);
});
