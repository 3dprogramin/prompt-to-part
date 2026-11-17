// The Settings dialog's keys and services: read (secrets masked), saved and reset. The values live in
// the data folder and are laid over the environment (server/settings.ts).
import express from 'express';
import type { SettingsView } from '../../shared/api';
import type { SettingsChange } from '../../shared/settings';
import { claudeVia } from '../config';
import { forgetConnection } from '../connection';
import { forgetOpenRouterModels } from '../openRouterModels';
import { SettingsError, resetSettings, saveSettings, settingRows } from '../settings';
import type { RouteContext } from './store';
import { runningReplies } from './generate';

export function registerSettingsRoutes(app: express.Express, { json }: RouteContext, { allowRestricted }: { allowRestricted: boolean }) {
  const view = (): SettingsView => ({ rows: settingRows({ allowRestricted }), via: claudeVia(), running: runningReplies() });

  /** Runs a save or reset; after it the connection and the OpenRouter models are checked afresh. */
  const change = async (res: express.Response, what: string, fn: () => Promise<void>) => {
    try {
      await fn();
      forgetConnection();
      forgetOpenRouterModels();
      res.json(view());
    } catch (e) {
      if (e instanceof SettingsError) return void res.status(400).json({ error: e.message });
      // Never the request body: it may hold a key.
      console.error(`[settings] Could not ${what} the settings:`, (e as NodeJS.ErrnoException).code ?? (e as Error).name);
      res.status(500).json({ error: `Could not ${what} the settings.` });
    }
  };

  app.get('/api/settings', (_req, res) => void res.json(view()));
  app.put('/api/settings', json('8kb'), (req, res) => change(res, 'save', () => saveSettings((req.body as { change?: SettingsChange } | undefined)?.change as SettingsChange, { allowRestricted })));
  app.post('/api/settings/reset', (_req, res) => change(res, 'reset', () => resetSettings()));
  // A body that is not JSON or too big: Express's own handler would log JSON.parse's message, which
  // quotes the text around the mistake (part of a key), and send it back.
  app.use('/api/settings', (err: { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err.type === 'entity.too.large') return void res.status(413).json({ error: 'Too many changes at once.' });
    if (err.type !== 'entity.parse.failed') console.error('[settings] Request failed:', err.type ?? (err as Error).name);
    res.status(err.status && err.status >= 400 && err.status < 500 ? err.status : 400).json({ error: 'The changes could not be read.' });
  });
}
