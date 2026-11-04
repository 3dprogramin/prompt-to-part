import './wasm';
import { DEFAULT_PRINTER, setPrinter } from '../shared/printer';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateScript, importMeshFile } from '../shared/runtime';
import { parseMeshFile } from '../shared/meshFormats';
import { decodeTexture } from '../shared/imageDecode';
import { applyRepaint, cleanPalette, cleanSlots, clusterColors, colorDistance, colorSlots, decodeTris, encodeTris, matchFilaments, MAX_REPAINTS, meshColorBudget, meshPalette, meshSlots, rgbHex, slotPatch, triangleAreas, triangleNeighbours } from '../shared/meshColors';
import { transferColors as transferColorsForTest } from '../shared/meshRepair';
import { decodeMesh, encodeMesh, MESHES_KEY, parseMeshes, registerMesh } from '../shared/meshes';
import { modelWarnings } from '../shared/modelWarnings';
import { BANDS } from './fixtures/meshes/make-colour-figure';

const glb = new Uint8Array(readFileSync(path.join(import.meta.dirname, 'fixtures', 'meshes', 'colour-figure.glb')));
const hex = (c: number[]) => rgbHex(c);
const [HAIR, SKIN, SHIRT, TROUSERS] = BANDS.map((b) => hex(b.color));

test('a GLB\'s base colour texture gives each triangle the colour under its UVs', () => {
  const raw = parseMeshFile(glb, 'figure.glb', { colors: { decode: decodeTexture } });
  assert.equal(raw.colors?.length, raw.indices.length);
  // Each triangle's colour is its band's (by height: Y up, 2 units tall); the bands' edges may blend.
  let right = 0;
  for (let t = 0; t < raw.indices.length / 3; t++) {
    const y = [0, 1, 2].reduce((s, k) => s + raw.positions[raw.indices[3 * t + k] * 3 + 1], 0) / 3;
    const want = BANDS.find((b) => y >= b.from)!.color;
    if (colorDistance(hex([...raw.colors!.subarray(3 * t, 3 * t + 3)]), hex(want)) < 0.05) right++;
  }
  assert.ok(right / (raw.indices.length / 3) > 0.9, `${right}`);
  // Without colours asked for, none are read.
  assert.equal(parseMeshFile(glb, 'figure.glb').colors, undefined);
});

test('colours survive the repair: welded, and rebuilt on a grid', () => {
  for (const rebuild of [false, true]) {
    const { mesh, report } = importMeshFile(glb, 'figure.glb', { colors: true, rebuild }, decodeTexture);
    assert.ok(report.colored);
    assert.equal(mesh.colors?.length, mesh.indices.length);
    // Z up now, standing on z = 0, 80 mm tall: each triangle has its band's colour.
    let right = 0;
    for (let t = 0; t < mesh.indices.length / 3; t++) {
      const z = [0, 1, 2].reduce((s, k) => s + mesh.positions[mesh.indices[3 * t + k] * 3 + 2], 0) / 3;
      const want = BANDS.find((b) => z / 40 >= b.from)!.color;
      if (colorDistance(hex([...mesh.colors!.subarray(3 * t, 3 * t + 3)]), hex(want)) < 0.05) right++;
    }
    assert.ok(right / (mesh.indices.length / 3) > 0.85, `rebuild ${rebuild}: ${right} of ${mesh.indices.length / 3}`);
    // The stored file keeps them.
    assert.deepEqual(decodeMesh(encodeMesh(mesh)).colors, mesh.colors);
  }
  // Nearest-surface transfer on its own: a triangle takes the colour of the original nearest to it.
  const src = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0]);
  const out = transferColorsForTest(src, new Uint32Array([0, 1, 2, 3, 4, 5]), new Uint8Array([255, 0, 0, 0, 0, 255]), new Float32Array([9.5, 0.2, 0.1, 10.5, 0.2, 0.1, 10, 0.6, 0.1]), new Uint32Array([0, 1, 2]));
  assert.deepEqual([...out], [0, 0, 255]);
});

