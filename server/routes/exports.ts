// Exports and fonts: a .blend of the model, and the fonts for text.
import express from 'express';
import type { BlendRequest } from '../../shared/api';
import { listFonts, loadFontBuffers } from '../fonts';
import { exportBlend } from '../blend';
import { oneAtATime, type RouteContext } from './store';

export function registerExportRoutes(app: express.Express, { json }: RouteContext) {
  // One Blender export running and one waiting at most (each body can be hundreds of MB).
  app.post('/api/export/blend', oneAtATime('Busy with another .blend export. Try again in a moment.'), json('300mb'), async (req, res) => {
    const body = req.body as BlendRequest;
    if (!body?.parts?.length) return void res.status(400).json({ error: 'no parts' });
    // Only strings reach the exporter: an object with a huge length would be walked as if it were data.
    const parts = body.parts as unknown;
    if (!Array.isArray(parts) || parts.length > 500 || !parts.every((p) => !!p && typeof p.positions === 'string' && typeof p.indices === 'string' && (p.name === undefined || typeof p.name === 'string'))) {
      return void res.status(400).json({ error: 'invalid parts' });
    }
    try {
      const file = await exportBlend(body);
      res.set({ 'Content-Type': 'application/x-blender', 'Content-Disposition': 'attachment; filename="model.blend"' }).send(file);
    } catch (e) {
      console.error('[blend]', (e as Error).message);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/fonts', async (_req, res) => {
    res.json(await listFonts());
  });

  app.get('/api/fonts/data', async (req, res) => {
    try {
      const bufs = await loadFontBuffers(String(req.query.id ?? ''));
      res.set('Cache-Control', 'max-age=86400').json({ files: bufs.map((b) => Buffer.from(b).toString('base64')) });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });
}
