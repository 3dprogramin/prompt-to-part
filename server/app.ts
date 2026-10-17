// The HTTP API (and, with --production, the built app). server/index.ts starts it.
import express from 'express';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { runGeneration, workspaceDir } from './agent';
import type { AgentEvent, BlendRequest, Capabilities, GenerateRequest, SpeechToken, PriceRequest } from '../shared/api';
import { claudeAuthProblem, DATA_DIR, PORT, PRODUCTION, ROOT } from './config';
import { listFonts, loadFontBuffers } from './fonts';
import { blenderInfo, exportBlend } from './blend';
import { bambuTemplate, bambuVersion, cachedPrintDefaults } from './bambu';
import { sliceProject } from './slicer';
import { suggestPrice } from './pricing';
import { cleanCostSettings } from '../shared/cost';
import type { Design, DesignSummary } from '../shared/types';

const DESIGNS = path.join(DATA_DIR, 'designs');
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

/** The fields every saved design has; anything else would break the list or the app. */
function isDesign(d: unknown): d is Design {
  const o = d as Design;
  return !!o && typeof o === 'object' && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.code === 'string'
    && Number.isFinite(o.updatedAt) && Number.isFinite(o.createdAt) && Number.isInteger(o.currentVersion)
    && Array.isArray(o.messages) && Array.isArray(o.versions) && !!o.values && typeof o.values === 'object'
    && (o.rev === undefined || Number.isInteger(o.rev));
}

// Chat images (reference photos, renders, assembly pictures) are stored once per design, by
// content, instead of inside the design JSON that is rewritten on every autosave.
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGE_NAME = /^[0-9a-f]{32}\.(png|jpg|webp|gif)$/;

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
}

export function createApp({ port = PORT, generate = runGeneration, suggest = suggestPrice }: AppOptions = {}): express.Express {
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
    if (generatingDesigns.has(id)) return void res.status(409).json({ error: 'Claude is working on this design – stop it first.' });
    await serially(id, async () => {
      deleted.add(id);
      await rm(designFile(id), { force: true });
      await rm(imageDir(id), { recursive: true, force: true });
      await rm(workspaceDir(id), { recursive: true, force: true });
    });
    res.json({ ok: true });
  });

  app.post('/api/designs/:id/images', json('20mb'), async (req, res) => {
    const { id } = req.params;
    const { mediaType, data } = (req.body ?? {}) as { mediaType?: unknown; data?: unknown };
    const ext = IMAGE_TYPES[String(mediaType)];
    if (!ID_RE.test(id) || !ext || typeof data !== 'string') return void res.status(400).json({ error: 'bad image' });
    const bytes = Buffer.from(data, 'base64');
    const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
    // In the design's queue, so a delete can't run between the check and the write.
    await serially(id, async () => {
      if (deleted.has(id)) return void res.status(410).json({ error: 'This design was deleted' });
      const target = path.join(imageDir(id), name);
      await mkdir(imageDir(id), { recursive: true });
      // Written whole or not at all: a half-written file would be served (and cached) forever.
      if (!existsSync(target)) await writeAtomically(target, bytes);
      res.json({ url: `/api/designs/${id}/images/${name}` });
    });
  });

  app.get('/api/designs/:id/images/:name', (req, res) => {
    const { id, name } = req.params;
    if (!ID_RE.test(id) || !IMAGE_NAME.test(name)) return void res.status(400).json({ error: 'bad image' });
    // Named by content, so a stored image never changes; a missing one may still be uploaded.
    res.sendFile(path.join(imageDir(id), name), { headers: { 'Cache-Control': 'max-age=31536000, immutable' } }, (e) => {
      if (e && !res.headersSent) res.set('Cache-Control', 'no-store').status(404).json({ error: 'not found' });
    });
  });

  app.get('/api/capabilities', async (_req, res) => {
    const blender = await blenderInfo();
    res.json({ blender: blender?.version ?? null, blenderProblem: blender?.problem ?? null, bambu: await bambuVersion(), speech: !!process.env.ELEVENLABS_API_KEY, printDefaults: await cachedPrintDefaults(), claude: claudeAuthProblem() } satisfies Capabilities);
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
    res.json(cleanCostSettings(await readFile(COST_SETTINGS, 'utf8').then((t) => JSON.parse(t), () => ({}))));
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

  app.post('/api/generate', json('40mb'), async (req, res) => {
    const body = req.body as GenerateRequest;
    if (!body || !ID_RE.test(body.designId ?? '')) return void res.status(400).json({ error: 'designId required' });
    const problem = generateProblem(body);
    if (problem) return void res.status(400).json({ error: problem });
    if (!body.prompt?.trim() && !body.images?.length) return void res.status(400).json({ error: 'prompt or images required' });
    const authProblem = claudeAuthProblem();
    if (authProblem) return void res.status(503).json({ error: authProblem });
    if (generatingDesigns.has(body.designId)) {
      return void res.status(409).json({ error: 'Claude is already working on this design (maybe in another tab). Wait for it to finish or stop it there, or start a New design.' });
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
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const isImage = (i: unknown) => !!i && typeof (i as { data?: unknown }).data === 'string' && typeof (i as { mediaType?: unknown }).mediaType === 'string';

/** What is wrong with a generation request's fields, or null. */
function generateProblem(b: GenerateRequest): string | null {
  if (typeof b.prompt !== 'string' || b.prompt.length > 20000) return 'prompt must be text (up to 20,000 characters)';
  if (b.images != null && (!Array.isArray(b.images) || b.images.length > 8 || !b.images.every(isImage))) return 'up to 8 images';
  if (b.currentView != null && !isImage(b.currentView)) return 'bad currentView';
  if (b.model != null && !MODELS.includes(b.model)) return `model must be one of ${MODELS.join(', ')}`;
  if (b.effort != null && !EFFORTS.includes(b.effort)) return `effort must be one of ${EFFORTS.join(', ')}`;
  if (b.code != null && typeof b.code !== 'string') return 'bad code';
  if (b.sessionId != null && !/^[\w-]{1,100}$/.test(b.sessionId)) return 'bad sessionId';
  for (const v of [b.values, b.renderValues]) if (v != null && (typeof v !== 'object' || Array.isArray(v))) return 'bad values';
  if (b.drawings != null && (typeof b.drawings !== 'object' || Array.isArray(b.drawings))) return 'bad drawings';
  if (b.history != null && (!Array.isArray(b.history) || b.history.length > 40 || !b.history.every((h) => h && typeof h.text === 'string' && (h.role === 'user' || h.role === 'assistant')))) return 'bad history';
  return null;
}

function friendlyError(msg: string) {
  if (/auth|login|credential|401|oauth/i.test(msg)) return `Claude authentication failed – run \`claude\` in a terminal and log in (/login) with your subscription. (${msg})`;
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
