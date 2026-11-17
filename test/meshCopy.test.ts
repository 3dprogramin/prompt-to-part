// Copying a design's mesh files to a new design (a fork) is all or nothing, and a file cut short
// at its final name by an earlier copy is not kept forever.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-mesh-copy-'));
process.env.PTP_DATA = dataDir;
const { copyMeshes, meshDir } = await import('../server/meshes');
after(() => rmSync(dataDir, { recursive: true, force: true }));

const named = (bytes: Buffer, ext: string) => `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
/** Stores files in the design's mesh folder by content; returns their names. */
function stored(id: string, n: number): string[] {
  mkdirSync(meshDir(id), { recursive: true });
  return Array.from({ length: n }, (_, i) => {
    const bytes = Buffer.from(`mesh ${id} ${i} `.repeat(1000));
    const name = named(bytes, 'bin');
    writeFileSync(path.join(meshDir(id), name), bytes);
    return name;
  });
}

test('a copy that fails part way leaves no mesh files (and no temp files) in the new design', async () => {
  stored('copy-src-0000001', 3);
  // A source entry that can't be read: a folder with a mesh file's name, made last.
  mkdirSync(path.join(meshDir('copy-src-0000001'), `${'f'.repeat(32)}.png`));
  await assert.rejects(copyMeshes('copy-src-0000001', 'copy-dst-0000001'));
  assert.deepEqual(readdirSync(meshDir('copy-dst-0000001')), []);
});

test('a file cut short at its final name is replaced by a whole copy; whole files are kept', async () => {
  const [cut, whole] = stored('copy-src-0000002', 2);
  mkdirSync(meshDir('copy-dst-0000002'), { recursive: true });
  const source = (n: string) => readFileSync(path.join(meshDir('copy-src-0000002'), n));
  writeFileSync(path.join(meshDir('copy-dst-0000002'), cut), source(cut).subarray(0, 100));
  writeFileSync(path.join(meshDir('copy-dst-0000002'), whole), source(whole));
  assert.equal(await copyMeshes('copy-src-0000002', 'copy-dst-0000002'), 2);
  for (const n of [cut, whole]) assert.ok(readFileSync(path.join(meshDir('copy-dst-0000002'), n)).equals(source(n)), n);
  assert.deepEqual(readdirSync(meshDir('copy-dst-0000002')).sort(), [cut, whole].sort());
});
