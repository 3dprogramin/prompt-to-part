/**
 * When something happened, short enough for a list row: "just now", "12 min ago", "today 4:46 PM",
 * "yesterday 11:47 PM", "Oct 27", "Mar 3, 2025". The full date and time go in a tooltip (whenFull).
 */
export function whenShort(at: number | string | Date, now = Date.now()): string {
  const t = new Date(at);
  const ago = now - t.getTime();
  if (ago >= 0 && ago < 60_000) return 'just now';
  if (ago >= 0 && ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(t)) / 86_400_000);
  const time = t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  const sameYear = t.getFullYear() === new Date(now).getFullYear();
  return t.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function whenFull(at: number | string | Date): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
