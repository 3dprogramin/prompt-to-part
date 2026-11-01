// The user's printer: GET lists every printer (Bambu Studio's and the user's own presets, read again
// each time) with the chosen one, PUT saves a choice.
import type express from 'express';
import { loadPrinterSetting, savePrinterSetting } from '../printerSetting';
import type { RouteContext } from './store';

export function registerPrinterRoutes(app: express.Express, { json }: RouteContext) {
  app.get('/api/printer', async (_req, res) => {
    res.json(await loadPrinterSetting());
  });
  app.put('/api/printer', json('2kb'), async (req, res) => {
    const b = (req.body ?? {}) as { printerId?: unknown; filaments?: unknown };
    if (typeof b.printerId !== 'string' || !b.printerId) return void res.status(400).json({ error: 'Send printerId' });
    try {
      res.json(await savePrinterSetting({ printerId: b.printerId, filaments: Number(b.filaments) }));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
}
