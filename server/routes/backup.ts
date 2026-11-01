// Backups: every design and the user's settings as one zip, and restoring one (or a zipped project).
import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { BackupImport } from '../../shared/api';
import { DATA_DIR } from '../config';
import { cleanMyFilaments, myFilamentsProblem } from '../../shared/filaments';
import { cleanCostSettings } from '../../shared/cost';
import { cleanTagMap } from '../../shared/tags';
import { MAX_MESH_BYTES, MESH_FILE, meshDir } from '../meshes';
import { MAX_ZIP_BYTES, openZip, writeZip, ZipError, zipSizeBound, type ZipEntry, type ZipSource } from '../backup';
import { DESIGNS, ID_RE, cleanStarred, isDesign, IMAGE_NAME, writeAtomically, type RouteContext } from './store';

// What a backup zip may hold (see /api/backup), and how large each kind of file in it may be.
const BACKUP_SETTINGS: Record<string, string> = { 'cost.json': 'cost settings', 'filaments.json': 'My filaments', 'printer.json': 'printer', 'starred.json': 'starred designs', 'tags.json': 'design tags' };
const MAX_BACKUP_ENTRIES = 100_000;
const BACKUP_LIMITS = { settings: 1024 * 1024, design: 80 * 1024 * 1024, image: 25 * 1024 * 1024, mesh: 2 * MAX_MESH_BYTES };

type BackupPath =
  | { kind: 'folder' } | { kind: 'settings' } | { kind: 'design'; id: string }
  /** An image (sub '') or a mesh file (sub 'meshes') of a design. */
  | { kind: 'file'; id: string; sub: '' | 'meshes'; name: string };

/**
 * What a path in a backup zip is, or null for anything a Jig backup never holds. Every part is
 * checked against the stored names' own patterns, so no path can lead out of the data folder.
 */
function backupPath(name: string): BackupPath | null {
  const p = name.split('/');
  if (p.length === 1) return Object.hasOwn(BACKUP_SETTINGS, name) ? { kind: 'settings' } : null;
  if (p[0] !== 'designs') return null;
  if (p.length === 2) {
    if (p[1] === '') return { kind: 'folder' };
    const id = p[1].slice(0, -'.json'.length);
    return p[1].endsWith('.json') && ID_RE.test(id) ? { kind: 'design', id } : null;
  }
  if (!ID_RE.test(p[1])) return null;
  if (p.length === 3) return p[2] === '' ? { kind: 'folder' } : IMAGE_NAME.test(p[2]) ? { kind: 'file', id: p[1], sub: '', name: p[2] } : null;
  if (p.length === 4 && p[2] === 'meshes') return p[3] === '' ? { kind: 'folder' } : MESH_FILE.test(p[3]) ? { kind: 'file', id: p[1], sub: 'meshes', name: p[3] } : null;
  return null;
}

/** The design file of a project folder ("Export project…"), zipped with or without the folder itself. */
const PROJECT_DESIGN = /^(?:[^/]+\/)?design\.jig\.json$/;

/**
 * The folder a zipped project's files are in ('' or '<name>/'), or null when the zip isn't one
 * project: it must hold exactly one design.jig.json, at the top or in one folder.
 */
function projectRoot(names: string[]): string | null {
  const found = names.filter((n) => PROJECT_DESIGN.test(n));
  return found.length === 1 ? found[0].slice(0, -'design.jig.json'.length) : null;
}

/**
 * What a path in a zipped project is: design.jig.json, images/<image> and meshes/<file> are its
 * design, with the same checks as in a backup; the rest (model.js, STL, 3MF, README…) is for people
 * and is never read or written ('other'). The design's id comes from design.jig.json (id '').
 */
function projectPath(name: string, root: string): BackupPath | { kind: 'other' } {
  if (!name.startsWith(root)) return { kind: 'other' };
  const p = name.slice(root.length).split('/');
  if (p.length === 1 && p[0] === 'design.jig.json') return { kind: 'design', id: '' };
  if (p.length === 2 && p[0] === 'images' && IMAGE_NAME.test(p[1])) return { kind: 'file', id: '', sub: '', name: p[1] };
  if (p.length === 2 && p[0] === 'meshes' && MESH_FILE.test(p[1])) return { kind: 'file', id: '', sub: 'meshes', name: p[1] };
  return { kind: 'other' };
}

