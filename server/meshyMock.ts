// A stand-in for Meshy's API (https://docs.meshy.ai), for tests and for using generate_3d without
// spending credits: the same paths, auth, status sequence (PENDING → IN_PROGRESS with progress →
// SUCCEEDED), Retry-After, errors and expiring asset links, serving the sample models in
// test/fixtures/meshes. Jig talks to it like to Meshy: MESHY_BASE_URL=http://127.0.0.1:8790/openapi
// and any MESHY_API_KEY starting with msy_.
//
//   pnpm mock:meshy             (port 8790, or MESHY_MOCK_PORT; MESHY_MOCK_SECONDS for the run time)
//
// Test triggers in the prompt: FAIL (the task fails), MODERATION (refused), RESCHEDULE (back to
// PENDING once), FLAKY (the first poll answers 503), BROKEN (a mesh with holes and flipped faces).
// A textured model (image to 3D with should_texture, or a Text to 3D refine task) is the coloured
// figure (colour-figure.glb, with UVs and an embedded base colour texture). Image to 3D takes a
// texture_image_url (a URL or a data URI, like image_url) to paint it from; `created` records it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMeshFile } from '../shared/meshFormats';
import { renderIso } from './render';
import type { PartMesh } from '../shared/types';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'meshes');

/** Which sample model a prompt gets (the first match; the figurine otherwise). */
const MODELS: [RegExp, string][] = [
  [/\bBROKEN\b/, 'broken-holes.glb'],
  [/\bfox/i, 'fox.glb'],
  [/\b(dog|pup|puppy|pug)/i, 'dog.glb'],
  [/\b(cat|kitten|kitty)/i, 'cat.glb'],
  [/\b(fish|koi|carp)/i, 'fish.glb'],
];
const FIGURINE = 'figurine.glb';
const TEXTURED = 'colour-figure.glb';
const TEXTURE_RESOLUTIONS = ['2k', '4k', '8k'];

export interface MockOptions {
  /** Time a task spends IN_PROGRESS (ms). */
  runMs?: number;
  /** Time a task waits as PENDING first (ms). */
  pendingMs?: number;
  /** Retry-After the mock asks for (s). */
  retryAfter?: number;
  /** Credits the account starts with. */
  balance?: number;
  /** The mock's clock (ms), which tasks move on by; tests pass one they advance themselves. */
  now?: () => number;
}

type Status = 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED';
interface Task {
  id: string;
  family: 'text-to-3d' | 'image-to-3d';
  type: string;
  prompt: string;
  created: number;
  credits: number;
  model: string;
  formats: string[];
  fail?: { type: string; code: string; message: string };
  /** Textured (should_texture, or a refine task); `preview`: the preview task a refine paints. */
  textured?: boolean;
  /** Image to 3D: the texture_image_url it was painted from, when a URL (a data URI shows as ""). */
  textureImage?: string;
  preview?: string;
  reschedule?: boolean;
  flaky?: boolean;
  deleted?: boolean;
}

const ERR_DOCS = 'https://docs.meshy.ai/en/api/errors';
const DEFAULT_FORMATS = ['glb', 'fbx', 'obj', 'mtl', 'usdz', 'stl'];
const FORMATS = new Set(['glb', 'obj', 'fbx', 'stl', 'usdz', '3mf']);

/** The mock server; `created` lists the tasks created, with what they were created with (for tests). */
export type MeshyMock = Server & { created: { type: string; body: Record<string, unknown> }[] };

