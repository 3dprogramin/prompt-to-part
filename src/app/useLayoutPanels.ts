// Small screens: the panel a phone shows (or the split layout's pane beside the 3D view), the 3D
// tab marked by a new model, and the 3D view shown while picking a surface.
import { useEffect, useRef, useState } from 'react';
import type { Design } from '../../shared/types';
import type { LayoutTab } from '../components/LayoutTabs';
import { useLayoutMode } from '../hooks/useLayoutMode';
import { load, store } from '../lib/storage';

export function useLayoutPanels({ design, picking }: { design: Design; picking: string | null }) {
  // Small screens (useLayoutMode): a phone shows one panel at a time (`tab`), the split layout the
  // 3D view beside the chat or the side panel (`pane`, the last of those two picked). Remembered
  // in this browser.
  const layout = useLayoutMode();
  const [shownPanel, setShownPanel] = useState<{ tab: LayoutTab; pane: Exclude<LayoutTab, '3d'> }>(() => {
    const saved = load<{ tab?: unknown; pane?: unknown }>('layoutTab', {});
    const pane = saved.pane === 'panel' ? 'panel' : 'chat';
    return { tab: saved.tab === '3d' || saved.tab === 'panel' || saved.tab === 'chat' ? saved.tab : pane, pane };
  });
  useEffect(() => store('layoutTab', shownPanel), [shownPanel]);
  const showPanel = (tab: LayoutTab) => setShownPanel((s) => ({ tab, pane: tab === '3d' ? s.pane : tab }));
  const shownTab: LayoutTab | null = layout === 'phone' ? shownPanel.tab : layout === 'split' ? shownPanel.pane : null;
  // A new version from a reply marks the phone's 3D tab until it is shown (no switch: the reply is
  // still being read).
  const [newModel, setNewModel] = useState(false);
  const seenVersions = useRef({ id: design.id, n: design.versions.length });
  useEffect(() => {
    const seen = seenVersions.current;
    if (seen.id !== design.id) setNewModel(false);
    else if (design.versions.length > seen.n && design.versions.at(-1)?.source === 'ai') setNewModel(true);
    seenVersions.current = { id: design.id, n: design.versions.length };
  }, [design.id, design.versions.length]);
  useEffect(() => { if (layout !== 'phone' || shownPanel.tab === '3d') setNewModel(false); }, [layout, shownPanel.tab, newModel]);
  // Picking a surface for a text or drawing happens in the 3D view: a phone shows it while picking,
  // then goes back to the panel.
  const pickedFrom = useRef<LayoutTab | null>(null);
  useEffect(() => {
    if (layout !== 'phone') return;
    if (picking && shownPanel.tab !== '3d') { pickedFrom.current = shownPanel.tab; showPanel('3d'); }
    if (!picking && pickedFrom.current) { showPanel(pickedFrom.current); pickedFrom.current = null; }
  }, [picking]);
  return { layout, shownPanel, showPanel, shownTab, newModel };
}
