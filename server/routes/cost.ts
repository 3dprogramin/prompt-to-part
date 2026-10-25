// Costs: the user's prices, slicing for grams and time, and Claude's price suggestion.
import express from 'express';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import type { PriceRequest } from '../../shared/api';
import { claudeAuthProblem, DATA_DIR } from '../config';
import { sliceProject } from '../slicer';
import { suggestPrice } from '../pricing';
import { cleanCostSettings, DEFAULT_COST_SETTINGS } from '../../shared/cost';
import { writeAtomically, type RouteContext } from './store';

export function registerCostRoutes(app: express.Express, { json }: RouteContext, { suggest }: { suggest: typeof suggestPrice }) {
  // ---- cost: the user's prices, slicing for grams and time, and Claude's price suggestion
  const COST_SETTINGS = path.join(DATA_DIR, 'cost.json');
  app.get('/api/cost/settings', async (_req, res) => {
    // Nothing saved yet (a new install or data volume): the defaults.
    res.json(cleanCostSettings(await readFile(COST_SETTINGS, 'utf8').then((t) => JSON.parse(t), () => DEFAULT_COST_SETTINGS)));
  });
  app.put('/api/cost/settings', json('10kb'), async (req, res) => {
    const s = cleanCostSettings(req.body);
    await mkdir(DATA_DIR, { recursive: true });
    await writeAtomically(COST_SETTINGS, JSON.stringify(s));
    res.json(s);
  });
  app.post('/api/slice', express.raw({ type: 'application/octet-stream', limit: '300mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return void res.status(400).json({ error: 'Send the Bambu Studio project (.3mf) as the body' });
    try {
      res.json(await sliceProject(req.body));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  app.post('/api/price', json('20kb'), async (req, res) => {
    const authProblem = claudeAuthProblem();
    if (authProblem) return void res.status(503).json({ error: authProblem });
    const r = req.body as PriceRequest;
    if (!r || typeof r.name !== 'string' || !Number.isFinite(r.grams) || !Number.isFinite(r.seconds)) return void res.status(400).json({ error: 'bad price request' });
    try {
      res.json(await suggest({ ...r, name: r.name.slice(0, 200), description: typeof r.description === 'string' ? r.description.slice(0, 1000) : undefined, size: String(r.size).slice(0, 100) }));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });
}