test('colours reduce to at most 4 by area, tiny and look-alike ones merged, each with the closest filament', () => {
  const { mesh } = importMeshFile(glb, 'figure.glb', { colors: true }, decodeTexture);
  const areas = triangleAreas(mesh.positions, mesh.indices);
  const four = clusterColors(mesh.colors!, areas, 4);
  // The white buttons (a sliver of the shirt) don't get a filament of their own.
  assert.equal(four.length, 4);
  for (const want of [HAIR, SKIN, SHIRT, TROUSERS]) assert.ok(four.some((c) => colorDistance(c.color, want) < 0.03), want);
  assert.ok(four.every((c, i) => i === 0 || c.share <= four[i - 1].share));
  assert.ok(Math.abs(four.reduce((s, c) => s + c.share, 0) - 1) < 1e-6);
  assert.equal(clusterColors(mesh.colors!, areas, 2).length, 2);
  // Two near-identical reds are one colour.
  const reds = new Uint8Array([200, 30, 40, 203, 32, 41, 20, 20, 200]);
  assert.equal(clusterColors(reds, [1, 1, 1], 4).length, 2);

  const pal = meshPalette({ ...mesh, colors: mesh.colors! }, 4);
  const byColour = (c: string) => pal.find((p) => colorDistance(p.color, c) < 0.03)!.filament;
  assert.equal(byColour(HAIR).name, 'PLA Basic Black'); // a grey gets a grey (not a dark blue)
  assert.equal(byColour(SHIRT).name, 'PLA Basic Red');
  assert.equal(byColour(TROUSERS).name, 'PLA Basic Blue');
  // The user's own filament wins when it is close; each filament is used once.
  const mine = [{ name: 'Fire Red', brand: 'eSUN', color: '#c4262e', td: 1 }];
  assert.deepEqual(matchFilaments([SHIRT, '#c62a30'], mine).map((f) => f.name), ['Fire Red', 'PLA Basic Red']);
  // Each triangle's index is its nearest palette colour.
  assert.deepEqual([...colorSlots(new Uint8Array([250, 0, 0, 0, 0, 240]), ['#0000ff', '#ff0000'])], [1, 0]);
});

test('shading stays on its colour: a grey\'s highlights stay grey, not the light skin\'s', () => {
  // The real case: a grey beard's highlights are lighter than the skin, and nearer it in lightness.
  const palette = ['#a88473', '#706b68'];
  const highlights = new Uint8Array([0xa8, 0xa8, 0xa8, 0xb4, 0xb4, 0xb4, 0xc0, 0xc0, 0xc0, 0xb0, 0xae, 0xab]);
  assert.deepEqual([...colorSlots(highlights, palette)], [1, 1, 1, 1]);
  // Skin in light shadow and in light is still skin.
  assert.deepEqual([...colorSlots(new Uint8Array([0x8f, 0x70, 0x62, 0xb9, 0x91, 0x7f]), palette)], [0, 0]);
  // A grey beard in light and shadow and a caramel skin: two colours, the grey and the skin.
  const greys = Array.from({ length: 6 }, (_, i) => 0x60 + i * 10);
  const skins = [0.9, 1, 1.1, 1.15].map((s) => [0xa8, 0x84, 0x73].map((c) => Math.min(255, Math.round(c * s))));
  const rgb = new Uint8Array([...greys.flatMap((g) => [g, g, g]), ...skins.flat()]);
  const two = clusterColors(rgb, Array(greys.length + skins.length).fill(1), 2);
  const slots = colorSlots(rgb, two.map((c) => c.color));
  assert.equal(new Set(slots.subarray(0, greys.length)).size, 1);
  assert.ok(slots.subarray(greys.length).every((s) => s !== slots[0]), [...slots].join());
  // Greys differing only in lightness still come apart.
  const dark = new Uint8Array([60, 60, 60, 64, 64, 64, 180, 180, 180, 184, 184, 184]);
  assert.equal(clusterColors(dark, [1, 1, 1, 1], 4).length, 2);
  // The real case: a white beard and pale skin in light and shadow stay two colours, and a dark
  // brown glove gets a brown filament, not a dark grey.
  const beard = [0xa8, 0xb4, 0xc0].map((g) => [g, g - 2, g - 5]);
  const pale = [0.85, 0.95, 1.05, 1.15].map((s) => [0xb7, 0x92, 0x7f].map((c) => Math.min(255, Math.round(c * s))));
  const mix = clusterColors(new Uint8Array([...beard, ...pale].flat()), [2, 2, 2, 1, 1, 1, 1], 2);
  const mixSlots = colorSlots(new Uint8Array([...beard, ...pale].flat()), mix.map((c) => c.color));
  assert.deepEqual([...mixSlots], [0, 0, 0, 1, 1, 1, 1].map((i) => mixSlots[i ? 3 : 0]));
  assert.notEqual(mixSlots[0], mixSlots[3]);
  assert.match(matchFilaments(['#37231a'])[0].name!, /Chocolate|Brown/);
});

