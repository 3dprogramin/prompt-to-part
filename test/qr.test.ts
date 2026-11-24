import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { strFromU8, unzipSync } from 'fflate';
import { toBambuProject } from '../src/lib/bambu3mf';
import type { BambuTemplate } from '../shared/api';
import Module from 'manifold-3d';
import { evaluateScript } from '../shared/runtime';
import { PART_COLORS_KEY } from '../shared/params';
import { describeQr } from '../src/app/describe';
import { describeSettings } from '../src/lib/settings';
import { applyQrFeatures, newQrFeature, nextQrName, pickTarget, parseQrFeatures, qrMatrix, qrPayload, qrSections, QR_KEY } from '../shared/qrFeatures';
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

const CUBE = 'function build() { return Manifold.cube([40, 40, 10], true).translate([0, 0, 5]); }';

test('the build lists the tile and the modules after their part, in their own colours', () => {
  const values = { [QR_KEY]: JSON.stringify([newQrFeature('q', { text: 'https://example.com' })]) };
  const r = evaluateScript(CUBE, values, 'draft');
  assert.deepEqual(r.parts.map((p) => [p.name, p.color]), [['Model', r.parts[0].color], ['QR code tile', '#ffffff'], ['QR code', '#000000']]);
  assert.deepEqual(r.parts.slice(1).map((p) => p.qr), [{ id: 'q', role: 'tile', host: 'Model' }, { id: 'q', role: 'code', host: 'Model' }]);
  assert.equal(+r.bbox!.max[2].toFixed(3), 11.6);
  assert.ok(r.parts.every((p) => p.triCount > 0));
  // A filament picked for the modules wins, as for any part.
  const picked = evaluateScript(CUBE, { ...values, [PART_COLORS_KEY]: JSON.stringify({ 'QR code': { color: '#1e3a8a' } }) }, 'draft');
  assert.equal(picked.parts.find((p) => p.name === 'QR code')!.color, '#1e3a8a');
  // Lite builds (sizes only) list them too.
  assert.equal(evaluateScript(CUBE, values, 'draft', { lite: true }).parts.length, 3);
});

test('QR parts take their host plate, and names stay unique', () => {
  const two = 'function build() { return [{ name: "QR code", shape: Manifold.cube([40, 40, 10], true).translate([0, 0, 5]), plate: 2 }, { name: "B", shape: Manifold.cube(5) .translate([50, 0, 0]) }]; }';
  const values = { [QR_KEY]: JSON.stringify([newQrFeature('a', { text: 'one', part: 'QR code' }), newQrFeature('b', { text: 'two', part: 'QR code', offset: [0, 0] })]) };
  const r = evaluateScript(two, values, 'draft');
  const names = r.parts.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, ['QR code', 'QR code (QR) tile', 'QR code (QR)', 'QR code (QR 2) tile', 'QR code (QR 2)', 'B']);
  assert.ok(r.parts.filter((p) => p.qr).every((p) => p.plate === 2 && p.qr!.host === 'QR code'));
});

test('a new QR code gets the next free name', () => {
  assert.equal(nextQrName([]), 'QR code');
  assert.equal(nextQrName([newQrFeature('a'), newQrFeature('b', { name: 'QR code 3' })]), 'QR code 2');
});

test('Claude hears what each QR code holds and where it is, never the Wi-Fi password', () => {
  const wifi = newQrFeature('w', { name: 'Guest Wi-Fi', kind: 'wifi', wifi: { ssid: 'Home', password: 'secret123', security: 'WPA', hidden: false }, face: 'front', style: 'flush', tile: false, part: 'Sign' });
  const note = describeQr([newQrFeature('a', { text: 'https://example.com' }), wifi, newQrFeature('off', { text: 'x', enabled: false })])!;
  assert.match(note, /QR code "QR code" \(link "https:\/\/example\.com"\), 30 × 30 mm on a white 1 mm tile, modules raised 0\.6 mm, on the top of part "first part"/);
  assert.match(note, /QR code "Guest Wi-Fi" \(Wi-Fi network "Home"\), 30 × 30 mm, modules flush 0\.6 mm, on the front of part "Sign"/);
  assert.doesNotMatch(note, /secret123|"off"/);
  assert.equal(describeQr([]), undefined);
});

test('a click on a QR code places on the part under it', () => {
  const parts = [{ name: 'Model' }, { name: 'QR code tile', qr: { id: 'q', role: 'tile' as const, host: 'Model' } }];
  assert.equal(pickTarget(parts, 'QR code tile')?.name, 'Model');
  assert.equal(pickTarget(parts, 'Model')?.name, 'Model');
  assert.equal(pickTarget(parts, 'Nope'), undefined);
});

test('a saved version names a QR code change in words', () => {
  assert.equal(describeSettings({}, { [QR_KEY]: '[]' }, {}), 'Settings: QR code');
});

test('in the Bambu project the tile and the modules stay one object with their part', async () => {
  const r = evaluateScript(CUBE, { [QR_KEY]: JSON.stringify([newQrFeature('q', { text: 'https://example.com' })]) }, 'draft');
  const tpl: BambuTemplate = {
    version: '02.08.04.57',
    settings: { filament_colour: ['#00AE42'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0'], flush_volumes_vector: ['140', '140'], printable_area: ['0x0', '256x0', '256x256', '0x256'], wipe_tower_x: ['15'], wipe_tower_y: ['220'] },
    perFilament: ['filament_colour'], perFilamentPlus2: [],
  };
  const files = unzipSync(new Uint8Array(await toBambuProject(r.parts, 't', tpl, { print: null }).arrayBuffer()));
  const config = strFromU8(files['Metadata/model_settings.config']);
  const objects = [...config.matchAll(/<object id="\d+"><metadata key="name" value="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(objects, ['Model (+2)']);
  // Three filaments: the model's, white and black.
  const colours = JSON.parse(strFromU8(files['Metadata/project_settings.config'])).filament_colour.map((c: string) => c.toLowerCase());
  assert.ok(colours.includes('#ffffff') && colours.includes('#000000'), String(colours));
});
