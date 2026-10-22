import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designKind, kindImageMode } from '../shared/designKind';
import { LAYERTONE_IMAGES_KEY, toLayerToneImage } from '../shared/layertone';
import { MESHES_KEY, type MeshEntry } from '../shared/meshes';
import { DRAWINGS_KEY } from '../shared/svgFeatures';
import { cleanChatMode, withChatMode } from '../src/lib/chatModes';

const build = (body: string) => `const params = {}; function build(p) { return ${body}; }`;
const mesh = (source: MeshEntry['source']): MeshEntry => ({ file: '/api/designs/test-kind-0000001/meshes/0123456789abcdef0123456789abcdef.bin', triangles: 10, size: [10, 10, 10], source });
const drawing = { aspect: 1, shapes: [] };
const picture = { [LAYERTONE_IMAGES_KEY]: JSON.stringify({ photo: toLayerToneImage('photo', 2, 2, new Uint8Array(16).fill(200)) }) };

test('designKind: picture prints from their helper, in the server\'s order', () => {
  assert.equal(designKind(build('H.lineart("car.svg", { style: "outline" })'), {}), 'lineart');
  assert.equal(designKind(build('H.lithophane("photo", { width: 100 })'), picture), 'lithophane');
  assert.equal(designKind(build('H.layertone("photo", { width: 100 })'), {}), 'layertone');
  // LayerTone pictures kept with the design make it LayerTone (as on the server), but not a lithophane or line art.
  assert.equal(designKind(build('Manifold.cube([1, 1, 1])'), picture), 'layertone');
  assert.equal(designKind(build('H.lineart("car", {})'), picture), 'lineart');
});

test('designKind: a 3D figure needs a Meshy mesh, AI artwork a drawing that is not an attached .svg', () => {
  const meshy = { [MESHES_KEY]: JSON.stringify({ fox: mesh('meshy') }) };
  const upload = { [MESHES_KEY]: JSON.stringify({ pug: mesh('upload') }) };
  assert.equal(designKind(build('H.mesh("fox", { height: 60 })'), meshy), 'figure');
  assert.equal(designKind(build('H.mesh("pug", { height: 60 })'), upload), 'model');
  // A Meshy mesh the current code no longer uses (an earlier version restored).
  assert.equal(designKind(build('Manifold.cube([1, 1, 1])'), meshy), 'model');
  assert.equal(designKind(build('H.svg("fox", { height: 40 })'), { [DRAWINGS_KEY]: JSON.stringify({ fox: drawing }) }), 'artwork');
  assert.equal(designKind(build('H.svg("logo.svg", { height: 40 })'), { [DRAWINGS_KEY]: JSON.stringify({ 'logo.svg': drawing }) }), 'model');
  assert.equal(designKind('', {}), 'model');
  assert.equal(designKind(undefined, undefined), 'model');
});

test('a design without a remembered picture mode starts in its kind\'s', () => {
  assert.equal(kindImageMode('model'), 'off');
  for (const k of ['lineart', 'layertone', 'lithophane', 'figure', 'artwork'] as const) assert.equal(kindImageMode(k), k);
});

test('remembered picture modes are checked and capped', () => {
  assert.deepEqual(cleanChatMode({ imageMode: 'lineart', lineArtStyle: 'keyholder', figureColor: true, model: 'opus' }), { imageMode: 'lineart', lineArtStyle: 'keyholder', figureColor: true });
  assert.deepEqual(cleanChatMode({ imageMode: 'figure', lineArtStyle: 'nope' }), { imageMode: 'figure' });
  assert.equal(cleanChatMode({ imageMode: 'sculpture' }), null);
  assert.equal(cleanChatMode('lineart'), null);
  let all = {};
  for (let i = 0; i < 5; i++) all = withChatMode(all, `d${i}`, { imageMode: 'off' }, i, 3);
  assert.deepEqual(Object.keys(all).sort(), ['d2', 'd3', 'd4']);
  // Setting one again keeps it.
  all = withChatMode(all, 'd2', { imageMode: 'figure' }, 9, 3);
  all = withChatMode(all, 'd5', { imageMode: 'off' }, 10, 3);
  assert.deepEqual(Object.keys(all).sort(), ['d2', 'd4', 'd5']);
});
