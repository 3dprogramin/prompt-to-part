import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Design } from '../../shared/types';
import { api, HttpError } from '../lib/api';
import { tell } from '../lib/tabs';

interface Options {
  setDesign: Dispatch<SetStateAction<Design>>;
  /** Id of the open design. */
  currentId: MutableRefObject<string>;
  /** Generations running in this tab, by design id. */
  runningRef: MutableRefObject<Record<string, AbortController>>;
  /** After a save: refresh the Designs list and drop a background copy that is now saved. */
  onSaved: (saved: Design) => void;
  /** Another tab's newer copy replaced the open design. */
  onAdopted: () => void;
  /** The design was deleted (in another tab or window); nothing saves it any more. */
  onGone: (id: string) => void;
}

/**
 * Saving designs: each design is saved about half a second after its last change (its own timer,
 * so opening another design right after a change still saves it). Saves of one design run one
 * after another, each based on the revision the last one produced. Failed saves are kept per
 * design ("Not saved – retry"), a save conflict adopts the newer copy, and closing the page with
 * unsaved changes or a running generation asks first.
 */
export function useDesignSaving({ setDesign, currentId, runningRef, onSaved, onAdopted, onGone }: Options) {
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const unsaved = useRef(new Set<string>());
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // The design object as it came from the server or another tab: already saved, so not autosaved.
  const lastLoaded = useRef<Design | null>(null);
  // Designs being deleted: nothing may save them again (a pending autosave would bring them back).
  const deleting = useRef(new Set<string>());
  // A design adopted after a save conflict keeps the notice that explains it.
  const adopted = useRef<Design | null>(null);
  const callbacks = useRef({ onSaved, onAdopted, onGone });
  callbacks.current = { onSaved, onAdopted, onGone };
  // The newest server revision this tab knows per design (a loaded copy may carry a newer one).
  const revs = useRef(new Map<string, number>());
  const queues = useRef(new Map<string, Promise<void>>());

  const clearSaveError = useCallback((id: string) => setSaveErrors((s) => {
    if (!(id in s)) return s;
    const next = { ...s };
    delete next[id];
    return next;
  }), []);

  const saveOnce = useCallback(async (d: Design, base?: number): Promise<void> => {
    if (deleting.current.has(d.id)) return;
    unsaved.current.add(d.id);
    let saved: Design;
    try {
      saved = await api.saveDesign(d, base ?? Math.max(revs.current.get(d.id) ?? 0, d.rev ?? 0));
    } catch (e) {
      if (e instanceof HttpError && e.status === 410) {
        unsaved.current.delete(d.id);
        clearSaveError(d.id);
        deleting.current.add(d.id);
        callbacks.current.onGone(d.id);
        return;
      }
      if (e instanceof HttpError && e.status === 409 && !deleting.current.has(d.id)) {
        // Another tab saved a newer copy. A generation running here owns the design, so its copy
        // wins; otherwise the newer copy replaces this one.
        if (runningRef.current[d.id] && base === undefined) return saveOnce(d, Number(e.body.rev));
        const fresh = await api.getDesign(d.id).catch(() => null);
        if (fresh) {
          revs.current.set(d.id, fresh.rev ?? 0);
          unsaved.current.delete(d.id);
          clearSaveError(d.id);
          setDesign((cur) => {
            if (cur.id !== d.id) return cur;
            lastLoaded.current = adopted.current = fresh;
            return fresh;
          });
          if (currentId.current === d.id) callbacks.current.onAdopted();
          return;
        }
      }
      setSaveErrors((s) => ({ ...s, [d.id]: (e as Error).message || 'the server could not be reached' }));
      throw e;
    }
    revs.current.set(d.id, saved.rev!);
    unsaved.current.delete(d.id);
    clearSaveError(d.id);
    tell({ type: 'saved', design: saved });
    callbacks.current.onSaved(d);
  }, [clearSaveError, currentId, runningRef, setDesign]);

  /** Save now, after any save of the same design still under way (each builds on the last one's revision). */
  const saveNow = useCallback((d: Design): Promise<void> => {
    const run = (queues.current.get(d.id) ?? Promise.resolve()).catch(() => {}).then(() => saveOnce(d));
    queues.current.set(d.id, run);
    run.finally(() => { if (queues.current.get(d.id) === run) queues.current.delete(d.id); }).catch(() => {});
    return run;
  }, [saveOnce]);

  /** Save a design about half a second after its last change. */
  const saveSoon = useCallback((d: Design) => {
    if (deleting.current.has(d.id)) return;
    const timers = saveTimers.current;
    unsaved.current.add(d.id);
    clearTimeout(timers.get(d.id));
    timers.set(d.id, setTimeout(() => { timers.delete(d.id); saveNow(d).catch(() => {}); }, 600));
  }, [saveNow]);

  /** Drop a pending autosave (e.g. another tab's newer copy replaced the design). */
  const cancelPending = useCallback((id: string) => {
    clearTimeout(saveTimers.current.get(id));
    saveTimers.current.delete(id);
    unsaved.current.delete(id);
  }, []);

  /** Nothing saves this design any more (it is being deleted); `undo` if the delete fails. */
  const stopSaving = useCallback((id: string) => {
    deleting.current.add(id);
    cancelPending(id);
    return { undo: () => deleting.current.delete(id) };
  }, [cancelPending]);

  /** Changes of this design not saved yet (pending, under way or failed). */
  const isUnsaved = useCallback((id: string) => unsaved.current.has(id), []);

  useEffect(() => {
    // Closing the tab loses unsaved changes and stops Claude (the server aborts a generation whose
    // page is gone), so both ask first.
    const onUnload = (e: BeforeUnloadEvent) => { if (unsaved.current.size || Object.keys(runningRef.current).length) e.preventDefault(); };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [runningRef]);

  return { saveNow, saveSoon, saveErrors, clearSaveError, saveTimers, lastLoaded, adopted, stopSaving, cancelPending, isUnsaved };
}
