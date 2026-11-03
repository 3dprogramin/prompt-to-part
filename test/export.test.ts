import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { toBinaryStl } from '../src/lib/files';
import { to3mf } from '../src/lib/export';
import { toBambuProject } from '../src/lib/bambu3mf';
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
