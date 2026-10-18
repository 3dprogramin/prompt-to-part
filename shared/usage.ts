// The Claude subscription's usage limits, as the top-bar chip and the chat show them.

/** One of the plan's usage windows (GET /api/connection in subscription mode). */
export interface UsageWindow {
  /** Claude Code's name for it: 'five_hour', 'seven_day', 'seven_day_opus', … */
  kind: string;
  /** For people: "5-hour", "7-day", "7-day Opus". */
  label: string;
  /** Share of the window used, 0–100 (it can pass 100). */
  percent: number;
  /** When the window resets (ms since 1970), if known. */
  resetsAt?: number;
  /** The limit is reached: nothing runs until it resets. */
  limited: boolean;
  /** When Jig learnt this (ms since 1970). */
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

/**
 * What the chip shows: the most-used window's percentage, 'warn' from 80 % and 'limited' while a
 * limit is reached (until the last limited window resets, if known). Null without any windows.
 */
export function usageSummary(windows: UsageWindow[] | undefined, now = Date.now()): { percent: number; level: 'ok' | 'warn' | 'limited'; until?: number } | null {
  const ws = (windows ?? []).map((w) => currentWindow(w, now));
  if (!ws.length) return null;
  const percent = Math.max(...ws.map((w) => w.percent));
  const limited = ws.filter((w) => w.limited || w.percent >= 100);
  if (limited.length) {
    const resets = limited.map((w) => w.resetsAt);
    return { percent, level: 'limited', until: resets.every((r) => r != null) ? Math.max(...(resets as number[])) : undefined };
  }
  return { percent, level: percent >= 80 ? 'warn' : 'ok' };
}
