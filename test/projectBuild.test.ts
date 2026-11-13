import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { buildJob } from '../src/lib/projectBuild';
import { BUILTIN_PRINTERS, DEFAULT_PRINTER, setPrinter, type ActivePrinter } from '../shared/printer';
import type { BambuTemplate } from '../shared/api';
import type { PartMesh } from '../shared/types';

/** A w x d x h box from (0, 0, 0). */
function box(name: string, w: number, d: number, h: number, color: string): PartMesh {
  const v = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { name, color, positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()), bbox: { min: [0, 0, 0], max: [w, d, h] }, volume: w * d * h, surfaceArea: 0, triCount: 12, genus: 0, components: 1 };
}
const parts = () => [box('Plaque', 150, 100, 3, '#ffffff')];

const tpl: BambuTemplate = {
  version: '02.08.04.57',
  settings: { filament_colour: ['#00AE42'], different_settings_to_system: ['', '', ''], flush_volumes_matrix: ['0'], flush_volumes_vector: ['140', '140'], printable_area: ['0x0', '180x0', '180x180', '0x180'], wipe_tower_x: ['15'], wipe_tower_y: ['120'] },
  perFilament: ['filament_colour'],
  perFilamentPlus2: [],
};
const mini: ActivePrinter = { ...DEFAULT_PRINTER, ...BUILTIN_PRINTERS.find((p) => p.name === 'Bambu Lab A1 mini')!, presets: DEFAULT_PRINTER.presets, filaments: 4 };

const model = (buf: ArrayBuffer) => strFromU8(unzipSync(new Uint8Array(buf))['3D/3dmodel.model']);
/** Where a Bambu project puts the object: the translation of its build item. */
const bambuAt = (xml: string) => /<item [^>]*transform="(?:\S+ ){9}(\S+) (\S+)/.exec(xml)!.slice(1).map(Number);
/** Where a plain 3MF puts the model: the centre of its vertices (the shift is baked into them). */
function plainAt(xml: string): number[] {
  const vs = [...xml.matchAll(/<vertex x="(\S+)" y="(\S+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  return [0, 1].map((k) => (Math.min(...vs.map((v) => v[k])) + Math.max(...vs.map((v) => v[k]))) / 2);
}
const bambu = async (p: ActivePrinter) => bambuAt(model(await buildJob({ kind: 'bambu', parts: parts(), title: 't', tpl, opts: { print: null }, printer: p })));
const plain = async (p: ActivePrinter) => plainAt(model(await buildJob({ kind: '3mf', parts: parts(), title: 't', oneColour: null, printer: p })));

test('a Bambu project for the A1 mini is centred on its 180 mm plate', async () => {
  setPrinter(DEFAULT_PRINTER);
  assert.deepEqual(await bambu(mini), [90, 90]);
});

test('a plain 3MF for the A1 mini is centred on its plate', async () => {
  setPrinter(DEFAULT_PRINTER);
  assert.deepEqual(await plain(mini), [90, 90]);
});

test('the worker module state follows the job, not the page', async () => {
  await bambu(mini);
  assert.deepEqual(await bambu(DEFAULT_PRINTER), [128, 128]);
  assert.deepEqual(await plain(DEFAULT_PRINTER), [128, 128]);
});
