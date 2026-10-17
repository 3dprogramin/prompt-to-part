/** Lines added and removed going from `before` to `after` (a longest-common-subsequence line diff, like git's counts). */
export function lineChanges(before: string, after: string): { added: number; removed: number } {
  const a = before ? before.split('\n') : [], b = after ? after.split('\n') : [];
  // Common lines at both ends don't count and needn't go through the quadratic part.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const x = a.slice(start, endA), y = b.slice(start, endB);
  if (!x.length || !y.length || x.length * y.length > 4_000_000) return { added: y.length, removed: x.length };
  let prev = new Uint32Array(y.length + 1), row = new Uint32Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) row[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    [prev, row] = [row, prev];
  }
  const common = prev[y.length];
  return { added: y.length - common, removed: x.length - common };
}
