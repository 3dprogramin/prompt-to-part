import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { DATA_DIR, runGeneration, workspaceDir, type AgentEvent, type GenerateRequest } from './agent';
import { geometry } from './geometry';
import { listFonts, loadFontBuffers } from './fonts';
import { blenderVersion, exportBlend, type BlendRequest } from './blend';
import type { Design, DesignSummary } from '../shared/types';

const PORT = Number(process.env.PORT ?? 8787);
const DESIGNS = path.join(DATA_DIR, 'designs');
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

const app = express();
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
  res.json({ blender: await blenderVersion() });
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

const dist = path.resolve(process.cwd(), 'dist');
if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

geometry.warmup();
app.listen(PORT, '127.0.0.1', () => {
  console.log(`AI Designer server on http://127.0.0.1:${PORT}  (data: ${DATA_DIR})`);
});
