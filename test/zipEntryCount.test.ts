import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { zipSync, type Zippable } from 'fflate';
import { MAX_ZIP_ENTRIES, openZip, writeZip, ZipError } from '../server/backup';

const dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-zipcount-'));
const entries = (n: number) => { const z: Zippable = {}; for (let i = 0; i < n; i++) z[`f${i}`] = new Uint8Array(0); return z; };

test('a zip whose 16-bit entry count wrapped is refused, not restored in part', async () => {
  // 65,540 entries: fflate writes the count as 4 (no ZIP64), the central directory holds all of them.
  const file = path.join(dir, 'big.zip');
  writeFileSync(file, zipSync(entries(65_540)));
  await assert.rejects(openZip(file, 200_000), (e) => e instanceof ZipError);
});

test('a zip with fewer entries than the limit still opens', async () => {
  const file = path.join(dir, 'small.zip');
  writeFileSync(file, zipSync(entries(3)));
  const z = await openZip(file, 100);
  assert.equal(z.entries.length, 3);
  await z.close();
});

test('writing more files than a zip can count fails before anything is written', async () => {
  const files = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, file: path.join(dir, 'none'), compress: false }));
  const out = new PassThrough();
  let written = 0;
  out.on('data', (c: Buffer) => { written += c.length; });
  await assert.rejects(writeZip(files, out), /too many files/i);
  assert.equal(written, 0);
});
