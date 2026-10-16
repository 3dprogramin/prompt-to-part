import type { AgentStep, Design, DesignSummary, ParamValues } from '../../shared/types';

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'step'; step: AgentStep }
  | { type: 'model'; code: string; summary: string }
  | { type: 'done'; durationMs: number; turns: number; submitted: boolean; text: string }
  | { type: 'error'; message: string }
  | { type: 'live'; text: string }
  | { type: 'block'; op: 'start'; kind: 'thinking' | 'text' | 'tool'; name?: string; label?: string; at?: number }
  | { type: 'block'; op: 'append'; text: string }
  | { type: 'block'; op: 'fields'; fields: Record<string, string> };

export interface FontEntry { id: string; family: string; style: string; source: 'standard' | 'installed' }

/** Every write to the API carries X-Jig: the server refuses writes without it (see server/index.ts). */
export const WRITE_HEADERS = { 'Content-Type': 'application/json', 'X-Jig': '1' };

export const api = {
  async listFonts(): Promise<FontEntry[]> {
    const r = await fetch('/api/fonts');
    return r.ok ? r.json() : [];
  },
  async listDesigns(): Promise<DesignSummary[]> {
    const r = await fetch('/api/designs');
    return r.ok ? r.json() : [];
  },
  async getDesign(id: string): Promise<Design | null> {
    const r = await fetch(`/api/designs/${id}`);
    return r.ok ? r.json() : null;
  },
  async saveDesign(d: Design): Promise<void> {
    // The live activity transcript stays in memory (it can hold every model.js Claude typed).
    const body = JSON.stringify(d, (k, v) => (k === 'activity' ? undefined : v));
    await fetch(`/api/designs/${d.id}`, { method: 'PUT', headers: WRITE_HEADERS, body });
  },
  async deleteDesign(id: string): Promise<void> {
    await fetch(`/api/designs/${id}`, { method: 'DELETE', headers: { 'X-Jig': '1' } });
  },
};

export interface GenerateBody {
  designId: string;
  prompt: string;
  images: { mediaType: string; data: string }[];
  code?: string;
  values?: ParamValues;
  sessionId?: string;
  model: string;
  effort: string;
  /** Description of text the user placed with the text tool (applied after the script). */
  textNote?: string;
  /** Follow-ups: screenshot of the current viewer. */
  currentView?: { mediaType: string; data: string };
  /** Follow-ups: values to render the current state exactly (incl. $scale and $text). */
  renderValues?: ParamValues;
  scale?: number;
  versionNote?: string;
  /** Let Claude search the web (per design, off by default, never saved). */
  webSearch?: boolean;
}

export async function generate(body: GenerateBody, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
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
