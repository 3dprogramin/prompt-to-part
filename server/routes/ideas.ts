// New starter ideas for the empty chat.
import express from 'express';
import { claudeAuthProblem } from '../config';
import { artworkAvailable } from '../artwork';
import { meshyAvailable } from '../meshy';
import { IDEAS_TIMEOUT_MESSAGE, type writeIdeas } from '../ideas';
import { printer } from '../../shared/printer';
import { ideaModes, ideasPrompt, parseIdeas, topUp } from '../../shared/ideas';
import type { RouteContext } from './store';

const IDEAS_FAILED = "Couldn't come up with ideas. Try again.";

export function registerIdeaRoutes(app: express.Express, { json }: RouteContext, { ideas }: { ideas: typeof writeIdeas }) {
  app.post('/api/ideas', json('8kb'), async (req, res) => {
    const shown = (req.body as { shown?: unknown } | undefined)?.shown ?? [];
    if (!Array.isArray(shown) || shown.length > 8 || !shown.every((s) => typeof s === 'string' && s.length <= 200)) {
      return void res.status(400).json({ error: 'Send the ideas on show (at most 8, each under 200 characters)' });
    }
    const authProblem = claudeAuthProblem();
    if (authProblem) return void res.status(503).json({ error: authProblem });
    const modes = ideaModes({ artwork: artworkAvailable(), meshy: meshyAvailable() });
    const p = printer();
    try {
      const seen = new Set(shown.map((s) => s.trim().toLowerCase()));
      const parsed = parseIdeas(await ideas(ideasPrompt({ modes, bed: p.bed, height: p.height, printerName: p.name, shown })), modes)
        .filter((i) => !seen.has(i.text.trim().toLowerCase()));
      if (!parsed.length) return void res.status(502).json({ error: IDEAS_FAILED });
      res.json({ ideas: topUp(parsed, modes, shown) });
    } catch (e) {
      const msg = (e as Error).message;
      console.error('ideas:', msg);
      res.status(502).json({ error: msg === IDEAS_TIMEOUT_MESSAGE ? msg : IDEAS_FAILED });
    }
  });
}
