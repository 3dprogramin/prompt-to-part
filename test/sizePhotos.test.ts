import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoPrompt, photoProblem, sizeVariantPrompt, type PhotoRequest } from '../shared/photos';

const from = { photo: '/api/designs/abcdefgh-1234/images/0123456789abcdef0123456789abcdef.png' };
const render = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };
// The L size of a wall plaque, made from the M size's photo on the wall beside a light switch.
const wallL = (extra: Partial<PhotoRequest> = {}): PhotoRequest => ({
  render, from, scene: 'wall', aspect: '1:1', shop: 'size', saleSize: { id: 'l', label: 'L' },
  resize: { base: { label: 'M', size: [150, 100, 6] } },
  product: { name: 'Home plaque', size: [225, 150, 6], faceOn: true },
  ...extra,
});

test('a size photo keeps the earlier photo\'s scene and camera, and changes only the product\'s size', () => {
  const p = sizeVariantPrompt(wallL());
  // Everything photoPrompt says about the product, at this size.
  assert.ok(p.startsWith(photoPrompt({ ...wallL(), notes: undefined })));
  assert.match(p, /THIS PHOTO SHOWS THE L SIZE OF THE PRODUCT: 225 mm wide, 150 mm tall and 6 mm thick\./);
  assert.match(p, /photo of the M size: 150 mm wide, 100 mm tall and 6 mm thick/);
  assert.match(p, /1\.5x as wide and as tall as in the earlier photo \(just as thick as before\)/);
  // The ratio to the light switch beside it, before and now.
  assert.match(p, /In the earlier photo the product was 1\.76x as wide as the light switch \(about 85 mm wide\); now it is 2\.65x as wide as it\. The light switch stays exactly the same size/);
  assert.match(p, /same camera position, angle, lens and framing/);
  assert.match(p, /Nothing in the scene moves, grows, shrinks, appears or disappears/);
  assert.match(p, /grows around it/);
  assert.match(p, /takes up more of the picture/);
  assert.match(p, /first attached picture, its render at this size/);
  assert.doesNotMatch(p, /THE CHANGE/);
  assert.doesNotMatch(p.slice(photoPrompt({ ...wallL(), notes: undefined }).length), /[–—]/, 'plain hyphens only');
});

test('smaller sizes, other scenes and references', () => {
  const small = sizeVariantPrompt(wallL({ saleSize: { id: 's', label: 'S' }, product: { name: 'Home plaque', size: [100, 66.7, 6], faceOn: true } }));
  assert.match(small, /0\.67x as wide and as tall/);
  assert.match(small, /shrinks around it/);
  assert.match(small, /takes up less of the picture/);
  // A lifestyle photo on a wall: the switch only if the earlier photo has one (nothing is added).
  const life = sizeVariantPrompt(wallL({ shop: 'lifestyle' }));
  assert.match(life, /If the earlier photo shows a light switch: in the earlier photo/);
  // In a hand: the hand's length; on a table by a mug: the mug's height.
  const hand = sizeVariantPrompt(wallL({ scene: 'hand', shop: 'size', resize: { base: { size: [40, 30, 20] } }, saleSize: undefined, product: { name: 'Charm', size: [60, 45, 30] } }));
  assert.match(hand, /THIS PHOTO SHOWS ANOTHER SIZE OF THE PRODUCT: 60 × 45 mm footprint and 30 mm high/);
  assert.match(hand, /photo of it in another size/);
  assert.match(hand, /1\.5x as wide and as deep and as high/);
  assert.match(hand, /0\.21x as long as the hand \(about 190 mm long\); now it is 0\.32x/);
  const mug = sizeVariantPrompt(wallL({ scene: 'table', shop: 'size', resize: { base: { label: 'M', size: [120, 120, 200] } }, product: { name: 'Vase', size: [96, 96, 160] } }));
  assert.match(mug, /2\.11x as tall as the coffee mug \(about 95 mm tall\); now it is 1\.68x/);
  // A table scene without a known reference: just the ratio to the earlier photo.
  const table = sizeVariantPrompt(wallL({ scene: 'table', shop: 'lifestyle', product: { name: 'Plaque', size: [225, 150, 6] } }));
  assert.doesNotMatch(table, /as wide as the light switch/);
  assert.match(table, /So the product is 1\.5x as wide and as deep as in the earlier photo \(just as high as before\)/);
  // Earlier wishes and an extra change go along.
  assert.match(sizeVariantPrompt(wallL({ notes: 'evening light', change: 'a bit warmer' })), /Also: a bit warmer\.\nEarlier wishes that still apply: evening light\./);
});

test('size photo requests are checked: the earlier photo, a render at this size, the sizes', () => {
  assert.equal(photoProblem(wallL()), null);
  assert.equal(photoProblem(wallL({ render: undefined, from: { ...from, render: from.photo } })), null, 'its stored render (made again)');
  assert.match(photoProblem(wallL({ from: undefined }))!, /resize: needs `from`/);
  assert.match(photoProblem(wallL({ render: undefined }))!, /needs the render/);
  assert.match(photoProblem(wallL({ resize: { base: { size: [1, 2, 0] } } }))!, /resize\.base/);
  assert.match(photoProblem(wallL({ saleSize: { id: 'x', label: 'y'.repeat(40) } }))!, /saleSize/);
  assert.match(photoProblem(wallL({ change: '  ' }))!, /change:/);
  // A plain change of a photo still needs to say what to change.
  assert.match(photoProblem(wallL({ resize: undefined }))!, /change:/);
});
