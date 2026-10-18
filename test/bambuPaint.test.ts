import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { toBambuProject } from '../src/lib/bambu3mf';
import { DATA_DIR } from '../server/config';
import { findBambuBinary } from '../server/bambu';
import { slicedProject } from '../server/slicer';
import type { BambuTemplate } from '../shared/api';
import type { PartMesh } from '../shared/types';

// Bambu Studio's colour painting: each triangle's paint_color is the TriangleSelector state of the
// whole (unsplit) triangle, its extruder: 1 → "4", 2 → "8", 3 → "0C", 4 → "1C".
const paint = (extruder: number) => (extruder < 3 ? (extruder << 2).toString(16).toUpperCase() : `${(extruder - 3).toString(16).toUpperCase()}C`);

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

const TEMPLATE = path.join(DATA_DIR, 'bambu', 'template.json');
const canSlice = !!(await findBambuBinary()) && existsSync(TEMPLATE);

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

test('Bambu Studio slices paint_color triangles with four filaments', { skip: !canSlice && 'needs Bambu Studio and its Jig template' }, async () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as BambuTemplate;
  const { part, band, side } = bandedCube();
  const files = unzipSync(new Uint8Array(await toBambuProject([part], 'paint', tpl, { colours: true, print: null }).arrayBuffer()));
  // Painted band by band; one side of band 1 with filament 4.
  const obj = '3D/Objects/object_1.model';
  let k = 0;
  files[obj] = strToU8(strFromU8(files[obj]).replace(/<triangle ([^/]*)\/>/g, (_, a) => {
    const t = k++;
    return `<triangle ${a} paint_color="${paint(band[t] === 1 && side[t] === 0 ? 4 : band[t] + 1)}"/>`;
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
  const used = [...info.matchAll(/<filament id="(\d)"[^>]*color="([^"]+)" used_m="([^"]+)"/g)].map((m) => [Number(m[1]), m[2], Number(m[3]) > 0]);
  assert.deepEqual(used, [[1, '#FF0000', true], [2, '#00FF00', true], [3, '#0000FF', true], [4, '#FFFF00', true]]);
  // Bands change filament at 5, 10 and 15 mm; band 1 prints filaments 2 and 4 on every layer.
  const lists = [...info.matchAll(/filament_list="([^"]+)" layer_ranges="(\d+) (\d+)"/g)].map((m) => [m[1], Number(m[2])]).sort((a, b) => (a[1] as number) - (b[1] as number));
  assert.deepEqual(lists.map((l) => l[0]), ['0', '1 3', '2', '3']);
  const tools = toolChanges(strFromU8(sliced['Metadata/plate_1.gcode']));
  assert.ok(tools.includes('15.2:T3') && tools.some((t) => t.startsWith('5.2:')) && tools.some((t) => t.startsWith('10.2:T2')), tools.join(' '));
});
