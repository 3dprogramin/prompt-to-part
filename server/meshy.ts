// Meshy (https://docs.meshy.ai): AI 3D models from a description (Text to 3D, preview stage) or a
// photo (Image to 3D), for generate_3d. A figure in one colour is the untextured mesh only (25
// credits a model at 2k geometry); a coloured one (3D figure mode's Colour) is textured: Image to 3D
// with should_texture (painted from texture_image_url when there is a painted concept picture), Text
// to 3D with a refine task after the preview (35 credits either way), and the GLB's base colour
// texture gives the colours. The preview picture is only for the chat. The key
// stays on the server. MESHY_BASE_URL points it at the mock (`npm run mock:meshy`, server/meshyMock.ts).

import type { MeshyBalance } from '../shared/api';

export const MESHY_DEFAULT_BASE = 'https://api.meshy.ai/openapi';
export const meshyAvailable = () => !!process.env.MESHY_API_KEY?.trim();
export const meshyBaseUrl = () => (process.env.MESHY_BASE_URL?.trim() || MESHY_DEFAULT_BASE).replace(/\/+$/, '');
/** Largest model or picture downloaded. */
export const MAX_DOWNLOAD = 100 * 1024 * 1024;
/** Longest prompt Meshy takes. */
export const MAX_MESHY_PROMPT = 800;
export { MESHY_CREDITS_PER_COLOR_MODEL, MESHY_CREDITS_PER_MODEL, meshyCredits } from '../shared/meshes';
/** Most generate_3d calls in one reply (JIG_MESHY_MAX_PER_REPLY); the user's next message gets a fresh allowance. */
export const MESHY_MAX_PER_REPLY = 2;
export const meshyMaxPerReply = () => {
  const n = Number(process.env.JIG_MESHY_MAX_PER_REPLY);
  return process.env.JIG_MESHY_MAX_PER_REPLY?.trim() && Number.isInteger(n) && n >= 0 ? n : MESHY_MAX_PER_REPLY;
};

export type MeshyKind = 'text-to-3d' | 'image-to-3d';
const PATHS: Record<MeshyKind, string> = { 'text-to-3d': '/v2/text-to-3d', 'image-to-3d': '/v1/image-to-3d' };

export interface MeshyTask {
  id: string;
  type?: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  progress: number;
  created_at: number;
  started_at?: number;
  finished_at?: number;
  preceding_tasks?: number;
  model_urls?: Record<string, string>;
  thumbnail_url?: string;
  /** `{ message: "" }` or null when there is no error. */
  task_error?: { type?: string; code?: string; message?: string } | null;
  consumed_credits?: number;
}

export class MeshyError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); }
}

export interface MeshyClient {
  key: string;
  baseUrl: string;
  fetch?: typeof fetch;
  /** Waits between polls (tests make it instant). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function meshyClient(): MeshyClient | null {
  return meshyAvailable() ? { key: process.env.MESHY_API_KEY!.trim(), baseUrl: meshyBaseUrl() } : null;
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

async function call<T>(c: MeshyClient, method: string, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ data: T; headers: Headers }> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  let r: Response;
  try {
    r = await (c.fetch ?? fetch)(`${c.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${c.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new MeshyError(`Couldn't reach Meshy: ${(e as Error).name === 'TimeoutError' ? 'no answer in time' : (e as Error).message}`);
  }
  const text = await r.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* a proxy's HTML error page */ }
  if (!r.ok) {
    const msg = (data as { message?: string } | undefined)?.message ?? (text.slice(0, 200) || `HTTP ${r.status}`);
    const why = r.status === 401 ? 'Meshy refused the API key (MESHY_API_KEY)' : r.status === 402 ? 'Not enough Meshy credits' : r.status === 429 ? 'Meshy is busy (rate or queue limit)' : `Meshy said HTTP ${r.status}`;
    throw new MeshyError(`${why}: ${msg}`, r.status);
  }
  return { data: data as T, headers: r.headers };
}

/** The account's credits (free to ask). */
export async function getBalance(c: MeshyClient, signal?: AbortSignal): Promise<MeshyBalance> {
  const { data } = await call<MeshyBalance>(c, 'GET', '/v1/balance', undefined, 15000, signal);
  if (!Number.isFinite(data?.balance)) throw new MeshyError('Meshy returned no balance');
  return {
    balance: data.balance,
    ...(Number.isFinite(data.monthly_credits) ? { monthly_credits: data.monthly_credits } : {}),
    ...(Number.isFinite(data.permanent_credits) ? { permanent_credits: data.permanent_credits } : {}),
    ...(Number.isFinite(data.monthly_resets_at) ? { monthly_resets_at: data.monthly_resets_at } : {}),
  };
}

/** How long a balance is shown before Meshy is asked again. */
export const BALANCE_CACHE_MS = 60_000;
let balanceCache: { at: number; key: string; value: Promise<MeshyBalance> } | null = null;

