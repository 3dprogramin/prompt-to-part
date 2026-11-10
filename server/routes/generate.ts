// Replies: starting one, its server-sent events (kept so a page can catch up), messages sent while
// it runs, and stopping it.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { KeyRefusedError, runGeneration, steerGeneration, UsageLimitError } from '../agent';
import type { AgentEvent, GenerateRequest, ImageData } from '../../shared/api';
import { claudeAuthProblem, claudeKeyRefused, claudeViaOpenRouter, defaultModel, EFFORTS } from '../config';
import { OPENROUTER_MODEL_ID } from '../openRouterModels';
import { MAX_SCAD_CHARS, MAX_SCAD_FILES, parseScadFiles } from '../../shared/scad';
import { isLineArtStyle, LINE_ART_STYLES } from '../../shared/lineart';
import { MAX_MESHES, MESH_NAME } from '../../shared/meshes';
import { ID_RE, type RouteContext } from './store';

/**
 * A reply being worked on, or finished a little while ago: its server-sent events so far (the
 * first says which run it is) and the one page connection following it.
 */
interface Run { id: string; events: string[]; listener: express.Response | null; done: boolean; abort: AbortController; forget?: ReturnType<typeof setTimeout>; bytes: number; doneAt?: number }
/** By design id. */
const runs = new Map<string, Run>();
/** How long a finished reply's events are kept for a page that comes back. */
const KEEP_RUN_MS = 30 * 60_000;
/**
 * How many bytes of events (renders are base64 pictures, so a reply can hold tens of MB) the kept
 * replies may hold together: beyond it, the replies that finished first are forgotten first (their
 * pages, if they come back, show what they have). Replies under way are never forgotten.
 */
let keptBytesBudget = 256 * 1024 * 1024;
/** Bytes of events over all kept replies. */
let keptBytes = 0;

/** For tests: sets the kept replies' byte budget and returns the old one. */
export function setKeptRunsBudget(bytes: number): number {
  const old = keptBytesBudget;
  keptBytesBudget = bytes;
  return old;
}

function forgetRun(designId: string, run: Run) {
  if (runs.get(designId) !== run) return;
  runs.delete(designId);
  clearTimeout(run.forget);
  keptBytes -= run.bytes;
}

/** Forgets finished replies, those that finished first first, until the kept ones fit the budget. */
function fitBudget() {
  if (keptBytes <= keptBytesBudget) return;
  const finished = [...runs].filter(([, r]) => r.done).sort((a, b) => (a[1].doneAt ?? 0) - (b[1].doneAt ?? 0));
  for (const [designId, run] of finished) {
    if (keptBytes <= keptBytesBudget) break;
    forgetRun(designId, run);
  }
}
/** Replies under way in this process, over all designs (each runs Claude Code and spends the API key). */
let running = 0;

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
 * The server is stopping: every running reply ends with `message` (its page shows at once that it
 * stopped, instead of waiting for the connection to drop) and Claude is stopped. Resolves when
 * they have ended, or after `waitMs`.
 */
