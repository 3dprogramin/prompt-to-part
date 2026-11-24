import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { toBambuProject } from '../src/lib/bambu3mf';
import type { BambuTemplate } from '../shared/api';
import type { PartMesh, Vec3 } from '../shared/types';

type Box = [number, number, number, number, number, number]; // x0 y0 z0 x1 y1 z1

/** One part made of axis-aligned boxes (their triangles together, as a union mesh would look from outside). */
function part(name: string, color: string, boxes: Box[]): PartMesh {
  const pos: number[] = [], idx: number[] = [];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const base = pos.length / 3;
    pos.push(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
    f.forEach((t) => idx.push(...t.map((k) => k + base)));
  }
  const min = [0, 1, 2].map((a) => Math.min(...boxes.map((b) => b[a]))) as Vec3;
  const max = [0, 1, 2].map((a) => Math.max(...boxes.map((b) => b[a + 3]))) as Vec3;
  const volume = boxes.reduce((s, b) => s + (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]), 0);
  return { name, color, positions: new Float32Array(pos), indices: new Uint32Array(idx), bbox: { min, max }, volume, surfaceArea: 0, triCount: idx.length / 3, genus: 0, components: 1 };
}

const tpl: BambuTemplate = {
  version: '02.08.04.57',
  settings: { filament_colour: ['#00AE42'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0'], flush_volumes_vector: ['140', '140'], printable_area: ['0x0', '256x0', '256x256', '0x256'], wipe_tower_x: ['15'], wipe_tower_y: ['220'] },
  perFilament: ['filament_colour'],
  perFilamentPlus2: [],
};

/** The Bambu objects of the project, by name (an object of several parts is named "Main (+n)"). */
async function objects(parts: PartMesh[]): Promise<string[]> {
  const files = unzipSync(new Uint8Array(await toBambuProject(parts, 't', tpl, { print: null }).arrayBuffer()));
  return [...strFromU8(files['Metadata/model_settings.config']).matchAll(/<object id="\d+"><metadata key="name" value="([^"]*)"/g)].map((m) => m[1]).sort();
}

// An L-shaped tray: 100 × 100 mm box minus its top right 50 × 50 mm corner, 4 mm tall.
const tray = () => part('Tray', '#ffffff', [[0, 0, 0, 100, 50, 4], [0, 50, 0, 50, 100, 4]]);

test('a piece in the empty corner of an L-shaped part is its own object, though inside its box', async () => {
  // A 20 × 20 piece packed into the empty corner, 10 mm clear of the tray: separate prints.
  const piece = part('Piece', '#ff0000', [[65, 65, 0, 85, 85, 5]]);
  assert.deepEqual(await objects([tray(), piece]), ['Piece', 'Tray']);
});

test('parts that really touch stay one object', async () => {
  // Raised on the tray's top face: a coloured part of the tray itself.
  const onTop = part('Raised', '#00ff00', [[10, 10, 4, 30, 30, 5]]);
  // Flush against the tray's inner edge of the L, in the corner.
  const beside = part('Beside', '#0000ff', [[50, 60, 0, 60, 70, 4]]);
  assert.deepEqual(await objects([tray(), onTop, beside]), ['Tray (+2)']);
});
