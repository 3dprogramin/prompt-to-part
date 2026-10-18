import type { Design, DesignSummary } from '../../shared/types';
import type { AgentEvent, BackupImport, BambuTemplate, Capabilities, Connection, DesignFiles, FontEntry, GenerateRequest, ImageData, MeshUpload, PriceRequest, PriceSuggestion } from '../../shared/api';
import type { CostSettings, SliceStats } from '../../shared/cost';
import type { FilamentLookup } from '../../shared/filaments';
import type { LayerToneFilament } from '../../shared/layertone';
import type { PhotoRequest, PhotoResponse } from '../../shared/photos';
import { dataUrlToImage } from './files';

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
  const messages = await Promise.all(d.messages.map(async (m) => ({
    ...m,
    images: m.images && await Promise.all(m.images.map(sub)),
    steps: m.steps && await Promise.all(m.steps.map(async (s) => (s.image ? { ...s, image: await sub(s.image) } : s))),
  })));
  return { ...d, messages };
}

export const api = {
  listFonts: () => getJson<FontEntry[]>('/api/fonts'),
  listDesigns: () => getJson<DesignSummary[]>('/api/designs'),
  starDesign: (id: string, starred: boolean) => getJson<{ starred: boolean }>(`/api/designs/${id}/star`, { method: 'PUT', body: JSON.stringify({ starred }) }),
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
   */
  async saveDesign(d: Design, rev: number): Promise<Design> {
    const saved = await withStoredImages(d);
    // The live activity transcript stays in memory (it can hold every model.js Claude typed).
    const body = JSON.stringify({ ...saved, rev }, (k, v) => (k === 'activity' ? undefined : v));
    const r = await (await request(`/api/designs/${d.id}`, { method: 'PUT', body })).json() as { rev: number };
    return { ...saved, rev: r.rev };
  },
  async deleteDesign(id: string): Promise<void> {
    await request(`/api/designs/${id}`, { method: 'DELETE' });
  },
  capabilities: () => getJson<Capabilities>('/api/capabilities'),
  connection: (fresh = false) => getJson<Connection>(`/api/connection${fresh ? '?fresh=1' : ''}`),
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

export async function generate(body: GenerateRequest, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await request('/api/generate', { method: 'POST', body: JSON.stringify(body), signal });
  if (!res.body) throw new Error('The server sent no response');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore malformed */ }
        }
      }
    }
  }
}
