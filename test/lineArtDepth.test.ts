import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { strFromU8 } from 'fflate';
import { evaluateScript } from '../shared/runtime';
import { withFonts } from '../shared/text';
import { loadFontBuffers } from '../server/fonts';
import { DRAWINGS_KEY, type SvgDrawing } from '../shared/svgFeatures';
import { colourBottom, colourLayers, colourSwaps, drawingFingerprint, filamentTd, LINEART_DEPTH_KEY, LINEART_EDITS_KEY, parseLineArtDepth, type LineArtStroke } from '../shared/lineart';
import { PRINT_KEY } from '../shared/print';
import { toBambuProject } from '../src/lib/bambu3mf';
import { DATA_DIR } from '../server/config';
import { findBambuBinary } from '../server/bambu';
import { parseSliceInfo, slicedProject } from '../server/slicer';
import type { PartMesh, Vec2 } from '../shared/types';

// The frame of lineArtColour.test.ts: a 2:1 rectangle outline, 200 × 100 mm, its lines 2 mm wide.
const box = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const frame: SvgDrawing = { name: 'frame', aspect: 2, shapes: [{ rule: 'EvenOdd', contours: [box(-1, -0.5, 1, 0.5), box(-0.98, -0.48, 0.98, 0.48)], color: '#000000' }] };
const fp = drawingFingerprint(frame);
const red = { color: '#c12e1f', name: 'PLA Basic Red', brand: 'Bambu Lab' };
const gray = { color: '#8e9089', name: 'PLA Basic Gray', brand: 'Bambu Lab' };
const paint = (y: number, x0: number, x1: number, filament = red, width = 4): LineArtStroke => ({ mode: 'paint', width, points: [[x0, y], [x1, y]], filament });
const build = (strokes: LineArtStroke[], depth?: string, opts = "style: 'outline', width: 200", extra: Record<string, string> = {}) => evaluateScript(`function build() { return H.lineart('frame', { ${opts} }); }`,
  { [DRAWINGS_KEY]: JSON.stringify({ frame }), [LINEART_EDITS_KEY]: JSON.stringify({ frame: { fp, strokes } }), ...(depth ? { [LINEART_DEPTH_KEY]: depth } : {}), ...extra }, 'draft');
const total = (parts: PartMesh[]) => parts.reduce((v, p) => v + p.volume, 0);
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

test('colour depth: parsed, the top layers cut to the print\'s layers, the TD sets how many hide what is under them', () => {
  assert.equal(parseLineArtDepth('through'), 'through');
  assert.equal(parseLineArtDepth('auto'), 'auto');
  assert.equal(parseLineArtDepth('4'), 4);
  for (const raw of ['', undefined, '0', '2.5', '51', 'top', -3]) assert.equal(parseLineArtDepth(raw), undefined, String(raw));
  const l = { layerHeight: 0.2, firstLayerHeight: 0.2 };
  assert.equal(colourBottom(0, 0, 2, l), 0, 'through');
  assert.equal(colourBottom(3, 0, 2, l), 1.4);
  assert.equal(colourBottom(30, 0, 2, l), 0.2, 'the first layer stays the piece\'s own');
  assert.equal(colourBottom(2, 3, 4, l), 3.6, 'the sign\'s text: its top 2 layers');
  assert.equal(colourBottom(10, 3, 4, l), 3, 'all of it, nothing under it to keep');
  // A thicker first layer: the boundaries are 0.3, 0.5, 0.7… (the top one 0.1 mm thick).
  assert.equal(colourBottom(3, 0, 2, { layerHeight: 0.2, firstLayerHeight: 0.3 }), 1.3);
  // 95 % hidden at a TD's thickness; at least 2 layers.
  assert.equal(colourLayers(4.2, 0.2), 21);
  assert.equal(colourLayers(1.2, 0.2), 6);
  assert.equal(colourLayers(0.2, 0.2), 2);
  assert.deepEqual(filamentTd(red), { td: 4.2, known: true });
  assert.deepEqual(filamentTd({ color: '#000000', name: 'PLA Basic Black', brand: 'Bambu Lab' }), { td: 0.2, known: true });
  assert.deepEqual(filamentTd({ color: '#123456', name: 'Mine', td: 0.7 }), { td: 0.7, known: true }, 'the user\'s own TD');
  const guess = filamentTd({ color: '#ff0000' });
  assert.equal(guess.known, false);
  assert.ok(guess.td > 1 && guess.td < 6, `an unknown red: ${guess.td}`);
  assert.ok(filamentTd({ color: '#fafafa' }).td > filamentTd({ color: '#101010' }).td, 'white lets more through than black');
});

