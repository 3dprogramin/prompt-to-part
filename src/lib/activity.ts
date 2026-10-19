import type { ActivityItem, AgentStep, ChatMessage } from '../../shared/types';
import type { AgentEvent } from './api';

type BlockEvent = Extract<AgentEvent, { type: 'block' }>;

/** Apply a streamed content-block event to the live transcript. */
export function applyBlock(list: ActivityItem[], ev: BlockEvent): ActivityItem[] {
  if (ev.op === 'start') {
    const at = ev.at ?? 0;
    return [...list, ev.kind === 'tool' ? { kind: 'tool', name: ev.name ?? '', label: ev.label ?? ev.name ?? 'Tool', fields: {}, at } : { kind: ev.kind, text: '', at }];
  }
  // Deltas belong to the newest block (steps may have been logged after it started).
  let i = list.length - 1;
  while (i >= 0 && list[i].kind === 'step') i--;
  const b = list[i];
  if (!b) return list;
  let next: ActivityItem | null = null;
  if (ev.op === 'append' && (b.kind === 'thinking' || b.kind === 'text')) next = { ...b, text: b.text + ev.text };
  else if (ev.op === 'fields' && b.kind === 'tool') next = { ...b, fields: ev.fields };
  if (!next) return list;
  const out = list.slice();
  out[i] = next;
  return out;
}

/** Log a finished step; thinking and reply text that already streamed in are completed, not repeated. */
export function addStep(list: ActivityItem[], step: AgentStep): ActivityItem[] {
  if (step.kind === 'thinking' || step.kind === 'text') {
    const kind = step.kind;
    const full = step.text.trim();
    for (let i = list.length - 1; i >= 0; i--) {
      const x = list[i];
      if (x.kind !== kind) continue;
      const streamed = x.text.trim();
      if (streamed === full) return list;
      if (streamed && full.startsWith(streamed)) {
        const out = list.slice();
        out[i] = { ...x, text: step.text };
        return out;
      }
    }
    return [...list, { kind, text: step.text, at: step.at ?? 0 }];
  }
  return [...list, { kind: 'step', step }];
}

/**
 * When the reply's current thinking started (ms into the reply), while its newest block is one:
 * thinking lasts until the next block (a tool call or the reply) starts. Null when it isn't thinking.
 */
export function thinkingSince(list: ActivityItem[]): number | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const x = list[i];
    if (x.kind !== 'step') return x.kind === 'thinking' ? x.at : null;
  }
  return null;
}

/** How long block `i` took: until the next block started, else the last step logged after it; undefined if nothing came after it. */
export function blockDuration(list: ActivityItem[], i: number): number | undefined {
  const it = list[i];
  if (!it || it.kind === 'step') return undefined;
  let end: number | undefined;
  for (let j = i + 1; j < list.length; j++) {
    const x = list[j];
    if (x.kind !== 'step') { end = x.at; break; }
    if (x.step.at != null) end = x.step.at;
  }
  return end == null ? undefined : Math.max(0, end - it.at);
}

/** The transcript to show for a reply: the live (or saved) one if there is one, else rebuilt from its steps. */
export function activityOf(m: ChatMessage): ActivityItem[] {
  if (m.activity?.length) return m.activity;
  return (m.steps ?? []).filter((s) => s.kind !== 'assembly').reduce(addStep, [] as ActivityItem[]);
}

/** Most characters of a reply's transcript saved with the design (the whole of it stays in memory). */
export const MAX_SAVED_ACTIVITY = 200_000;
/** Longest tool input (e.g. a model.js being written: the versions keep it anyway) or step detail in a saved transcript. */
const MAX_SAVED_FIELD = 2000;

const clipped = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}\n… (${(s.length - max).toLocaleString('en')} more characters, not saved)`);

function itemSize(it: ActivityItem): number {
  if (it.kind === 'tool') return it.label.length + Object.values(it.fields).reduce((n, v) => n + v.length, 0);
  if (it.kind === 'step') return it.step.text.length + (it.step.detail?.length ?? 0);
  return it.text.length;
}

/**
 * A reply's transcript as it is saved (designs are saved often, so it is kept small): thinking and
 * reply text as they are, long tool inputs and step details shortened, and if that is still over
 * `max` characters, only the newest entries.
 */
export function trimActivity(items: ActivityItem[], max = MAX_SAVED_ACTIVITY): ActivityItem[] {
  const short = items.map((it): ActivityItem => {
    if (it.kind === 'tool') return { ...it, fields: Object.fromEntries(Object.entries(it.fields).map(([k, v]) => [k, clipped(v, MAX_SAVED_FIELD)])) };
    if (it.kind === 'step') return it.step.detail && it.step.detail.length > MAX_SAVED_FIELD ? { ...it, step: { ...it.step, detail: clipped(it.step.detail, MAX_SAVED_FIELD) } } : it;
    return it.text.length > max / 2 ? { ...it, text: clipped(it.text, max / 2) } : it;
  });
  let total = 0, from = short.length;
  while (from > 0 && total + itemSize(short[from - 1]) <= max) total += itemSize(short[--from]);
  if (!from) return short;
  return [{ kind: 'step', step: { kind: 'status', text: `… ${from} earlier ${from === 1 ? 'entry' : 'entries'} not saved` } }, ...short.slice(from)];
}

export const INTERRUPTED = 'Interrupted – Jig stopped before finishing (the server restarted or the page reloaded). Send "continue" to pick up where it stopped.';

/** A reply saved while Jig worked on it that nothing is working on any more (and that has no error of its own). */
export const wasInterrupted = (m: ChatMessage, live: boolean) => m.role === 'assistant' && !!m.pending && !live && !m.error;
