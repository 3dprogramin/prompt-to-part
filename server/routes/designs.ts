// The designs: the list, loading and saving one, stars, tags and deleting.
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { workspaceDir } from '../agent';
import { DATA_DIR } from '../config';
import type { Design, DesignSummary } from '../../shared/types';
import { designKind } from '../../shared/designKind';
import { cleanTags, hasTag, MAX_TAGS, tagsProblem, withTag } from '../../shared/tags';
import { DESIGNS, ID_RE, STARRED_FILE, readStarred, readTags, isDesign, writeAtomically, type RouteContext } from './store';

export function registerDesignRoutes(app: express.Express, { json, designFile, imageDir, generatingDesigns, deleted, serially, changeTags, putTags }: RouteContext) {
  app.get('/api/designs', async (_req, res) => {
    await mkdir(DESIGNS, { recursive: true });
    const out: DesignSummary[] = [];
    const starred = new Set(await readStarred().catch(() => []));
    const tags = await readTags().catch(() => ({} as Record<string, string[]>));
    for (const f of await readdir(DESIGNS)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await readFile(path.join(DESIGNS, f), 'utf8')) as Design;
        out.push({
          id: d.id, name: String(d.name ?? 'Untitled design'), updatedAt: Number(d.updatedAt) || 0, createdAt: Number(d.createdAt) || 0,
          versions: Array.isArray(d.versions) ? d.versions.length : 0, kind: designKind(d.code, d.values),
          ...(starred.has(d.id) && { starred: true }), ...(Object.hasOwn(tags, d.id) && { tags: tags[d.id] }),
        });
      } catch { /* skip corrupt */ }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json(out);
  });

  app.get('/api/designs/:id', async (req, res) => {
    if (!ID_RE.test(req.params.id)) return void res.status(400).json({ error: 'bad id' });
    try {
      res.type('json').send(await readFile(designFile(req.params.id), 'utf8'));
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  });

  app.put('/api/designs/:id', json('80mb'), async (req, res) => {
    const d: unknown = req.body;
    if (!ID_RE.test(req.params.id) || (d as Design)?.id !== req.params.id) return void res.status(400).json({ error: 'bad id' });
    if (!isDesign(d)) return void res.status(400).json({ error: 'Not a complete design' });
    const file = designFile(d.id);
    await serially(d.id, async () => {
      // Every save names the revision it was based on (`rev`, counted up by each save), so a copy
      // that missed a save from another tab can't overwrite it. A design that is gone is not
      // re-created by a copy that had been saved before.
      const stored = await readFile(file, 'utf8').then((t) => Number(JSON.parse(t).rev) || 0, () => null);
      const base = d.rev ?? 0;
      if (stored === null && (deleted.has(d.id) || base > 0)) return void res.status(410).json({ error: 'This design was deleted' });
      if (stored !== null && base !== stored) return void res.status(409).json({ error: 'A newer version of this design was saved in another tab', rev: stored });
      const rev = (stored ?? 0) + 1;
      await mkdir(DESIGNS, { recursive: true });
      await writeAtomically(file, JSON.stringify({ ...d, rev }));
      res.json({ ok: true, rev });
    });
  });

  // Star or unstar a design. One change at a time, so two quick clicks can't lose one.
  let starring = Promise.resolve();
  app.put('/api/designs/:id/star', json('1kb'), (req, res) => {
    const id = req.params.id;
    if (!ID_RE.test(id) || typeof req.body?.starred !== 'boolean') return void res.status(400).json({ error: 'Expected { starred: true | false }' });
    starring = starring.then(async () => {
      const ids = (await readStarred()).filter((x) => x !== id);
      if (req.body.starred) ids.push(id);
      await mkdir(DATA_DIR, { recursive: true });
      await writeAtomically(STARRED_FILE, JSON.stringify({ ids }));
      res.json({ starred: req.body.starred });
    }).catch((e: Error) => { res.status(500).json({ error: e.message }); });
  });

  // Set a design's tags: { tags: [...] } replaces them all.
  app.put('/api/designs/:id/tags', json('10kb'), async (req, res) => {
    const id = req.params.id;
    const problem = !ID_RE.test(id) ? 'bad id' : tagsProblem(req.body?.tags);
    if (problem) return void res.status(400).json({ error: `Expected { tags: [...] }: ${problem}` });
    const tags = cleanTags(req.body.tags);
    try {
      let found = true;
      await changeTags((all) => { found = existsSync(designFile(id)); if (found) putTags(all, id, tags); });
      if (!found) return void res.status(404).json({ error: 'not found' });
      res.json({ tags });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Add a tag to several designs, or take one away: { ids, add } or { ids, remove }. Designs that
  // are gone, or already have MAX_TAGS other tags, are left as they are; the reply lists the changed.
  app.post('/api/designs/tags', json('100kb'), async (req, res) => {
    const { ids, add, remove } = (req.body ?? {}) as { ids?: unknown; add?: unknown; remove?: unknown };
    const tag = add ?? remove;
    const problem = !Array.isArray(ids) || !ids.length || ids.length > 5000 || !ids.every((x) => typeof x === 'string' && ID_RE.test(x)) ? 'ids must be a list of design ids'
      : (add === undefined) === (remove === undefined) ? 'give either add or remove' : tagsProblem([tag]);
    if (problem) return void res.status(400).json({ error: `Expected { ids: [...], add: "tag" } or { ids: [...], remove: "tag" }: ${problem}` });
    try {
      const changed: string[] = [];
      await changeTags((all) => {
        for (const id of new Set(ids as string[])) {
          if (!existsSync(designFile(id))) continue;
          const before = all[id] ?? [];
          if (add !== undefined && !hasTag(before, tag as string) && before.length >= MAX_TAGS) continue;
          const after = withTag(before, tag as string, add !== undefined);
          if (after.join('\n') === before.join('\n')) continue;
          putTags(all, id, after);
          changed.push(id);
        }
      });
      res.json({ changed });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.delete('/api/designs/:id', async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return void res.status(400).json({ error: 'bad id' });
    if (generatingDesigns.has(id)) return void res.status(409).json({ error: 'Jig is working on this design – stop it first.' });
    await serially(id, async () => {
      deleted.add(id);
      await rm(designFile(id), { force: true });
      await rm(imageDir(id), { recursive: true, force: true });
      await rm(workspaceDir(id), { recursive: true, force: true });
    });
    // Its tags go with it (its star stays, as before: harmless).
    await changeTags((all) => { delete all[id]; }).catch(() => undefined);
    res.json({ ok: true });
  });
}
