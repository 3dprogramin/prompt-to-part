import { useEffect, useRef } from 'react';
import { Icon } from './Icon';

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

/** Open designs as tabs in the top bar, so parallel generations are one click apart. */
export function DesignTabs({ tabs, current, onOpen, onClose }: Props) {
  const strip = useRef<HTMLDivElement>(null);

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
    <div className="design-tabs" ref={strip}>
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`dtab ${t.id === current ? 'on' : ''} ${t.unseen ? 'unseen' : ''}`}
          title={`${t.name}${t.running ? ' · Claude is working on it' : t.unseen ? ' · finished, not viewed yet' : ''}`}
          onMouseDown={(e) => { if (e.button === 1 && !t.running) { e.preventDefault(); onClose(t.id); } }}
        >
          <button className="dtab-open" onClick={() => onOpen(t.id)}>
            {t.running ? <span className="spinner" /> : t.unseen ? <span className="dtab-dot" /> : null}
            <span className="dtab-name">{t.name}</span>
          </button>
          {!t.running && (
            <button className="dtab-close" title="Close tab (the design stays in Designs)" onClick={() => onClose(t.id)}>
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
