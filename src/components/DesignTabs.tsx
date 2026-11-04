import { useEffect, useMemo, useRef, useState } from 'react';
import { foldText } from '../../shared/tags';
import { load, store } from '../lib/storage';
import { Icon } from './Icon';
import { usePopover } from './usePopover';

export interface DesignTab {
  id: string;
  name: string;
  /** Claude is working on it (in this browser tab or another); such tabs can't be closed. */
  running: boolean;
  /** A generation finished while another design was open. */
  unseen: boolean;
}

interface Props {
  tabs: DesignTab[];
  current: string;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
}

/** How many tabs show besides the open design's; the rest are under the "+N" button. */
const SHOWN_OTHERS = 2;

/**
 * Open designs as tabs in the top bar, so parallel generations are one click apart: the open
 * design and the two seen last, the others in a searchable list under "+N".
 */
export function DesignTabs({ tabs, current, onOpen, onClose }: Props) {
  const strip = useRef<HTMLDivElement>(null);
  // The designs seen last, newest first (kept across reloads).
  const [recent, setRecent] = useState<string[]>(() => load<string[]>('designTabsRecent', []));
  useEffect(() => setRecent((r) => (r[0] === current ? r : [current, ...r.filter((id) => id !== current)].slice(0, 50))), [current]);
  useEffect(() => store('designTabsRecent', recent), [recent]);
  const shown = useMemo(() => {
    const others = tabs.filter((t) => t.id !== current).map((t) => t.id)
      .sort((a, b) => (recent.indexOf(a) + 1 || Infinity) - (recent.indexOf(b) + 1 || Infinity)).slice(0, SHOWN_OTHERS);
    return new Set([current, ...others]);
  }, [tabs, current, recent]);
  const hidden = tabs.filter((t) => !shown.has(t.id));
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState('');
  const moreWrap = useRef<HTMLDivElement>(null);
  usePopover(more, () => setMore(false), moreWrap);
  useEffect(() => { if (!more) setQuery(''); }, [more]);
  useEffect(() => { if (!hidden.length) setMore(false); }, [hidden.length]);
  // Case and accents don't matter (ș finds s).
  const matches = hidden.filter((t) => foldText(t.name).includes(foldText(query.trim())));
  const openHidden = (id: string) => { setMore(false); onOpen(id); };

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('.dtab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current, tabs.length]);

  // A vertical mouse wheel scrolls the strip sideways.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="design-tabs-bar">
    <div className="design-tabs" ref={strip}>
      {tabs.filter((t) => shown.has(t.id)).map((t) => (
        <div
          key={t.id}
          className={`dtab ${t.id === current ? 'on' : ''} ${t.unseen ? 'unseen' : ''}`}
          title={`${t.name}${t.running ? ' · being worked on' : t.unseen ? ' · finished, not viewed yet' : ''}`}
          onMouseDown={(e) => { if (e.button === 1 && !t.running) { e.preventDefault(); onClose(t.id); } }}
        >
          <button className="dtab-open" onClick={() => onOpen(t.id)}>
            {t.running ? <span className="spinner" /> : t.unseen ? <span className="dtab-dot" /> : null}
            <span className="dtab-name">{t.name}</span>
          </button>
          {!t.running && (
            <button className="dtab-close" title="Close tab (the design stays in Designs)" aria-label={`Close ${t.name}`} onClick={() => onClose(t.id)}>
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      ))}
    </div>
      {hidden.length > 0 && (
        <div className="menu-wrap dtab-more-wrap" ref={moreWrap}>
          <button className={`dtab-more ${more ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}
            title={`${hidden.length} more open ${hidden.length === 1 ? 'design' : 'designs'}${hidden.some((t) => t.running) ? ' · one is being worked on' : hidden.some((t) => t.unseen) ? ' · one finished, not viewed yet' : ''}`}>
            {hidden.some((t) => t.running) ? <span className="spinner" /> : hidden.some((t) => t.unseen) ? <span className="dtab-dot" /> : null}
            +{hidden.length} <Icon name="chevron" size={11} />
          </button>
          {more && (
            <div className="menu dtab-menu" role="menu">
              <div className="menu-top">
                <div className="menu-search">
                  <Icon name="search" size={13} />
                  <input autoFocus type="search" placeholder="Search open designs" aria-label="Search open designs" value={query}
                    onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) openHidden(matches[0].id); }} />
                  {query && <button className="icon-btn" title="Clear the search" aria-label="Clear the search" onClick={() => setQuery('')}><Icon name="x" size={12} /></button>}
                </div>
              </div>
              {matches.map((t) => (
                <div key={t.id} className={`dtab-row ${t.unseen ? 'unseen' : ''}`}>
                  <button className="menu-open" role="menuitem" onClick={() => openHidden(t.id)}>
                    <span>{t.running ? <span className="spinner" /> : t.unseen ? <span className="dtab-dot" /> : null} {t.name}</span>
                  </button>
                  {!t.running && (
                    <button className="icon-btn" title="Close tab (the design stays in Designs)" aria-label={`Close ${t.name}`} onClick={() => onClose(t.id)}><Icon name="x" size={12} /></button>
                  )}
                </div>
              ))}
              {!matches.length && <div className="menu-empty">No open design matches.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
