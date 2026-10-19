// The lithophane preview widget's pure logic (litho/src): configuration, size → lithophane options,
// framing, the order's settings and photo tips. The DOM parts are checked by hand / screenshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, findVariant, formatPrice, parseConfig, parseVariants, sizeGeometry, sizeLabel, sizePrice, type SizePreset } from '../litho/src/config';
import { CENTRED, clampCrop, cropFromRect, cropRect, normaliseRect, panCrop, zoomCrop } from '../litho/src/crop';
import { pickLang, t } from '../litho/src/i18n';
import { decodeOrder, encodeOrder, type OrderSettings } from '../litho/src/order';
import { photoStats, photoTips } from '../litho/src/tips';
import { unlitLithophane } from '../litho/src/lit';
import { resolveLithoOptions, simulateLithophane } from '../shared/lithophane';
import { toLayerToneImage } from '../shared/layertone';
import { binaryStl } from '../shared/stl';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test('parseConfig: defaults, checked sizes, JSON text, bad input', () => {
  assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig('not json'), DEFAULT_CONFIG);
  const c = parseConfig(JSON.stringify({
    currency: 'RON', maxThickness: '3.2', border: 99,
    sizes: [
      { id: 'a', shape: 'flat', width: 150, height: 100, price: '79', variant: '4242' },
      { shape: 'cylinder', width: 100, height: 150, options: ['Lampă', '10x15', 7] },
      { shape: 'flat', width: 'wide', height: 100 }, // unusable: dropped
      { shape: 'blob', width: 9999, height: 5 }, // unknown shape → flat; sizes clamped to the printer
    ],
  }));
  assert.equal(c.currency, 'RON');
  assert.equal(c.maxThickness, 3.2);
  assert.equal(c.border, 15);
  assert.equal(c.sizes.length, 3);
  assert.deepEqual(c.sizes[0], { id: 'a', shape: 'flat', width: 150, height: 100, price: 79, variant: '4242' });
  assert.deepEqual(c.sizes[1].options, ['Lampă', '10x15']);
  assert.equal(c.sizes[1].id, 'cylinder-2');
  assert.deepEqual([c.sizes[2].shape, c.sizes[2].width, c.sizes[2].height], ['flat', 250, 20]);
  // A config without usable sizes keeps the default ones.
  assert.deepEqual(parseConfig({ sizes: [{}] }).sizes, DEFAULT_CONFIG.sizes);
});

test('sizeGeometry: outer size minus the frame is the picture; portrait turns it; a lamp wraps', () => {
  const c = DEFAULT_CONFIG;
  const flat: SizePreset = { id: 'f', shape: 'flat', width: 150, height: 100 };
  const land = sizeGeometry(flat, 'landscape', c);
  assert.deepEqual(land.outer, [150, 100]);
  assert.deepEqual(land.picture, [144, 94]);
  assert.equal(land.options.width, 144);
  assert.equal(land.options.shape, 'flat');
  const port = sizeGeometry(flat, 'portrait', c, 0.8);
  assert.deepEqual(port.outer, [100, 150]);
  assert.deepEqual(port.picture, [94, 144]);
  assert.equal(port.options.gamma, 0.8);
  // Jig's mesh makes the picture's height from the image's proportions: the crop's aspect is picture[0] / picture[1].
  const r = resolveLithoOptions(land.options);
  assert.equal(r.width + 2 * r.border, 150);
  const lamp = sizeGeometry({ id: 'l', shape: 'cylinder', width: 100, height: 150 }, 'portrait', c);
  assert.ok(near(lamp.options.width, Math.PI * (100 - 2 * c.maxThickness)));
  assert.deepEqual(lamp.outer, [100, 150]);
  assert.equal(lamp.picture[1], 144);
  const curved = sizeGeometry({ id: 'c', shape: 'curved', width: 180, height: 130, angle: 90 }, 'landscape', c);
  assert.equal(curved.options.angle, 90);
  assert.equal(sizeGeometry({ ...flat, stand: 25 }, 'landscape', c).options.stand, 25);
});