/** The balance, asked at most once a minute (a failed answer isn't kept). */
export function cachedBalance(c: MeshyClient): Promise<MeshyBalance> {
  const key = `${c.baseUrl} ${c.key}`;
  if (balanceCache && balanceCache.key === key && Date.now() - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.value;
  const entry = { at: Date.now(), key, value: getBalance(c) };
  balanceCache = entry;
  entry.value.catch(() => { if (balanceCache === entry) balanceCache = null; });
  return entry.value;
}

/** Credits were spent: the next balance asks Meshy. */
export function forgetBalance() { balanceCache = null; }

/** Starts a model from a description; returns the task id. Each call costs credits: never retry it blindly. */
export async function createTextTo3d(c: MeshyClient, prompt: string, signal?: AbortSignal): Promise<string> {
  const { data } = await call<{ result: string }>(c, 'POST', PATHS['text-to-3d'], {
    mode: 'preview', prompt: prompt.slice(0, MAX_MESHY_PROMPT), ai_model: 'meshy-7.1', geometry_resolution: '2k', should_remesh: false, target_formats: ['glb'],
  }, 60000, signal);
  if (typeof data?.result !== 'string') throw new MeshyError('Meshy returned no task id');
  return data.result;
}

/** Textures the colour asks for: the base colour only (no PBR maps), 2k, without baked-in lighting. */
const TEXTURE = { enable_pbr: false, texture_resolution: '2k', remove_lighting: true } as const;

/** Paints a finished Text to 3D preview (the refine stage, 10 credits); returns the refine task's id. */
export async function createTextRefine(c: MeshyClient, previewTaskId: string, signal?: AbortSignal): Promise<string> {
  const { data } = await call<{ result: string }>(c, 'POST', PATHS['text-to-3d'], { mode: 'refine', preview_task_id: previewTaskId, ...TEXTURE, target_formats: ['glb'] }, 60000, signal);
  if (typeof data?.result !== 'string') throw new MeshyError('Meshy returned no task id');
  return data.result;
}

/**
 * Starts a model from a photo (a data URI: JPEG, PNG or WebP up to 20 MB), textured with `color`:
 * painted from `textureDataUri` (the same picture in colour, also a data URI) when given, otherwise
 * by Meshy from the photo itself. Returns the task id.
 */
export async function createImageTo3d(c: MeshyClient, imageDataUri: string, signal?: AbortSignal, color = false, textureDataUri?: string): Promise<string> {
  const { data } = await call<{ result: string }>(c, 'POST', PATHS['image-to-3d'], {
    image_url: imageDataUri, ai_model: 'meshy-7.1', geometry_resolution: '2k', should_texture: color, ...(color ? TEXTURE : {}),
    ...(color && textureDataUri ? { texture_image_url: textureDataUri } : {}), should_remesh: false, target_formats: ['glb'],
  }, 60000, signal);
  if (typeof data?.result !== 'string') throw new MeshyError('Meshy returned no task id');
  return data.result;
}

export async function getTask(c: MeshyClient, kind: MeshyKind, id: string, signal?: AbortSignal): Promise<{ task: MeshyTask; retryAfter: number | null }> {
  const { data, headers } = await call<MeshyTask>(c, 'GET', `${PATHS[kind]}/${encodeURIComponent(id)}`, undefined, 30000, signal);
  const ra = Number(headers.get('retry-after'));
  return { task: data, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null };
}

/**
 * Polls a task until it is done, as Meshy asks: every Retry-After seconds (5 s without one),
 * giving up `timeoutMs` after it was created. Network and server errors while polling are
 * retried (the task runs on regardless); a stopped generation deletes a task that hasn't started,
 * which refunds it.
 */
export async function waitForTask(c: MeshyClient, kind: MeshyKind, id: string, opts: {
  signal?: AbortSignal; onProgress?: (t: MeshyTask) => void; timeoutMs?: number;
} = {}): Promise<MeshyTask> {
  const sleep = c.sleep ?? defaultSleep;
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  let failures = 0;
  let last: MeshyTask | null = null;
  try {
    for (;;) {
      let wait = 5;
      try {
        const { task, retryAfter } = await getTask(c, kind, id, opts.signal);
        failures = 0;
        last = task;
        opts.onProgress?.(task);
        if (task.status === 'SUCCEEDED') return task;
        if (task.status === 'FAILED' || task.status === 'CANCELED') {
          const e = task.task_error;
          throw new MeshyError(`Meshy couldn't make the model: ${e?.message || task.status.toLowerCase()}${e?.code ? ` (${e.code})` : ''}`, undefined, e?.code ?? task.status);
        }
        wait = retryAfter ?? 5;
      } catch (e) {
        if (opts.signal?.aborted || !(e instanceof MeshyError) || e.code) throw e;
        // 4xx other than a rate limit won't get better; anything else is retried a few times.
        if (e.status && e.status < 500 && e.status !== 429) throw e;
        if (++failures > 5) throw e;
        wait = Math.min(30, 2 ** failures);
      }
      if (Date.now() - started > timeoutMs) throw new MeshyError(`Meshy didn't finish within ${Math.round(timeoutMs / 60000)} minutes (task ${id}; it may still finish in your Meshy account)`, undefined, 'timeout');
      await sleep(wait * 1000, opts.signal);
    }
  } catch (e) {
    if (opts.signal?.aborted && (!last || last.status === 'PENDING')) {
      // Fire and forget: a PENDING task is deleted and refunded; a running one can't be stopped.
      void call(c, 'DELETE', `${PATHS[kind]}/${encodeURIComponent(id)}`, undefined, 10000).catch(() => undefined);
    }
    throw e;
  }
}

/** Downloads one of a finished task's files (signed URLs that expire after a few days). */
export async function download(c: MeshyClient, url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; type: string }> {
  if (!/^https?:\/\//i.test(url)) throw new MeshyError('Meshy returned an invalid download link');
  let r: Response;
  try {
    r = await (c.fetch ?? fetch)(url, { signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]) });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new MeshyError(`Couldn't download from Meshy: ${(e as Error).message}`);
  }
  if (!r.ok) throw new MeshyError(`Downloading from Meshy failed (HTTP ${r.status})`, r.status);
  const tooBig = () => new MeshyError('The model Meshy made is too big to download');
  if (Number(r.headers.get('content-length')) > MAX_DOWNLOAD) {
    void r.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  // Read as it comes, so a body larger than it said (or one with no length) stops at the limit
  // instead of being held in memory whole.
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (r.body) {
    const reader = r.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if ((size += value.length) > MAX_DOWNLOAD) {
          void reader.cancel().catch(() => undefined);
          throw tooBig();
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof MeshyError || signal?.aborted) throw e;
      throw new MeshyError(`Couldn't download from Meshy: ${(e as Error).message}`);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return { bytes, type: r.headers.get('content-type') ?? '' };
}

/** The printing wishes added to every description (Meshy's own advice for figurines). */
export function meshyPrompt(subject: string): string {
  const extra = ', on a stable circular base, solid, printable, no thin overhangs';
  return subject.trim().slice(0, MAX_MESHY_PROMPT - extra.length) + extra;
}

export interface MeshyResult {
  /** The task the model came from (a coloured Text to 3D model's refine task). */
  task: MeshyTask;
  /** Credits all its tasks used (preview and refine). */
  credits: number;
  /** The model file and its name (for its format). */
  model: { bytes: Uint8Array; filename: string };
  picture?: { bytes: Uint8Array; ext: 'png' | 'jpg' | 'webp' };
  /** What was sent: the description, or which picture it was. */
  prompt: string;
}

/**
 * A whole Meshy model: start the task, wait for it, download the model and its preview picture. In
 * colour, a model from a description is painted by a refine task after its preview, and one from a
 * picture is painted from `texture` when given (texture_image_url); `onProgress` says which stage it is in.
 */
export async function generateMeshyModel(c: MeshyClient, input: { prompt: string } | { image: string; label?: string; texture?: string }, opts: {
  signal?: AbortSignal; onProgress?: (t: MeshyTask, stage: 'model' | 'texture') => void; onStarted?: (id: string) => void; timeoutMs?: number; color?: boolean;
} = {}): Promise<MeshyResult> {
  const kind: MeshyKind = 'prompt' in input ? 'text-to-3d' : 'image-to-3d';
  const prompt = 'prompt' in input ? meshyPrompt(input.prompt) : input.label ?? 'From the attached photo';
  const id = 'prompt' in input ? await createTextTo3d(c, prompt, opts.signal) : await createImageTo3d(c, input.image, opts.signal, !!opts.color, input.texture);
  opts.onStarted?.(id);
  const stage = (s: 'model' | 'texture') => ({ ...opts, onProgress: opts.onProgress && ((t: MeshyTask) => opts.onProgress!(t, s)) });
  let task = await waitForTask(c, kind, id, stage('model'));
  let credits = task.consumed_credits ?? 0;
  if (opts.color && kind === 'text-to-3d') {
    const refine = await createTextRefine(c, id, opts.signal);
    opts.onStarted?.(refine);
    task = await waitForTask(c, kind, refine, stage('texture'));
    credits += task.consumed_credits ?? 0;
  }
  const urls = task.model_urls ?? {};
  // Missing formats may come as "" as well as absent.
  const fmt = (['glb', 'stl', 'obj'] as const).find((f) => urls[f]);
  if (!fmt) throw new MeshyError('Meshy finished but returned no GLB, STL or OBJ model');
  const model = await download(c, urls[fmt], opts.signal);
  let picture: MeshyResult['picture'];
  if (task.thumbnail_url) {
    try {
      const p = await download(c, task.thumbnail_url, opts.signal);
      const b = p.bytes;
      const ext = b[0] === 0x89 && b[1] === 0x50 ? 'png' : b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b[8] === 0x57 && b[9] === 0x45 ? 'webp' : null;
      if (ext) picture = { bytes: b, ext };
    } catch (e) {
      if (opts.signal?.aborted) throw e; // the picture is optional
    }
  }
  return { task, credits, model: { bytes: model.bytes, filename: `meshy-${task.id ?? id}.${fmt}` }, picture, prompt };
}