test('top layers: the colour is the top N layers of the line, the piece\'s own filament under it, nothing added or lost', () => {
  const plain = build([]).parts;
  const through = build([paint(0.49, -0.3, 0.3)], 'through').parts;
  const top = build([paint(0.49, -0.3, 0.3)], '3').parts;
  assert.deepEqual(top.map((p) => p.name), ['Line art', 'Line art (PLA Basic Red)']);
  const [own, col] = top;
  assert.ok(near(col.bbox.min[2], 1.4) && near(col.bbox.max[2], 2), `red from z ${col.bbox.min[2]} to ${col.bbox.max[2]}`);
  assert.ok(near(own.bbox.min[2], 0) && near(own.bbox.max[2], 2));
  assert.ok(Math.abs(col.volume - (through[1].volume * 3) / 10) < 0.5, `3 of the 10 layers: ${col.volume.toFixed(1)} of ${through[1].volume.toFixed(1)} mm³`);
  assert.ok(Math.abs(total(top) - plain[0].volume) < 0.5, 'nothing added, nothing lost');
  assert.equal(own.lineArt?.components, 1);
  // Unset, a design keeps its colours through (as they were before the choice).
  assert.ok(near(build([paint(0.49, -0.3, 0.3)]).parts[1].bbox.min[2], 0));
  // Auto: PLA Basic Red needs 4.2 mm, more than the piece: all but its first layer.
  const auto = build([paint(0.49, -0.3, 0.3)], 'auto').parts;
  assert.ok(near(auto[1].bbox.min[2], 0.2));
  // Each colour its own: gray (TD 0.4) hides black in 2 layers.
  const two = build([paint(0.49, -0.3, 0.3), paint(-0.49, -0.3, 0.3, gray)], 'auto').parts;
  assert.ok(near(two[2].bbox.min[2], 1.6), `gray from ${two[2].bbox.min[2]}`);
  const p = two[0].lineArt!.paint!;
  assert.deepEqual(p.colours.map((c) => [c.filament.name, c.need, c.known]), [['PLA Basic Red', 21, true], ['PLA Basic Gray', 2, true]]);
  // The user's layer height (Print tab): 0.12 mm layers, so 3 layers are 0.36 mm.
  const fine = build([paint(0.49, -0.3, 0.3)], '3', undefined, { [PRINT_KEY]: JSON.stringify({ layerHeight: 0.12, firstLayerHeight: 0.2 }) }).parts;
  assert.ok(near(fine[1].bbox.max[2] - fine[1].bbox.min[2], 0.36), `${(fine[1].bbox.max[2] - fine[1].bbox.min[2]).toFixed(3)} mm`);
});

test('paint across empty paper adds nothing: no colour part, the piece as it was', () => {
  const plain = build([]).parts;
  // Inside the frame's opening, where there is no line.
  const r = build([paint(0, -0.5, 0.5, red, 10)], 'through').parts;
  assert.deepEqual(r.map((p) => p.name), ['Line art']);
  assert.ok(Math.abs(r[0].volume - plain[0].volume) < 1e-6);
  // Half on a line, half off it: only the line's part is coloured.
  const half = build([paint(0.5, -0.3, 0.3, red, 10)], 'through').parts;
  assert.ok(half[1].bbox.max[1] - half[1].bbox.min[1] < 2.01, 'as high as the line, not the brush');
  assert.ok(Math.abs(total(half) - plain[0].volume) < 0.5);
});

