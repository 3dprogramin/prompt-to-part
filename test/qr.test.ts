import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import Module from 'manifold-3d';
import { applyQrFeatures, newQrFeature, parseQrFeatures, qrMatrix, qrPayload, qrSections } from '../shared/qrFeatures';
import type { Vec2 } from '../shared/types';

/** Reads the modules as a phone would from above: black polygons on white, `px` pixels per mm. */
function decode(polys: Vec2[][], side: number, px = 12): string | null {
  const n = Math.ceil(side * px) + 2 * 4 * px;
  const rgba = new Uint8ClampedArray(n * n * 4).fill(255);
  // Scanlines: where each row crosses the outlines, filled by the non-zero rule.
  for (let j = 0; j < n; j++) {
    const y = (n / 2 - j - 0.5) / px;
    const xs: [number, number][] = [];
    for (const c of polys) for (let i = 0; i < c.length; i++) {
      const [x1, y1] = c[i], [x2, y2] = c[(i + 1) % c.length];
      if ((y1 <= y) !== (y2 <= y)) xs.push([x1 + ((y - y1) / (y2 - y1)) * (x2 - x1), y2 > y1 ? 1 : -1]);
    }
    xs.sort((p, q) => p[0] - q[0]);
    let w = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      w += xs[k][1];
      if (!w) continue;
      const i0 = Math.max(0, Math.ceil(xs[k][0] * px + n / 2 - 0.5)), i1 = Math.min(n - 1, Math.floor(xs[k + 1][0] * px + n / 2 - 0.5));
      for (let i = i0; i <= i1; i++) rgba.fill(0, (j * n + i) * 4, (j * n + i) * 4 + 3);
    }
  }
  return jsQR(rgba, n, n)?.data ?? null;
}

const wasm = await Module();
wasm.setup();
const rt = () => wasm;

test('Wi-Fi content is the standard WIFI: string, special characters escaped', () => {
  const f = newQrFeature('q', { kind: 'wifi', wifi: { ssid: 'My;Net', password: 'a:b', security: 'WPA', hidden: false } });
  assert.equal(qrPayload(f), 'WIFI:T:WPA;S:My\\;Net;P:a\\:b;;');
  assert.equal(qrPayload({ ...f, wifi: { ssid: 'Open "café"', password: 'x', security: 'nopass', hidden: true } }), 'WIFI:T:nopass;S:Open \\"café\\";H:true;;');
  assert.equal(qrPayload({ ...f, wifi: { ...f.wifi, ssid: ' ' } }), '');
  assert.equal(qrPayload(newQrFeature('t', { text: '  https://example.com  ' })), 'https://example.com');
});

test('the modules read back as the content', () => {
  const f = newQrFeature('q', { text: 'https://example.com', size: 30 });
  const m = qrMatrix(qrPayload(f), f.ecc)!;
  const { code, tile, module } = qrSections(m, f, rt().CrossSection);
  assert.equal(+module.toFixed(4), +(30 / (m.length + 4)).toFixed(4));
  const tb = tile.bounds();
  assert.deepEqual([...tb.min, ...tb.max].map((v) => +v.toFixed(3)), [-15, -15, 15, 15]);
  assert.equal(decode(code.toPolygons() as Vec2[][], 30), 'https://example.com');
  // Not mirrored: module (row r, column c) is black where the matrix says, row 0 at the top (+y).
  const sec = code.toPolygons() as Vec2[][];
  const inside = (x: number, y: number) => sec.reduce((w, c) => w + c.reduce((k, [x1, y1], i) => {
    const [x2, y2] = c[(i + 1) % c.length];
    return (y1 <= y) !== (y2 <= y) && x < x1 + ((y - y1) / (y2 - y1)) * (x2 - x1) ? k + (y2 > y1 ? 1 : -1) : k;
  }, 0), 0) !== 0;
  const n = m.length;
  const wrong = m.flatMap((row, r) => row.map((black, c) => inside((c + 0.5 - n / 2) * module, (n / 2 - r - 0.5) * module) !== black)).filter(Boolean).length;
  assert.equal(wrong, 0);
  // Letters beyond ASCII travel as UTF-8.
  const u = newQrFeature('u', { text: 'Cafe Ștefan č', size: 30 });
  assert.equal(decode(qrSections(qrMatrix(qrPayload(u), u.ecc)!, u, rt().CrossSection).code.toPolygons() as Vec2[][], 30), 'Cafe Ștefan č');
});

