// LayerTone filaments: looking one up, and the user's own filaments.
import express from 'express';
import { mkdir } from 'node:fs/promises';
import { claudeAuthProblem, DATA_DIR } from '../config';
import { lookupFilament } from '../filaments';
import { cleanMyFilaments, matchFilament, MAX_BRAND_CHARS, MAX_FILAMENT_NAME_CHARS, myFilamentsProblem } from '../../shared/filaments';
import { MY_FILAMENTS_FILE, readMyFilaments } from '../myFilaments';
import { writeAtomically, type RouteContext } from './store';

export function registerFilamentRoutes(app: express.Express, { json }: RouteContext, { lookup }: { lookup: typeof lookupFilament }) {
  // ---- LayerTone filaments: the library, or Claude on the web for one it doesn't have
  app.post('/api/filaments/lookup', json('2kb'), async (req, res) => {
    const { brand, name } = (req.body ?? {}) as { brand?: unknown; name?: unknown };
    if (typeof brand !== 'string' || typeof name !== 'string' || !brand.trim() || !name.trim()) return void res.status(400).json({ error: 'Send the filament\'s brand and name' });
    if (brand.length > MAX_BRAND_CHARS || name.length > MAX_FILAMENT_NAME_CHARS) return void res.status(400).json({ error: 'Brand or filament name too long' });
    const q = { brand: brand.trim(), name: name.trim() };
    const authProblem = matchFilament(q.brand, q.name) ? null : claudeAuthProblem();
    if (authProblem) return void res.status(503).json({ error: `This filament isn't in the built-in library, and looking it up needs Claude. ${authProblem}` });
    try {
      res.json(await lookup(q));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  // The user's own filaments, for every design's LayerTone panel and for Claude.
  app.get('/api/filaments/mine', async (_req, res) => {
    res.json({ filaments: await readMyFilaments() });
  });
  app.put('/api/filaments/mine', json('64kb'), async (req, res) => {
    const list = (req.body as { filaments?: unknown } | undefined)?.filaments;
    const problem = myFilamentsProblem(list);
    if (problem) return void res.status(400).json({ error: problem });
    const filaments = cleanMyFilaments(list);
    await mkdir(DATA_DIR, { recursive: true });
    await writeAtomically(MY_FILAMENTS_FILE, JSON.stringify({ filaments }));
    res.json({ filaments });
  });
}