export function registerBackupRoutes(app: express.Express, { designFile, imageDir, generatingDesigns, deleted, serially, changeTags }: RouteContext) {
  // ---- backups: every design (with its images and meshes) and the user's settings as one zip, and
  // back. The zip mirrors the data folder (designs/<id>.json, designs/<id>/<image>,
  // designs/<id>/meshes/<file>, cost.json, filaments.json); workspaces, Claude sessions and the
  // Bambu caches are left out (they are made again when needed).
  app.get('/api/backup', async (req, res) => {
    // A GET, so it can be a plain download link; another site's page could then start one (with an
    // <img>, say), though never read it. Only Jig's own page, the address bar or a non-browser may.
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return void res.status(403).json({ error: 'Cross-site request refused' });
    const files: ZipSource[] = Object.keys(BACKUP_SETTINGS).map((name) => ({ name, file: path.join(DATA_DIR, name), compress: true }));
    for (const f of (await readdir(DESIGNS).catch(() => [] as string[])).sort()) {
      const id = f.slice(0, -'.json'.length);
      if (!f.endsWith('.json') || !ID_RE.test(id)) continue;
      files.push({ name: `designs/${f}`, file: designFile(id), compress: true });
      for (const n of await readdir(imageDir(id)).catch(() => [] as string[])) if (IMAGE_NAME.test(n)) files.push({ name: `designs/${id}/${n}`, file: path.join(imageDir(id), n), compress: false });
      for (const n of await readdir(meshDir(id)).catch(() => [] as string[])) if (MESH_FILE.test(n)) files.push({ name: `designs/${id}/meshes/${n}`, file: path.join(meshDir(id), n), compress: false });
    }
    if (await zipSizeBound(files) > MAX_ZIP_BYTES) {
      return void res.status(500).json({ error: 'Your designs are too large for one zip (over 4 GB): back up Jig\'s data folder instead (see "Docker" in the README).' });
    }
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="jig-designs-${day}.zip"`, 'Cache-Control': 'no-store' });
    try {
      await writeZip(files, res);
    } catch (e) {
      if (!res.destroyed) console.error('[backup]', (e as Error).message);
      res.destroy();
    }
  });

  // Restores a backup zip. Designs that aren't here are added; one whose id is already here is kept
  // as it is and reported as skipped (never overwritten, even by a newer copy: delete it first to
  // take the zip's). Settings are restored only where none are saved yet.
  app.post('/api/backup/import', async (req, res) => {
    if (Number(req.headers['content-length']) > MAX_ZIP_BYTES) return void res.status(413).json({ error: 'A backup can be up to 4 GB' });
    await mkdir(DATA_DIR, { recursive: true });
    // On disk next to the designs, not in /tmp (in Docker that is memory).
    const upload = path.join(DATA_DIR, `.backup-import-${randomUUID()}.zip`);
    let zip: Awaited<ReturnType<typeof openZip>> | undefined;
    try {
      let received = 0;
      await pipeline(req, async function* (chunks: AsyncIterable<Buffer>) {
        for await (const c of chunks) {
          if ((received += c.length) > MAX_ZIP_BYTES) throw new ZipError('A backup can be up to 4 GB');
          yield c;
        }
      }, createWriteStream(upload));
      zip = await openZip(upload, MAX_BACKUP_ENTRIES);

      // Every entry is checked before anything is written: a zip with anything else in it is refused
      // whole. A zipped project ("Export project…") is one design; only its design files are read.
      const root = projectRoot(zip.entries.map((e) => e.name));
      const designs = new Map<string, { json?: ZipEntry; files: { entry: ZipEntry; sub: '' | 'meshes'; name: string }[] }>();
      const settings: ZipEntry[] = [];
      for (const entry of zip.entries) {
        const p = root === null ? backupPath(entry.name) : projectPath(entry.name, root);
        if (!p) throw new ZipError(`Not a Jig backup: it holds "${entry.name.slice(0, 100)}"`);
        if (p.kind === 'folder' || p.kind === 'other') continue;
        if (entry.size > BACKUP_LIMITS[p.kind === 'file' ? (p.sub ? 'mesh' : 'image') : p.kind]) throw new ZipError(`${entry.name} is too large`);
        if (p.kind === 'settings') { settings.push(entry); continue; }
        const design = designs.get(p.id) ?? { files: [] };
        designs.set(p.id, design);
        if (p.kind === 'design') design.json = entry;
        else design.files.push({ entry, sub: p.sub, name: p.name });
      }

      const out: BackupImport = { imported: [], skipped: [], settings: [] };
      for (const [key, { json, files }] of designs) {
        if (!json) continue; // images or meshes without their design
        const label = key || 'design.jig.json';
        let d: unknown;
        try {
          d = JSON.parse(Buffer.from(await json.read()).toString('utf8'));
        } catch (e) {
          out.skipped.push({ id: key, name: label, reason: e instanceof ZipError ? e.message : 'not a design' });
          continue;
        }
        // A backup's design must have the id it is filed under; a project's names its own.
        if (!isDesign(d) || (key ? d.id !== key : !ID_RE.test(d.id))) { out.skipped.push({ id: key, name: label, reason: 'not a complete design' }); continue; }
        const design = d, id = d.id;
        // In the design's queue, so a save from another tab can't land between the check and the write.
        const skipped = await serially(id, async () => {
          if (generatingDesigns.has(id) || existsSync(designFile(id))) return 'already here (kept as it is)';
          const written: string[] = [];
          try {
            // Its images and meshes first, the design last: it shows up only once it is whole.
            for (const f of files) {
              const dir = f.sub ? meshDir(id) : imageDir(id);
              const target = path.join(dir, f.name);
              if (existsSync(target)) continue; // named by content: the same file
              const bytes = await f.entry.read();
              await mkdir(dir, { recursive: true });
              await writeAtomically(target, bytes);
              written.push(target);
            }
            await mkdir(DESIGNS, { recursive: true });
            await writeAtomically(designFile(id), JSON.stringify(design));
            deleted.delete(id);
            return null;
          } catch (e) {
            for (const f of written) await rm(f, { force: true });
            return e instanceof ZipError ? e.message : `could not be written: ${(e as Error).message}`;
          }
        });
        if (skipped) out.skipped.push({ id, name: design.name, reason: skipped });
        else out.imported.push({ id, name: design.name });
      }

      for (const entry of settings) {
        const file = path.join(DATA_DIR, entry.name);
        // The tags of designs that have none here are added (the imported designs' tags).
        if (entry.name === 'tags.json') {
          try {
            const v = JSON.parse(Buffer.from(await entry.read()).toString('utf8')) as { tags?: unknown };
            const imported = cleanTagMap(v?.tags, (id) => ID_RE.test(id));
            let added = 0;
            await changeTags((all) => { for (const [id, tags] of Object.entries(imported)) if (!Object.hasOwn(all, id) && existsSync(designFile(id))) { all[id] = tags; added++; } });
            if (added) out.settings.push(BACKUP_SETTINGS[entry.name]);
          } catch { /* a damaged settings file is left out */ }
          continue;
        }
        if (existsSync(file)) continue;
        try {
          const v = JSON.parse(Buffer.from(await entry.read()).toString('utf8')) as { filaments?: unknown };
          if (entry.name === 'filaments.json' && myFilamentsProblem(v?.filaments)) continue;
          await writeAtomically(file, JSON.stringify(entry.name === 'cost.json' ? cleanCostSettings(v)
            : entry.name === 'starred.json' ? { ids: cleanStarred((v as { ids?: unknown }).ids) } : { filaments: cleanMyFilaments(v.filaments) }));
          out.settings.push(BACKUP_SETTINGS[entry.name]);
        } catch { /* a damaged settings file is left out */ }
      }
      res.json(out);
    } catch (e) {
      if (e instanceof ZipError) return void res.status(400).json({ error: e.message });
      if (req.destroyed) return;
      console.error('[backup]', (e as Error).message);
      res.status(500).json({ error: (e as Error).message });
    } finally {
      await zip?.close();
      await rm(upload, { force: true });
    }
  });
}
