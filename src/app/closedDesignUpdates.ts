// Results of long jobs (product photos, sale-size builds and slices) for a design that is no longer
// in memory: the job was paid for, so its result is written into the saved design rather than lost.
import type { Design } from '../../shared/types';

export interface ClosedDesignUpdates {
  update(id: string, fn: (d: Design) => Design): Promise<void>;
  /** Resolves once the design has no changes queued or under way (at once when it has none). */
  pending(id: string): Promise<void>;
}

/** Changes for designs not in memory: each loaded, changed and saved, one after another per design. */
export function closedDesignUpdates(deps: {
  /** The server's copy, or null when it has none (api.getDesign). */
  load: (id: string) => Promise<Design | null>;
  /** Save a changed copy (saveNow). */
  save: (d: Design) => Promise<void>;
  /** True when the design is open or in background now: the change was applied there instead. */
  applyInMemory: (id: string, fn: (d: Design) => Design) => boolean;
}): ClosedDesignUpdates {
  // One chain per design, so a second change loads the copy the first one saved.
  const chains = new Map<string, Promise<void>>();

  const step = async (id: string, fn: (d: Design) => Design) => {
    try {
      const loaded = await deps.load(id);
      // Deleted meanwhile: there is nothing to put the result in.
      if (!loaded) return;
      // Opened while it loaded: the open copy would save over this one, so the change goes there.
      if (deps.applyInMemory(id, fn)) return;
      await deps.save(fn(loaded));
    } catch (e) {
      console.warn(`Couldn't update design ${id}:`, (e as Error).message);
    }
  };

  const update = (id: string, fn: (d: Design) => Design): Promise<void> => {
    const run = (chains.get(id) ?? Promise.resolve()).then(() => step(id, fn));
    chains.set(id, run);
    void run.finally(() => { if (chains.get(id) === run) chains.delete(id); });
    return run;
  };

  // Opening the design waits for this: a copy loaded while a change is being saved would lack it, and
  // its next save (on the revision that change produced) would overwrite it without a conflict.
  const pending = async (id: string): Promise<void> => {
    // A change queued while waiting is waited for too.
    for (let run = chains.get(id); run; run = chains.get(id)) await run;
  };

  return { update, pending };
}
