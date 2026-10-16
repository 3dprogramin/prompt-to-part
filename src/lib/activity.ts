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

/** The transcript to show for a reply: the live one if this session saw it stream, else rebuilt from its steps. */
export function activityOf(m: ChatMessage): ActivityItem[] {
  if (m.activity?.length) return m.activity;
  return (m.steps ?? []).filter((s) => s.kind !== 'assembly').reduce(addStep, [] as ActivityItem[]);
}