test('sizeLabel and formatPrice in both languages', () => {
  assert.equal(sizeLabel({ id: 'f', shape: 'flat', width: 150, height: 100 }, 'ro'), '10 × 15 cm');
  assert.equal(sizeLabel({ id: 'l', shape: 'cylinder', width: 85, height: 150 }, 'ro'), 'Ø 8,5 × 15 cm');
  assert.equal(sizeLabel({ id: 'l', shape: 'cylinder', width: 85, height: 150 }, 'en'), 'Ø 8.5 × 15 cm');
  assert.equal(sizeLabel({ id: 'x', shape: 'flat', width: 150, height: 100, label: 'A6' }, 'en'), 'A6');
  assert.equal(formatPrice(79, 'ro', 'lei'), '79 lei');
  assert.equal(formatPrice(129.5, 'ro', 'lei'), '129,50 lei');
  assert.equal(formatPrice(1299, 'en', 'RON'), '1,299 RON');
});

test('Shopify variants: by id, by option values (loosely), price in cents wins', () => {
  const variants = parseVariants(JSON.stringify([
    { id: 11, options: ['Panou drept', '10×15 cm'], price: 7900 },
    { id: 12, options: ['Panou drept', '13×18 cm'], price: 9900 },
    { id: 21, options: ['Lampă', 'Ø10 × 15 cm'], price: 14950 },
  ]));
  assert.equal(parseVariants('[{"title":"no id"}]').length, 0);
  const byOptions: SizePreset = { id: 'a', shape: 'flat', width: 150, height: 100, price: 1, options: ['panou drept', '10 x 15 cm'] };
  assert.equal(findVariant(byOptions, variants)?.id, 11);
  assert.equal(sizePrice(byOptions, variants), 79);
  const lamp: SizePreset = { id: 'l', shape: 'cylinder', width: 100, height: 150, options: ['Lampa', 'Ø 10x15 cm'] };
  assert.equal(sizePrice(lamp, variants), 149.5);
  const byId: SizePreset = { id: 'b', shape: 'flat', width: 180, height: 130, variant: '12', price: 5 };
  assert.equal(sizePrice(byId, variants), 99);
  // An id the page has no variant data for is still selected; its price comes from the preset.
  const unknown: SizePreset = { ...byId, variant: 99 };
  assert.equal(findVariant(unknown, variants)?.id, 99);
  assert.equal(sizePrice(unknown, variants), 5);
  assert.equal(findVariant({ id: 'n', shape: 'flat', width: 1, height: 1 }, variants), undefined);
});

test('crop: covers the frame, stays inside the photo, pans and zooms around a point', () => {
  // A 4000 × 3000 photo in a square frame: the largest square is 3000², centred.
  assert.deepEqual(cropRect(4000, 3000, 1, CENTRED), { x: 500, y: 0, w: 3000, h: 3000 });
  // A wide frame on a tall photo: the full width.
  assert.deepEqual(cropRect(1000, 2000, 2, CENTRED), { x: 0, y: 750, w: 1000, h: 500 });
  // Off the edge: clamped back inside.
  const c = clampCrop(4000, 3000, 1, { zoom: 2, cx: 0, cy: 1 });
  assert.deepEqual(cropRect(4000, 3000, 1, c), { x: 0, y: 1500, w: 1500, h: 1500 });
  // Dragging right by a fifth of the frame moves the crop left by a fifth of its width.
  const z2 = { zoom: 2, cx: 0.5, cy: 0.5 };
  const panned = panCrop(4000, 3000, 1, z2, 20, 0, 100);
  assert.ok(near(cropRect(4000, 3000, 1, panned).x, cropRect(4000, 3000, 1, z2).x - 300));
  // Zooming around the top-left corner keeps that corner of the crop in place.
  const before = cropRect(4000, 3000, 1, CENTRED);
  const after = cropRect(4000, 3000, 1, zoomCrop(4000, 3000, 1, CENTRED, 2, 0, 0));
  assert.deepEqual([after.x, after.y, after.w], [before.x, before.y, 1500]);
  // Zoom stays between 1 and the maximum.
  assert.equal(zoomCrop(4000, 3000, 1, CENTRED, 0.1).zoom, 1);
  assert.equal(zoomCrop(4000, 3000, 1, CENTRED, 100).zoom, 5);
  // Saved as fractions and back: the same rectangle.
  const n = normaliseRect(cropRect(4000, 3000, 1.5, { zoom: 1.7, cx: 0.4, cy: 0.6 }), 4000, 3000);
  const back = cropRect(4000, 3000, 1.5, cropFromRect(n, 4000, 3000, 1.5));
  assert.ok(near(back.x / 4000, n.x, 1e-4) && near(back.y / 3000, n.y, 1e-4) && near(back.w / 4000, n.w, 1e-4));
});