/** A flat n × n grid of 1 mm squares (two triangles each, facing up); `slot(x, y, upper)` per triangle. */
function grid(n: number, slot: (x: number, y: number, upper: boolean) => number) {
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.set([x, y, 0], (y * (n + 1) + x) * 3);
  const indices: number[] = [], slots: number[] = [];
  const v = (x: number, y: number) => y * (n + 1) + x;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    indices.push(v(x, y), v(x + 1, y), v(x + 1, y + 1), v(x, y), v(x + 1, y + 1), v(x, y + 1));
    slots.push(slot(x, y, false), slot(x, y, true));
  }
  return { positions, indices: Uint32Array.from(indices), slots: Uint8Array.from(slots) };
}

test('specks go: lone triangles by majority, thin streaks and small patches into the colour around them', () => {
  const inside = (x: number, y: number, x0: number, y0: number, w: number) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + w;
  const g = grid(30, (x, y, upper) =>
    inside(x, y, 2, 2, 8) ? 2 // a big patch (an eye), stays
      : x === 20 && y === 5 && upper ? 1 // a lone triangle
        : y === 15 && x >= 22 ? 3 // a thin streak
          : inside(x, y, 20, 20, 3) ? 1 // a small patch
            : 0);
  const n = g.slots.length;
  const clean = cleanSlots(g.positions, g.indices, g.slots, 0.015);
  const at = (x: number, y: number, upper = false) => clean[2 * (y * 30 + x) + (upper ? 1 : 0)];
  assert.equal(at(20, 5, true), 0);
  assert.ok(Array.from({ length: 8 }, (_, i) => at(22 + i, 15) + at(22 + i, 15, true)).every((s) => s === 0));
  assert.equal(at(21, 21), 0);
  assert.equal(at(21, 21, true), 0);
  // The big patch keeps its inside and most of its area; nothing of the others is left.
  assert.equal(at(5, 5), 2);
  const count = (s: number) => clean.reduce((c, x) => c + (x === s ? 1 : 0), 0);
  assert.ok(count(2) > 0.9 * 128, `${count(2)}`);
  assert.equal(count(1) + count(3), 0);
  assert.equal(count(0) + count(2), n);
  // The majority filter alone: the lone triangle goes, the streak and the small patch (9 mm² of 900) stay.
  const kept = cleanSlots(g.positions, g.indices, g.slots, 0);
  assert.equal(kept[2 * (5 * 30 + 20) + 1], 0);
  assert.equal(kept[2 * (21 * 30 + 21)], 1);
  assert.equal(kept[2 * (15 * 30 + 25)], 3);
  // One colour: nothing to do.
  assert.deepEqual(cleanSlots(g.positions, g.indices, new Uint8Array(n)), new Uint8Array(n));
});

