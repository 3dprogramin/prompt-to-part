// The HTTP API (and, with --production, the built app). server/index.ts starts it.
import express from 'express';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { runGeneration, steerGeneration, workspaceDir } from './agent';
import type { AgentEvent, BlendRequest, Capabilities, GenerateRequest, ImageData, SpeechToken, PriceRequest } from '../shared/api';
import { authMode, claudeAuthProblem, DATA_DIR, defaultEffort, defaultModel, EFFORTS, PORT, PRODUCTION, ROOT } from './config';
import { listFonts, loadFontBuffers } from './fonts';
import { blenderInfo, exportBlend } from './blend';
import { bambuTemplate, bambuVersion, cachedPrintDefaults } from './bambu';
import { sliceProject } from './slicer';
import { suggestPrice } from './pricing';
import { lookupFilament } from './filaments';
import { matchFilament, MAX_BRAND_CHARS, MAX_FILAMENT_NAME_CHARS } from '../shared/filaments';
import { cleanCostSettings, DEFAULT_COST_SETTINGS } from '../shared/cost';
import { MAX_SCAD_CHARS, MAX_SCAD_FILES, parseScadFiles } from '../shared/scad';
import { artworkAvailable, imageModel, requestImage } from './artwork';
import { photoProblem, photoPrompt, type PhotoRequest, type PhotoResponse } from '../shared/photos';
import type { Design, DesignSummary } from '../shared/types';
import { geometry } from './geometry';
import { copyMeshes, MAX_MESH_BYTES, MESH_FILE, meshDir, storeMesh } from './meshes';
import { freeMeshName, MAX_MESHES, MESH_NAME } from '../shared/meshes';
import { meshFormat } from '../shared/meshFormats';
import { meshyAvailable } from './meshy';
import type { MeshUpload } from '../shared/api';

const DESIGNS = path.join(DATA_DIR, 'designs');
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

/** The fields every saved design has; anything else would break the list or the app. */
function isDesign(d: unknown): d is Design {
  const o = d as Design;
  return !!o && typeof o === 'object' && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.code === 'string'
    && Number.isFinite(o.updatedAt) && Number.isFinite(o.createdAt) && Number.isInteger(o.currentVersion)
    && Array.isArray(o.messages) && Array.isArray(o.versions) && !!o.values && typeof o.values === 'object'
    && (o.rev === undefined || Number.isInteger(o.rev)) && (o.photos === undefined || Array.isArray(o.photos));
}

// Chat images (reference photos, renders, assembly pictures) are stored once per design, by
// content, instead of inside the design JSON that is rewritten on every autosave.
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGE_NAME = /^[0-9a-f]{32}\.(png|jpg|webp|gif)$/;
/** Largest render sent for a product photo. */
const MAX_RENDER_BYTES = 15 * 1024 * 1024;

/** Write through a temp file and rename it into place, so readers see the old or the new file. */
async function writeAtomically(file: string, data: string | Buffer) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/**
 * Dictation languages from ELEVENLABS_LANGUAGE (the main one) and ELEVENLABS_SECONDARY_LANGUAGES
 * (comma-separated), as ISO 639-1/-3 codes; unset means detected automatically.
 */
function speechLanguages(): Pick<SpeechToken, 'language' | 'secondaryLanguages'> {
  const code = (s: string) => s.trim().toLowerCase();
  const valid = (s: string) => /^[a-z]{2,3}$/.test(s);
  const language = code(process.env.ELEVENLABS_LANGUAGE ?? '');
  const secondary = (process.env.ELEVENLABS_SECONDARY_LANGUAGES ?? '').split(',').map(code).filter(valid);
  return { language: valid(language) ? language : undefined, secondaryLanguages: secondary };
}

export interface AppOptions {
  /** Port the server listens on: requests must name it in their Host header. */
  port?: number;
  /** Runs a generation (tests pass a stand-in instead of Claude). */
  generate?: typeof runGeneration;
  /** Suggests a selling price (tests pass a stand-in instead of Claude). */
  suggest?: typeof suggestPrice;
  /** Finds a filament's colour and TD (tests pass one with a stand-in for Claude). */
  lookup?: typeof lookupFilament;
  /** Asks the image model for a picture (tests pass a stand-in). */
  image?: typeof requestImage;
}

