// What the app sends Claude besides the request: the current model as the user sees it, messages sent
// while Claude works (steerGeneration) and a recap of the conversation for a fresh session.
import { type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, GenerateRequest, ImageData } from '../../shared/api';
import { geometry, formatReport } from '../geometry';
import type { ParamValues } from '../../shared/types';

export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

type UserContent = Exclude<SDKUserMessage['message']['content'], string>[number];

/**
 * A follow-up's view of the model: the user's screenshot (currentView) and a four-view render at
 * their settings (renderValues), each only when the request brings it. Without either ("Send my
 * view" off, an approval of concept pictures, or no model on screen) Claude is told so instead.
 * `signal` (the generation's) aborting drops the render.
 */
export async function currentModelContext(req: GenerateRequest, emit: (e: AgentEvent) => void, render = (code: string, values: ParamValues, signal?: AbortSignal) => geometry.render(code, values, signal), signal?: AbortSignal): Promise<{ content: UserContent[]; notes: string[] }> {
  const content: UserContent[] = [];
  const notes: string[] = [];
  const view = req.currentView && IMAGE_TYPES.has(req.currentView.mediaType) ? req.currentView : undefined;
  if (!view && !req.renderValues) {
    notes.push('No picture of the current model came with this message: render_model shows it if you need to see it.');
    return { content, notes };
  }
  emit({ type: 'live', text: 'Capturing the current model…' });
  const sent: string[] = [];
  if (view) {
    content.push({ type: 'text', text: 'CURRENT VIEW – the model exactly as the user sees it in the app right now (their camera angle; labels are live measurements in mm):' });
    content.push({ type: 'image', source: { type: 'base64', media_type: view.mediaType as 'image/jpeg', data: view.data } });
    sent.push('your current view');
    emit({ type: 'step', step: { kind: 'render', verbose: true, text: 'Sent your current view', image: `data:${view.mediaType};base64,${view.data}` } });
  }
  if (req.renderValues) {
    try {
      const r = await render(req.code!, req.renderValues, signal);
      if (r.ok && r.png) {
        content.push({ type: 'text', text: `CURRENT MODEL – four-view render at the user's exact current settings (top-left ISO, top-right FRONT, bottom-left RIGHT, bottom-right TOP; grid ${r.gridStep} mm):` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: r.png } });
        notes.push(`Measurements of the current model at the user's settings:\n${formatReport(r)}`);
        sent.push('a four-view render with measurements');
        emit({ type: 'step', step: { kind: 'render', verbose: true, text: 'Sent a four-view render at your settings', image: `data:image/png;base64,${r.png}`, detail: formatReport(r) } });
      }
    } catch { /* the request still works without the render */ }
  }
  if (sent.length) emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Sent ${sent.join(' and ')} of the current model` } });
  return { content, notes };
}

/** The user's messages for one running reply, handed to Claude Code as it asks for them. */
export class Inbox {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  /** Handed to Claude Code, and read by Claude (echoed back). */
  sent = 0;
  read = 0;
  push(m: SDKUserMessage): boolean {
    if (this.closed) return false;
    this.queue.push(m);
    this.wake?.();
    return true;
  }
  /** Sent or waiting messages Claude hasn't read yet. */
  unanswered() { return this.queue.length > 0 || this.sent > this.read; }
  close() { this.closed = true; this.wake?.(); }
  async *drain(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift();
      if (next) { this.sent++; yield next; continue; }
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }
}

/** Running replies by design, for messages sent while Claude works. */
export const steering = new Map<string, { inbox: Inbox; emit: (e: AgentEvent) => void }>();

/**
 * A message for the reply Claude is working on: it reads it at its next step (after the current
 * tool call or thinking). False when no reply is running (or it has just ended): queue it instead.
 */
export function steerGeneration(designId: string, text: string, images: ImageData[] = []): boolean {
  const run = steering.get(designId);
  if (!run) return false;
  const pictures = images.filter((img) => IMAGE_TYPES.has(img.mediaType));
  const ok = run.inbox.push({
    type: 'user', parent_tool_use_id: null, priority: 'next',
    message: { role: 'user', content: [
      { type: 'text', text: `Message from the user while you work${pictures.length ? ' (with pictures)' : ''}:\n${text.trim() || '(see the pictures)'}` },
      ...pictures.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType as 'image/jpeg', data: img.data } })),
    ] },
  });
  if (ok) run.emit({ type: 'step', step: { kind: 'user', text: text.trim() || `${pictures.length} picture${pictures.length > 1 ? 's' : ''}`, ...(pictures[0] ? { image: `data:${pictures[0].mediaType};base64,${pictures[0].data}` } : {}) } });
  return ok;
}

/** The earlier conversation as text for a fresh session (newest messages kept, each shortened). */
export function recapOf(history: GenerateRequest['history']): string | undefined {
  const lines = (history ?? []).filter((h) => h.text.trim()).slice(-12)
    .map((h) => `${h.role === 'user' ? 'User' : 'You'}: ${h.text.replace(/\s+/g, ' ').trim().slice(0, 600)}`);
  if (!lines.length) return undefined;
  return `EARLIER CONVERSATION about this design (the previous session couldn't be continued, so here is what was said; model.js holds the current script):\n${lines.join('\n')}`;
}
