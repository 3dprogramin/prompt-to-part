import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Design } from '../../shared/types';
import { api } from '../lib/api';
import { createDesignSaver, type DesignSaver } from '../lib/designSaver';
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
  /** A save conflict brought the server's newer copy (after the open design, if it is that one, adopted it). */
  onConflict?: (fresh: Design) => void;
  /** The design was deleted (in another tab or window); nothing saves it any more. */
  onGone: (id: string) => void;
}

/**
 * Saving designs (see lib/designSaver): each design is saved about half a second after its last
 * change and every few seconds while it is being worked on. Failed saves are kept per design
 * ("Not saved - retry"), a save conflict adopts the newer copy, and closing the page with unsaved
 * changes or a running generation asks first.
 */
export function useDesignSaving({ setDesign, currentId, runningRef, onSaved, onAdopted, onConflict, onGone }: Options) {
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  // The design object as it came from the server or another tab: already saved, so not autosaved.
  const lastLoaded = useRef<Design | null>(null);
  // A design adopted after a save conflict keeps the notice that explains it.
  const adopted = useRef<Design | null>(null);
  const callbacks = useRef({ setDesign, currentId, runningRef, onSaved, onAdopted, onConflict, onGone });
  callbacks.current = { setDesign, currentId, runningRef, onSaved, onAdopted, onConflict, onGone };

  // One saver for the life of the component; it reads the latest callbacks through the ref.
  const saverRef = useRef<DesignSaver | null>(null);
  saverRef.current ??= createDesignSaver({
    save: (d, base, keepalive) => api.saveDesign(d, base, keepalive),
    load: (id) => api.getDesign(id),
    isRunning: (id) => !!callbacks.current.runningRef.current[id],
    tell,
    onSaved: (d) => callbacks.current.onSaved(d),
    onConflict: (fresh) => {
      const cb = callbacks.current;
      cb.setDesign((cur) => {
        if (cur.id !== fresh.id) return cur;
        lastLoaded.current = adopted.current = fresh;
        return fresh;
      });
      if (cb.currentId.current === fresh.id) cb.onAdopted();
      cb.onConflict?.(fresh);
    },
    onGone: (id) => callbacks.current.onGone(id),
    onErrors: setSaveErrors,
  });
  const saver = saverRef.current;

  useEffect(() => {
    // Closing the tab loses unsaved changes and stops Claude (the server aborts a generation whose
    // page is gone), so both ask first.
    const onUnload = (e: BeforeUnloadEvent) => { if (saver.hasUnsaved() || Object.keys(runningRef.current).length) e.preventDefault(); };
    // Leaving anyway: changes still waiting for their timer are saved at once (best effort).
    const onHide = () => saver.flushWaiting();
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onHide);
    return () => { window.removeEventListener('beforeunload', onUnload); window.removeEventListener('pagehide', onHide); };
  }, [runningRef, saver]);

  const { saveNow, saveSoon, clearSaveError, stopSaving, cancelPending, isUnsaved } = saver;
  return { saveNow, saveSoon, saveErrors, clearSaveError, lastLoaded, adopted, stopSaving, cancelPending, isUnsaved };
}
