// The designs: the list, loading and saving one, stars, tags and deleting.
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { workspaceDir } from '../agent';
import { DATA_DIR } from '../config';
import type { Design, DesignSummary } from '../../shared/types';
import { designKind } from '../../shared/designKind';
import { cleanTags, hasTag, MAX_TAGS, tagsProblem, withTag } from '../../shared/tags';
import type { PrintedMap } from '../../shared/printed';
import { printedGuard, readPrinted } from '../printed';
import { DESIGNS, ID_RE, STARRED_FILE, readStarred, readTags, isDesign, writeAtomically, type RouteContext } from './store';

type Summary = Omit<DesignSummary, 'starred' | 'tags' | 'printed'>;

/** A design file's summary for the list, or null when it isn't one (corrupt). */
function summarize(text: string): Summary | null {
  try {
    const d = JSON.parse(text) as Design;
    return {
      id: d.id, name: String(d.name ?? 'Untitled design'), updatedAt: Number(d.updatedAt) || 0, createdAt: Number(d.createdAt) || 0,
      versions: Array.isArray(d.versions) ? d.versions.length : 0, kind: designKind(d.code, d.values),
    };
  } catch {
    return null;
  }
}

export function registerDesignRoutes(app: express.Express, { json, designFile, imageDir, generatingDesigns, deleted, serially, changeTags, putTags }: RouteContext) {
  // The list's summaries by design file name, with the file's time and size they were read at: the
  // list reads only the files changed since (a design file can be tens of MB). Saves and deletes
  // here drop their entry; other writes (a restored backup) show in the time and size.
  const summaries = new Map<string, { mtimeMs: number; size: number; summary: Summary | null }>();
  app.get('/api/designs', async (_req, res) => {
    await mkdir(DESIGNS, { recursive: true });
    const out: DesignSummary[] = [];
    const starred = new Set(await readStarred().catch(() => []));
    const tags = await readTags().catch(() => ({} as Record<string, string[]>));
    const printed = await readPrinted().catch(() => ({} as PrintedMap));
    const files = (await readdir(DESIGNS)).filter((f) => f.endsWith('.json'));
    const here = new Set(files);
    for (const f of summaries.keys()) if (!here.has(f)) summaries.delete(f);
    for (const f of files) {
      const file = path.join(DESIGNS, f);
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) continue;
      let cached = summaries.get(f);
      if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        const text = await readFile(file, 'utf8').catch(() => null);
        if (text === null) continue;
        cached = { mtimeMs: st.mtimeMs, size: st.size, summary: summarize(text) };
        summaries.set(f, cached);
      }
      const d = cached.summary;
      if (!d) continue; // corrupt
      out.push({ ...d, ...(starred.has(d.id) && { starred: true }), ...(Object.hasOwn(tags, d.id) && { tags: tags[d.id] }), ...(Object.hasOwn(printed, d.id) && { printed: printed[d.id].map(({ fp: _fp, ...m }) => m) }) });
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
      // A printed version stays as it was printed: a save that changes or drops one is refused.
      const marks = (await readPrinted())[d.id];
      const broken = marks && printedGuard(d, marks);
      if (broken) return void res.status(423).json({ error: `Printed v${broken.v + 1} is locked: clone it to change it.` });
      const rev = (stored ?? 0) + 1;
      await mkdir(DESIGNS, { recursive: true });
      await writeAtomically(file, JSON.stringify({ ...d, rev }));
      summaries.delete(path.basename(file));
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
    if (generatingDesigns.has(id)) return void res.status(409).json({ error: 'This design is being worked on: stop it first.' });
    const marks = (await readPrinted())[id];
    if (marks) return void res.status(409).json({ error: `Kept: it has printed versions (${marks.map((m) => `v${m.v + 1}`).join(', ')}). Unmark them first.` });
    await serially(id, async () => {
      deleted.add(id);
      await rm(designFile(id), { force: true });
      summaries.delete(path.basename(designFile(id)));
      await rm(imageDir(id), { recursive: true, force: true });
      await rm(workspaceDir(id), { recursive: true, force: true });
    });
    // Its tags go with it (its star stays, as before: harmless).
    await changeTags((all) => { delete all[id]; }).catch(() => undefined);
    res.json({ ok: true });
  });
}