export function createApp({ port = PORT, generate = runGeneration, suggest = suggestPrice, lookup = lookupFilament, image = requestImage }: AppOptions = {}): express.Express {
  const app = express();

  // Only Jig's own pages may use the API. The Host check defeats DNS rebinding (a website whose
  // domain is re-pointed at 127.0.0.1), the Origin check refuses every other site, including pages
  // on other local ports, and requiring the X-Jig header on writes means a plain cross-site form or
  // beacon can never change anything. In development the Vite proxy (vite.config.ts) passes requests
  // from Jig's own page on with the API's origin and leaves every other origin as it is.
  const LOCAL_HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const LOCAL_ORIGINS = new Set([...LOCAL_HOSTS].map((h) => `http://${h}`));
  app.use('/api', (req, res, next) => {
    if (!LOCAL_HOSTS.has(req.headers.host ?? '')) return void res.status(421).json({ error: 'Unexpected Host header' });
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGINS.has(origin)) return void res.status(403).json({ error: 'Cross-origin request refused' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-jig'] !== '1') return void res.status(403).json({ error: 'Missing X-Jig header' });
    next();
  });
  // Body size limits per route: a design (its images are stored separately) or a generation request
  // with a few photos is small; a mesh sent for .blend export can be large.
  const json = (limit: string) => express.json({ limit });

  const designFile = (id: string) => path.join(DESIGNS, `${id}.json`);
  const imageDir = (id: string) => path.join(DESIGNS, id);
  // One generation per design at a time (each design has a single working file and session).
  const generatingDesigns = new Set<string>();

  // Writes to one design run one after another, each through its own temp file, so overlapping
  // saves (two tabs, an autosave racing a retry) can never interleave into a corrupt file.
  const writeQueues = new Map<string, Promise<unknown>>();
  // Designs deleted while this server runs: a late save (another tab, an upload still in flight)
  // must not bring one back.
  const deleted = new Set<string>();
  function serially<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (writeQueues.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    writeQueues.set(id, next);
    void next.finally(() => { if (writeQueues.get(id) === next) writeQueues.delete(id); }).catch(() => undefined);
    return next;
  }

  app.get('/api/designs', async (_req, res) => {
    await mkdir(DESIGNS, { recursive: true });
    const out: DesignSummary[] = [];
    for (const f of await readdir(DESIGNS)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await readFile(path.join(DESIGNS, f), 'utf8')) as Design;
        out.push({ id: d.id, name: String(d.name ?? 'Untitled design'), updatedAt: Number(d.updatedAt) || 0, versions: Array.isArray(d.versions) ? d.versions.length : 0 });
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
    res.json({ ok: true });
  });

  /** Stores an image with the design, named by its content: its URL, or null if the design was deleted. */
  const storeImage = (id: string, bytes: Buffer, ext: string) => {
    const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
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

  // Product photos: the image model turns a clean render of the model into a photo of the printed
  // product in a scene. The photo and the render are stored with the design's images; the app
  // lists them in the design (Design.photos).
  app.post('/api/designs/:id/photos', json('25mb'), async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return void res.status(400).json({ error: 'bad id' });
    const body = req.body as PhotoRequest;
    const problem = photoProblem(body);
    if (problem) return void res.status(400).json({ error: problem });
    const render = Buffer.from(body.render.data, 'base64');
    const png = render[0] === 0x89 && render[1] === 0x50, jpg = render[0] === 0xff && render[1] === 0xd8;
    if (render.length > MAX_RENDER_BYTES || !(body.render.mediaType === 'image/png' ? png : jpg)) {
      return void res.status(400).json({ error: `The render must be a PNG or JPEG of up to ${MAX_RENDER_BYTES / 1024 / 1024} MB` });
    }
    if (!artworkAvailable()) return void res.status(503).json({ error: 'Product photos need an OpenRouter key: set OPENROUTER_API_KEY in .env and restart Jig.' });
    if (deleted.has(id)) return void res.status(410).json({ error: 'This design was deleted' });
    const prompt = photoPrompt(body);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      const out = await image(prompt, body.aspect, [`data:${body.render.mediaType};base64,${body.render.data}`], abort.signal);
      const ext = IMAGE_TYPES[out.image.mediaType];
      if (!ext) throw new Error(`The image model returned a picture format Jig can't store (${out.image.mediaType})`);
      const photo = await storeImage(id, Buffer.from(out.image.data, 'base64'), ext);
      const renderUrl = photo && await storeImage(id, render, IMAGE_TYPES[body.render.mediaType]);
      if (!photo || !renderUrl) return void res.status(410).json({ error: 'This design was deleted' });
      res.json({ photo, render: renderUrl, prompt, model: out.model, cost: out.cost } satisfies PhotoResponse);
    } catch (e) {
      if (abort.signal.aborted) return;
      console.error('[photos]', (e as Error).message);
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

  // Mesh files (STL, OBJ, GLB/glTF, 3MF) attached in the chat: parsed, repaired and made a solid in
  // the locked-down geometry worker, then stored with the design for H.mesh (server/meshes.ts).
  app.post('/api/designs/:id/meshes', express.raw({ type: 'application/octet-stream', limit: MAX_MESH_BYTES }), async (req, res) => {
    const { id } = req.params;
    const filename = String(req.query.name ?? '').replace(/[/\\]/g, '_').slice(0, 200);
    if (!ID_RE.test(id)) return void res.status(400).json({ error: 'bad id' });
    if (!meshFormat(filename)) return void res.status(400).json({ error: 'Send an STL, OBJ, GLB/glTF or 3MF file (?name= its file name)' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return void res.status(400).json({ error: 'Send the file as the body (application/octet-stream)' });
    if (deleted.has(id)) return void res.status(410).json({ error: 'This design was deleted' });
    const bytes = new Uint8Array(req.body);
    let imported;
    try {
      imported = await geometry.importMesh(bytes, filename);
    } catch (e) {
      return void res.status(422).json({ error: `${filename}: ${(e as Error).message}` });
    }
    // The import takes seconds; only the writes wait in the design's queue (saves go on meanwhile).
    const entry = await storeMesh(id, imported, { bytes, filename }, { source: 'upload' }, (fn) => serially(id, async () => (deleted.has(id) ? null : fn())));
    if (!entry) return void res.status(410).json({ error: 'This design was deleted' });
    res.json({ name: freeMeshName(filename, {}), entry, report: imported.report } satisfies MeshUpload);
  });

  app.get('/api/designs/:id/meshes/:name', (req, res) => {
    const { id, name } = req.params;
    if (!ID_RE.test(id) || !MESH_FILE.test(name)) return void res.status(400).json({ error: 'bad mesh file' });
    // Named by content, like the images.
    res.sendFile(path.join(meshDir(id), name), { headers: { 'Cache-Control': 'max-age=31536000, immutable', ...(name.endsWith('.bin') ? { 'Content-Type': 'application/octet-stream' } : {}) } }, (e) => {
      if (e && !res.headersSent) res.set('Cache-Control', 'no-store').status(404).json({ error: 'not found' });
    });
  });

  // A design started from a version of another one gets copies of that design's mesh files.
  app.post('/api/designs/:id/meshes/copy', json('1kb'), async (req, res) => {
    const { id } = req.params;
    const from = String((req.body as { from?: unknown })?.from ?? '');
    if (!ID_RE.test(id) || !ID_RE.test(from) || id === from) return void res.status(400).json({ error: 'bad id' });
    const copied = await serially(id, async () => (deleted.has(id) ? null : copyMeshes(from, id)));
    if (copied == null) return void res.status(410).json({ error: 'This design was deleted' });
    res.json({ copied });
  });

  app.get('/api/capabilities', async (_req, res) => {
    const blender = await blenderInfo();
    res.json({ blender: blender?.version ?? null, blenderProblem: blender?.problem ?? null, bambu: await bambuVersion(), speech: !!process.env.ELEVENLABS_API_KEY, printDefaults: await cachedPrintDefaults(), claude: claudeAuthProblem(), artwork: artworkAvailable() ? imageModel() : null, meshy: meshyAvailable(), model: defaultModel(), effort: defaultEffort() } satisfies Capabilities);
  });

  // Dictation: a single-use token for ElevenLabs' realtime speech-to-text, so the page can stream
  // the microphone there without ever seeing the API key.
  app.post('/api/speech/token', async (_req, res) => {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return void res.status(503).json({ error: 'Dictation needs an ElevenLabs API key: set ELEVENLABS_API_KEY (e.g. in .env) and restart Jig.' });
    try {
      const r = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', { method: 'POST', headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10000) });
      const body = (await r.json().catch(() => ({}))) as { token?: string; detail?: { message?: string } | string };
      if (!r.ok || !body.token) {
        const why = typeof body.detail === 'string' ? body.detail : body.detail?.message;
        return void res.status(502).json({ error: `ElevenLabs refused the token request (HTTP ${r.status}${why ? `: ${why}` : ''})` });
      }
      res.json({ token: body.token, ...speechLanguages() } satisfies SpeechToken);
    } catch (e) {
      res.status(502).json({ error: `Couldn't reach ElevenLabs: ${(e as Error).message}` });
    }
  });

  // A POST, because the first call runs Bambu Studio for minutes: a GET could be triggered by any
  // website's <img> tag.
  app.post('/api/bambu/template', async (_req, res) => {
    try {
      res.json(await bambuTemplate());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

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

  // ---- HueForge filaments: the library, or Claude on the web for one it doesn't have
  app.post('/api/filaments/lookup', json('2kb'), async (req, res) => {
    const { brand, name } = (req.body ?? {}) as { brand?: unknown; name?: unknown };
    if (typeof brand !== 'string' || typeof name !== 'string' || !brand.trim() || !name.trim()) return void res.status(400).json({ error: 'Send the filament\'s brand and name' });
    if (brand.length > MAX_BRAND_CHARS || name.length > MAX_FILAMENT_NAME_CHARS) return void res.status(400).json({ error: 'Brand or filament name too long' });
    const q = { brand: brand.trim(), name: name.trim() };
    const authProblem = matchFilament(q.brand, q.name) ? null : claudeAuthProblem();
    if (authProblem) return void res.status(503).json({ error: `This filament isn't in Jig's library, and looking it up needs Claude. ${authProblem}` });
    try {
      res.json(await lookup(q));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  app.post('/api/export/blend', json('300mb'), async (req, res) => {
    const body = req.body as BlendRequest;
    if (!body?.parts?.length) return void res.status(400).json({ error: 'no parts' });
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

  // A message for the reply Claude is working on (it reads it at its next step); 409 when none is
  // running, so the page queues it for after the reply instead.
  app.post('/api/generate/:id/message', json('40mb'), (req, res) => {
    const { id } = req.params;
    const b = (req.body ?? {}) as { text?: unknown; images?: unknown };
    if (!ID_RE.test(id) || typeof b.text !== 'string' || b.text.length > 20000) return void res.status(400).json({ error: 'text must be a string (up to 20,000 characters)' });
    if (b.images != null && (!Array.isArray(b.images) || b.images.length > 8 || !b.images.every(isImage))) return void res.status(400).json({ error: 'up to 8 images' });
    if (!b.text.trim() && !(b.images as unknown[] | undefined)?.length) return void res.status(400).json({ error: 'empty message' });
    if (!steerGeneration(id, b.text, (b.images ?? []) as ImageData[])) return void res.status(409).json({ error: 'Jig is not working on this design' });
    res.json({ ok: true });
  });

  app.post('/api/generate', json('40mb'), async (req, res) => {
    const body = req.body as GenerateRequest;
    if (!body || !ID_RE.test(body.designId ?? '')) return void res.status(400).json({ error: 'designId required' });
    const problem = generateProblem(body);
    if (problem) return void res.status(400).json({ error: problem });
    if (!body.prompt?.trim() && !body.images?.length && !body.scad?.length && !body.meshes?.length) return void res.status(400).json({ error: 'prompt, images or files required' });
    const authProblem = claudeAuthProblem();
    if (authProblem) return void res.status(503).json({ error: authProblem });
    if (generatingDesigns.has(body.designId)) {
      return void res.status(409).json({ error: 'Jig is already working on this design (maybe in another tab). Wait for it to finish or stop it there, or start a New design.' });
    }
    generatingDesigns.add(body.designId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (e: AgentEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });

    try {
      await generate(body, send, abort);
    } catch (e) {
      if (!abort.signal.aborted) {
        const msg = (e as Error).message ?? String(e);
        console.error('[generate]', msg);
        send({ type: 'error', message: friendlyError(msg) });
      }
    } finally {
      generatingDesigns.delete(body.designId);
      clearInterval(ping);
      res.end();
    }
  });
  const dist = path.join(ROOT, 'dist');
  if (PRODUCTION) {
    if (!existsSync(path.join(dist, 'index.html'))) console.warn('[jig] dist/ is missing – run `npm run build` first; only the API is served.');
    else if (newestSource() > statSync(path.join(dist, 'index.html')).mtimeMs) console.warn('[jig] dist/ is older than the source code – run `npm run build` to serve the current app.');
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  return app;
}

const MODELS = ['opus', 'sonnet', 'haiku'];
const isImage = (i: unknown) => !!i && typeof (i as { data?: unknown }).data === 'string' && typeof (i as { mediaType?: unknown }).mediaType === 'string';

/** What is wrong with a generation request's fields, or null. */
function generateProblem(b: GenerateRequest): string | null {
  if (typeof b.prompt !== 'string' || b.prompt.length > 20000) return 'prompt must be text (up to 20,000 characters)';
  if (b.images != null && (!Array.isArray(b.images) || b.images.length > 8 || !b.images.every(isImage))) return 'up to 8 images';
  if (b.currentView != null && !isImage(b.currentView)) return 'bad currentView';
  if (b.model != null && !MODELS.includes(b.model) && b.model !== defaultModel()) return `model must be one of ${[...new Set([...MODELS, defaultModel()])].join(', ')}`;
  if (b.effort != null && !EFFORTS.includes(b.effort)) return `effort must be one of ${EFFORTS.join(', ')}`;
  if (b.code != null && typeof b.code !== 'string') return 'bad code';
  if (b.sessionId != null && !/^[\w-]{1,100}$/.test(b.sessionId)) return 'bad sessionId';
  for (const v of [b.values, b.renderValues, b.pictures]) if (v != null && (typeof v !== 'object' || Array.isArray(v))) return 'bad values';
  if (b.drawings != null && (typeof b.drawings !== 'object' || Array.isArray(b.drawings))) return 'bad drawings';
  if (b.meshes != null && (!Array.isArray(b.meshes) || b.meshes.length > MAX_MESHES || !b.meshes.every((n) => typeof n === 'string' && MESH_NAME.test(n)))) return 'bad meshes';
  if (b.imageMode != null && !['off', 'artwork', 'hueforge', 'lithophane', 'figure'].includes(b.imageMode)) return 'bad imageMode';
  if (!parseScadFiles(b.scad)) return `up to ${MAX_SCAD_FILES} .scad files of up to ${MAX_SCAD_CHARS.toLocaleString('en')} characters`;
  if (b.history != null && (!Array.isArray(b.history) || b.history.length > 40 || !b.history.every((h) => h && typeof h.text === 'string' && (h.role === 'user' || h.role === 'assistant')))) return 'bad history';
  return null;
}

function friendlyError(msg: string) {
  if (/auth|login|credential|401|oauth/i.test(msg)) {
    if (authMode() === 'subscription' && process.env.CLAUDE_CODE_OAUTH_TOKEN) return `Claude authentication failed – the token in CLAUDE_CODE_OAUTH_TOKEN may have expired or been revoked: make a new one with \`claude setup-token\` and restart Jig. (${msg})`;
    return `Claude authentication failed – run \`claude\` in a terminal and log in (/login) with your subscription. (${msg})`;
  }
  if (/rate.?limit|429|usage limit/i.test(msg)) return `Claude usage limit reached for now. (${msg})`;
  return msg;
}

/** Newest modification time of the files the browser app is built from. */
function newestSource(): number {
  let newest = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  for (const d of ['src', 'shared']) walk(path.join(ROOT, d));
  return Math.max(newest, ...['index.html', 'vite.config.ts', 'package.json'].map((f) => statSync(path.join(ROOT, f)).mtimeMs));
}
