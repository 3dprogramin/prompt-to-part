import type { Design } from '../../shared/types';
import { HttpError } from './api';

export interface SaverDeps {
  /** Save a copy based on the given server revision (api.saveDesign). */
  save: (d: Design, base: number, keepalive: boolean) => Promise<Design>;
  /** The server's copy, or null if there is none (api.getDesign). */
  load: (id: string) => Promise<Design | null>;
  /** A generation is running in this tab for the design. */
  isRunning: (id: string) => boolean;
  /** Tell the other tabs (lib/tabs). */
  tell: (msg: { type: 'saved'; design: Design }) => void;
  onSaved: (d: Design) => void;
  /** Another tab or device saved a newer copy, which replaces this one (open or kept in the background). */
  onConflict: (fresh: Design) => void;
  /** The design was deleted (in another tab or window); nothing saves it any more. */
  onGone: (id: string) => void;
  /** The failed saves changed: their messages by design id. */
  onErrors: (errors: Record<string, string>) => void;
}

/** While a design is being worked on (many changes a second), it is saved this often (ms). */
const RUNNING_SAVE_MS = 5000;

/**
 * Saving designs: each design is saved about half a second after its last change (its own timer,
 * so opening another design right after a change still saves it), and every few seconds while it
 * is being worked on, so a server restart or a reload keeps most of the reply. Saves of one design run one
 * after another, each based on the revision the last one produced. Failed saves are kept per
 * design ("Not saved - retry"), and a save conflict adopts the newer copy. Plain code, no React,
 * so it can be tested on its own (hooks/useDesignSaving wraps it).
 */
export function createDesignSaver(deps: SaverDeps) {
  let errors: Record<string, string> = {};
  const unsaved = new Set<string>();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // The newest copy of each design with a save timer, and when each design's last timed save began.
  const waiting = new Map<string, Design>();
  const lastTimed = new Map<string, number>();
  // Designs being deleted: nothing may save them again (a pending autosave would bring them back).
  const deleting = new Set<string>();
  // The newest server revision this tab knows per design (a loaded copy may carry a newer one).
  const revs = new Map<string, number>();
  const queues = new Map<string, Promise<boolean>>();
  // Bumped per design when a save conflict adopts the server's copy: saves queued before it hold the
  // stale copy and are skipped.
  const epochs = new Map<string, number>();

  const setErrors = (next: Record<string, string>) => {
    errors = next;
    deps.onErrors(errors);
  };

  const clearSaveError = (id: string) => {
    if (!(id in errors)) return;
    const next = { ...errors };
    delete next[id];
    setErrors(next);
  };

  /** True once saved; false when it wasn't (a newer copy replaced it, or the design is gone). */
  const saveOnce = async (d: Design, base?: number, keepalive = false): Promise<boolean> => {
    if (deleting.has(d.id)) return false;
    unsaved.add(d.id);
    let saved: Design;
    try {
      saved = await deps.save(d, base ?? Math.max(revs.get(d.id) ?? 0, d.rev ?? 0), keepalive);
    } catch (e) {
      if (e instanceof HttpError && e.status === 410) {
        unsaved.delete(d.id);
        clearSaveError(d.id);
        deleting.add(d.id);
        deps.onGone(d.id);
        return false;
      }
      if (e instanceof HttpError && e.status === 409 && !deleting.has(d.id)) {
        // Another tab saved a newer copy. A generation running here owns the design, so its copy
        // wins; otherwise the newer copy replaces this one.
        if (deps.isRunning(d.id) && base === undefined) return saveOnce(d, Number(e.body.rev));
        const fresh = await deps.load(d.id).catch(() => null);
        if (fresh) {
          // An autosave still waiting, or a save queued behind this one, holds the stale copy: with the
          // new revision it would save over the other device's change.
          cancelPending(d.id);
          epochs.set(d.id, (epochs.get(d.id) ?? 0) + 1);
          revs.set(d.id, fresh.rev ?? 0);
          clearSaveError(d.id);
          deps.onConflict(fresh);
          return false;
        }
      }
      setErrors({ ...errors, [d.id]: (e as Error).message || 'the server could not be reached' });
      throw e;
    }
    revs.set(d.id, saved.rev!);
    unsaved.delete(d.id);
    clearSaveError(d.id);
    deps.tell({ type: 'saved', design: saved });
    deps.onSaved(d);
    return true;
  };

  /**
   * Save now, after any save of the same design still under way (each builds on the last one's revision).
   * Resolves false when this copy wasn't saved because a newer one replaced it: a caller with a change
   * of its own (app/closedDesignUpdates) applies it again to that copy.
   */
  const saveNow = (d: Design, keepalive = false): Promise<boolean> => {
    const epoch = epochs.get(d.id) ?? 0;
    const run = (queues.get(d.id) ?? Promise.resolve(true)).catch(() => {}).then(() => {
      // A conflict while this waited replaced the copy it holds: saving it would undo the newer one.
      if ((epochs.get(d.id) ?? 0) !== epoch) return false;
      return saveOnce(d, undefined, keepalive);
    });
    queues.set(d.id, run);
    run.finally(() => { if (queues.get(d.id) === run) queues.delete(d.id); }).catch(() => {});
    return run;
  };

  /**
   * Save a design about half a second after its last change; while it is being worked on, at most every
   * RUNNING_SAVE_MS (the timer isn't pushed back by each change). The timer saves the newest copy.
   */
  const saveSoon = (d: Design) => {
    if (deleting.has(d.id)) return;
    unsaved.add(d.id);
    waiting.set(d.id, d);
    const running = deps.isRunning(d.id);
    if (running && saveTimers.has(d.id)) return;
    clearTimeout(saveTimers.get(d.id));
    const wait = running ? Math.max(600, (lastTimed.get(d.id) ?? 0) + RUNNING_SAVE_MS - Date.now()) : 600;
    saveTimers.set(d.id, setTimeout(() => {
      saveTimers.delete(d.id);
      const latest = waiting.get(d.id) ?? d;
      waiting.delete(d.id);
      lastTimed.set(d.id, Date.now());
      saveNow(latest).catch(() => {});
    }, wait));
  };

  /** Drop a pending autosave (e.g. another tab's newer copy replaced the design). */
  const cancelPending = (id: string) => {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    waiting.delete(id);
    unsaved.delete(id);
  };

  /** Nothing saves this design any more (it is being deleted); `undo` if the delete fails. */
  const stopSaving = (id: string) => {
    deleting.add(id);
    cancelPending(id);
    return { undo: () => { deleting.delete(id); } };
  };

  /** Changes of this design not saved yet (pending, under way or failed). */
  const isUnsaved = (id: string) => unsaved.has(id);

  /**
   * Leaving the page: changes still waiting for their timer (e.g. the last seconds of a reply) are
   * saved at once, as a request that outlives the page where it can (best effort).
   */
  const flushWaiting = () => {
    for (const [id, d] of waiting) {
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
      waiting.delete(id);
      saveNow(d, true).catch(() => {});
    }
  };

  /** Any design with changes not saved yet (closing the page would lose them). */
  const hasUnsaved = () => unsaved.size > 0;

  return { saveNow, saveSoon, cancelPending, stopSaving, isUnsaved, clearSaveError, flushWaiting, hasUnsaved };
}

export type DesignSaver = ReturnType<typeof createDesignSaver>;
