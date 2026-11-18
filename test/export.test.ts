import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { toBinaryStl } from '../src/lib/files';
import { to3mf } from '../src/lib/export';
import { OBJECT_ONLY, toBambuProject } from '../src/lib/bambu3mf';
import { esc } from '../src/lib/threeMf';
import { printer } from '../shared/printer';
import type { PartMesh } from '../shared/types';

function cube(name: string, x0: number, s: number, color: string): PartMesh {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]].map(([x, y, z]) => [x + x0, y, z]);
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { name, color, positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()), bbox: { min: [x0, 0, 0], max: [x0 + s, s, s] }, volume: s ** 3, surfaceArea: 6 * s * s, triCount: 12, genus: 0, components: 1 };
}
const unzip = async (b: Blob) => unzipSync(new Uint8Array(await b.arrayBuffer()));

test('binary STL layout', async () => {
  const buf = new DataView(await toBinaryStl([cube('A', 0, 10, '#ff0000')], 'Ünïcode').arrayBuffer());
  assert.equal(buf.byteLength, 84 + 50 * 12);
  assert.equal(buf.getUint32(80, true), 12);
});

test('3MF: one escaped object per part, centred on the bed', async () => {
  const files = await unzip(to3mf([cube('A & <B>', 0, 10, '#ff0000'), cube('C', 10, 10, '#00ff00')], 'T & "x"'));
  const model = strFromU8(files['3D/3dmodel.model']);
  assert.equal((model.match(/<object /g) ?? []).length, 2);
  assert.match(model, /name="A &amp; &lt;B&gt;"/);
  // Control characters XML forbids are dropped (tab, LF and CR are allowed).
  assert.equal(esc('a\u0000b\u0007c\u000B\u001F\td\ne\r<'), 'abc\td\ne\r&lt;');
  const ctl = strFromU8((await unzip(to3mf([cube('Pa\u0001rt', 0, 10, '#ff0000')], 'T\u0008')))['3D/3dmodel.model']);
  assert.match(ctl, /name="Part"/);
  assert.doesNotMatch(ctl, /[\u0000-\u0008]/);
  const xs = [...model.matchAll(/<vertex x="([^"]+)"/g)].map((m) => Number(m[1]));
  assert.equal((Math.min(...xs) + Math.max(...xs)) / 2, printer().bed[0] / 2);
  // In one colour: that colour for every part.
  const one = strFromU8((await unzip(to3mf([cube('A', 0, 10, '#ff0000'), cube('C', 10, 10, '#00ff00')], 't', '#336699')))['3D/3dmodel.model']);
  assert.match(one, /<m:colorgroup id="1"><m:color color="#336699FF"\/><\/m:colorgroup>/);
  assert.deepEqual([...new Set([...one.matchAll(/ p(?:index|1)="(\d+)"/g)].map((m) => m[1]))], ['0']);
});