export async function endGenerations(message: string, waitMs = 3000): Promise<void> {
  for (const end of openStreams) end(message);
  const until = Date.now() + waitMs;
  while (openStreams.size && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const isImage = (i: unknown) => !!i && typeof (i as { data?: unknown }).data === 'string' && typeof (i as { mediaType?: unknown }).mediaType === 'string';

/** What is wrong with a generation request's fields, or null. */
function generateProblem(b: GenerateRequest): string | null {
  if (typeof b.prompt !== 'string' || b.prompt.length > 20000) return 'prompt must be text (up to 20,000 characters)';
  if (b.images != null && (!Array.isArray(b.images) || b.images.length > 8 || !b.images.every(isImage))) return 'up to 8 images';
  if (b.currentView != null && !isImage(b.currentView)) return 'bad currentView';
  // Through OpenRouter any of its models may be chosen (the menu lists them); else Claude's.
  const openRouterModel = claudeViaOpenRouter() && typeof b.model === 'string' && b.model.length <= 120 && OPENROUTER_MODEL_ID.test(b.model);
  if (b.model != null && !MODELS.includes(b.model) && b.model !== defaultModel() && !openRouterModel) return `model must be one of ${[...new Set([...MODELS, defaultModel()])].join(', ')}`;
  if (b.effort != null && !EFFORTS.includes(b.effort)) return `effort must be one of ${EFFORTS.join(', ')}`;
  if (b.code != null && typeof b.code !== 'string') return 'bad code';
  if (b.sessionId != null && !/^[\w-]{1,100}$/.test(b.sessionId)) return 'bad sessionId';
  if (b.sessionCostUsd != null && !(typeof b.sessionCostUsd === 'number' && Number.isFinite(b.sessionCostUsd) && b.sessionCostUsd >= 0)) return 'bad sessionCostUsd';
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
  if (limited) return `Claude usage limit reached for now. (${msg})`;
  if (/auth|login|credential|401|oauth|invalid api key/i.test(msg)) return `${claudeKeyRefused()} (${msg})`;
  return msg;
}

export function registerGenerateRoutes(app: express.Express, { json, generatingDesigns }: RouteContext, { generate, maxGenerations }: { generate: typeof runGeneration; maxGenerations: number }) {
  // A message for the reply Claude is working on (it reads it at its next step); 409 when none is
  // running, so the page queues it for after the reply instead.
  app.post('/api/generate/:id/message', json('40mb'), (req, res) => {
    const { id } = req.params;
    const b = (req.body ?? {}) as { text?: unknown; images?: unknown };
    if (!ID_RE.test(id) || typeof b.text !== 'string' || b.text.length > 20000) return void res.status(400).json({ error: 'text must be a string (up to 20,000 characters)' });
    if (b.images != null && (!Array.isArray(b.images) || b.images.length > 8 || !b.images.every(isImage))) return void res.status(400).json({ error: 'up to 8 images' });
    if (!b.text.trim() && !(b.images as unknown[] | undefined)?.length) return void res.status(400).json({ error: 'empty message' });
    if (!steerGeneration(id, b.text, (b.images ?? []) as ImageData[])) return void res.status(409).json({ error: 'No reply is under way for this design' });
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
      return void res.status(409).json({ error: 'This design is already being worked on (maybe in another tab). Wait for it to finish or stop it there, or start a New design.' });
    }
    if (running >= maxGenerations) {
      return void res.status(429).json({ error: `${maxGenerations === 1 ? 'A reply is' : `${maxGenerations} replies are`} already under way, the most that can run at once. Wait for one to finish, then send again.` });
    }
    generatingDesigns.add(body.designId);
    running++;

    // The reply runs on whatever happens to the page's connection (a phone that locks its screen
    // drops it): its events are kept, so the page can catch up (GET …/events) and stop it (POST …/stop).
    const abort = new AbortController();
    const run: Run = { id: randomUUID(), events: [], listener: null, done: false, abort, bytes: 0 };
    const prev = runs.get(body.designId);
    if (prev) forgetRun(body.designId, prev);
    runs.set(body.designId, run);
    let ended = false;
    const send = (e: AgentEvent) => {
      if (e.type === 'done' || e.type === 'error') ended = true;
      const s = `data: ${JSON.stringify(e)}\n\n`;
      run.events.push(s);
      if (runs.get(body.designId) === run) {
        run.bytes += s.length;
        keptBytes += s.length;
        fitBudget();
      }
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
        send({ type: 'error', message: e instanceof KeyRefusedError ? msg : friendlyError(msg, limited) });
      }
    } finally {
      // Every reply's events end with how it ended, so a page catching up later knows.
      if (!ended) send({ type: 'error', message: 'Stopped.' });
      openStreams.delete(end);
      generatingDesigns.delete(body.designId);
      running--;
      clearInterval(ping);
      run.done = true;
      run.doneAt = Date.now();
      run.listener?.end();
      run.listener = null;
      if (runs.get(body.designId) === run) {
        run.forget = setTimeout(() => forgetRun(body.designId, run), KEEP_RUN_MS);
        run.forget.unref?.();
        fitBudget();
      }
    }
  });

  // A page catching up with a reply after its connection dropped (or a reload): the events from
  // `from` on, then the rest as they come. 404 when the server doesn't have that reply (any more).
  app.get('/api/generate/:id/events', (req, res) => {
    const run = runs.get(req.params.id);
    const from = Number(req.query.from);
    if (!run || run.id !== req.query.run || !Number.isInteger(from) || from < 0 || from > run.events.length) {
      return void res.status(404).json({ error: 'No such reply is under way' });
    }
    follow(run, res, from);
  });

  // Stops the design's reply (the page's Stop button).
  app.post('/api/generate/:id/stop', (req, res) => {
    runs.get(req.params.id)?.abort.abort();
    res.json({ ok: true });
  });
}
