// Printed versions: mark one (with the 3MF it was printed from), download that file, unmark it.
import express from 'express';
import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import type { Design } from '../../shared/types';
import { MAX_PRINTED_BYTES, printedFileName, type PrintedMark } from '../../shared/printed';
import { slug } from '../../shared/slug';
import { versionFingerprint } from '../printed';
import { ID_RE, writeAtomically, type RouteContext } from './store';

export function registerPrintedRoutes(app: express.Express, { designFile, imageDir, generatingDesigns, serially, changePrinted }: RouteContext) {
  const fileOf = (id: string, v: number) => path.join(imageDir(id), 'printed', printedFileName(v));
  /** The version index in the URL, or null when it isn't one. */
  const indexOf = (s: string) => (/^\d{1,5}$/.test(s) ? Number(s) : null);
  const without = ({ fp: _fp, ...mark }: PrintedMark) => mark;

  // Mark version v printed. The body is its 3MF (none: marked without a file); ?settings=1 says it has print settings.
  app.post('/api/designs/:id/printed/:v', express.raw({ type: 'application/octet-stream', limit: MAX_PRINTED_BYTES }), async (req, res) => {
    const { id } = req.params;
    const v = indexOf(req.params.v);
    if (!ID_RE.test(id) || v === null) return void res.status(400).json({ error: 'bad id or version' });
    const bytes = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
    await serially(id, async () => {
      const design = await readFile(designFile(id), 'utf8').then((t) => JSON.parse(t) as Design, () => null);
      if (!design) return void res.status(404).json({ error: 'not found' });
      if (generatingDesigns.has(id)) return void res.status(409).json({ error: 'This design is being worked on: stop it first.' });
      const version = design.versions[v];
      if (!version) return void res.status(400).json({ error: `This design has no version ${v + 1}` });
      const file = fileOf(id, v);
      if (bytes) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeAtomically(file, bytes);
      } else {
        await rm(file, { force: true });
      }
      const mark: PrintedMark = { v, at: Date.now(), fp: versionFingerprint(version), file: !!bytes, settings: !!bytes && req.query.settings === '1' };
      await changePrinted((all) => { all[id] = [...(all[id] ?? []).filter((m) => m.v !== v), mark].sort((a, b) => a.v - b.v); });
      res.json(without(mark));
    });
  });

  app.delete('/api/designs/:id/printed/:v', async (req, res) => {
    const { id } = req.params;
    const v = indexOf(req.params.v);
    if (!ID_RE.test(id) || v === null) return void res.status(400).json({ error: 'bad id or version' });
    await serially(id, async () => {
      await changePrinted((all) => {
        const rest = (all[id] ?? []).filter((m) => m.v !== v);
        if (rest.length) all[id] = rest; else delete all[id];
      });
      await rm(fileOf(id, v), { force: true });
      res.json({ ok: true });
    });
  });

  app.get('/api/designs/:id/printed/:v/3mf', async (req, res) => {
    const { id } = req.params;
    const v = indexOf(req.params.v);
    if (!ID_RE.test(id) || v === null) return void res.status(400).json({ error: 'bad id or version' });
    const name = await readFile(designFile(id), 'utf8').then((t) => String((JSON.parse(t) as Design).name ?? ''), () => '');
    res.download(fileOf(id, v), `${slug(name)}-v${v + 1}.3mf`, { headers: { 'Content-Type': 'model/3mf', 'Cache-Control': 'no-store' } }, (e) => {
      if (e && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  });
}
