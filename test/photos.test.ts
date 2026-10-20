import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoEditPrompt, photoProblem, photoPrompt, suggestScene, type PhotoRequest } from '../shared/photos';

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
  assert.match(p, /drinks coaster/, "a familiar size for the scale");
  assert.match(p, /true proportion/);
  assert.match(p, /exact colours of the render/);
  assert.match(p, /do not add, remove, move/);
  assert.match(p, /letter for letter/);
  assert.match(p, /layer lines/);
  assert.match(p, /warm oak wooden table/);
  assert.match(p, /No text, captions, logos, watermarks/);
  assert.doesNotMatch(p, /Also:/);
  assert.match(photoPrompt(request({ product: { name: 'x', size: [100, 100, 5], colors: ['#1f6f78', '#f2efe6'] } })), /filament colours #1f6f78, #f2efe6/);
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
  assert.equal(suggestScene('LayerTone portrait of a dog'), 'wall');
  assert.equal(suggestScene('Café coaster. Round drinks coaster'), 'table');
  assert.equal(suggestScene('Pen holder for the desk'), 'office');
  assert.equal(suggestScene('Ribbed bud vase'), 'shelf');
  assert.equal(suggestScene('Spice jar rack'), 'kitchen');
  assert.equal(suggestScene('Bird feeder'), 'garden');
  assert.equal(suggestScene('Name keychain'), 'hand');
  assert.equal(suggestScene('Widget', [30, 20, 10]), 'hand', 'small things in a hand');
  assert.equal(suggestScene('Widget', [150, 80, 60]), 'table');
  assert.equal(suggestScene('NFC fridge magnet'), 'fridge');
  assert.equal(suggestScene('Toothbrush holder'), 'bathroom');
  assert.equal(suggestScene('Pegboard wrench holder'), 'workshop');
  assert.equal(suggestScene('Controller stand'), 'gaming');
  assert.equal(suggestScene('Car vent phone mount'), 'wall', 'a mount still goes on the wall first');
  assert.equal(suggestScene('Restaurant table number'), 'restaurant');
  assert.equal(suggestScene('Snowflake Christmas Ornament'), 'xmas-tree');
  assert.equal(suggestScene('Bauble with a name'), 'xmas-tree');
  assert.equal(suggestScene('Santa sleigh line art'), 'xmas-wall');
  assert.equal(suggestScene('Gingerbread house figurine'), 'xmas-gifts');
  assert.equal(suggestScene('Ornament stand for a shelf'), 'shelf', 'not Christmas without a Christmas word');
});

test('photo requests are checked', () => {
  assert.equal(photoProblem(request()), null);
  assert.equal(photoProblem(request({ scene: 'custom', notes: 'on a boat' })), null);
  assert.match(photoProblem(request({ scene: 'custom' }))!, /custom scene/);
  assert.match(photoProblem(request({ scene: 'moon' }))!, /scene must be one of/);
  assert.match(photoProblem(request({ aspect: '2:1' as PhotoRequest['aspect'] }))!, /aspect/);
  assert.match(photoProblem(request({ render: { mediaType: 'image/webp', data: 'x' } }))!, /PNG or JPEG/);
  assert.match(photoProblem(request({ product: { name: 'x', size: [1, 2, Infinity] } }))!, /size/);
  assert.match(photoProblem(request({ product: { name: 'x', size: [1, 2, 3], colors: ['red'] } }))!, /colors/);
  assert.match(photoProblem(request({ product: { name: 'x'.repeat(300), size: [1, 2, 3] } }))!, /name/);
  assert.match(photoProblem(null as unknown as PhotoRequest)!, /render/);
});

test('a photo made again with a change: its photo is the scene, the product from its render or a new angle', () => {
  const from = { photo: '/api/designs/abcdefgh-1234/images/0123456789abcdef0123456789abcdef.png', render: '/api/designs/abcdefgh-1234/images/fedcba9876543210fedcba9876543210.png' };
  const { render: _r, ...noRender } = request();
  assert.equal(photoProblem({ ...noRender, from, change: 'add a plant behind it' }), null);
  assert.equal(photoProblem({ ...request(), from, change: 'seen from lower' }), null, 'a new angle may come with it');
  assert.match(photoProblem({ ...noRender, from, change: ' ' })!, /change/);
  assert.match(photoProblem({ ...noRender, from: { photo: 'https://example.com/x.png' }, change: 'x' })!, /from/);
  assert.match(photoProblem(noRender)!, /render/);
  const p = photoEditPrompt({ ...noRender, from, change: 'add a plant behind it', notes: 'evening light' });
  assert.match(p, /THE SCENE TO KEEP: the second attached picture is an earlier photo/);
  assert.match(p, /THE CHANGE \(the reason for the new photo – make it clearly\): add a plant behind it\./);
  assert.match(p, /Earlier wishes that still apply: evening light\./);
  assert.match(p, /KEEP THE OBJECT EXACTLY AS IN THE RENDER/);
  assert.match(photoPrompt(request()), /rests ON the surface, not above it/);
});

test('an ornament on the tree hangs face-on from a ribbon, the only thing added', () => {
  const p = photoPrompt(request({ scene: 'xmas-tree', product: { name: 'Snowflake ornament', size: [80, 80, 3], faceOn: true } }));
  assert.match(p, /Christmas tree/);
  assert.match(p, /render shows its front face; it hangs with this face to the viewer/);
  assert.match(p, /only the thin ribbon it hangs from/);
  assert.match(p, /hangs freely from the branch on a thin red ribbon/);
  assert.doesNotMatch(p, /rests ON the surface/);
  assert.doesNotMatch(p, /hangs flat on the wall/);
  const gifts = photoPrompt(request({ scene: 'xmas-gifts' }));
  assert.match(gifts, /under a Christmas tree/);
  assert.match(gifts, /rests ON the surface/);
  assert.doesNotMatch(gifts, /ribbon it hangs from/);
  assert.match(photoPrompt(request({ scene: 'xmas-wall', product: { name: 'Sign', size: [300, 200, 3], faceOn: true } })), /hangs flat against the wall/);
});
