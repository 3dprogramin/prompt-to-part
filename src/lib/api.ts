import type { Design, DesignSummary, Vec3 } from '../../shared/types';
import type { AgentEvent, BackupImport, BambuTemplate, Capabilities, Connection, DesignFiles, FontEntry, GenerateRequest, ImageData, MeshUpload, MeshyBalance, PriceRequest, PriceSuggestion } from '../../shared/api';
import type { CostSettings, SliceStats } from '../../shared/cost';
import type { FilamentLookup } from '../../shared/filaments';
import type { LayerToneFilament } from '../../shared/layertone';
import type { PhotoRequest, PhotoResponse, PhotoSceneRequest, PhotoSceneResponse, SceneIdea } from '../../shared/photos';
import { dataUrlToImage } from './files';
import { trimActivity } from './activity';

export type { AgentEvent, FontEntry } from '../../shared/api';

/** Every write to the API carries X-Jig: the server refuses writes without it (see server/index.ts). */
export const WRITE_HEADERS = { 'Content-Type': 'application/json', 'X-Jig': '1' };

/** A failed API call: the server's message, the HTTP status and the response body. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

const UNREACHABLE = "Can't reach the Jig server – is it running?";

/** fetch() that adds X-Jig to writes and turns a network failure or an error status into an HttpError. */
export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const write = !!init.method && init.method !== 'GET';
  let r: Response;
  try {
    r = await fetch(path, write ? { ...init, headers: { ...WRITE_HEADERS, ...init.headers } } : init);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new HttpError(UNREACHABLE, 0);
  }
  if (r.ok) return r;
  if (r.status === 413) throw new HttpError('Too big for the server to accept', 413);
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  throw new HttpError(typeof body.error === 'string' ? body.error : `HTTP ${r.status}`, r.status, body);
}

const getJson = async <T>(path: string, init?: RequestInit): Promise<T> => (await request(path, init)).json() as Promise<T>;

// Images already stored on the server, by design and the data URL they came from (each design keeps
// its own copy: deleting one design must not break another's). Only images that arrived in this tab
// are data URLs; a design loaded from the server already refers to stored ones.
const storedImages = new Map<string, string>();

/** The design with every data-URL image replaced by its stored copy (uploaded first if needed). */
async function withStoredImages(d: Design): Promise<Design> {
  const sub = async (src: string) => {
    if (!src.startsWith('data:')) return src;
    const key = `${d.id}\n${src}`;
    let url = storedImages.get(key);
    if (!url) {
      ({ url } = await getJson<{ url: string }>(`/api/designs/${d.id}/images`, { method: 'POST', body: JSON.stringify(dataUrlToImage(src)) }));
      storedImages.set(key, url);
      if (storedImages.size > 500) storedImages.delete(storedImages.keys().next().value!);
    }
    return url;
  };
  // The live transcript is kept only for the newest reply, shortened: it can hold every model.js Claude typed.
  const newest = d.messages.findLastIndex((m) => m.role === 'assistant');
  const messages = await Promise.all(d.messages.map(async (m, i) => {
    const steps = m.steps && await Promise.all(m.steps.map(async (s) => (s.image ? { ...s, image: await sub(s.image) } : s)));
    const activity = i === newest && m.activity?.length
      ? await Promise.all(trimActivity(m.activity).map(async (a) => (a.kind === 'step' && a.step.image ? { ...a, step: { ...a.step, image: await sub(a.step.image) } } : a)))
      : undefined;
    return { ...m, images: m.images && await Promise.all(m.images.map(sub)), steps, activity };
  }));
  return { ...d, messages };
}

