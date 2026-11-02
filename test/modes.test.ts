import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateRequest } from '../shared/api';
import { LAYERTONE_IMAGES_KEY } from '../shared/layertone';
import { MESHES_KEY } from '../shared/meshes';
import { detectModes } from '../server/modes/detect';

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({ designId: 'design-0001', prompt: 'x', ...over });
const env = { images: true, meshy: false };
const none = { artwork: false, layerTone: false, lithophane: false, lineArt: false, figure: false, figureColor: false, meshTools: false, conceptTools: false };

test('line art stays line art when the menu is off', () => {
  const m = detectModes(req({ code: 'return H.lineart(src, {});', imageMode: 'off' }), {}, env);
  assert.deepEqual(m, { ...none, lineArt: true });
});

test('layertone menu wins over lithophane code', () => {
  const m = detectModes(req({ code: 'return H.lithophane(img, {});', imageMode: 'layertone' }), {}, env);
  assert.equal(m.layerTone, true);
  assert.equal(m.lithophane, false);
});

test('layertone pictures make a layertone design', () => {
  const img = { name: 'a', width: 3, height: 1, luma: 'AAAA' };
  const m = detectModes(req(), { [LAYERTONE_IMAGES_KEY]: JSON.stringify({ a: img }) }, env);
  assert.equal(m.layerTone, true);
});

test('artwork needs the image model', () => {
  assert.equal(detectModes(req({ imageMode: 'artwork' }), {}, { images: false, meshy: false }).artwork, false);
  assert.equal(detectModes(req({ imageMode: 'artwork' }), {}, env).artwork, true);
});

test('legacy artwork flag', () => {
  assert.equal(detectModes(req({ artwork: true }), {}, env).artwork, true);
});

test('meshes keep generate_3d in a follow-up', () => {
  const mesh = { file: '/api/designs/design-0001/meshes/' + 'a'.repeat(32) + '.bin', triangles: 10, size: [1, 1, 1], source: 'upload' };
  const m = detectModes(req(), { [MESHES_KEY]: JSON.stringify({ cube: mesh }) }, { images: true, meshy: true });
  assert.equal(m.meshTools, true);
  assert.equal(m.figure, false);
});

test('no concept pictures without the image model', () => {
  const m = detectModes(req({ imageMode: 'figure' }), {}, { images: false, meshy: true });
  assert.equal(m.meshTools, true);
  assert.equal(m.conceptTools, false);
});