test('colours carried through the repair come from the side of a thin gap the triangle faces', () => {
  // A chest (z = 0, facing up, red) and a beard 0.1 mm above it (facing down onto it, blue).
  const src = new Float32Array([-10, -10, 0, 10, -10, 0, -10, 10, 0, /* beard */ -1, -1, 0.1, -1, 1, 0.1, 1, -1, 0.1]);
  const colors = new Uint8Array([255, 0, 0, 0, 0, 255]);
  const tri = (x: number, y: number, z: number, up: boolean) => (up ? [x, y, z, x + 0.2, y, z, x, y + 0.2, z] : [x, y, z, x, y + 0.2, z, x + 0.2, y, z]);
  const target = new Float32Array([
    ...tri(-0.5, -0.5, 0.06, true), // facing up, nearer the beard: the chest's
    ...tri(-0.5, -0.5, 0.04, false), // facing down, nearer the chest: the beard's
    ...tri(-8, -8, 0.02, true), ...tri(-7, -8, 0.02, true), ...tri(-8, -7, 0.02, true), // the chest away from the beard
  ]);
  const out = transferColorsForTest(src, new Uint32Array([0, 1, 2, 3, 4, 5]), colors, target, Uint32Array.from({ length: 15 }, (_, i) => i));
  assert.deepEqual([...out], [255, 0, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 0, 0]);
});

const url = '/api/designs/abcdefgh/meshes/0123456789abcdef0123456789abcdef.bin';
const { mesh: figure } = importMeshFile(glb, 'figure.glb', { colors: true }, decodeTexture);
const palette = meshPalette({ ...figure, colors: figure.colors! }, 4);
registerMesh(url, decodeMesh(encodeMesh(figure)));
const values = (pal = palette) => ({ [MESHES_KEY]: JSON.stringify({ fig: { file: url, triangles: figure.indices.length / 3, size: [35, 35, 80], source: 'meshy', palette: pal } }) });

test('the colours follow the triangles through a script: cut, moved, joined with a base', () => {
  assert.deepEqual(parseMeshes(values()[MESHES_KEY]).fig.palette, palette);
  const code = `function build() {
    const fig = H.mesh('fig', { height: 60 }).trimByPlane([0, 0, 1], 2).translate([0, 0, 1]);
    const base = Manifold.cylinder(3, 22, 22, 48);
    return [{ name: 'Figure', shape: fig.add(base), color: BASE }, { name: 'Box', shape: Manifold.cube([5, 5, 5]).translate([40, 0, 0]), color: '#00ff00' }];
  }`;
  const run = (base: string) => evaluateScript(code.replace('BASE', `'${base}'`), values(), 'draft');
  const r = run('#123456');
  const part = r.parts[0];
  assert.ok(part.paint);
  assert.equal(part.paint.tri.length, part.indices.length / 3);
  const names = part.paint.filaments.map((f) => f.name ?? f.color);
  assert.deepEqual(names.slice().sort(), ['#123456', 'PLA Basic Black', 'PLA Basic Blue', 'PLA Basic Gold', 'PLA Basic Red'].sort());
  // Triangles by height: the base (z < 3) is the part's colour, the top of the head hair, the legs trousers.
  const at = (lo: number, hi: number) => {
    const seen = new Map<string, number>();
    for (let t = 0; t < part.paint!.tri.length; t++) {
      const z = [0, 1, 2].reduce((s, k) => s + part.positions[part.indices[3 * t + k] * 3 + 2], 0) / 3;
      if (z < lo || z > hi) continue;
      const n = names[part.paint!.tri[t]];
      seen.set(n, (seen.get(n) ?? 0) + 1);
    }
    return [...seen].sort((a, b) => b[1] - a[1])[0][0];
  };
  assert.equal(at(0, 2.9), '#123456');
  assert.equal(at(56, 62), 'PLA Basic Black');
  assert.equal(at(8, 15), 'PLA Basic Blue');
  assert.equal(at(25, 30), 'PLA Basic Red');
  // The other part has no coloured mesh: one colour.
  assert.equal(r.parts[1].paint, undefined);
  // Five filaments in the design: the app and the user are told.
  assert.ok(modelWarnings(r).some((w) => /needs 6 filaments.*Bambu Lab A1 loads 4 at once/.test(w)), modelWarnings(r).join('\n'));
  // Two AMS (8 slots): no warning; no AMS: each extra filament is swapped by hand.
  setPrinter({ ...DEFAULT_PRINTER, filaments: 8 });
  try { assert.ok(!modelWarnings(r).some((w) => /needs 6 filaments/.test(w))); } finally { setPrinter(DEFAULT_PRINTER); }
  setPrinter({ ...DEFAULT_PRINTER, filaments: 1 });
  try { assert.ok(modelWarnings(r).some((w) => /needs 6 filaments.*loads 1 at once.*by hand/.test(w))); } finally { setPrinter(DEFAULT_PRINTER); }
  // A base in one of the figure's filament colours shares its filament.
  const black = run('#000000').parts[0].paint!;
  assert.equal(black.filaments.length, 4);
  // Another filament for a colour changes only those triangles.
  const green = { color: '#00ae42', name: 'PLA Basic Bambu Green', brand: 'Bambu Lab' };
  const swapped = evaluateScript(code.replace('BASE', "'#000000'"), values(palette.map((c, i) => (i === 0 ? { ...c, filament: green } : c))), 'draft').parts[0].paint!;
  assert.ok(swapped.filaments.some((f) => f.name === 'PLA Basic Bambu Green'));
  assert.ok(!swapped.filaments.some((f) => f.name === palette[0].filament.name));
  // Without a palette (colour turned off) the mesh is the part's colour.
  const plain = evaluateScript(code.replace('BASE', "'#000000'"), { [MESHES_KEY]: JSON.stringify({ fig: { file: url, triangles: 1, size: [1, 1, 1], source: 'meshy' } }) }, 'draft');
  assert.equal(plain.parts[0].paint, undefined);
});