test('the frame, the bar, the sign\'s text and the pegs take paint; their top layers, the pegs whole', async () => {
  const opts = (style: string) => `style: '${style}', width: 200`;
  // A brush along the middle of the bar or frame's bottom edge, across the piece.
  const along = (style: string, w: number) => {
    const plain = build([], undefined, opts(style));
    const f = plain.parts[0].lineArt!.frames[0], b = plain.parts[0].bbox;
    const y = ((style === 'framed' ? b.min[1] + 2 : b.min[1] + w / 2) - f.ty) / f.k;
    return { plain, strokes: [{ mode: 'paint', width: w, points: [[(b.min[0] + 8 - f.tx) / f.k, y], [(b.max[0] - 8 - f.tx) / f.k, y]], filament: red } as LineArtStroke] };
  };
  // Framed: the frame (3 mm thick) is coloured, its top 3 layers.
  const fr = along('framed', 4);
  const top = build(fr.strokes, '3', opts('framed')).parts;
  assert.deepEqual(top.map((p) => p.name), ['Line art', 'Line art (PLA Basic Red)']);
  assert.ok(near(top[1].bbox.min[2], 2.4) && near(top[1].bbox.max[2], 3), `frame red z ${top[1].bbox.min[2]}..${top[1].bbox.max[2]}`);
  assert.ok(Math.abs(total(top) - fr.plain.parts[0].volume) < 0.5);
  assert.deepEqual(top[0].lineArt?.paint?.colours[0].on, ['frame']);
  // Key holder: the brush over the bar colours it and every peg under it, whole (they stand 15 mm on the 4 mm bar).
  const kh = along('keyholder', 12);
  for (const depth of ['through', '3']) {
    const r = build(kh.strokes, depth, opts('keyholder')).parts;
    const col = r[1];
    assert.ok(near(col.bbox.max[2], 19), `pegs to 19 mm: ${col.bbox.max[2]}`);
    assert.ok(near(col.bbox.min[2], depth === 'through' ? 0 : 3.4), `${depth}: bar red from ${col.bbox.min[2]}`);
    assert.ok(near(r[0].bbox.max[2], 4), 'no peg left in the piece\'s own filament');
    assert.ok(Math.abs(total(r) - kh.plain.parts[0].volume) < 1, `${depth}: ${total(r).toFixed(1)} vs ${kh.plain.parts[0].volume.toFixed(1)} mm³`);
    const p = r[0].lineArt!.paint!;
    assert.deepEqual(p.materials.map((m) => [m.kind, m.own]), [['lines', true], ['frame', true], ['pegs', false]]);
  }
  // Name sign: its raised text (1 mm on the 3 mm bar) is coloured, its own height only.
  const sign = await withFonts(() => {
    const { strokes } = along('sign', 16);
    const r = build(strokes, '2', `${opts('sign')}, text: 'PTP'`).parts;
    return { plain: build([], undefined, `${opts('sign')}, text: 'PTP'`).parts, r };
  }, loadFontBuffers);
  const col = sign.r[1];
  assert.ok(near(col.bbox.max[2], 4) && near(col.bbox.min[2], 2.6), `sign red z ${col.bbox.min[2]}..${col.bbox.max[2]}`);
  assert.deepEqual(sign.r[0].lineArt?.paint?.colours[0].on, ['frame', 'text']);
  assert.ok(Math.abs(total(sign.r) - sign.plain[0].volume) < 1);
});

