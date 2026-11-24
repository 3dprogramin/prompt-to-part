import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { toBambuProject } from '../src/lib/bambu3mf';
import type { BambuTemplate } from '../shared/api';
import type { PartMesh, Vec3 } from '../shared/types';

type Box = [number, number, number, number, number, number]; // x0 y0 z0 x1 y1 z1

/** One part made of axis-aligned boxes. */
function part(name: string, color: string, boxes: Box[], plate?: number): PartMesh {
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
  return { name, color, positions: new Float32Array(pos), indices: new Uint32Array(idx), bbox: { min, max }, volume, surfaceArea: 0, triCount: idx.length / 3, genus: 0, components: 1, ...(plate ? { plate } : {}) };
}

const BED = 256;
const tpl: BambuTemplate = {
  version: '02.08.04.57',
  settings: { filament_colour: ['#00AE42'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0'], flush_volumes_vector: ['140', '140'], printable_area: ['0x0', `${BED}x0`, `${BED}x${BED}`, `0x${BED}`], wipe_tower_x: ['15'], wipe_tower_y: ['220'] },
  perFilament: ['filament_colour'],
  perFilamentPlus2: [],
};

// '#e4bd68' is Bambu Lab PLA Basic Gold in the filament library; '#d63a3a' is in no library: a plain colour word.
const GOLD = '#e4bd68', RED = '#d63a3a';

interface Plate { name: string; objects: string[]; boxes: { min: number[]; max: number[] }[] }

/** The project's plates in order: their names, their objects' names and where those objects lie on the plate (x, y). */
async function plates(parts: PartMesh[]): Promise<{ plates: Plate[]; settings: Record<string, unknown> }> {
  const files = unzipSync(new Uint8Array(await toBambuProject(parts, 't', tpl, { print: null, platePerColour: true }).arrayBuffer()));
  const cfg = strFromU8(files['Metadata/model_settings.config']);
  const model = strFromU8(files['3D/3dmodel.model']);
  const names = new Map([...cfg.matchAll(/<object id="(\d+)"><metadata key="name" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  // Each object's footprint: its mesh's x/y extent around its item's transform (rotation included).
  const extent = new Map<string, { min: number[]; max: number[] }>();
  for (const m of model.matchAll(/<item objectid="(\d+)" transform="([^"]+)"/g)) {
    const t = m[2].split(' ').map(Number);
    const file = new RegExp(`<object id="${m[1]}" type="model"><components><component p:path="/([^"]+)"`).exec(model)![1];
    const xs: number[] = [], ys: number[] = [];
    for (const v of strFromU8(files[file]).matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) {
      const [x, y] = [Number(v[1]), Number(v[2])];
      xs.push(x * t[0] + y * t[3] + t[9]); ys.push(x * t[1] + y * t[4] + t[10]);
    }
    extent.set(m[1], { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] });
  }
  const out = [...cfg.matchAll(/<plate><metadata key="plater_id" value="(\d+)"\/><metadata key="plater_name" value="([^"]*)"\/>.*?<\/plate>/g)].map((m) => {
    const ids = [...m[0].matchAll(/key="object_id" value="(\d+)"/g)].map((x) => x[1]);
    return { name: m[2], objects: ids.map((id) => names.get(id)!).sort(), boxes: ids.map((id) => extent.get(id)!) };
  });
  return { plates: out, settings: JSON.parse(strFromU8(files['Metadata/project_settings.config'])) };
}

/** The objects of each plate lie on its bed, clear of the edge and of each other. Plates sit in Bambu's grid (1.2 beds apart). */
function assertPacked(list: Plate[]) {
  const cols = Math.ceil(Math.sqrt(list.length) - 1e-9);
  list.forEach((pl, k) => {
    const ox = (k % cols) * BED * 1.2, oy = -Math.floor(k / cols) * BED * 1.2;
    const local = pl.boxes.map((b) => ({ min: [b.min[0] - ox, b.min[1] - oy], max: [b.max[0] - ox, b.max[1] - oy] }));
    for (const b of local) assert.ok(b.min[0] >= 1 && b.min[1] >= 1 && b.max[0] <= BED - 1 && b.max[1] <= BED - 1, `${pl.name}: ${JSON.stringify(b)} is off the bed`);
    local.forEach((a, i) => local.slice(i + 1).forEach((b) => {
      const apart = a.max[0] + 2 <= b.min[0] || b.max[0] + 2 <= a.min[0] || a.max[1] + 2 <= b.min[1] || b.max[1] + 2 <= a.min[1];
      assert.ok(apart, `${pl.name}: objects overlap ${JSON.stringify(a)} ${JSON.stringify(b)}`);
    }));
  });
}

test('one plate per colour: parts of two colours on one design plate go to two plates', async () => {
  const { plates: list, settings } = await plates([
    part('Year', GOLD, [[0, 0, 0, 40, 10, 2]]),
    part('Hat', RED, [[60, 0, 0, 90, 30, 3]]),
    part('Bauble', RED, [[100, 0, 0, 130, 30, 3]]),
  ]);
  assert.deepEqual(list.map((p) => [p.name, p.objects]), [['Gold', ['Year']], ['Red', ['Bauble', 'Hat']]]);
  assertPacked(list);
  // Every plate prints one filament: no prime tower.
  assert.equal(settings.enable_prime_tower, '0');
});

test('one plate per colour: the same colour on several design plates shares one plate', async () => {
  const { plates: list } = await plates([part('A', RED, [[0, 0, 0, 30, 30, 3]], 1), part('B', RED, [[0, 0, 0, 30, 30, 3]], 2)]);
  assert.deepEqual(list.map((p) => [p.name, p.objects]), [['Red', ['A', 'B']]]);
  assertPacked(list);
});

test('one plate per colour: pieces that overflow one bed open a second plate of the colour', async () => {
  // 60 × 60 mm squares, 70 mm apart: 3 × 3 fit on a 256 mm bed with 5 mm gaps and margins, 12 don't.
  const pieces = Array.from({ length: 12 }, (_, i) => part(`Piece ${String(i + 1).padStart(2, '0')}`, GOLD, [[i * 70, 0, 0, i * 70 + 60, 60, 2]]));
  const { plates: list } = await plates(pieces);
  assert.deepEqual(list.map((p) => p.name), ['Gold', 'Gold 2']);
  assert.deepEqual(list.map((p) => p.objects.length), [9, 3]);
  assertPacked(list);
});

test('one plate per colour: a long piece is turned to fit beside others', async () => {
  // A 240 × 100 piece leaves about 140 mm of bed above it: three 40 × 150 strips only fit there
  // turned, lying 150 wide and stacked.
  const { plates: list } = await plates([
    part('Long', RED, [[0, 0, 0, 240, 100, 2]]),
    part('S1', RED, [[0, 200, 0, 40, 350, 2]]),
    part('S2', RED, [[50, 200, 0, 90, 350, 2]]),
    part('S3', RED, [[100, 200, 0, 140, 350, 2]]),
  ]);
  assert.deepEqual(list.map((p) => [p.name, p.objects]), [['Red', ['Long', 'S1', 'S2', 'S3']]]);
  assertPacked(list);
});

test('one plate per colour: touching parts of two colours stay one object on a plate of their own', async () => {
  // A red tray with a gold part raised on its top face, and a loose gold piece.
  const { plates: list, settings } = await plates([
    part('Tray', RED, [[0, 0, 0, 100, 100, 4]]),
    part('Raised', GOLD, [[10, 10, 4, 30, 30, 5]]),
    part('Loose', GOLD, [[150, 0, 0, 170, 20, 3]]),
  ]);
  assert.deepEqual(list.map((p) => p.objects), [['Loose'], ['Tray (+1)']]);
  assert.equal(list[0].name, 'Gold');
  assert.match(list[1].name, /Tray.*Red.*Gold|Tray.*Gold.*Red/);
  assert.match(list[1].name, /colours/);
  assertPacked(list);
  // The two-colour plate keeps its prime tower.
  assert.notEqual(settings.enable_prime_tower, '0');
});
