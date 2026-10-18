// Backups as zip files (GET /api/backup, POST /api/backup/import; server/app.ts decides what goes in
// and what comes back out). A backup is written as a stream and read back from a file on disk, one
// entry at a time, so neither side holds the whole archive in memory: designs can carry large meshes.
import { open, stat, type FileHandle } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

const inflate = promisify(inflateRaw);

/** fflate writes no ZIP64: every size and offset in the archive must stay under 4 GiB. */
export const MAX_ZIP_BYTES = 0xffffffff;
/** Bytes a zip adds per file besides its name (local header, data descriptor, central directory entry). */
const ENTRY_OVERHEAD = 30 + 16 + 46;

export interface ZipSource {
  /** Path inside the zip. */
  name: string;
  file: string;
  /** Deflate it (text); images and meshes are stored as they are. */
  compress: boolean;
}

/** The largest zip these files could make (before compression), to refuse one that would pass 4 GiB. */
export async function zipSizeBound(files: ZipSource[]): Promise<number> {
  let total = 22;
  for (const f of files) {
    const size = await stat(f.file).then((s) => s.size, () => 0);
    // Deflate can grow incompressible data by a few bytes per block.
    total += size + Math.ceil(size / 1000) + ENTRY_OVERHEAD + 2 * f.name.length + 16;
  }
  return total;
}

/** Waits until `out` wants more data or is closed. */
const drained = (out: Writable) => new Promise<void>((resolve) => {
  const done = () => { out.off('drain', done); out.off('close', done); resolve(); };
  out.on('drain', done);
  out.on('close', done);
});

/**
 * Writes the files into `out` as a zip and ends it, a chunk at a time, waiting whenever `out` is
 * full. A file that is gone by the time its turn comes (a design deleted meanwhile) is left out.
 * Throws when `out` is closed early or a file can't be read; `out` is then not ended.
 */
export async function writeZip(files: ZipSource[], out: Writable): Promise<void> {
  let failed: Error | null = null;
  const zip = new Zip((e, data, final) => {
    if (e) failed = e;
    else if (!out.destroyed) out.write(data);
    if (final && !e) out.end();
  });
  for (const f of files) {
    let fh: FileHandle;
    try {
      fh = await open(f.file);
    } catch {
      continue;
    }
    const entry = f.compress ? new ZipDeflate(f.name, { level: 6 }) : new ZipPassThrough(f.name);
    const mtime = (await fh.stat()).mtime;
    // A zip can only hold dates from 1980 to 2099.
    entry.mtime = mtime.getFullYear() >= 1980 && mtime.getFullYear() < 2100 ? mtime : new Date();
    zip.add(entry);
    // The stream closes the file when it ends, or when the loop is left early.
    for await (const chunk of fh.createReadStream()) {
      entry.push(chunk as Uint8Array);
      if (failed) throw failed;
      if (out.writableNeedDrain) await drained(out);
      if (out.destroyed) throw new Error('The download was closed');
    }
    entry.push(new Uint8Array(0), true);
  }
  zip.end();
  if (failed) throw failed;
}

export interface ZipEntry {
  name: string;
  /** Uncompressed size, as the zip states it (read() checks it). */
  size: number;
  /** The entry's bytes, checked against its CRC; throws when it is damaged. */
  read(): Promise<Uint8Array>;
}

/** Problem with a zip file itself: not a zip, damaged, or a kind Jig doesn't read. */
export class ZipError extends Error {}

/**
 * The entries of a zip file on disk, from its central directory; each is read on demand. Only
 * stored and deflated entries, no encryption or ZIP64 (Jig's own backups never use them).
 */
export async function openZip(file: string, maxEntries: number): Promise<{ entries: ZipEntry[]; close: () => Promise<void> }> {
  const fh = await open(file);
  try {
    const { size: fileSize } = await fh.stat();
    const readAt = async (pos: number, length: number) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, pos);
      if (bytesRead !== length) throw new ZipError('The zip file is cut short');
      return buf;
    };
    // The end-of-central-directory record: the last 22 bytes, unless a comment (up to 64 KiB) follows it.
    const tailStart = Math.max(0, fileSize - 22 - 0xffff);
    const tail = await readAt(tailStart, fileSize - tailStart);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new ZipError('Not a zip file');
    const count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdStart = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdStart === 0xffffffff) throw new ZipError('ZIP64 archives are not supported');
    if (count > maxEntries) throw new ZipError(`The zip has more than ${maxEntries.toLocaleString('en')} files`);
    if (cdStart + cdSize > tailStart + eocd) throw new ZipError('The zip file is damaged');
    const cd = await readAt(cdStart, cdSize);
    const entries: ZipEntry[] = [];
    for (let i = 0, p = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The zip file is damaged');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
      const compressed = cd.readUInt32LE(p + 20), size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (p > cd.length) throw new ZipError('The zip file is damaged');
      if (flags & 1) throw new ZipError(`${name} is encrypted`);
      if (method !== 0 && method !== 8) throw new ZipError(`${name} uses a compression method Jig can't read`);
      // Stored data is as long as the file; deflate never grows it by more than a fraction.
      if (method === 0 ? compressed !== size : compressed > size + size / 8 + 1024) throw new ZipError(`${name} is damaged`);
      entries.push({
        name,
        size,
        read: async () => {
          const local = await readAt(offset, 30);
          if (local.readUInt32LE(0) !== 0x04034b50) throw new ZipError(`${name} is damaged`);
          const start = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
          if (start + compressed > cdStart) throw new ZipError(`${name} is damaged`);
          const raw = await readAt(start, compressed);
          let data: Uint8Array = raw;
          if (method === 8) {
            try {
              // Node's inflate rather than fflate's: it stops as soon as the output passes the stated
              // size, so a lying entry (a zip bomb) can't make it grow or run for long.
              data = await inflate(raw, { maxOutputLength: Math.max(size, 1) });
            } catch {
              throw new ZipError(`${name} is damaged`);
            }
          }
          if (data.length !== size || crc32(data) !== crc) throw new ZipError(`${name} is damaged`);
          return data;
        },
      });
    }
    return { entries, close: () => fh.close() };
  } catch (e) {
    await fh.close();
    throw e;
  }
}
