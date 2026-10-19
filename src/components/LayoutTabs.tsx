import type { LayoutMode } from '../hooks/useLayoutMode';
import { Icon } from './Icon';

/** The workspace's panels a small screen shows one at a time. */
export type LayoutTab = 'chat' | '3d' | 'panel';

interface Props {
  mode: Exclude<LayoutMode, 'desktop'>;
  /** The panel shown (in the split layout, the pane beside the 3D view: chat or panel). */
  active: LayoutTab;
  onSelect: (tab: LayoutTab) => void;
  /** Jig is working on the design: a pulsing dot on Chat while it isn't shown. */
  working: boolean;
  /** A reply made a new version that hasn't been looked at: a dot on 3D. */
  newModel: boolean;
}

const TABS: [LayoutTab, string, string][] = [['chat', 'Chat', 'chat'], ['3d', '3D', 'cube'], ['panel', 'Panel', 'sliders']];

/**
 * Picks the panel on a small screen: a tab bar at the bottom on a phone (Chat, 3D, Panel), a
 * switch above the pane beside the 3D view in the split layout (Chat, Panel). Placed by the
 * workspace's grid (styles.css).
 */
export function LayoutTabs({ mode, active, onSelect, working, newModel }: Props) {
  return (
    <nav className={`layout-tabs ${mode}`} role="tablist" aria-label="Panels">
      {TABS.filter(([t]) => mode === 'phone' || t !== '3d').map(([t, label, icon]) => {
        const dot = t === 'chat' && working && active !== 'chat' ? 'live' : t === '3d' && newModel && active !== '3d' ? 'new' : null;
        return (
          <button key={t} role="tab" aria-selected={active === t} className={active === t ? 'on' : ''} onClick={() => onSelect(t)}
            title={dot === 'live' ? 'Jig is working on it' : dot === 'new' ? 'A new version to look at' : undefined}>
            <span className="layout-tab-icon"><Icon name={icon} size={20} />{dot && <i className={`layout-dot ${dot}`} />}</span>
            <span>{label}</span>
            {dot && <span className="sr-only">{dot === 'live' ? ' (Jig is working)' : ' (new version)'}</span>}
          </button>
        );
      })}
    </nav>
  );
}