export function createMeshyMock(opts: MockOptions = {}): MeshyMock {
  const runMs = opts.runMs ?? 12000, pendingMs = opts.pendingMs ?? 1500, retryAfter = opts.retryAfter ?? 2;
  const now = opts.now ?? Date.now;
  let balance = opts.balance ?? 1000;
  const tasks = new Map<string, Task>();
  const previews = new Map<string, Buffer>();

  /** The task as Meshy would show it now: its status follows the clock. */
  const view = (t: Task) => {
    // Waiting, then running; RESCHEDULE runs half way, goes back to PENDING (progress 0) and starts again.
    const timeline = t.reschedule ? [pendingMs, runMs / 2, pendingMs, runMs] : [pendingMs, runMs];
    let e = now() - t.created, at = t.created;
    let status: Status = 'SUCCEEDED', progress = 100, started = 0, finished = 0;
    for (let i = 0; i < timeline.length; i++) {
      const d = timeline[i], running = i % 2 === 1, last = i === timeline.length - 1;
      if (running) started = at;
      if (running && last && t.fail && e >= d / 3) { status = 'FAILED'; progress = 0; finished = at + d / 3; break; }
      if (e < d) { status = running ? 'IN_PROGRESS' : 'PENDING'; progress = running ? Math.min(99, Math.floor((e / d) * (last ? 100 : 50))) : 0; if (!running) started = 0; break; }
      e -= d;
      at += d;
      if (last) finished = at;
    }
    const expires = finished ? finished + 259_200_000 : 0;
    const asset = (file: string) => `${base}/mock-assets/${t.id}/${file}?Expires=${Math.floor(expires / 1000)}&Signature=mock`;
    return {
      id: t.id, type: t.type, ...(t.family === 'text-to-3d' ? { prompt: t.prompt, mode: t.preview ? 'refine' : 'preview', ...(t.preview ? { preceding_task_id: t.preview } : {}) } : {}),
      status, progress: status === 'SUCCEEDED' ? 100 : progress, preceding_tasks: 0,
      created_at: t.created, started_at: started, finished_at: finished, ...(t.family === 'image-to-3d' ? { expires_at: expires } : {}),
      model_urls: status === 'SUCCEEDED' ? Object.fromEntries(t.formats.map((f) => [f, asset(`model.${f}`)])) : {},
      thumbnail_url: status === 'SUCCEEDED' ? asset('preview.png') : '',
      texture_urls: status === 'SUCCEEDED' && t.textured ? [{ base_color: asset('texture_0.png') }] : [], texture_prompt: '', texture_image_url: t.textureImage ?? '',
      task_error: status === 'FAILED' ? { ...t.fail, doc_url: `${ERR_DOCS}#${t.fail!.code.replace(/_/g, '-')}` } : { message: '' },
      consumed_credits: status === 'FAILED' ? 0 : t.credits,
    };
  };
  let base = '';

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'X-RateLimit-Limit': '20', 'X-RateLimit-Remaining': '19', 'X-RateLimit-Reset': String(Math.ceil(now() / 1000) + 1), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
  };
  const readBody = (req: IncomingMessage) => new Promise<unknown>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size <= 30 * 1024 * 1024) chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(undefined); } });
  });
  const active = () => [...tasks.values()].filter((t) => !t.deleted && ['PENDING', 'IN_PROGRESS'].includes(view(t).status)).length;

  const create = (res: ServerResponse, family: Task['family'], b: Record<string, unknown>) => {
    const asked = Array.isArray(b.target_formats) ? b.target_formats.map(String) : null;
    if (asked?.some((f) => !FORMATS.has(f))) return send(res, 400, { message: `Invalid target format: ${asked.find((f) => !FORMATS.has(f))}` });
    const formats = asked ?? DEFAULT_FORMATS;
    if (b.ai_model === 'meshy-5') return send(res, 400, { message: 'meshy-5 has been retired; use meshy-6 or latest' });
    if (b.ai_model != null && !['meshy-6-lite', 'meshy-6', 'meshy-7', 'meshy-7.1', 'latest'].includes(String(b.ai_model))) return send(res, 400, { message: `Invalid ai_model: ${b.ai_model}` });
    if (b.geometry_resolution != null && b.geometry_resolution !== 'standard' && !['meshy-7.1', 'latest', undefined].includes(b.ai_model as string)) return send(res, 400, { message: 'geometry_resolution 2k/4k needs meshy-7.1' });
    if (b.target_polycount != null && !(Number(b.target_polycount) >= 100 && Number(b.target_polycount) <= 300000)) return send(res, 400, { message: 'target_polycount must be between 100 and 300000' });
    if (b.texture_resolution != null && !TEXTURE_RESOLUTIONS.includes(String(b.texture_resolution))) return send(res, 400, { message: `Invalid texture_resolution: ${b.texture_resolution} (2k, 4k or 8k)` });
    if (b.enable_pbr != null && typeof b.enable_pbr !== 'boolean') return send(res, 400, { message: 'enable_pbr must be a boolean' });
    let prompt = '';
    let preview: Task | undefined;
    if (family === 'text-to-3d') {
      if (b.mode !== 'preview' && b.mode !== 'refine') return send(res, 400, { message: 'mode is required (preview or refine)' });
      if (b.mode === 'refine') {
        preview = typeof b.preview_task_id === 'string' ? tasks.get(b.preview_task_id) : undefined;
        if (!preview || preview.deleted || preview.family !== 'text-to-3d' || preview.preview) return send(res, 400, { message: 'preview_task_id must be a Text to 3D preview task' });
        if (view(preview).status !== 'SUCCEEDED') return send(res, 400, { message: 'The preview task has not succeeded yet' });
        prompt = preview.prompt;
      } else {
        if (typeof b.prompt !== 'string' || !b.prompt.trim()) return send(res, 400, { message: 'prompt is required' });
        if (b.prompt.length > 800) return send(res, 400, { message: 'prompt must be at most 800 characters' });
        prompt = b.prompt;
      }
    } else {
      const img = b.image_url;
      if (typeof img !== 'string' && typeof b.input_task_id !== 'string') return send(res, 400, { message: 'image_url or input_task_id is required' });
      if (typeof img === 'string') {
        const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(img);
        if (!m && !/^https:\/\//.test(img)) return send(res, 400, { message: 'image_url must be a public URL or a data URI (jpg, jpeg, png or webp)' });
        if (m && (m[2].length * 3) / 4 > 20 * 1024 * 1024) return send(res, 400, { message: 'Image too large (max 20 MB)' });
      }
      if (b.enable_pbr && b.should_texture === false) return send(res, 400, { message: 'enable_pbr requires should_texture' });
      if (b.texture_image_url != null) {
        const tex = b.texture_image_url;
        const m = typeof tex === 'string' ? /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(tex) : null;
        if (typeof tex !== 'string' || (!m && !/^https:\/\//.test(tex))) return send(res, 400, { message: 'texture_image_url must be a public URL or a data URI (jpg, jpeg, png or webp)' });
        if (m && (m[2].length * 3) / 4 > 20 * 1024 * 1024) return send(res, 400, { message: 'Texture image too large (max 20 MB)' });
      }
      prompt = typeof b.texture_prompt === 'string' ? b.texture_prompt : '';
    }
    // 20 for the mesh, 30 textured; 2k/4k geometry costs 5 more; a refine 10.
    const textured = preview ? true : family === 'image-to-3d' && b.should_texture !== false;
    const credits = preview ? 10 : (family === 'text-to-3d' || b.should_texture === false ? 20 : 30) + (b.geometry_resolution === '2k' || b.geometry_resolution === '4k' ? 5 : 0);
    if (balance < credits) return send(res, 402, { message: 'Insufficient credits' });
    if (active() >= 10) return send(res, 429, { message: 'NoMorePendingTasks: too many tasks in the queue' });
    balance -= credits;
    const id = randomUUID();
    const t: Task = {
      id, family, type: family === 'text-to-3d' ? (preview ? 'text-to-3d-refine' : 'text-to-3d-preview') : 'image-to-3d', prompt, created: now(), credits,
      model: textured ? TEXTURED : MODELS.find(([re]) => re.test(prompt))?.[1] ?? FIGURINE, formats, textured,
      ...(textured && typeof b.texture_image_url === 'string' ? { textureImage: b.texture_image_url.startsWith('https://') ? b.texture_image_url : '' } : {}),
      ...(preview ? { preview: preview.id } : {}),
      reschedule: /\bRESCHEDULE\b/.test(prompt), flaky: /\bFLAKY\b/.test(prompt),
      ...(/\bFAIL\b/.test(prompt) ? { fail: { type: 'invalid_input', code: 'image_too_complex', message: 'The uploaded image is too complex for 3D generation.' } } : {}),
      ...(/\bMODERATION\b/.test(prompt) ? { fail: { type: 'invalid_input', code: 'moderation_blocked', message: 'The input was blocked by content moderation.' } } : {}),
    };
    tasks.set(id, t);
    server.created.push({ type: t.type, body: b });
    send(res, 202, { result: id });
  };

  const asset = (res: ServerResponse, t: Task, file: string, expires: number) => {
    if (!Number.isFinite(expires) || expires * 1000 < now()) return send(res, 403, undefined, {}), undefined;
    if (file === 'preview.png') {
      let png = previews.get(t.model);
      if (!png) {
        // A grey render of the model, like Meshy's untextured preview.
        const raw = parseMeshFile(new Uint8Array(readFileSync(path.join(FIXTURES, t.model))), t.model);
        const p = raw.positions;
        const pos = new Float32Array(p.length);
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) {
          pos[i] = p[i]; pos[i + 1] = -p[i + 2]; pos[i + 2] = p[i + 1];
          for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
        }
        const part = { name: 'preview', color: '#c9c9c9', positions: pos, indices: raw.indices, bbox: { min, max }, volume: 0, surfaceArea: 0, triCount: 0, genus: 0, components: 1 } as PartMesh;
        png = renderIso([part], 512).png;
        previews.set(t.model, png);
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    if (file === 'texture_0.png' && t.textured) {
      // The base colour texture embedded in the textured model.
      const glb = readFileSync(path.join(FIXTURES, t.model));
      const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
      const bv = json.bufferViews[json.images[0].bufferView];
      const png = glb.subarray(28 + glb.readUInt32LE(12) + (bv.byteOffset ?? 0), 28 + glb.readUInt32LE(12) + (bv.byteOffset ?? 0) + bv.byteLength);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    const fmt = /^model\.(\w+)$/.exec(file)?.[1];
    if (fmt !== 'glb') return send(res, 404, { message: 'The mock serves GLB models only' });
    const bytes = readFileSync(path.join(FIXTURES, t.model));
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': bytes.length });
    res.end(bytes);
  };

  const sse = (req: IncomingMessage, res: ServerResponse, t: Task) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const tick = () => {
      const v = view(t);
      const done = v.status === 'SUCCEEDED' || v.status === 'FAILED';
      res.write(`event: message\ndata: ${JSON.stringify(done ? v : { id: v.id, progress: v.progress, status: v.status })}\n\n`);
      if (done) { clearInterval(timer); res.end(); }
    };
    const timer = setInterval(tick, 1000);
    req.on('close', () => clearInterval(timer));
    tick();
  };

  const server = Object.assign(createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'mock-assets') {
      const t = tasks.get(parts[1] ?? '');
      if (!t || t.deleted || view(t).status !== 'SUCCEEDED') return send(res, 404, { message: 'Not found' });
      return asset(res, t, parts[2] ?? '', Number(url.searchParams.get('Expires')));
    }
    if (parts[0] !== 'openapi') return send(res, 404, { message: 'Not found' });
    if (!/^Bearer msy_\S+$/.test(req.headers.authorization ?? '')) return send(res, 401, { message: 'Invalid API key' });
    const route = parts.slice(1).join('/');
    if (req.method === 'GET' && route === 'v1/balance') return send(res, 200, { balance, monthly_credits: Math.min(balance, 600), permanent_credits: Math.max(0, balance - 600), monthly_resets_at: now() + 30 * 86400000 });
    const fam = /^(v2\/text-to-3d|v1\/image-to-3d)(?:\/([^/]+))?(?:\/(stream))?$/.exec(route);
    if (!fam) return send(res, 404, { message: 'Not found' });
    const family: Task['family'] = fam[1] === 'v2/text-to-3d' ? 'text-to-3d' : 'image-to-3d';
    const id = fam[2];
    if (!id) {
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (!b || typeof b !== 'object') return send(res, 400, { message: 'Invalid JSON body' });
        return create(res, family, b as Record<string, unknown>);
      }
      if (req.method === 'GET') {
        const size = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size')) || 10));
        const page = Math.max(1, Number(url.searchParams.get('page_num')) || 1);
        const asc = url.searchParams.get('sort_by') === '+created_at';
        const list = [...tasks.values()].filter((t) => t.family === family && !t.deleted).sort((a, b) => (asc ? a.created - b.created : b.created - a.created));
        return send(res, 200, list.slice((page - 1) * size, page * size).map(view));
      }
      return send(res, 405, { message: 'Method not allowed' });
    }
    const t = tasks.get(id);
    if (!t || t.deleted || t.family !== family) return send(res, 404, { message: 'Task not found' });
    if (req.method === 'DELETE') {
      const s = view(t).status;
      if (s === 'IN_PROGRESS') return send(res, 409, { message: 'Task is IN_PROGRESS and cannot be deleted. Wait until it finishes.' });
      if (s === 'PENDING') balance += t.credits;
      t.deleted = true;
      res.writeHead(200);
      return res.end();
    }
    if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' });
    if (fam[3] === 'stream') return sse(req, res, t);
    if (t.flaky) { t.flaky = false; return send(res, 503, { message: 'Service temporarily unavailable' }); }
    const v = view(t);
    send(res, 200, v, v.status === 'PENDING' || v.status === 'IN_PROGRESS' ? { 'Retry-After': String(retryAfter) } : {});
  }), { created: [] as MeshyMock['created'] });
  server.on('listening', () => {
    const a = server.address();
    if (a && typeof a === 'object') base = `http://127.0.0.1:${a.port}`;
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MESHY_MOCK_PORT ?? 8790);
  const seconds = Number(process.env.MESHY_MOCK_SECONDS ?? 12);
  createMeshyMock({ runMs: seconds * 1000 }).listen(port, '127.0.0.1', () => {
    console.log(`Mock Meshy API on http://127.0.0.1:${port}/openapi – in .env set:\n  MESHY_BASE_URL=http://127.0.0.1:${port}/openapi\n  MESHY_API_KEY=msy_mock`);
  });
}
