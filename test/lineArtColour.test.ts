import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { evaluateScript } from '../shared/runtime';
import { withFonts } from '../shared/text';
import { loadFontBuffers } from '../server/fonts';
import { DRAWINGS_KEY, type SvgDrawing } from '../shared/svgFeatures';
import { cleanLineArtInfo, colourStrokes, drawingFingerprint, LINEART_EDITS_KEY, parseLineArtEdits, type LineArtStroke } from '../shared/lineart';
import { modelWarnings } from '../shared/modelWarnings';
import { toBambuProject } from '../src/lib/bambu3mf';
import { recolourEdits, removeStroke, strokeFilaments, withoutColours } from '../src/lib/lineArtEdit';
import { DATA_DIR } from '../server/config';
import { findBambuBinary } from '../server/bambu';
import { slicedProject } from '../server/slicer';
import type { BambuTemplate } from '../shared/api';
import type { Box3, PartMesh, Vec2 } from '../shared/types';

// A frame drawn as a 2:1 rectangle outline, its lines 0.02 high (2 mm in a piece 200 mm wide,
// 100 mm high: 1 unit = 100 mm, the top line from y 48 to 50 mm).
const box = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const frame: SvgDrawing = { name: 'frame', aspect: 2, shapes: [{ rule: 'EvenOdd', contours: [box(-1, -0.5, 1, 0.5), box(-0.98, -0.48, 0.98, 0.48)], color: '#000000' }] };
const fp = drawingFingerprint(frame);
const red = { color: '#ff0000', name: 'Red' }, blue = { color: '#0000ff', name: 'Blue', brand: 'Bambu Lab' };
const paint = (y: number, x0: number, x1: number, filament?: typeof red, width = 4): LineArtStroke => ({ mode: 'paint', width, points: [[x0, y], [x1, y]], ...(filament ? { filament } : {}) });
const build = (strokes: LineArtStroke[], opts = "style: 'outline', width: 200") => evaluateScript(`function build() { return H.lineart('frame', { ${opts} }); }`,
  { [DRAWINGS_KEY]: JSON.stringify({ frame }), [LINEART_EDITS_KEY]: JSON.stringify({ frame: { fp, strokes } }) }, 'draft');
const inside = (a: Box3, b: Box3) => [0, 1, 2].every((k) => a.min[k] >= b.min[k] - 1e-3 && a.max[k] <= b.max[k] + 1e-3);

test('colour strokes: old edits load unchanged, paint and filaments are checked', () => {
  const old = { a: { fp: 'x', strokes: [{ mode: 'draw', width: 1.2, points: [[0, 0], [0.1, 0.2]] }, { mode: 'erase', points: [[0.3, 0.3]] }] } };
  assert.deepEqual(parseLineArtEdits(JSON.stringify(old)), old);
  const raw = { a: { fp: 'x', strokes: [
    { mode: 'paint', width: 3, points: [[0, 0]], filament: { color: '#FF0000', name: 'Red', extra: 1 } },
    { mode: 'draw', points: [[0, 0]], filament: { color: 'red' } },
    { mode: 'erase', points: [[0, 0]], filament: { color: '#00ff00' } },
    { mode: 'colour', points: [[0, 0]] },
    { mode: 'paint', points: [] },
  ] } };
  assert.deepEqual(parseLineArtEdits(raw).a.strokes, [
    { mode: 'paint', width: 3, points: [[0, 0]], filament: { color: '#ff0000', name: 'Red' } },
    { mode: 'draw', points: [[0, 0]] },
    { mode: 'erase', points: [[0, 0]] },
  ]);
  // Redrawn by the image model, the lines are in the picture: their colours stay as paint.
  const kept = colourStrokes([{ mode: 'draw', points: [[0, 0]] }, { mode: 'draw', width: 0.5, points: [[1, 1]], filament: red }, { mode: 'erase', points: [[2, 2]] }, paint(0, 0, 1)], 1);
  assert.deepEqual(kept, [{ mode: 'paint', width: 1, points: [[1, 1]], filament: red }, paint(0, 0, 1)]);
  assert.deepEqual(colourStrokes([{ mode: 'draw', points: [[0, 0]] }]), []);
  // Recolouring, taking colours off, undoing a coloured stroke.
  const e = { frame: { fp, strokes: [paint(0.49, -0.3, 0.3, red), paint(-0.49, -0.3, 0.3, blue), { mode: 'erase' as const, points: [[0, 0]] as Vec2[] }] } };
  assert.deepEqual(strokeFilaments(e.frame.strokes), [red, blue]);
  assert.deepEqual(recolourEdits(e, red, blue).frame.strokes.map((s) => s.filament?.name), ['Blue', 'Blue', undefined]);
  assert.equal(recolourEdits(e, red, null).frame.strokes[0].filament, undefined);
  assert.deepEqual(withoutColours(e, ['frame']).frame.strokes, [{ mode: 'erase', points: [[0, 0]] }]);
  assert.deepEqual(removeStroke(e, 'frame', { ...paint(0.49, -0.3, 0.3, blue) }), e, 'another filament is another stroke');
  assert.equal(removeStroke(e, 'frame', paint(0.49, -0.3, 0.3, red)).frame.strokes.length, 2);
  // The line-art info keeps a part's filament and the piece's colours.
  const info = cleanLineArtInfo({ style: 'outline', sources: ['a'], size: [1, 1], thickness: 2, lineWidth: 1, longestBridge: 0, colours: [red, { color: 'nope' }], paintedIn: blue, components: 1 });
  assert.deepEqual([info?.colours, info?.paintedIn, info?.components], [[red], blue, 1]);
});

