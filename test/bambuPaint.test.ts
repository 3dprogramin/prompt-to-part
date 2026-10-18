import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { filamentPlan, paintColor, toBambuProject } from '../src/lib/bambu3mf';
import { to3mf } from '../src/lib/export';
import { DATA_DIR } from '../server/config';
import { findBambuBinary } from '../server/bambu';
import { slicedProject } from '../server/slicer';
import { evaluateScript, importMeshFile } from '../shared/runtime';
import { decodeTexture } from '../shared/imageDecode';
import { meshPalette, triangleAreas } from '../shared/meshColors';
import { decodeMesh, encodeMesh, MESHES_KEY, registerMesh } from '../shared/meshes';
import type { BambuTemplate } from '../shared/api';
import type { PartMesh } from '../shared/types';

// Bambu Studio's colour painting: each triangle's paint_color is the TriangleSelector state of the
// whole (unsplit) triangle, its filament.
test('paint_color: a whole triangle in filament 1 … 6', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(paintColor), ['4', '8', '0C', '1C', '2C', '3C']);
});

/** A 20 mm cube in four 5 mm bands; `band[t]` is the band of triangle t (the bottom is in band 0, the top in band 3). */
function bandedCube(): { part: PartMesh; band: number[]; side: number[] } {
  const S = 20, corners = [[0, 0], [S, 0], [S, S], [0, S]];
  const pos: number[] = [];
  for (let r = 0; r < 5; r++) for (const [x, y] of corners) pos.push(x, y, r * 5);
  const tri = [0, 2, 1, 0, 3, 2, 16, 17, 18, 16, 18, 19], band = [0, 0, 3, 3], side = [-1, -1, -1, -1];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const a = r * 4 + c, b = r * 4 + ((c + 1) % 4);
    tri.push(a, b, b + 4, a, b + 4, a + 4);
    band.push(r, r);
    side.push(c, c);
  }
  return {
    part: { name: 'Cube', color: '#ff0000', positions: new Float32Array(pos), indices: new Uint32Array(tri), bbox: { min: [0, 0, 0], max: [S, S, S] }, volume: S ** 3, surfaceArea: 0, triCount: tri.length / 3, genus: 0, components: 1 },
    band, side,
  };
}
const FOUR = [{ color: '#ff0000', name: 'Red' }, { color: '#00ff00', name: 'Green' }, { color: '#0000ff', name: 'Blue' }, { color: '#ffff00', name: 'Yellow' }];
/** The cube painted band by band, one side of band 1 with the fourth filament. */
function paintedCube(): PartMesh {
  const { part, band, side } = bandedCube();
  return { ...part, paint: { filaments: FOUR, tri: Uint8Array.from(band, (b, t) => (b === 1 && side[t] === 0 ? 3 : b)) } };
}