test('order settings: encode → decode round trip, pasted with a label, bad ones refused', () => {
  const geo = sizeGeometry({ id: 'flat-10x15', shape: 'flat', width: 150, height: 100 }, 'portrait', DEFAULT_CONFIG, 0.9);
  const order: OrderSettings = {
    v: 1, size: 'flat-10x15', label: '10 × 15 cm', shape: 'flat', orient: 'portrait', mm: geo.outer,
    crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, litho: geo.options,
  };
  const text = encodeOrder(order);
  assert.ok(text.length < 400, 'short enough for a line item property');
  const back = decodeOrder(`_litho: ${text}`)!;
  assert.deepEqual([back.size, back.shape, back.orient, back.mm, back.crop], [order.size, 'flat', 'portrait', [100, 150], order.crop]);
  assert.deepEqual([back.litho.width, back.litho.gamma, back.litho.border, back.litho.maxThickness], [94, 0.9, 3, 3]);
  assert.equal(decodeOrder('{"v":2}'), null);
  assert.equal(decodeOrder(JSON.stringify({ ...order, crop: { x: 0.8, y: 0, w: 0.5, h: 1 } })), null);
  assert.equal(decodeOrder(JSON.stringify({ ...order, litho: { width: -1 } })), null);
  assert.equal(decodeOrder('nonsense'), null);
});

test('photo tips: dark, washed out, too small, and a good photo', () => {
  const grad = Uint8Array.from({ length: 256 * 4 }, (_, i) => i % 256);
  const s = photoStats(grad);
  assert.ok(near(s.mean, 127.5) && s.p5 <= 13 && s.p95 >= 242);
  assert.deepEqual(photoTips(s, 1200, 150), []);
  // Dark but with its contrast: only the dark tip.
  assert.deepEqual(photoTips(photoStats(grad.map((v) => v ** 3 / 255 ** 2)), 1200, 150), ['tipDark']);
  assert.deepEqual(photoTips(photoStats(grad.map((v) => 100 + v / 8)), 1200, 150), ['tipDark', 'tipFlat']);
  assert.deepEqual(photoTips(photoStats(grad.map((v) => 200 + v / 6)), 1200, 150), ['tipBright', 'tipFlat']);
  assert.deepEqual(photoTips(s, 300, 150), ['tipSmall']);
});

test('unlit preview: same size as the lit one, light PLA, relief shading', () => {
  const rgba = new Uint8Array(60 * 40 * 4).map((_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4) % 60 < 30 ? 20 : 235));
  const image = toLayerToneImage('t', 60, 40, rgba);
  const o = { width: 60, border: 3 };
  const lit = simulateLithophane(image, o), unlit = unlitLithophane(image, o);
  assert.deepEqual([unlit.width, unlit.height], [lit.width, lit.height]);
  const px = (x: number, y: number) => unlit.rgba[(y * unlit.width + x) * 4];
  // Flat areas are plain PLA; the step from thick (dark) to thin (bright) picks up shading.
  assert.ok(px(10, 20) > 200 && px(50, 20) > 200);
  assert.notEqual(px(33, 20), px(10, 20));
});

test('i18n: Romanian by default, English on request, placeholders', () => {
  assert.equal(pickLang(null), 'ro');
  assert.equal(pickLang('en-GB'), 'en');
  assert.equal(pickLang('de'), 'ro');
  assert.equal(t('ro', 'shape_cylinder'), 'Lampă');
  assert.equal(t('en', 'diameter', { d: 10, h: 15 }), 'Ø 10 × 15 cm');
});

test('binaryStl: header, count and one facet', () => {
  const buf = new DataView(binaryStl([{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }], 'litho'));
  assert.equal(buf.byteLength, 84 + 50);
  assert.equal(String.fromCharCode(...new Uint8Array(buf.buffer, 0, 5)), 'litho');
  assert.equal(buf.getUint32(80, true), 1);
  assert.equal(buf.getFloat32(84 + 8, true), 1); // normal +Z
});
