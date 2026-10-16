import type { AgentStep, Design, DesignSummary, ParamValues } from '../../shared/types';

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'step'; step: AgentStep }
  | { type: 'model'; code: string; summary: string }
  | { type: 'done'; durationMs: number; turns: number; submitted: boolean; text: string }
  | { type: 'error'; message: string };

export const api = {
  async listDesigns(): Promise<DesignSummary[]> {
    const r = await fetch('/api/designs');
    return r.ok ? r.json() : [];
  },
  async getDesign(id: string): Promise<Design | null> {
    const r = await fetch(`/api/designs/${id}`);
    return r.ok ? r.json() : null;
  },
  async saveDesign(d: Design): Promise<void> {
    await fetch(`/api/designs/${d.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
  },
  async deleteDesign(id: string): Promise<void> {
    await fetch(`/api/designs/${id}`, { method: 'DELETE' });
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
}

export async function generate(body: GenerateBody, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
