import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Design } from '../../shared/types';
import { channel, TAB_ID, tell, type TabMessage } from '../lib/tabs';

/**
 * Keeps this tab in step with the app's other tabs: their saves and deletes arrive through `onSaved`
 * and `onDeleted` (a version marked or unmarked printed through `onPrinted`), and the designs they are generating are returned (id → last heartbeat). This
 * tab's generations are announced every few seconds, so a closed tab's ones are forgotten.
 */
export function useCrossTabSync(runningRef: MutableRefObject<Record<string, AbortController>>, onSaved: (d: Design) => void, onDeleted: (id: string) => void, onPrinted?: (id: string) => void) {
  const [remoteRunning, setRemoteRunning] = useState<Record<string, number>>({});
  const handlers = useRef({ onSaved, onDeleted, onPrinted });
  handlers.current = { onSaved, onDeleted, onPrinted };
  useEffect(() => {
    if (!channel) return;
    const onMsg = (ev: MessageEvent<TabMessage>) => {
      const m = ev.data;
      if (!m || m.tab === TAB_ID) return;
      if (m.type === 'hello') {
        for (const id of Object.keys(runningRef.current)) tell({ type: 'running', id, on: true });
      } else if (m.type === 'running') {
        setRemoteRunning((r) => {
          const next = { ...r };
          if (m.on) next[m.id] = Date.now(); else delete next[m.id];
          return next;
        });
      } else if (m.type === 'saved') {
        handlers.current.onSaved(m.design);
      } else if (m.type === 'deleted') {
        handlers.current.onDeleted(m.id);
      } else if (m.type === 'printed') {
        handlers.current.onPrinted?.(m.id);
      }
    };
    channel.addEventListener('message', onMsg);
    tell({ type: 'hello' });
    // Heartbeat our generations; forget other tabs' that went quiet (tab closed).
    const beat = setInterval(() => {
      for (const id of Object.keys(runningRef.current)) tell({ type: 'running', id, on: true });
      setRemoteRunning((r) => {
        const now = Date.now();
        const stale = Object.entries(r).filter(([, t]) => now - t > 12000);
        if (!stale.length) return r;
        const next = { ...r };
        for (const [id] of stale) delete next[id];
        return next;
      });
    }, 4000);
    return () => { channel?.removeEventListener('message', onMsg); clearInterval(beat); };
  }, [runningRef]);
  return remoteRunning;
}