test('split and top layers: each piece\'s colour its top layers', async () => {
  const r = await withFonts(() => build([paint(0.49, -0.3, 0.3)], '3', "style: 'outline', width: 400, split: 'auto'"), loadFontBuffers);
  assert.deepEqual(r.parts.map((p) => p.name), ['A1', 'A1 (PLA Basic Red)', 'A2', 'A2 (PLA Basic Red)']);
  for (const p of r.parts.filter((q) => q.lineArt?.paintedIn)) assert.ok(near(p.bbox.min[2], 1.4), `${p.name} from ${p.bbox.min[2]}`);
  for (const p of r.parts.filter((q) => !q.lineArt?.paintedIn)) assert.equal(p.lineArt?.paint?.depth, 3, `${p.name} has its paint info`);
});

test('filament changes: a change on each layer a colour is on, the estimate from what Bambu Studio measured', () => {
  const info = (strokes: LineArtStroke[], depth: string) => build(strokes, depth).parts[0].lineArt!.paint!;
  const one = info([paint(0.49, -0.3, 0.3)], 'through');
  const through = colourSwaps(one, 'through'), top = colourSwaps(one, 3);
  assert.deepEqual([through.layers, through.changes], [10, 10]);
  assert.deepEqual([top.layers, top.changes], [3, 3]);
  // As sliced: about 17 min and 3.9 g more through, 5.9 min and 1.5 g for the top 3 layers.
  assert.ok(Math.abs(through.minutes - 17) < 1 && Math.abs(through.grams - 3.9) < 0.3, JSON.stringify(through));
  assert.ok(Math.abs(top.minutes - 5.9) < 0.6 && Math.abs(top.grams - 1.5) < 0.2, JSON.stringify(top));
  // Two colours on the same layers: two changes on each.
  const two = info([paint(0.49, -0.3, 0.3), paint(-0.49, -0.3, 0.3, gray)], 'through');
  assert.deepEqual([colourSwaps(two, 'through').layers, colourSwaps(two, 'through').changes], [10, 20]);
  // Auto: red on 9 layers, gray on its top 2 (a third filament there).
  assert.deepEqual([colourSwaps(two, 'auto').layers, colourSwaps(two, 'auto').changes], [9, 11]);
});

const TEMPLATE = path.join(DATA_DIR, 'bambu', 'template.json');
const canSlice = !!(await findBambuBinary()) && existsSync(TEMPLATE);

test('Bambu Studio: the top 3 layers in red change filament 3 times, through the piece 10; the estimate near the slice', { skip: !canSlice && 'needs Bambu Studio and its prompt-to-part template' }, async () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  const slice = async (depth?: string) => {
    const r = build(depth ? [paint(0.49, -0.3, 0.3)] : [], depth);
    const sliced = await slicedProject(new Uint8Array(await toBambuProject(r.parts, 't', tpl, { print: { ai: r.print, user: {} } }).arrayBuffer()));
    const swaps = (strFromU8(sliced['Metadata/plate_1.gcode']).match(/^T\d+\b/gm) ?? []).length - 1;
    return { ...parseSliceInfo(strFromU8(sliced['Metadata/slice_info.config'])), swaps, paint: r.parts[0].lineArt?.paint };
  };
  const plain = await slice(), through = await slice('through'), top = await slice('3');
  assert.deepEqual([through.swaps, top.swaps], [10, 3]);
  for (const [s, depth] of [[through, 'through'], [top, 3]] as const) {
    const est = colourSwaps(s.paint!, depth), minutes = (s.seconds - plain.seconds) / 60, grams = s.grams - plain.grams;
    assert.ok(Math.abs(est.minutes - minutes) / minutes < 0.25, `${depth}: ${est.minutes.toFixed(1)} min estimated, ${minutes.toFixed(1)} sliced`);
    assert.ok(Math.abs(est.grams - grams) / grams < 0.25, `${depth}: ${est.grams.toFixed(2)} g estimated, ${grams.toFixed(2)} sliced`);
  }
});