test('repainted triangles: a short code for their indices, applied in order in the nearest current colour', () => {
  for (const tris of [[], [0], [5], [0, 1, 2, 3, 9], [70000, 3, 4, 5, 5, 100, 99, 1e6], Array.from({ length: 500 }, (_, i) => i * 7 + (i % 3))]) {
    const want = [...new Set(tris)].sort((a, b) => a - b);
    assert.deepEqual([...decodeTris(encodeTris(tris))], want);
  }
  assert.equal(encodeTris([0, 1, 2, 3, 9]), '0+3,5');
  // Only the mesh's own triangles.
  assert.deepEqual([...decodeTris('0+3,5', 3)], [0, 1, 2]);
  const palette = ['#ff0000', '#00ff00', '#0000ff'];
  const slots = new Uint8Array([0, 0, 0, 0]);
  assert.equal(applyRepaint(slots, palette), slots);
  // A colour of an earlier palette (a darker green) takes the nearest of this one; the later repaint wins.
  const out = applyRepaint(slots, palette, [{ color: '#20c020', tris: encodeTris([0, 1]) }, { color: '#0000ff', tris: encodeTris([1, 7]) }]);
  assert.deepEqual([...out], [1, 2, 0, 0]);
  assert.deepEqual([...slots], [0, 0, 0, 0]);
});

test('a patch is the connected triangles of one colour', () => {
  // Two squares of colour 1 that touch only at a corner: a patch is one of them.
  const g = grid(6, (x, y) => ((x < 2 && y < 2) || (x >= 2 && x < 4 && y >= 2 && y < 4) ? 1 : 0));
  const patch = slotPatch(triangleNeighbours(g.indices), g.slots, 0);
  assert.equal(patch.length, 8);
  assert.ok([...patch].every((t) => g.slots[t] === 1 && t % 12 < 4));
});

test('repaints are kept with the mesh, invalid ones dropped', () => {
  const entry = (repaint: unknown, pal: unknown = palette) => parseMeshes(JSON.stringify({ fig: { file: url, triangles: 10, size: [1, 1, 1], source: 'meshy', palette: pal, repaint } })).fig;
  const good = { color: '#AABBCC', tris: '0+3,5' };
  assert.deepEqual(entry([good]).repaint, [{ color: '#aabbcc', tris: '0+3,5' }]);
  assert.deepEqual(entry([good, { color: 'red', tris: '1' }, { color: '#000000', tris: '1,,2' }, { color: '#000000', tris: '-1' }, { color: '#000000' }]).repaint, [{ color: '#aabbcc', tris: '0+3,5' }]);
  assert.equal(entry(Array(MAX_REPAINTS + 5).fill(good)).repaint!.length, MAX_REPAINTS);
  assert.equal(entry([]).repaint, undefined);
  // Only a coloured mesh has them.
  assert.equal(entry([good], null).repaint, undefined);
});

