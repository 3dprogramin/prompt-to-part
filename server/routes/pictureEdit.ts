// Picture edits: part of a design's picture changed by the image model (server/pictureEdit). One
// at a time per design; while one runs a marker file in the temp folder says so, so the owner's
// Docker rebuild (scripts/rebuild.sh) waits for it like for a reply.
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { artworkAvailable, requestImage } from '../artwork';
import { editPicture, PictureEditError, pictureEditProblem } from '../pictureEdit/index';
import type { PictureEditRequest, PictureEditResponse } from '../../shared/api';
import { ID_RE, type RouteContext } from './store';

/** The marker file of a running picture edit (scripts/rebuild.sh looks for /tmp/ptp-busy-*). */
export const pictureEditBusyFile = (id: string) => path.join(os.tmpdir(), `ptp-busy-picture-edit-${id}`);

export function registerPictureEditRoutes(app: express.Express, { json, deleted, generatingDesigns }: RouteContext, { image }: { image: typeof requestImage }) {
  // Designs with a picture edit under way. They are in `generatingDesigns` too while it runs, so a
  // reply can't start on the design and the design can't be deleted meanwhile, and the other way round.
  const running = new Set<string>();

  // The values sent hold the drawing (up to 40,000 points) and the photos.
  app.post('/api/designs/:id/picture-edit', json('40mb'), async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return void res.status(400).json({ error: 'bad id' });
    const body = req.body as PictureEditRequest;
    const problem = pictureEditProblem(body);
    if (problem) return void res.status(400).json({ error: problem });
    if (!artworkAvailable()) return void res.status(503).json({ error: 'Picture edits need an OpenRouter key: set OPENROUTER_API_KEY in .env and restart prompt-to-part.' });
    if (deleted.has(id)) return void res.status(410).json({ error: 'This design was deleted' });
    if (running.has(id)) return void res.status(409).json({ error: 'A picture edit is already running for this design' });
    if (generatingDesigns.has(id)) return void res.status(409).json({ error: 'A reply is being written for this design: wait for it to finish or stop it, then edit the picture.' });
    running.add(id);
    generatingDesigns.add(id);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    const busy = pictureEditBusyFile(id);
    let result: PictureEditResponse | undefined, error: unknown;
    try {
      await writeFile(busy, `${process.pid}\n`);
      result = await editPicture(body, { image, signal: abort.signal, id });
    } catch (e) {
      error = e;
    } finally {
      // Not busy any more before the answer goes out.
      running.delete(id);
      generatingDesigns.delete(id);
      await rm(busy, { force: true }).catch(() => undefined);
    }
    if (abort.signal.aborted) return;
    if (result) return void res.json(result);
    const status = error instanceof PictureEditError ? error.status : 502;
    if (status >= 500) console.error('[picture-edit]', (error as Error).message);
    res.status(status).json({ error: (error as Error).message });
  });
}