test('paint: the lines under the brush become a part in that filament, clipped to them, the piece one piece', () => {
  const plain = build([]);
  assert.deepEqual(plain.parts.map((p) => p.name), ['Line art']);
  // A 4 mm brush along the 2 mm top line, 60 mm long: only the line is coloured.
  const r = build([paint(0.49, -0.3, 0.3, red)]);
  assert.deepEqual(r.parts.map((p) => [p.name, p.color]), [['Line art', '#1d1d1f'], ['Line art (Red)', '#ff0000']]);
  const [own, col] = r.parts;
  assert.deepEqual(col.lineArt?.paintedIn, red);
  assert.deepEqual(own.lineArt?.colours, [red]);
  assert.equal(own.lineArt?.components, 1);
  // 60 × 2 mm and the brush's round ends on the line (two caps of sqrt(3) + 2π/3 mm²), 2 mm thick.
  const want = (120 + 2 * (Math.sqrt(3) + (2 * Math.PI) / 3)) * 2;
  assert.ok(Math.abs(col.volume - want) / want < 0.02, `red ${col.volume.toFixed(1)} mm³, about ${want.toFixed(1)}`);
  assert.ok(Math.abs(col.bbox.max[1] - col.bbox.min[1] - 2) < 0.02, 'as high as the line, not the brush');
  assert.ok(Math.abs(col.bbox.max[2] - 2) < 1e-6 && Math.abs(col.bbox.min[2]) < 1e-6, 'through the whole thickness');
  assert.ok(inside(col.bbox, own.bbox));
  assert.ok(Math.abs(own.volume + col.volume - plain.parts[0].volume) < 0.5, 'nothing added, nothing lost');
  // How to print it says so.
  const logged = evaluateScript("function build() { const r = H.lineart('frame', { style: 'outline', width: 200 }); console.log(r.note); return r; }",
    { [DRAWINGS_KEY]: JSON.stringify({ frame }), [LINEART_EDITS_KEY]: JSON.stringify({ frame: { fp, strokes: [paint(0.49, -0.3, 0.3, red)] } }) }, 'draft');
  assert.match(logged.logs.join('\n'), /in 2 filaments \(its own and Red: .*prime tower/);
});

test('paint: slivers too thin to print go, one left beside a colour takes it, the own filament takes it back', () => {
  const full = build([paint(0.49, -0.3, 0.3, red)]).parts[1].volume;
  // The brush 1.15 mm too high leaves 0.15 mm of the line under it: that sliver goes red too.
  const high = build([paint(0.5015, -0.3, 0.3, red)]).parts;
  assert.equal(high.length, 2);
  assert.ok(Math.abs(high[1].volume - full) / full < 0.04, `${high[1].volume.toFixed(1)} vs ${full.toFixed(1)} mm³`);
  // Touching only 0.15 mm of the line's edge: nothing to colour.
  assert.deepEqual(build([paint(0.5185, -0.3, 0.3, red)]).parts.map((p) => p.name), ['Line art']);
  // Later strokes win: blue over the middle of the red, then the piece's own filament over its left end.
  const r = build([paint(0.49, -0.3, 0.3, red), paint(0.49, -0.1, 0.1, blue), paint(0.49, -0.3, -0.2)]);
  assert.deepEqual(r.parts.map((p) => p.name), ['Line art', 'Line art (Red)', 'Line art (Blue)']);
  const [, rd, bl] = r.parts;
  assert.equal(rd.components, 2, 'red on both sides of the blue');
  assert.ok(rd.bbox.min[0] > -21 && rd.bbox.max[0] > 29, `red from x ${rd.bbox.min[0].toFixed(1)}`);
  assert.ok(Math.abs(bl.bbox.max[0] - bl.bbox.min[0] - 24) < 0.5, 'blue 20 mm and its brush ends');
  // Two colours across the top and bottom lines cut the piece's own part in two: still one piece, no warning.
  const cut = build([paint(0.49, -0.3, 0.3, red), paint(-0.49, -0.3, 0.3, red)]);
  assert.equal(cut.parts[0].components, 2);
  assert.equal(cut.parts[0].lineArt?.components, 1);
  assert.ok(!modelWarnings(cut).some((w) => /disconnected/.test(w)), modelWarnings(cut).join('; '));
  // A line drawn in a filament is that filament all along.
  const drawn = build([{ mode: 'draw', width: 1, points: [[0, 0.48], [0, 0.2]], filament: blue }]);
  assert.deepEqual(drawn.parts.map((p) => p.name), ['Line art', 'Line art (Blue)']);
  assert.ok(drawn.parts[1].bbox.min[1] < 22 && drawn.parts[1].bbox.max[1] > 47.5, 'the drawn line in blue');
});

test('paint on a split piece: each piece keeps its colours, on its plate, put up with it', async () => {
  // 400 mm wide, in two pieces; the red runs across the middle, where the seam is.
  const r = await withFonts(() => build([paint(0.49, -0.3, 0.3, red)], "style: 'outline', width: 400, split: 'auto'"), loadFontBuffers);
  const names = r.parts.map((p) => p.name);
  assert.deepEqual(names, ['A1', 'A1 (Red)', 'A2', 'A2 (Red)']);
  for (const piece of ['A1', 'A2']) {
    const own = r.parts.find((p) => p.name === piece)!, col = r.parts.find((p) => p.name === `${piece} (Red)`)!;
    assert.equal(col.plate, own.plate);
    assert.ok(inside(col.bbox, own.bbox), `${piece}'s red on it`);
    assert.deepEqual(col.lineArt?.piece, own.lineArt?.piece);
  }
  assert.deepEqual(r.assembly.map((s) => s.parts), [['A2', 'A2 (Red)']]);
});

/** A 3MF of the parts, unzipped. */
const tpl: BambuTemplate = {
  version: '02.08.04.57',
  settings: { filament_colour: ['#00AE42'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0'], flush_volumes_vector: ['140', '140'], printable_area: ['0x0', '256x0', '256x256', '0x256'], wipe_tower_x: ['15'], wipe_tower_y: ['220'] },
  perFilament: ['filament_colour'],
  perFilamentPlus2: [],
};
const project = async (parts: PartMesh[], oneColour?: string, t = tpl) => unzipSync(new Uint8Array(await toBambuProject(parts, 't', t, { print: null, oneColour }).arrayBuffer()));

test('3MF: the coloured lines are parts of the one object, each with its filament, and a prime tower beside it', async () => {
  const r = build([paint(0.49, -0.3, 0.3, red), paint(-0.49, -0.3, 0.3, blue)]);
  const files = await project(r.parts);
  const cfg = strFromU8(files['Metadata/model_settings.config']);
  const objects = [...cfg.matchAll(/<object id="\d+">(.*?)<\/object>/g)].map((m) => m[1]);
  assert.equal(objects.length, 1, 'one object');
  const parts = [...objects[0].matchAll(/<part id="\d+" subtype="normal_part"><metadata key="name" value="([^"]+)"\/><metadata key="matrix" value="[^"]+"\/><metadata key="extruder" value="(\d)"\/>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(parts, [['Line art', '1'], ['Line art (Red)', '2'], ['Line art (Blue)', '3']]);
  const settings = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
  assert.deepEqual(settings.filament_colour, ['#1D1D1F', '#FF0000', '#0000FF']);
  assert.equal(settings.enable_prime_tower, undefined, 'the prime tower stays on');
  assert.notDeepEqual(settings.wipe_tower_x, ['15'], 'placed beside the piece');
  // Print in one colour wins: one filament, every part in it.
  const one = await project(r.parts, '#1D1D1F');
  assert.deepEqual(JSON.parse(strFromU8(one['Metadata/project_settings.config'])).filament_colour, ['#1D1D1F']);
  assert.deepEqual([...strFromU8(one['Metadata/model_settings.config']).matchAll(/<part [^>]*>.*?key="extruder" value="(\d)"/g)].map((m) => m[1]), ['1', '1', '1']);
});

const TEMPLATE = path.join(DATA_DIR, 'bambu', 'template.json');
const canSlice = !!(await findBambuBinary()) && existsSync(TEMPLATE);

test('Bambu Studio slices coloured line art: every filament used, the swaps on each layer', { skip: !canSlice && 'needs Bambu Studio and its Jig template' }, async () => {
  const r = build([paint(0.49, -0.3, 0.3, red)]);
  const sliced = await slicedProject(new Uint8Array(await toBambuProject(r.parts, 't', JSON.parse(readFileSync(TEMPLATE, 'utf8')), { print: { ai: r.print, user: {} } }).arrayBuffer()));
  const info = strFromU8(sliced['Metadata/slice_info.config']);
  const used = [...info.matchAll(/<filament\b[^>]*color="([^"]+)"[^>]*used_g="([^"]+)"/g)].map((m) => [m[1].toUpperCase(), Number(m[2])] as const);
  assert.deepEqual(used.map((u) => u[0]), ['#1D1D1F', '#FF0000']);
  assert.ok(used.every((u) => u[1] > 0));
  const objects = (JSON.parse(strFromU8(sliced['Metadata/plate_1.json'])) as { bbox_objects: { name: string }[] }).bbox_objects.map((o) => o.name);
  assert.ok(objects.includes('wipe_tower'), 'with its prime tower');
  // 2 mm at 0.2 mm: both filaments on each of the 10 layers, a change on each (it starts a layer with the last one's).
  const swaps = (strFromU8(sliced['Metadata/plate_1.gcode']).match(/^T[01]\b/gm) ?? []).length;
  assert.ok(swaps >= 9, `${swaps} filament changes`);
});