test('a repaint follows its triangles through a script, and each painted triangle knows its stored one', () => {
  const pal = palette.map((c) => c.color);
  const slots = meshSlots({ ...figure, colors: figure.colors! }, pal);
  const trousers = pal.findIndex((c) => colorDistance(c, TROUSERS) < 0.03), shirt = pal.findIndex((c) => colorDistance(c, SHIRT) < 0.03);
  // The stored figure is 80 mm tall: its legs (below 20 mm) repainted in the shirt's colour.
  const legs: number[] = [];
  for (let t = 0; t < slots.length; t++) {
    const z = [0, 1, 2].reduce((s, k) => s + figure.positions[figure.indices[3 * t + k] * 3 + 2], 0) / 3;
    if (z < 20 && slots[t] === trousers) legs.push(t);
  }
  assert.ok(legs.length > 50);
  const code = `function build() {
    const fig = H.mesh('fig', { height: 60 }).trimByPlane([0, 0, 1], 2).translate([0, 0, 1]);
    return [{ name: 'Figure', shape: fig.add(Manifold.cylinder(3, 22, 22, 48)), color: '#123456' }];
  }`;
  const run = (repaint?: unknown) => evaluateScript(code, { [MESHES_KEY]: JSON.stringify({ fig: { file: url, triangles: slots.length, size: [35, 35, 80], source: 'meshy', palette, ...(repaint ? { repaint } : {}) } }) }, 'draft').parts[0];
  const part = run([{ color: palette[shirt].color, tris: encodeTris(legs) }]);
  const paint = part.paint!, src = paint.source!;
  assert.deepEqual(src.meshes, ['fig']);
  const name = (t: number) => paint.filaments[paint.tri[t]].name ?? paint.filaments[paint.tri[t]].color;
  const repainted = new Set(legs);
  let mapped = 0, own = 0;
  for (let t = 0; t < paint.tri.length; t++) {
    if (src.mesh[t] === 255) { own++; assert.equal(name(t), '#123456'); continue; }
    mapped++;
    // Each of the figure's triangles is in its stored triangle's colour, the repainted ones in the shirt's.
    const f = src.face[t];
    assert.ok(f < slots.length);
    assert.equal(name(t), repainted.has(f) ? palette[shirt].filament.name : palette[slots[f]].filament.name);
  }
  assert.ok(mapped > 1000 && own > 10, `${mapped} ${own}`);
  // The legs (8–15 mm after the script's scaling and moving) print red now; without the repaint, blue.
  const zOf = (p: typeof part, t: number) => [0, 1, 2].reduce((s, k) => s + p.positions[p.indices[3 * t + k] * 3 + 2], 0) / 3;
  const legColour = (p: typeof part) => {
    const n = new Map<string, number>();
    for (let t = 0; t < p.paint!.tri.length; t++) if (zOf(p, t) > 8 && zOf(p, t) < 15) { const f = p.paint!.filaments[p.paint!.tri[t]].name!; n.set(f, (n.get(f) ?? 0) + 1); }
    return [...n].sort((a, b) => b[1] - a[1])[0][0];
  };
  assert.equal(legColour(part), 'PLA Basic Red');
  assert.equal(legColour(run()), 'PLA Basic Blue');
});

test('the mesh colour budget is min(filaments, 4), and a saved palette is never trimmed by a lower count', () => {
  for (const [n, want] of [[1, 1], [4, 4], [16, 4]] as const) {
    setPrinter({ ...DEFAULT_PRINTER, filaments: n });
    assert.equal(meshColorBudget(), want);
  }
  setPrinter({ ...DEFAULT_PRINTER, filaments: 2 });
  try {
    const four = ['#000000', '#ffffff', '#ff0000', '#0000ff'].map((color) => ({ color, share: 0.25, filament: { name: 'PLA', color } }));
    assert.equal(cleanPalette(four)?.length, 4);
  } finally { setPrinter(DEFAULT_PRINTER); }
});