test('raised on its tile: tile and modules are their own solids, touching, the host unchanged', () => {
  const { Manifold, CrossSection } = rt();
  const host = Manifold.cube([40, 40, 10], true).translate([0, 0, 5]);
  const f = newQrFeature('q', { text: 'hello', size: 30 });
  const r = applyQrFeatures(host, [f], CrossSection);
  assert.equal(r.host.volume(), host.volume());
  const [tile, code] = ['tile', 'code'].map((role) => r.parts.find((p) => p.role === role)!);
  assert.equal(tile.name, 'QR code tile');
  assert.equal(code.name, 'QR code');
  assert.equal(tile.color, '#ffffff');
  assert.equal(code.color, '#000000');
  const tb = tile.shape.boundingBox(), cb = code.shape.boundingBox();
  assert.deepEqual([tb.min[2], tb.max[2]].map((v) => +v.toFixed(3)), [10, 11]);
  assert.deepEqual([cb.min[2], cb.max[2]].map((v) => +v.toFixed(3)), [11, 11.6]);
  assert.equal(tile.shape.status(), 'NoError');
  assert.equal(code.shape.status(), 'NoError');
  assert.ok(Math.abs(tile.shape.volume() - 30 * 30 * 1) < 0.5, String(tile.shape.volume()));
});

test('flush without a tile: the modules fill pockets in the host, level with its top', () => {
  const { Manifold, CrossSection } = rt();
  const host = Manifold.cube([40, 40, 10], true).translate([0, 0, 5]);
  const f = newQrFeature('q', { text: 'hello', size: 30, tile: false, style: 'flush', depth: 0.6 });
  const r = applyQrFeatures(host, [f], CrossSection);
  assert.equal(r.parts.length, 1);
  const code = r.parts[0].shape;
  const cb = code.boundingBox();
  assert.deepEqual([cb.min[2], cb.max[2]].map((v) => +v.toFixed(3)), [9.4, 10]);
  assert.ok(Math.abs(host.volume() - r.host.volume() - code.volume()) < 0.01);
  assert.ok(r.host.add(code).volume() - host.volume() < 0.01);
});

test('flush on its tile: the tile has the pockets, the host keeps its top', () => {
  const { Manifold, CrossSection } = rt();
  const host = Manifold.cube([40, 40, 10], true).translate([0, 0, 5]);
  const f = newQrFeature('q', { text: 'hello', size: 30, style: 'flush', depth: 0.6, tileHeight: 1.2 });
  const r = applyQrFeatures(host, [f], CrossSection);
  assert.equal(r.host.volume(), host.volume());
  const tile = r.parts.find((p) => p.role === 'tile')!.shape, code = r.parts.find((p) => p.role === 'code')!.shape;
  assert.ok(Math.abs(tile.volume() + code.volume() - 30 * 30 * 1.2) < 0.5);
  assert.equal(+code.boundingBox().max[2].toFixed(3), 11.2);
});

test('too much content for a QR code: no parts, one warning', () => {
  const { Manifold, CrossSection } = rt();
  const host = Manifold.cube([40, 40, 10], true);
  const f = newQrFeature('q', { text: 'x'.repeat(3000), ecc: 'H' });
  assert.equal(qrMatrix(qrPayload(f), 'H'), null);
  const r = applyQrFeatures(host, [f], CrossSection);
  assert.equal(r.parts.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /too long/);
});

test('empty content or a hidden code adds nothing and says nothing', () => {
  const { Manifold, CrossSection } = rt();
  const host = Manifold.cube([40, 40, 10], true);
  const r = applyQrFeatures(host, [newQrFeature('a', { text: '  ' }), newQrFeature('b', { text: 'x', enabled: false })], CrossSection);
  assert.deepEqual([r.parts.length, r.warnings.length], [0, 0]);
});

test('saved QR codes are checked', () => {
  const ok = parseQrFeatures(JSON.stringify([newQrFeature('a', { text: 'x' }), { id: 'b', text: 5 }, null, { id: 'c', ecc: 'Z', size: -3, border: 99 }]));
  assert.deepEqual(ok.map((f) => f.id), ['a', 'c']);
  assert.deepEqual([ok[1].ecc, ok[1].size > 0, ok[1].border <= 4], ['M', true, true]);
  assert.deepEqual(parseQrFeatures('nonsense'), []);
});