const fakeTpl: BambuTemplate = {
  version: '02.08.04.57',
  settings: { filament_colour: ['#00AE42'], filament_type: ['PLA'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0'], flush_volumes_vector: ['140', '140'], layer_height: '0.2', initial_layer_print_height: '0.2' },
  perFilament: ['filament_colour', 'filament_type'],
  perFilamentPlus2: [],
};
const unzip = async (b: Blob) => unzipSync(new Uint8Array(await b.arrayBuffer()));
const paints = (xml: string) => [...xml.matchAll(/<triangle [^>]*?(?: paint_color="([^"]+)")?\/>/g)].map((m) => m[1] ?? '');

test('Bambu project: a painted part is one solid with its triangles painted, and one filament per colour', async () => {
  const cube = paintedCube();
  const base = { ...bandedCube().part, name: 'Base', color: '#ffff00', positions: bandedCube().part.positions.map((v, i) => (i % 3 === 0 ? v + 30 : v)), bbox: { min: [30, 0, 0], max: [50, 20, 20] } } as PartMesh;
  const plan = filamentPlan([cube, base], { layerHeight: 0.2, firstLayerHeight: 0.2 });
  assert.deepEqual(plan.filaments.map((f) => f.colour), ['#FF0000', '#00FF00', '#0000FF', '#FFFF00']);
  // The base in the cube's yellow shares its filament; the cube's own filament is its most used.
  assert.deepEqual(plan.slot, [4, 4]);
  assert.deepEqual(plan.paint, [[1, 2, 3, 4], []]);
  assert.deepEqual(plan.ams, [1, 2, 3, 4]);

  const files = await unzip(toBambuProject([cube, base], 'paint', fakeTpl, { colours: true, print: null }));
  const objects = Object.keys(files).filter((f) => f.startsWith('3D/Objects/'));
  assert.equal(objects.length, 2);
  const cubeXml = strFromU8(files['3D/Objects/object_1.model']);
  assert.equal((cubeXml.match(/<object /g) ?? []).length, 1, 'one solid');
  // Filament 4 (the cube's own, most of it) unpainted; the others painted.
  const codes = paints(cubeXml);
  assert.equal(codes.length, cube.indices.length / 3);
  assert.deepEqual([...new Set(codes)].sort(), ['', '0C', '4', '8']);
  cube.paint!.tri.forEach((f, t) => assert.equal(codes[t], f === 3 ? '' : paintColor(f + 1)));
  assert.match(strFromU8(files['Metadata/model_settings.config']), /value="Cube"\/><metadata key="matrix" value="[^"]+"\/><metadata key="extruder" value="4"\/>/);
  assert.ok(paints(strFromU8(files['3D/Objects/object_2.model'])).every((c) => c === ''));
  const settings = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
  assert.deepEqual(settings.filament_colour, ['#FF0000', '#00FF00', '#0000FF', '#FFFF00']);
  assert.deepEqual(settings.filament_type, ['PLA', 'PLA', 'PLA', 'PLA']);

  // "Colours (AMS)" off: everything in one filament, no painting.
  const plain = await unzip(toBambuProject([cube, base], 'paint', fakeTpl, { colours: false, print: null }));
  assert.ok(paints(strFromU8(plain['3D/Objects/object_1.model'])).every((c) => c === ''));
  assert.doesNotMatch(strFromU8(plain['3D/Objects/object_1.model']), /paint_color/);
  assert.deepEqual(JSON.parse(strFromU8(plain['Metadata/project_settings.config'])).filament_colour, ['#00AE42']);

  // The plain 3MF: each triangle its filament's colour (the Materials extension), or none without colours.
  const flat = strFromU8((await unzip(to3mf([cube], 'paint')))['3D/3dmodel.model']);
  assert.match(flat, /<m:colorgroup id="1"><m:color color="#FF0000FF"\/><m:color color="#00FF00FF"\/><m:color color="#0000FFFF"\/><m:color color="#FFFF00FF"\/><\/m:colorgroup>/);
  const p1 = [...flat.matchAll(/<triangle [^>]*p1="(\d)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(p1, [...cube.paint!.tri]);
  assert.doesNotMatch(strFromU8((await unzip(to3mf([cube], 'paint', false)))['3D/3dmodel.model']), /p1=/);
});

// ---------------------------------------------------------------------------
// Slicing with the user's Bambu Studio (skipped without it, or before Jig has built its template).
// ---------------------------------------------------------------------------

const TEMPLATE = path.join(DATA_DIR, 'bambu', 'template.json');
const canSlice = !!(await findBambuBinary()) && existsSync(TEMPLATE);
const skip = !canSlice && 'needs Bambu Studio and its Jig template';

/** The tool changes in the G-code, as "z:Tn". */
function toolChanges(gcode: string): string[] {
  let z = 0;
  const out: string[] = [];
  for (const line of gcode.split('\n')) {
    const zh = /^; Z_HEIGHT: (.+)/.exec(line);
    if (zh) z = Number(zh[1]);
    const t = /^T(\d+)\s*$/.exec(line);
    if (t && t[1] !== '255') out.push(`${z}:T${t[1]}`);
  }
  return out;
}
/** Each filament's use in the sliced project: [id, colour, used]. */
const used = (info: string) => [...info.matchAll(/<filament id="(\d)"[^>]*color="([^"]+)" used_m="([^"]+)"/g)].map((m) => [Number(m[1]), m[2], Number(m[3]) > 0]);

test('Bambu Studio slices paint_color triangles with four filaments (a hand-made project)', { skip }, async () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as BambuTemplate;
  const { part, band, side } = bandedCube();
  const files = unzipSync(new Uint8Array(await toBambuProject([part], 'paint', tpl, { colours: true, print: null }).arrayBuffer()));
  // Painted band by band by hand; one side of band 1 with filament 4.
  const obj = '3D/Objects/object_1.model';
  let k = 0;
  files[obj] = strToU8(strFromU8(files[obj]).replace(/<triangle ([^/]*)\/>/g, (_, a) => {
    const t = k++;
    return `<triangle ${a} paint_color="${paintColor(band[t] === 1 && side[t] === 0 ? 4 : band[t] + 1)}"/>`;
  }));
  // Four filaments in the project settings.
  const settings = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
  const colours = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'];
  for (const key of tpl.perFilament) if (Array.isArray(settings[key]) && settings[key].length) settings[key] = Array(4).fill(settings[key][0]);
  for (const key of tpl.perFilamentPlus2) settings[key] = Array(6).fill('');
  Object.assign(settings, {
    filament_colour: colours, filament_self_index: ['1', '2', '3', '4'], filament_map: ['1', '1', '1', '1'],
    flush_volumes_matrix: colours.flatMap((_, i) => colours.map((_, j) => (i === j ? '0' : '280'))), flush_volumes_vector: colours.flatMap(() => ['140', '140']),
  });
  files['Metadata/project_settings.config'] = strToU8(JSON.stringify(settings));
  const sliced = await slicedProject(zipSync(files));
  const info = strFromU8(sliced['Metadata/slice_info.config']);
  assert.deepEqual(used(info), [[1, '#FF0000', true], [2, '#00FF00', true], [3, '#0000FF', true], [4, '#FFFF00', true]]);
  // Bands change filament at 5, 10 and 15 mm; band 1 prints filaments 2 and 4 on every layer.
  const lists = [...info.matchAll(/filament_list="([^"]+)" layer_ranges="(\d+) (\d+)"/g)].map((m) => [m[1], Number(m[2])] as const).sort((a, b) => a[1] - b[1]);
  assert.deepEqual(lists.map((l) => l[0]), ['0', '1 3', '2', '3']);
  const tools = toolChanges(strFromU8(sliced['Metadata/plate_1.gcode']));
  assert.ok(tools.includes('15.2:T3') && tools.some((t) => t.startsWith('5.2:')) && tools.some((t) => t.startsWith('10.2:T2')), tools.join(' '));
});

test('Bambu Studio slices Jig\'s painted cube and a coloured figure on a base with their filaments', { skip }, async () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as BambuTemplate;
  // The cube through Jig's writer: four filaments, each band its own.
  const cube = await slicedProject(new Uint8Array(await toBambuProject([paintedCube()], 'paint', tpl, { colours: true, print: null }).arrayBuffer()));
  const info = strFromU8(cube['Metadata/slice_info.config']);
  assert.deepEqual(used(info), [[1, '#FF0000', true], [2, '#00FF00', true], [3, '#0000FF', true], [4, '#FFFF00', true]]);
  assert.deepEqual([...info.matchAll(/filament_list="([^"]+)" layer_ranges="(\d+) /g)].map((m) => [m[1], Number(m[2])] as const).sort((a, b) => a[1] - b[1]).map((l) => l[0]), ['0', '1 3', '2', '3']);

  // The mock's coloured figure, cut and joined with a base in its black: 4 filaments, all used.
  const glb = new Uint8Array(readFileSync(path.join(import.meta.dirname, 'fixtures', 'meshes', 'colour-figure.glb')));
  const { mesh } = importMeshFile(glb, 'figure.glb', { colors: true }, decodeTexture);
  const palette = meshPalette(mesh.colors!, triangleAreas(mesh.positions, mesh.indices), 4);
  const url = '/api/designs/abcdefgh/meshes/fedcba9876543210fedcba9876543210.bin';
  registerMesh(url, decodeMesh(encodeMesh(mesh)));
  const black = palette.find((c) => c.filament.name === 'PLA Basic Black')!.filament.color;
  const r = evaluateScript(`function build() { return [{ name: 'Figure', color: '${black}', shape: H.mesh('fig', { height: 40 }).translate([0, 0, 2]).add(Manifold.cylinder(2.4, 14, 14, 48)) }]; }`,
    { [MESHES_KEY]: JSON.stringify({ fig: { file: url, triangles: 1, size: [1, 1, 1], source: 'meshy', palette } }) }, 'normal');
  const project = toBambuProject(r.parts, 'figure', tpl, { colours: true, print: null });
  const fig = await slicedProject(new Uint8Array(await project.arrayBuffer()));
  const figInfo = strFromU8(fig['Metadata/slice_info.config']);
  assert.deepEqual(used(figInfo).map((f) => f[2]), [true, true, true, true]);
  assert.deepEqual(used(figInfo).map((f) => f[1]).sort(), palette.map((c) => c.filament.color.toUpperCase()).sort());
  assert.ok(toolChanges(strFromU8(fig['Metadata/plate_1.gcode'])).length >= 3);
});