export const api = {
  listFonts: () => getJson<FontEntry[]>('/api/fonts'),
  listDesigns: () => getJson<DesignSummary[]>('/api/designs'),
  starDesign: (id: string, starred: boolean) => getJson<{ starred: boolean }>(`/api/designs/${id}/star`, { method: 'PUT', body: JSON.stringify({ starred }) }),
  /** Replaces a saved design's tags (404: not saved yet); returns them as stored. */
  tagDesign: (id: string, tags: string[]) => getJson<{ tags: string[] }>(`/api/designs/${id}/tags`, { method: 'PUT', body: JSON.stringify({ tags }) }).then((r) => r.tags),
  /** Adds a tag to several designs or takes it away; returns the ids that changed. */
  tagDesigns: (ids: string[], tag: string, on: boolean) => getJson<{ changed: string[] }>('/api/designs/tags', { method: 'POST', body: JSON.stringify({ ids, [on ? 'add' : 'remove']: tag }) }).then((r) => r.changed),
  /** null if there is no such design; throws if the server can't be reached. */
  async getDesign(id: string): Promise<Design | null> {
    try {
      return await getJson<Design>(`/api/designs/${id}`);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  },
  /**
   * Saves the design as the next revision after `rev` and returns what was saved (images replaced by
   * their stored URLs, `rev` the new revision). 409: another save came first; 410: deleted.
   * `keepalive`: the page is closing, the save should still reach the server (only up to 64 KB).
   */
  async saveDesign(d: Design, rev: number, keepalive = false): Promise<Design> {
    const saved = await withStoredImages(d);
    const body = JSON.stringify({ ...saved, rev });
    const r = await (await request(`/api/designs/${d.id}`, { method: 'PUT', body, keepalive: keepalive && new Blob([body]).size < 64000 })).json() as { rev: number };
    return { ...saved, rev: r.rev };
  },
  async deleteDesign(id: string): Promise<void> {
    await request(`/api/designs/${id}`, { method: 'DELETE' });
  },
  capabilities: () => getJson<Capabilities>('/api/capabilities'),
  connection: (fresh = false) => getJson<Connection>(`/api/connection${fresh ? '?fresh=1' : ''}`),
  /** The Meshy account's credits (only when the server has a Meshy key). */
  meshyBalance: () => getJson<MeshyBalance>('/api/meshy/balance'),
  /** The Bambu Studio project template (built from the user's Bambu Studio the first time: minutes). */
  bambuTemplate: () => getJson<BambuTemplate>('/api/bambu/template', { method: 'POST' }),
  costSettings: () => getJson<CostSettings>('/api/cost/settings'),
  saveCostSettings: (s: CostSettings) => getJson<CostSettings>('/api/cost/settings', { method: 'PUT', body: JSON.stringify(s) }),
  /** The user's own LayerTone filaments (data/filaments.json). */
  myFilaments: () => getJson<{ filaments: LayerToneFilament[] }>('/api/filaments/mine').then((r) => r.filaments),
  saveMyFilaments: (filaments: LayerToneFilament[]) => getJson<{ filaments: LayerToneFilament[] }>('/api/filaments/mine', { method: 'PUT', body: JSON.stringify({ filaments }) }).then((r) => r.filaments),
  /** Slice a Bambu Studio project in the user's Bambu Studio: grams and print time. */
  slice: (project: Blob) => getJson<SliceStats>('/api/slice', { method: 'POST', body: project, headers: { 'Content-Type': 'application/octet-stream' } }),
  suggestPrice: (r: PriceRequest) => getJson<PriceSuggestion>('/api/price', { method: 'POST', body: JSON.stringify(r) }),
  /** A product photo of the design from a render of it (the image model: 10–30 s). */
  /** A fresh setting for a scene preset's random sub-scene, or the user's idea written out, by Claude (seconds). */
  photoScene: (scene: string, size?: Vec3, idea?: SceneIdea) => getJson<PhotoSceneResponse>('/api/photo-scene', { method: 'POST', body: JSON.stringify({ scene, size, ...idea } satisfies PhotoSceneRequest) }).then((r) => r.scene),
  photo: (designId: string, r: PhotoRequest) => getJson<PhotoResponse>(`/api/designs/${designId}/photos`, { method: 'POST', body: JSON.stringify(r) }),
  /** A mesh file attached in the chat: imported, repaired and stored with the design (seconds for big files). */
  uploadMesh: (designId: string, file: File) => getJson<MeshUpload>(`/api/designs/${designId}/meshes?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } }),
  /** Restores the designs (and unsaved settings) in a backup zip from GET /api/backup. */
  importBackup: (file: File) => getJson<BackupImport>('/api/backup/import', { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } }),
  /** The images and mesh files stored with a design. */
  designFiles: (id: string) => getJson<DesignFiles>(`/api/designs/${id}/files`),
  /** Copies one design's mesh files to another (a design started from a version). */
  copyMeshes: (to: string, from: string) => getJson<{ copied: number }>(`/api/designs/${to}/meshes/copy`, { method: 'POST', body: JSON.stringify({ from }) }),
  /** Font files (base64) for the text tool and font previews. */
  fontData: (id: string) => getJson<{ files: string[] }>(`/api/fonts/data?id=${encodeURIComponent(id)}`),
};

/** A filament's colour and TD: from Jig's library, or found on the web by Claude (can take a minute). */
export const lookupFilament = (brand: string, name: string): Promise<FilamentLookup> =>
  getJson<FilamentLookup>('/api/filaments/lookup', { method: 'POST', body: JSON.stringify({ brand, name }) });

/** A message for the reply Claude is working on; false when no reply is running (queue it instead). */
export async function steer(designId: string, text: string, images: ImageData[]): Promise<boolean> {
  try {
    await request(`/api/generate/${designId}/message`, { method: 'POST', body: JSON.stringify({ text, images }) });
    return true;
  } catch {
    return false;
  }
}

/**
 * How following a reply ended: with its last event (done or an error), taken over by another page
 * ('moved'), or 'lost' when the server no longer has it (it restarted, or the reply is long over).
 */
export type ReplyEnd = 'ended' | 'moved' | 'lost';
/** A reply under way on the server and how many of its events a page has. */
export interface ReplyRun { id: string; seen: number }

/**
 * Starts a reply and follows it to its end. A dropped connection (a phone locking its screen) is
 * picked up again where it stopped: the server goes on with the reply meanwhile. `onEvent` gets
 * each event with the number of events seen so far (for resumeReply after a reload).
 */
export const generate = (body: GenerateRequest, onEvent: (e: AgentEvent, seen: number) => void, signal: AbortSignal): Promise<ReplyEnd> =>
  followReply(body.designId, { body }, onEvent, signal);

/** Catches up with a reply under way that a page had followed up to `run.seen` events, and follows it to its end. */
export const resumeReply = (designId: string, run: ReplyRun, onEvent: (e: AgentEvent, seen: number) => void, signal: AbortSignal): Promise<ReplyEnd> =>
  followReply(designId, { run }, onEvent, signal);

/** Tries to reconnect this many times in a row while the page is in view, before giving up. */
const MAX_RECONNECTS = 20;
/** A connection that sent nothing for this long is dead (the server pings every 15 s), e.g. after a phone slept. */
const SILENT_MS = 40_000;

async function followReply(designId: string, from: { body: GenerateRequest } | { run: ReplyRun }, onEvent: (e: AgentEvent, seen: number) => void, signal: AbortSignal): Promise<ReplyEnd> {
  let run = 'run' in from ? { ...from.run } : null;
  // Stop ends the reply on the server too: it no longer stops when the page's connection closes.
  const stop = () => { void request(`/api/generate/${designId}/stop`, { method: 'POST' }).catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    for (let failures = 0; ; ) {
      const attempt = new AbortController();
      const both = AbortSignal.any([signal, attempt.signal]);
      let heard = Date.now();
      const watch = setInterval(() => { if (Date.now() - heard > SILENT_MS) attempt.abort(); }, 5000);
      try {
        const res = run
          ? await request(`/api/generate/${designId}/events?run=${encodeURIComponent(run.id)}&from=${run.seen}`, { signal: both })
          : await request('/api/generate', { method: 'POST', body: JSON.stringify((from as { body: GenerateRequest }).body), signal: both });
        failures = 0;
        let last: AgentEvent | undefined;
        await readEvents(res, () => { heard = Date.now(); }, (e) => {
          last = e;
          if (e.type === 'moved') return;
          if (e.type === 'run') run = { id: e.runId, seen: 0 };
          if (run) run.seen++;
          onEvent(e, run?.seen ?? 0);
        });
        if (last?.type === 'moved') return 'moved';
        if (last?.type === 'done' || last?.type === 'error') return 'ended';
      } catch (e) {
        // Stopped, refused, or the reply never started: nothing to pick up.
        if (signal.aborted || !run || (e instanceof HttpError && e.status !== 0)) {
          if (e instanceof HttpError && e.status === 404) return 'lost';
          throw e;
        }
      } finally {
        clearInterval(watch);
      }
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      // Out of view (a locked phone), the page waits to be back before trying again.
      if (!document.hidden && ++failures > MAX_RECONNECTS) return 'lost';
      await reconnectPause(Math.min(8000, 500 * 2 ** failures), signal);
    }
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/** Waits `ms`, less when the page comes back into view or online; while it is hidden, until it is back. */
function reconnectPause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const onVisible = () => { if (!document.hidden) done(); };
    const t = document.hidden ? undefined : setTimeout(done, ms);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', done);
    signal.addEventListener('abort', done);
  });
}

/** Reads a server-sent event stream to its end. */
async function readEvents(res: Response, onData: () => void, onEvent: (e: AgentEvent) => void): Promise<void> {
  if (!res.body) throw new Error('The server sent no response');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onData();
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          let e: AgentEvent;
          try { e = JSON.parse(line.slice(6)); } catch { continue; /* ignore malformed */ }
          onEvent(e);
        }
      }
    }
  }
}
