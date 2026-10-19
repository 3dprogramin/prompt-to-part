import { useEffect, useState } from 'react';

/**
 * How the workspace is laid out. desktop: chat, 3D view and side panel side by side (resizable).
 * split: the 3D view beside one pane, the chat or the side panel (a tablet, an unfolded foldable).
 * phone: one of the three at a time, picked in a tab bar at the bottom.
 */
export type LayoutMode = 'desktop' | 'split' | 'phone';

const PHONE = '(max-width: 700px)';
// Only on a touch screen: a desktop window this narrow keeps its three columns.
const SPLIT = '(max-width: 1100px) and (pointer: coarse)';

function current(): LayoutMode {
  if (window.matchMedia(PHONE).matches) return 'phone';
  if (window.matchMedia(SPLIT).matches) return 'split';
  return 'desktop';
}

/** The layout for the window's width (and pointer), following it as a phone unfolds or turns. */
export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState(current);
  useEffect(() => {
    const queries = [PHONE, SPLIT].map((q) => window.matchMedia(q));
    const update = () => setMode(current());
    for (const q of queries) q.addEventListener('change', update);
    return () => { for (const q of queries) q.removeEventListener('change', update); };
  }, []);
  return mode;
}
