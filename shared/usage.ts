// The Claude subscription's usage limits, as the top-bar chip and the chat show them.

/** One of the plan's usage windows (GET /api/connection in subscription mode). */
export interface UsageWindow {
  /** Claude Code's name for it: 'five_hour', 'seven_day', 'seven_day_opus', … */
  kind: string;
  /** For people: "5-hour", "7-day", "7-day Opus". */
  label: string;
  /** Share of the window used, 0-100 (it can pass 100). */
  percent: number;
  /** When the window resets (ms since 1970), if known. */
  resetsAt?: number;
  /** The limit is reached: nothing runs until it resets. */
  limited: boolean;
  /** When the app learnt this (ms since 1970). */
  at: number;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

/** A reset time in local time: "18:40" today, "Mon 09:00" on another day. */
export function formatReset(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? time : `${DAYS[d.getDay()]} ${time}`;
}

/** A window as it stands now: once its reset time has passed it starts again from 0 %. */
export function currentWindow(w: UsageWindow, now = Date.now()): UsageWindow {
  return w.resetsAt != null && w.resetsAt <= now ? { ...w, percent: 0, limited: false, resetsAt: undefined } : w;
}

/** A window's name in short, for the chip: "5h", "7d", "7d Opus". */
export const shortLabel = (w: UsageWindow) => w.label.replace(/^(\d+)-hour\b/, '$1h').replace(/^(\d+)-day\b/, '$1d');

/**
 * What the chip shows: the most-used window's percentage and short name (which limit it is), 'warn'
 * from 80 % and 'limited' while a limit is reached (until the last limited window resets, if known;
 * then the name is the limited one's). Null without any windows.
 */
export function usageSummary(windows: UsageWindow[] | undefined, now = Date.now()): { percent: number; level: 'ok' | 'warn' | 'limited'; window: string; until?: number } | null {
  const ws = (windows ?? []).map((w) => currentWindow(w, now));
  if (!ws.length) return null;
  const top = ws.reduce((a, b) => (b.percent > a.percent ? b : a));
  const percent = top.percent;
  const limited = ws.filter((w) => w.limited || w.percent >= 100);
  if (limited.length) {
    const resets = limited.map((w) => w.resetsAt);
    const last = limited.reduce((a, b) => ((b.resetsAt ?? Infinity) > (a.resetsAt ?? Infinity) ? b : a));
    return { percent, level: 'limited', window: shortLabel(last), until: resets.every((r) => r != null) ? Math.max(...(resets as number[])) : undefined };
  }
  return { percent, level: percent >= 80 ? 'warn' : 'ok', window: shortLabel(top) };
}