test('Bambu project: per-part settings, object-only settings and filaments', async () => {
  const tpl = { version: '02.08.04.57', settings: { filament_colour: ['#00AE42'], filament_type: ['PLA'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0', '280', '280', '0'], flush_volumes_vector: ['140', '140'] }, perFilament: ['filament_colour', 'filament_type'], perFilamentPlus2: [] };
  const parts = [cube('Body', 0, 20, '#d9a441'), cube('Hook', 20, 10, '#5b9bd5')];
  const files = await unzip(toBambuProject(parts, 't', tpl, { print: { ai: {}, user: { walls: 3, parts: { Hook: { walls: 4, supports: 'tree' } } } } }));
  const cfg = strFromU8(files['Metadata/model_settings.config']);
  const hook = cfg.slice(cfg.indexOf('value="Hook"'));
  assert.match(hook, /key="wall_loops" value="4"/);
  assert.match(cfg, /<object id="\d+"><metadata key="name" value="Body \(\+1\)"\/>.*key="enable_support" value="1"/);
  assert.ok(!/<part[^]*enable_support/.test(hook), 'supports are object-only');
  const settings = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
  assert.deepEqual(settings.filament_colour, ['#D9A441', '#5B9BD5']);
  assert.equal(settings.flush_volumes_matrix.length, 4);
  assert.equal(settings.flush_volumes_vector.length, 4);
  assert.equal(settings.wall_loops, '3');
  assert.match(settings.different_settings_to_system[0], /wall_loops/);
});

test('Bambu project: the new settings stay on the object or the part the slicer reads them from', async () => {
  const tpl = { version: '02.08.04.57', settings: { filament_colour: ['#00AE42'], filament_type: ['PLA'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0', '280', '280', '0'], flush_volumes_vector: ['140', '140'] }, perFilament: ['filament_colour', 'filament_type'], perFilamentPlus2: [] };
  const parts = [cube('Body', 0, 20, '#d9a441'), cube('Hook', 20, 10, '#5b9bd5')];
  const files = await unzip(toBambuProject(parts, 't', tpl, { print: { ai: {}, user: { parts: { Hook: { supports: 'tree', supportAngle: 50, supportGap: 0.3, holeCompensation: 0.1, topOneWall: 'off', infillDirection: 90 } } } } }));
  const cfg = strFromU8(files['Metadata/model_settings.config']);
  const obj = cfg.slice(0, cfg.indexOf('<part '));
  const hook = cfg.slice(cfg.indexOf('value="Hook"'));
  // The part keeps what the slicer reads per part, and none of the object-only keys.
  assert.match(hook, /key="infill_direction" value="90"/);
  for (const key of OBJECT_ONLY) assert.ok(!hook.includes(`key="${key}"`), `${key} is not on a part`);
  for (const key of ['top_one_wall_type', 'xy_hole_compensation', 'support_threshold_angle', 'wall_generator', 'spiral_mode', 'elefant_foot_compensation']) assert.ok(OBJECT_ONLY.has(key), key);
  // The object takes the support settings of the part that turned the supports on (the main part has them off).
  assert.match(obj, /key="enable_support" value="1"/);
  assert.match(obj, /key="support_threshold_angle" value="50"/);
  assert.match(obj, /key="support_top_z_distance" value="0.3"/);
  // Spiral vase is model-wide: it goes into the project, with the walls, infill and supports it needs.
  const vase = await unzip(toBambuProject([cube('Body', 0, 20, '#d9a441')], 't', tpl, { print: { ai: {}, user: { spiralVase: true, supports: 'tree', infill: 30 } } }));
  const settings = JSON.parse(strFromU8(vase['Metadata/project_settings.config']));
  assert.equal(settings.spiral_mode, '1');
  assert.equal(settings.wall_loops, '1');
  assert.equal(settings.top_shell_layers, '0');
  assert.equal(settings.sparse_infill_density, '0%');
  assert.ok(settings.enable_support === undefined || settings.enable_support === '0', 'no supports');
  assert.doesNotMatch(strFromU8(vase['Metadata/model_settings.config']), /enable_support|support_type/);
});

test('Bambu project: spiral vase is off for a design of more than one part (the slicer refuses it)', async () => {
  const tpl = { version: '02.08.04.57', settings: { filament_colour: ['#00AE42'], filament_type: ['PLA'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0', '280', '280', '0'], flush_volumes_vector: ['140', '140'] }, perFilament: ['filament_colour', 'filament_type'], perFilamentPlus2: [] };
  for (const parts of [[cube('Body', 0, 20, '#d9a441'), cube('Lid', 20, 10, '#5b9bd5')], [cube('Body', 0, 20, '#d9a441'), cube('Lid', 40, 20, '#d9a441')]]) {
    const files = await unzip(toBambuProject(parts, 't', tpl, { print: { ai: {}, user: { spiralVase: true, walls: 3 } } }));
    const settings = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
    assert.equal(settings.spiral_mode, undefined);
    assert.equal(settings.wall_loops, '3');
    assert.equal(settings.top_shell_layers, undefined);
    assert.equal(settings.sparse_infill_density, undefined);
    assert.doesNotMatch(settings.different_settings_to_system[0], /spiral_mode|top_shell_layers|sparse_infill_density/);
    assert.doesNotMatch(strFromU8(files['Metadata/model_settings.config']), /spiral_mode|wall_loops/);
  }
});

test('Bambu project: a scarf seam switches on the filament override the slicer needs', async () => {
  const tpl = { version: '02.08.04.57', settings: { filament_colour: ['#00AE42'], filament_type: ['PLA'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0', '280', '280', '0'], flush_volumes_vector: ['140', '140'], override_filament_scarf_seam_setting: '0', seam_slope_type: 'none' }, perFilament: ['filament_colour', 'filament_type'], perFilamentPlus2: [] };
  const parts = [cube('Body', 0, 20, '#d9a441'), cube('Hook', 20, 10, '#5b9bd5')];
  const settings = async (user: object) => JSON.parse(strFromU8((await unzip(toBambuProject(parts, 't', tpl, { print: { ai: {}, user } })))['Metadata/project_settings.config']));
  const on = await settings({ scarfSeam: 'external' });
  assert.equal(on.seam_slope_type, 'external');
  assert.equal(on.override_filament_scarf_seam_setting, '1');
  assert.deepEqual(on.different_settings_to_system[0].split(';'), ['override_filament_scarf_seam_setting', 'seam_slope_type']);
  const off = await settings({ walls: 3 });
  assert.equal(off.override_filament_scarf_seam_setting, '0');
  assert.equal(off.seam_slope_type, 'none');
});
