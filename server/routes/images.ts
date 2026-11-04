// A design's images (stored by content) and its product photos, made by the image model from a render.
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { claudeAuthProblem } from '../config';
import { writeScene } from '../photoScene';
import { artworkAvailable, requestImage } from '../artwork';
import { IDEA_SCENE, MAX_NOTES_CHARS, photoEditPrompt, photoProblem, photoPrompt, sceneById, SHOP_IMAGE_SIZE, sizeVariantPrompt, type PhotoRequest, type PhotoResponse, type PhotoSceneRequest, type PhotoSceneResponse } from '../../shared/photos';
import type { Vec3 } from '../../shared/types';
import { contentHash, ID_RE, IMAGE_TYPES, IMAGE_NAME, writeAtomically, type RouteContext } from './store';

/** Largest render sent for a product photo. */
const MAX_RENDER_BYTES = 15 * 1024 * 1024;

export function registerImageRoutes(app: express.Express, { json, imageDir, deleted, serially }: RouteContext, { image, sceneWriter }: { image: typeof requestImage; sceneWriter: typeof writeScene }) {
  /** Stores an image with the design, named by its content: its URL, or null if the design was deleted. */
  const storeImage = (id: string, bytes: Buffer, ext: string) => {
    const name = `${contentHash(bytes)}.${ext}`;
    // In the design's queue, so a delete can't run between the check and the write.
    return serially(id, async () => {
      if (deleted.has(id)) return null;
      const target = path.join(imageDir(id), name);
      await mkdir(imageDir(id), { recursive: true });
      // Written whole or not at all: a half-written file would be served (and cached) forever.
      if (!existsSync(target)) await writeAtomically(target, bytes);
      return `/api/designs/${id}/images/${name}`;
    });
  };

  app.post('/api/designs/:id/images', json('20mb'), async (req, res) => {
    const { id } = req.params;
    const { mediaType, data } = (req.body ?? {}) as { mediaType?: unknown; data?: unknown };
    const ext = IMAGE_TYPES[String(mediaType)];
    if (!ID_RE.test(id) || !ext || typeof data !== 'string') return void res.status(400).json({ error: 'bad image' });
    const url = await storeImage(id, Buffer.from(data, 'base64'), ext);
    if (!url) return void res.status(410).json({ error: 'This design was deleted' });
    res.json({ url });
  });

  /** A render sent with a photo request as bytes, or what is wrong with it. */
  const checkedRender = (r: { mediaType: string; data: string }): Buffer | string => {
    const bytes = Buffer.from(r.data, 'base64');
    const png = bytes[0] === 0x89 && bytes[1] === 0x50, jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    return bytes.length > MAX_RENDER_BYTES || !(r.mediaType === 'image/png' ? png : jpg) ? `The render must be a PNG or JPEG of up to ${MAX_RENDER_BYTES / 1024 / 1024} MB` : bytes;
  };

  // Product photos: the image model turns a clean render of the model into a photo of the printed
  // product in a scene. The photo and the render are stored with the design's images; the app
  // lists them in the design (Design.photos). A shop set's photo is made at 2K, for the shop's zoom.
  app.post('/api/designs/:id/photos', json('25mb'), async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return void res.status(400).json({ error: 'bad id' });
    const body = req.body as PhotoRequest;
    const problem = photoProblem(body);
    if (problem) return void res.status(400).json({ error: problem });
    if (!artworkAvailable()) return void res.status(503).json({ error: 'Product photos need an OpenRouter key: set OPENROUTER_API_KEY in .env and restart prompt-to-part.' });
    if (deleted.has(id)) return void res.status(410).json({ error: 'This design was deleted' });
    // A new photo is made from the render sent; a change starts from a stored photo of this design
    // (and its render, as the product's reference).
    let references: string[], render: Buffer | null = null, renderUrl: string | null = null, prompt: string;
    if (body.from) {
      const stored = async (url: string) => {
        const [, owner, name] = /^\/api\/designs\/([^/]+)\/images\/([^/]+)$/.exec(url) ?? [];
        if (owner !== id || !IMAGE_NAME.test(name ?? '')) throw new Error('Only a photo of this design can be changed');
        const type = Object.keys(IMAGE_TYPES).find((t) => IMAGE_TYPES[t] === name.split('.')[1])!;
        return `data:${type};base64,${(await readFile(path.join(imageDir(id), name))).toString('base64')}`;
      };
      // The product from a new render (the view turned to another angle) or the photo's own.
      if (body.render) {
        const sent = checkedRender(body.render);
        if (typeof sent === 'string') return void res.status(400).json({ error: sent });
        render = sent;
      } else if (!body.from.render) return void res.status(400).json({ error: 'That photo has no render stored: make a new photo instead' });
      try {
        references = [body.render ? `data:${body.render.mediaType};base64,${body.render.data}` : await stored(body.from.render!), await stored(body.from.photo)];
      } catch (e) {
        return void res.status((e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400).json({ error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'That photo is no longer stored' : (e as Error).message });
      }
      renderUrl = body.render ? null : body.from.render!;
      // Another sale size of the photo: its scene kept, the product at this size (its own render).
      prompt = body.resize ? sizeVariantPrompt(body) : photoEditPrompt(body);
    } else {
      const r = body.render!;
      const sent = checkedRender(r);
      if (typeof sent === 'string') return void res.status(400).json({ error: sent });
      render = sent;
      references = [`data:${r.mediaType};base64,${r.data}`];
      prompt = photoPrompt(body);
    }
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      const out = await image(prompt, body.aspect, references, abort.signal, undefined, body.shop ? SHOP_IMAGE_SIZE : undefined);
      const ext = IMAGE_TYPES[out.image.mediaType];
      if (!ext) throw new Error(`The image model returned a picture format that can't be stored (${out.image.mediaType})`);
      const photo = await storeImage(id, Buffer.from(out.image.data, 'base64'), ext);
      if (render) renderUrl = photo && await storeImage(id, render, IMAGE_TYPES[body.render!.mediaType]);
      if (!photo || (render && !renderUrl)) return void res.status(410).json({ error: 'This design was deleted' });
      res.json({ photo, render: renderUrl ?? undefined, prompt, model: out.model, cost: out.cost } satisfies PhotoResponse);
    } catch (e) {
      if (abort.signal.aborted) return;
      console.error('[photos]', (e as Error).message);
      res.status(502).json({ error: (e as Error).message });
    }
  });

  // A random sub-scene: a fresh setting of a preset's kind, written by Claude before the photo is
  // asked for, so the photo, its changes and its other sizes all keep it. Without Claude the app asks
  // for the photo anyway and the image model invents the setting (photoPrompt). The 'idea' scene: the
  // user's few words written out the same way (without Claude the idea goes in as written).
  app.post('/api/photo-scene', json('4kb'), async (req, res) => {
    const { scene: id, size, idea, suggested, product } = (req.body ?? {}) as { [k in keyof PhotoSceneRequest]?: unknown };
    if (typeof id !== 'string' || (id !== IDEA_SCENE && !sceneById(id))) return void res.status(400).json({ error: `scene: one of the scene presets, or ${IDEA_SCENE}` });
    if (id === IDEA_SCENE && (typeof idea !== 'string' || !idea.trim() || idea.length > MAX_NOTES_CHARS)) return void res.status(400).json({ error: `idea: the scene in a few words, up to ${MAX_NOTES_CHARS} characters` });
    // The product's size, so the setting suits it (optional); for an idea, the scene suggested for it and its name.
    const dims = Array.isArray(size) && size.length === 3 && size.every((v) => typeof v === 'number' && v > 0 && v < 10000) ? size as Vec3 : undefined;
    const about = id === IDEA_SCENE ? {
      idea: idea as string,
      ...(typeof suggested === 'string' && sceneById(suggested) ? { suggested } : {}),
      ...(typeof product === 'string' && product.trim() ? { product: product.slice(0, 200) } : {}),
    } : undefined;
    const authProblem = claudeAuthProblem();
    if (authProblem) return void res.status(503).json({ error: authProblem });
    try {
      res.json({ scene: await sceneWriter(id, dims, about) } satisfies PhotoSceneResponse);
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  app.get('/api/designs/:id/images/:name', (req, res) => {
    const { id, name } = req.params;
    if (!ID_RE.test(id) || !IMAGE_NAME.test(name)) return void res.status(400).json({ error: 'bad image' });
    // Named by content, so a stored image never changes; a missing one may still be uploaded.
    res.sendFile(path.join(imageDir(id), name), { headers: { 'Cache-Control': 'max-age=31536000, immutable' } }, (e) => {
      if (e && !res.headersSent) res.set('Cache-Control', 'no-store').status(404).json({ error: 'not found' });
    });
  });
}
