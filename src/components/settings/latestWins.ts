// Saves that never overlap: one runs at a time, and of the changes made meanwhile only the newest
// runs next (a stepped-through select fires a change per key). Only the newest save reports.
export function latestWins<T>(
  save: (value: T) => Promise<void>,
  on: { onStart?: () => void; onSaved: () => void; onFailed: (e: Error) => void },
): (value: T) => void {
  let running = false;
  let waiting: { value: T } | null = null;
  const run = async (value: T) => {
    running = true;
    on.onStart?.();
    let failure: Error | null = null;
    try { await save(value); } catch (e) { failure = e as Error; }
    running = false;
    const next = waiting;
    waiting = null;
    if (next) { void run(next.value); return; }
    if (failure) on.onFailed(failure); else on.onSaved();
  };
  return (value) => {
    if (running) waiting = { value };
    else void run(value);
  };
}
