// The Claude subscription's usage limits (the 5-hour and 7-day windows), for the chip in the top bar
// and the chat's "limit reached" error. Claude Code reports them during replies (rate_limit_event),
// and Jig asks it for its /usage data in between (server/connection.ts). The newest report of each
// window wins; kept in memory only.
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { currentWindow, type UsageWindow } from '../shared/usage';

const LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: '7-day',
  seven_day_opus: '7-day Opus',
  seven_day_sonnet: '7-day Sonnet',
  seven_day_overage_included: '7-day (one model)',
  overage: 'Extra usage',
};
const ORDER = ['five_hour', 'seven_day'];
const windows = new Map<string, UsageWindow>();

function put(kind: string, percent: number, resetsAt: number | undefined, limited: boolean, at: number, label?: string) {
  const old = windows.get(kind);
  if (old && old.at > at) return;
  windows.set(kind, { kind, label: label ?? old?.label ?? LABELS[kind] ?? kind, percent, ...(resetsAt != null && { resetsAt }), limited, at });
}

/**
 * A rate_limit_event from a reply: the window that limits now (utilization 0–1, resetsAt in
 * seconds) and whether it lets requests through.
 */
export function recordRateLimit(info: SDKRateLimitInfo, now = Date.now()) {
  // Claude Code also sends the 5-hour and 7-day windows on each event, in a field the SDK doesn't
  // document yet: read it when it is there.
  const all = (info as { unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown } | undefined> }).unifiedWindows;
  for (const [kind, w] of Object.entries(all ?? {})) {
    if (w && typeof w.utilization === 'number') put(kind, w.utilization * 100, typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : undefined, false, now);
  }
  const kind = info.rateLimitType;
  if (!kind) return;
  const limited = info.status === 'rejected';
  const percent = typeof info.utilization === 'number' ? info.utilization * 100 : limited ? 100 : windows.get(kind)?.percent;
  if (percent == null) return;
  put(kind, percent, info.resetsAt != null ? info.resetsAt * 1000 : windows.get(kind)?.resetsAt, limited, now);
}

/** Claude Code's /usage data: utilization 0–100, reset times as ISO dates. */
export function recordUsage(limits: NonNullable<SDKControlGetUsageResponse['rate_limits']>, now = Date.now()) {
  const time = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : undefined);
  for (const kind of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const) {
    const w = limits[kind];
    if (w?.utilization != null) put(kind, w.utilization, time(w.resets_at), w.utilization >= 100, now);
  }
  // Per-model weekly windows; a single one is the window replies report as seven_day_overage_included.
  const models = limits.model_scoped ?? [];
  for (const m of models) {
    if (m.utilization != null) put(models.length === 1 ? 'seven_day_overage_included' : `model:${m.display_name}`, m.utilization, time(m.resets_at), m.utilization >= 100, now, `7-day ${m.display_name}`);
  }
}

/** The windows as they stand now (a window whose reset time has passed is back at 0 %), 5-hour first. */
export function usageWindows(now = Date.now()): UsageWindow[] {
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  return [...windows.values()].map((w) => currentWindow(w, now)).sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** When the reached limit lifts (the last limited window resets), or undefined if no limit is reached or it isn't known. */
export function limitResetsAt(now = Date.now()): number | undefined {
  const limited = usageWindows(now).filter((w) => w.limited);
  return limited.length && limited.every((w) => w.resetsAt != null) ? Math.max(...limited.map((w) => w.resetsAt!)) : undefined;
}

/** Forget every window (tests). */
export function clearUsage() {
  windows.clear();
}
