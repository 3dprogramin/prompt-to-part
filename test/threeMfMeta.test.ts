import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { to3mf } from '../src/lib/threeMf';
import type { PartMesh } from '../shared/types';

function cubePart(name: string, color: string): PartMesh {
  const s = 10;
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { name, color, positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()), bbox: { min: [0, 0, 0], max: [s, s, s] }, volume: s ** 3, surfaceArea: 6 * s * s, triCount: 12, genus: 0, components: 1 };
}

test('to3mf writes the metadata it is given', async () => {
  const blob = to3mf([cubePart('Sign', '#ffffff')], 'Sign', null, { Designer: 'Shop & Co', LicenseTerms: 'Prints only' });
  const model = strFromU8(unzipSync(new Uint8Array(await blob.arrayBuffer()))['3D/3dmodel.model']);
  assert.match(model, /<metadata name="Designer">Shop &amp; Co<\/metadata>/);
  assert.match(model, /<metadata name="LicenseTerms">Prints only<\/metadata>/);
});

test('threeMf.ts imports nothing from the app shell', async () => {
  const src = await readFile('src/lib/threeMf.ts', 'utf8');
  assert.doesNotMatch(src, /from '\.\/(api|projects|glb)'|from 'react'/);
});
