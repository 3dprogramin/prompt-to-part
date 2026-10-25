// The design tabs in the top bar (kept across reloads, at most MAX_TABS), and the designs that
// finished in the background unseen.
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Design } from '../../shared/types';
import { load, store } from '../lib/storage';

/** Most design tabs open at once in the top bar. */
const MAX_TABS = 8;

export function useDesignTabs({ design, currentId, runningRef }: { design: Design; currentId: RefObject<string>; runningRef: RefObject<Record<string, AbortController>> }) {
  // Designs open as tabs in the top bar (kept across reloads), and those that finished in the background unseen.
  // At most MAX_TABS: opening another closes the one used longest ago (never the open one, one
  // Claude is working on, or one that finished unseen); the others are still in Designs.
  const tabUsed = useRef<Record<string, number>>(load('designTabsUsed', {}));
  const trimTabs = (ids: string[], keep: (id: string) => boolean) => {
    const out = [...ids];
    while (out.length > MAX_TABS) {
      const drop = out.filter((id) => !keep(id)).sort((a, b) => (tabUsed.current[a] ?? 0) - (tabUsed.current[b] ?? 0))[0];
      if (!drop) break;
      out.splice(out.indexOf(drop), 1);
    }
    return out;
  };
  const [tabIds, setTabIds] = useState<string[]>(() => trimTabs(load('designTabs', []), (id) => id === currentId.current));
  useEffect(() => store('designTabs', tabIds), [tabIds]);
  const [unseen, setUnseen] = useState<string[]>([]);
  const hasContent = design.messages.length > 0 || !!design.code;
  useEffect(() => {
    tabUsed.current = Object.fromEntries(Object.entries({ ...tabUsed.current, [design.id]: Date.now() }).sort((a, b) => b[1] - a[1]).slice(0, 200));
    store('designTabsUsed', tabUsed.current);
    if (hasContent) setTabIds((t) => (t.includes(design.id) ? t : trimTabs([...t, design.id], (id) => id === design.id || !!runningRef.current[id] || unseen.includes(id))));
    setUnseen((u) => (u.includes(design.id) ? u.filter((x) => x !== design.id) : u));
  }, [design.id, hasContent]);
  return { tabIds, setTabIds, unseen, setUnseen };
}
