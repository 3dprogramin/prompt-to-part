// The composer's one options button: a gear with a count of what is on, and a menu of the four
// toggles (web search, ask first, send my view, sounds) as labelled switches.
import { useEffect } from 'react';
import { Icon } from '../Icon';
import { useChipMenu } from './useChipMenu';

export interface ChatOption { key: 'web' | 'ask' | 'view' | 'sounds'; label: string; line: string; on: boolean; title: string }

/** How many options are on, and a tooltip that names them ("Options: web search and sounds are on"). */
export function optionsSummary(opts: ChatOption[]): { count: number; title: string } {
  const names = opts.filter((o) => o.on).map((o) => o.label.toLowerCase());
  if (!names.length) return { count: 0, title: 'Options: all off' };
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return { count: names.length, title: `Options: ${list} ${names.length === 1 ? 'is' : 'are'} on` };
}

const ICONS: Record<ChatOption['key'], (on: boolean) => string> = {
  web: () => 'globe',
  ask: () => 'ask',
  view: (on) => (on ? 'eye' : 'eyeOff'),
  sounds: (on) => (on ? 'sound' : 'soundOff'),
};

export function OptionsMenu({ options, onToggle }: { options: ChatOption[]; onToggle: (key: ChatOption['key'], on: boolean) => void }) {
  const m = useChipMenu();
  const { count, title } = optionsSummary(options);
  useEffect(() => { if (m.open) m.menu.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus(); }, [m.open]);
  return (
    <span className="mode-wrap options-wrap" ref={m.wrap}>
      <button {...m.triggerProps} className={`web-toggle options-btn ${count ? 'has-on' : ''}`} aria-label={title} title={`${title}. Click to change.`}>
        <Icon name="sliders" size={14} />
        {count > 0 && <span className="options-badge" aria-hidden>{count}</span>}
      </button>
      {m.open && (
        <div className="mode-menu options-menu" role="menu" aria-label="Options" ref={m.menu} onKeyDown={m.onMenuKey}>
          {options.map((o) => (
            <button key={o.key} role="menuitemcheckbox" aria-checked={o.on} className={o.on ? 'on' : ''} title={o.title} onClick={() => onToggle(o.key, !o.on)}>
              <span className="options-icon" aria-hidden><Icon name={ICONS[o.key](o.on)} size={15} /></span>
              <span className="options-text"><b>{o.label}</b><span>{o.line}</span></span>
              <span className="options-switch" aria-hidden><i /></span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
