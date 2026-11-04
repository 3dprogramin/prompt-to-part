import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { toBambuProject } from '../src/lib/bambu3mf';
import { DATA_DIR } from '../server/config';
import { findBambuBinary, templateFile } from '../server/bambu';
import { DEFAULT_PRINTER } from '../shared/printer';
import { slicedProject } from '../server/slicer';
import type { BambuTemplate } from '../shared/api';
import type { PartMesh } from '../shared/types';

/** A w × d × h box from (x0, 0, 0). */
function box(name: string, x0: number, w: number, d: number, h: number, color: string): PartMesh {
  const v = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]].map(([x, y, z]) => [x + x0, y, z]);
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { name, color, positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()), bbox: { min: [x0, 0, 0], max: [x0 + w, d, h] }, volume: w * d * h, surfaceArea: 0, triCount: 12, genus: 0, components: 1 };
}
/** A plaque w × d of `colours.length` strips side by side, one colour each. */
const plaque = (w: number, d: number, colours: string[]) => colours.map((c, i) => box(`Strip ${i + 1}`, (i * w) / colours.length, w / colours.length, d, 3, c));

const tpl: BambuTemplate = {
  version: '02.08.04.57',
  settings: { filament_colour: ['#00AE42'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0'], flush_volumes_vector: ['140', '140'], printable_area: ['0x0', '256x0', '256x256', '0x256'], wipe_tower_x: ['15'], wipe_tower_y: ['220'] },
  perFilament: ['filament_colour'],
  perFilamentPlus2: [],
};
const project = async (parts: PartMesh[], t = tpl) => unzipSync(new Uint8Array(await toBambuProject(parts, 't', t, { print: null }).arrayBuffer()));
const settingsOf = (files: Record<string, Uint8Array>) => JSON.parse(strFromU8(files['Metadata/project_settings.config']));
/** Where the build puts the object (its centre on the plate). */
const placed = (files: Record<string, Uint8Array>) => /<item [^>]*transform="(?:\S+ ){9}(\S+) (\S+)/.exec(strFromU8(files['3D/3dmodel.model']))!.slice(1).map(Number);

test('prime tower: beside the model, clear of it, also when the model is big', async () => {
  // A 160 × 218 mm plaque centred on the bed starts at x 48: the template's tower (x 15, 31 mm
  // wide) would overlap it. The tower goes 10 mm to its left, level with its back.
  const big = await project(plaque(160, 218, ['#ffffff', '#000000']));
  assert.equal(settingsOf(big).enable_prime_tower, undefined);
  assert.deepEqual([settingsOf(big).wipe_tower_x, settingsOf(big).wipe_tower_y], [['9.2'], ['208.2']]);
  assert.deepEqual(placed(big), [128, 128]);

  // Four filaments make a 46 mm tower: no room beside the centred plaque, so it moves right.
  const four = await project(plaque(160, 218, ['#ffffff', '#000000', '#ff0000', '#0000ff']));
  assert.deepEqual(placed(four), [171, 128]);
  assert.deepEqual(settingsOf(four).wipe_tower_x, ['37.2'], 'its 47 mm ending 10 mm before the plaque at x 91');

  // Nowhere to put it: no tower (the A1 purges into its chute).
  const full = await project(plaque(250, 250, ['#ffffff', '#000000']));
  assert.equal(settingsOf(full).enable_prime_tower, '0');
  assert.deepEqual(placed(full), [128, 128]);

  // One filament: no tower to place.
  assert.deepEqual(settingsOf(await project(plaque(160, 218, ['#ffffff']))).wipe_tower_x, ['15']);
});

// The A1 0.4's template (data/bambu/template.json before printers could be chosen).
const TEMPLATE = [templateFile(DEFAULT_PRINTER), path.join(DATA_DIR, 'bambu', 'template.json')].find((f) => existsSync(f)) ?? '';
const canSlice = !!(await findBambuBinary()) && !!TEMPLATE;

test('Bambu Studio slices a big two-colour plaque with its prime tower', { skip: !canSlice && 'needs Bambu Studio and its prompt-to-part template' }, async () => {
  const realTpl = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as BambuTemplate;
  const sliced = await slicedProject(new Uint8Array(await toBambuProject(plaque(160, 218, ['#ffffff', '#000000']), 't', realTpl, { print: null }).arrayBuffer()));
  const objects = (JSON.parse(strFromU8(sliced['Metadata/plate_1.json'])) as { bbox_objects: { name: string; bbox: number[] }[] }).bbox_objects;
  const tower = objects.find((o) => o.name === 'wipe_tower')!.bbox, model = objects.find((o) => o.name !== 'wipe_tower')!.bbox;
  assert.ok(tower[2] <= model[0] - 10, `the tower ends ${model[0] - tower[2]} mm from the model`);
});
