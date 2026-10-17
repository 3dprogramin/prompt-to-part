import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoProblem, photoPrompt, suggestScene, type PhotoRequest } from '../shared/photos';

const request = (extra: Partial<PhotoRequest> = {}): PhotoRequest => ({
  render: { mediaType: 'image/png', data: 'iVBORw0KGgo=' },
  scene: 'table',
  aspect: '1:1',
  product: { name: 'Café coaster', description: 'Round coaster with raised lettering', size: [100, 100, 5.2] },
  ...extra,
});

test('the photo prompt keeps the object, its size and colours, and sets the scene', () => {
  const p = photoPrompt(request());
  assert.match(p, /Café coaster – Round coaster with raised lettering/);
  assert.match(p, /100 × 100 mm footprint and 5\.2 mm high/);
  assert.match(p, /drinks coaster/, 'a familiar size for the scale');
  assert.match(p, /exact colours of the render/);
  assert.match(p, /do not add, remove, move/);
  assert.match(p, /letter for letter/);
  assert.match(p, /layer lines/);
  assert.match(p, /warm oak wooden table/);
  assert.match(p, /No text, captions, logos, watermarks/);
  assert.doesNotMatch(p, /Also:/);
  assert.doesNotMatch(p, /\n\n\n/);
});

test('wall scenes hang a flat print face-on; custom scenes and extra wishes go in as written', () => {
  const wall = photoPrompt(request({ scene: 'wall', product: { name: 'Plaque', size: [180, 108, 6.5], faceOn: true } }));
  assert.match(wall, /180 mm wide, 108 mm tall and 6\.5 mm thick/);
  assert.match(wall, /hangs flat on the wall/);
  assert.match(wall, /render shows its front face/);
  assert.match(wall, /paperback book/);
  const custom = photoPrompt(request({ scene: 'custom', notes: 'on a bedside table at night' }));
  assert.match(custom, /SCENE: on a bedside table at night\./);
  const extra = photoPrompt(request({ scene: 'studio', notes: 'a soft blue backdrop' }));
  assert.match(extra, /white studio sweep/);
  assert.match(extra, /Also: a soft blue backdrop\./);
});

test('the suggested scene follows what the design is', () => {
  assert.equal(suggestScene('Home sweet home wall plaque'), 'wall');
  assert.equal(suggestScene('HueForge portrait of a dog'), 'wall');
  assert.equal(suggestScene('Café coaster. Round drinks coaster'), 'table');
  assert.equal(suggestScene('Pen holder for the desk'), 'office');
  assert.equal(suggestScene('Ribbed bud vase'), 'shelf');
  assert.equal(suggestScene('Spice jar rack'), 'kitchen');
  assert.equal(suggestScene('Bird feeder'), 'garden');
  assert.equal(suggestScene('Name keychain'), 'hand');
  assert.equal(suggestScene('Widget', [30, 20, 10]), 'hand', 'small things in a hand');
  assert.equal(suggestScene('Widget', [150, 80, 60]), 'table');
});

test('photo requests are checked', () => {
  assert.equal(photoProblem(request()), null);
  assert.equal(photoProblem(request({ scene: 'custom', notes: 'on a boat' })), null);
  assert.match(photoProblem(request({ scene: 'custom' }))!, /custom scene/);
  assert.match(photoProblem(request({ scene: 'moon' }))!, /scene must be one of/);
  assert.match(photoProblem(request({ aspect: '2:1' as PhotoRequest['aspect'] }))!, /aspect/);
  assert.match(photoProblem(request({ render: { mediaType: 'image/webp', data: 'x' } }))!, /PNG or JPEG/);
  assert.match(photoProblem(request({ product: { name: 'x', size: [1, 2, Infinity] } }))!, /size/);
  assert.match(photoProblem(request({ product: { name: 'x'.repeat(300), size: [1, 2, 3] } }))!, /name/);
  assert.match(photoProblem(null as unknown as PhotoRequest)!, /render/);
});
