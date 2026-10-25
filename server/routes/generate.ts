// Replies: starting one, its server-sent events (kept so a page can catch up), messages sent while
// it runs, and stopping it.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { runGeneration, steerGeneration, UsageLimitError } from '../agent';
import type { AgentEvent, GenerateRequest, ImageData } from '../../shared/api';
import { authMode, claudeAuthProblem, defaultModel, EFFORTS } from '../config';
import { MAX_SCAD_CHARS, MAX_SCAD_FILES, parseScadFiles } from '../../shared/scad';
import { isLineArtStyle, LINE_ART_STYLES } from '../../shared/lineart';
import { MAX_MESHES, MESH_NAME } from '../../shared/meshes';
import { limitResetsAt } from '../usage';
import { ID_RE, type RouteContext } from './store';

/**
 * A reply Jig is working on, or finished a little while ago: its server-sent events so far (the
 * first says which run it is) and the one page connection following it.
 */
interface Run { id: string; events: string[]; listener: express.Response | null; done: boolean; abort: AbortController; forget?: ReturnType<typeof setTimeout> }
/** By design id. */
const runs = new Map<string, Run>();
/** How long a finished reply's events are kept for a page that comes back. */
const KEEP_RUN_MS = 30 * 60_000;

/** Streams `run`'s events from `from` on to `res`, which takes over from any page following it before. */
function follow(run: Run, res: express.Response, from: number) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const old = run.listener;
  if (old && old !== res) {
    old.write(`data: ${JSON.stringify({ type: 'moved' } satisfies AgentEvent)}\n\n`);
    old.end();
  }
  for (const s of run.events.slice(from)) res.write(s);
  if (run.done) return void res.end();
  run.listener = res;
  res.on('close', () => { if (run.listener === res) run.listener = null; });
}

/** Ends each running reply's stream with an error (see endGenerations). */
const openStreams = new Set<(message: string) => void>();

/**
 * The server is stopping: every running reply ends with `message` (its page shows at once that Jig
 * stopped, instead of waiting for the connection to drop) and Claude is stopped. Resolves when
 * they have ended, or after `waitMs`.
 */
export async function endGenerations(message: string, waitMs = 3000): Promise<void> {
  for (const end of openStreams) end(message);
  const until = Date.now() + waitMs;
  while (openStreams.size && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
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
  if (b.imageMode != null && !['off', 'artwork', 'layertone', 'lithophane', 'lineart', 'figure'].includes(b.imageMode)) return 'bad imageMode';
  if (b.lineArtStyle != null && !isLineArtStyle(b.lineArtStyle)) return `lineArtStyle must be one of ${LINE_ART_STYLES.join(', ')}`;
  if (b.figureColor != null && typeof b.figureColor !== 'boolean') return 'bad figureColor';
  if (!parseScadFiles(b.scad)) return `up to ${MAX_SCAD_FILES} .scad files of up to ${MAX_SCAD_CHARS.toLocaleString('en')} characters`;
  if (b.history != null && (!Array.isArray(b.history) || b.history.length > 40 || !b.history.every((h) => h && typeof h.text === 'string' && (h.role === 'user' || h.role === 'assistant')))) return 'bad history';
  return null;
}

const USAGE_LIMIT = /rate.?limit|429|usage limit|hit your limit/i;

function friendlyError(msg: string, limited: boolean) {
  if (limited) return `${authMode() === 'subscription' ? 'Your Claude subscription\'s usage limit is reached' : 'Claude usage limit reached for now'}. (${msg})`;
  if (/auth|login|credential|401|oauth/i.test(msg)) {
    if (authMode() === 'subscription' && process.env.CLAUDE_CODE_OAUTH_TOKEN) return `Claude authentication failed – the token in CLAUDE_CODE_OAUTH_TOKEN may have expired or been revoked: make a new one with \`claude setup-token\` and restart Jig. (${msg})`;
    return `Claude authentication failed – run \`claude\` in a terminal and log in (/login) with your subscription. (${msg})`;
  }
  return msg;
}

export function registerGenerateRoutes(app: express.Express, { json, generatingDesigns }: RouteContext, { generate }: { generate: typeof runGeneration }) {
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

    // The reply runs on whatever happens to the page's connection (a phone that locks its screen
    // drops it): its events are kept, so the page can catch up (GET …/events) and stop it (POST …/stop).
    const abort = new AbortController();
    const run: Run = { id: randomUUID(), events: [], listener: null, done: false, abort };
    const prev = runs.get(body.designId);
    if (prev) clearTimeout(prev.forget);
    runs.set(body.designId, run);
    let ended = false;
    const send = (e: AgentEvent) => {
      if (e.type === 'done' || e.type === 'error') ended = true;
      const s = `data: ${JSON.stringify(e)}\n\n`;
      run.events.push(s);
      if (run.listener && !run.listener.writableEnded) run.listener.write(s);
    };
    send({ type: 'run', runId: run.id });
    follow(run, res, 0);
    const ping = setInterval(() => { if (run.listener && !run.listener.writableEnded) run.listener.write(': ping\n\n'); }, 15000);
    const end = (message: string) => { send({ type: 'error', message }); abort.abort(); };
    openStreams.add(end);

    try {
      await generate(body, send, abort);
    } catch (e) {
      if (!abort.signal.aborted) {
        const msg = (e as Error).message ?? String(e);
        console.error('[generate]', msg);
        const limited = e instanceof UsageLimitError || USAGE_LIMIT.test(msg);
        send({ type: 'error', message: friendlyError(msg, limited), ...(limited && { resetsAt: limitResetsAt() }) });
      }
    } finally {
      // Every reply's events end with how it ended, so a page catching up later knows.
      if (!ended) send({ type: 'error', message: 'Stopped.' });
      openStreams.delete(end);
      generatingDesigns.delete(body.designId);
      clearInterval(ping);
      run.done = true;
      run.listener?.end();
      run.listener = null;
      run.forget = setTimeout(() => { if (runs.get(body.designId) === run) runs.delete(body.designId); }, KEEP_RUN_MS);
      run.forget.unref?.();
    }
  });

  // A page catching up with a reply after its connection dropped (or a reload): the events from
  // `from` on, then the rest as they come. 404 when the server doesn't have that reply (any more).
  app.get('/api/generate/:id/events', (req, res) => {
    const run = runs.get(req.params.id);
    const from = Number(req.query.from);
    if (!run || run.id !== req.query.run || !Number.isInteger(from) || from < 0 || from > run.events.length) {
      return void res.status(404).json({ error: 'Jig has no such reply under way' });
    }
    follow(run, res, from);
  });

  // Stops the design's reply (the page's Stop button).
  app.post('/api/generate/:id/stop', (req, res) => {
    runs.get(req.params.id)?.abort.abort();
    res.json({ ok: true });
  });
}
