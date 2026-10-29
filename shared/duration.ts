/** A duration for people: "45 s", "2 min 24 s", "1 h 3 min 5 s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h) return `${h} h ${m} min ${s} s`;
  if (m) return `${m} min ${s} s`;
  return `${s} s`;
}

/** An API cost for people: "$0.30", "$1.24", "<$0.01". */
export function formatCost(usd: number): string {
  return usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`;
}
