import express from 'express';
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { runGeneration, workspaceDir, type AgentEvent, type GenerateRequest } from './agent';
import { DATA_DIR, PORT, PRODUCTION, ROOT } from './config';
import { geometry } from './geometry';
import { listFonts, loadFontBuffers } from './fonts';
import { blenderInfo, exportBlend, type BlendRequest } from './blend';
import { bambuTemplate, bambuVersion } from './bambu';
import type { Design, DesignSummary } from '../shared/types';

const DESIGNS = path.join(DATA_DIR, 'designs');
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

const app = express();

// Only Jig's own pages may use the API. The Host check defeats DNS rebinding (a website whose
// domain is re-pointed at 127.0.0.1), the Origin check refuses every other site, including pages
// on other local ports, and requiring the X-Jig header on writes means a plain cross-site form or
// beacon can never change anything. In development the Vite proxy (vite.config.ts) passes requests
// from Jig's own page on with the API's origin and leaves every other origin as it is.
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const LOCAL_ORIGINS = new Set([...LOCAL_HOSTS].map((h) => `http://${h}`));
app.use('/api', (req, res, next) => {
  if (!LOCAL_HOSTS.has(req.headers.host ?? '')) return void res.status(421).json({ error: 'Unexpected Host header' });
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGINS.has(origin)) return void res.status(403).json({ error: 'Cross-origin request refused' });
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-jig'] !== '1') return void res.status(403).json({ error: 'Missing X-Jig header' });
  next();
});
app.use(express.json({ limit: '80mb' }));

const designFile = (id: string) => path.join(DESIGNS, `${id}.json`);
// One generation per design at a time (each design has a single working file and session).
const generatingDesigns = new Set<string>();

app.get('/api/designs', async (_req, res) => {
  await mkdir(DESIGNS, { recursive: true });
  const out: DesignSummary[] = [];
  for (const f of await readdir(DESIGNS)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(await readFile(path.join(DESIGNS, f), 'utf8')) as Design;
      out.push({ id: d.id, name: d.name, updatedAt: d.updatedAt, versions: d.versions.length });
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

app.put('/api/designs/:id', async (req, res) => {
  const d = req.body as Design;
  if (!ID_RE.test(req.params.id) || d?.id !== req.params.id) return void res.status(400).json({ error: 'bad id' });
  await mkdir(DESIGNS, { recursive: true });
  const tmp = `${designFile(d.id)}.tmp`;
  await writeFile(tmp, JSON.stringify(d));
  await rename(tmp, designFile(d.id));
  res.json({ ok: true });
});

app.delete('/api/designs/:id', async (req, res) => {
  if (!ID_RE.test(req.params.id)) return void res.status(400).json({ error: 'bad id' });
  await rm(designFile(req.params.id), { force: true });
  await rm(workspaceDir(req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});

app.get('/api/capabilities', async (_req, res) => {
  const blender = await blenderInfo();
  res.json({ blender: blender?.version ?? null, blenderProblem: blender?.problem ?? null, bambu: await bambuVersion() });
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

app.post('/api/export/blend', async (req, res) => {
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

app.post('/api/generate', async (req, res) => {
  const body = req.body as GenerateRequest;
  if (!body || !ID_RE.test(body.designId ?? '')) return void res.status(400).json({ error: 'designId required' });
  if (!body.prompt?.trim() && !body.images?.length) return void res.status(400).json({ error: 'prompt or images required' });
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
    await runGeneration(body, send, abort);
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

function friendlyError(msg: string) {
  if (/auth|login|credential|401|oauth/i.test(msg)) return `Claude authentication failed – run \`claude\` in a terminal and log in (/login) with your subscription. (${msg})`;
  if (/rate.?limit|429|usage limit/i.test(msg)) return `Claude usage limit reached for now. (${msg})`;
  return msg;
}

const dist = path.join(ROOT, 'dist');
if (PRODUCTION) {
  if (!existsSync(path.join(dist, 'index.html'))) console.warn('[jig] dist/ is missing – run `npm run build` first; only the API is served.');
  else if (newestSource() > statSync(path.join(dist, 'index.html')).mtimeMs) console.warn('[jig] dist/ is older than the source code – run `npm run build` to serve the current app.');
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
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

geometry.warmup();
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Jig server on http://127.0.0.1:${PORT}  (data: ${DATA_DIR})`);
});
