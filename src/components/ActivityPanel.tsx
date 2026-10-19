import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ActivityItem } from '../../shared/types';
import { EditTags } from './EditTags';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { useEscape } from './useEscape';
import { load, store } from '../lib/storage';
import { blockDuration } from '../lib/activity';

interface Props {
  items: ActivityItem[];
  live: boolean;
  /** Screen position to open at (beside the chat, level with the line that opened it). */
  at: { left: number; top: number };
  pinned: boolean;
  onPin: (pinned: boolean) => void;
  onClose: () => void;
  onHover: (inside: boolean) => void;
  onImage: (src: string) => void;
}

/** Where the user put the panel and how big they made it (remembered across reloads). */
interface Placement { left: number; top: number; width: number; height?: number }
const PLACEMENT_KEY = 'activityPanel';
const MIN_W = 280, MIN_H = 160;

/** Keeps a placement on screen: the header stays reachable and the bottom (with the resize corner) inside the window. */
function onScreen(p: Placement): Placement {
  const width = Math.max(MIN_W, Math.min(p.width, window.innerWidth - 16));
  const top = Math.max(8, Math.min(p.top, window.innerHeight - MIN_H - 8));
  const height = p.height != null ? Math.max(MIN_H, Math.min(p.height, window.innerHeight - top - 8)) : undefined;
  return { width, height, top, left: Math.max(80 - width, Math.min(p.left, window.innerWidth - 80)) };
}

/** Without a chosen height the panel grows with its content, up to the window's bottom edge. */
const maxHeightAt = (top: number) => Math.max(MIN_H, Math.min(window.innerHeight * 0.8, window.innerHeight - top - 8));

/**
 * Everything Claude does during one reply, beside the chat: thinking, the reply, model.js as it
 * is typed, tool calls and their results. Follows the newest output unless the user scrolls up.
 * Drag the header to move it (anywhere, e.g. over the 3D view) and the corner to resize it; a
 * double-click on the header puts it back beside the chat.
 */
export function ActivityPanel({ items, live, at, pinned, onPin, onClose, onHover, onImage }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const beside = (): Placement => {
    const width = Math.max(300, Math.min(760, window.innerWidth - at.left - 16));
    return { left: at.left, top: Math.max(12, Math.min(at.top - 40, window.innerHeight * 0.2 - 12)), width };
  };
  const [place, setPlace] = useState<Placement>(() => onScreen(load<Placement | null>(PLACEMENT_KEY, null) ?? beside()));
  const placeRef = useRef(place);
  placeRef.current = place;
  useEffect(() => {
    const fit = () => setPlace((p) => onScreen(p));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  /** Pointer drag on the header (move) or the corner (resize); saved when released. */
  const drag = (kind: 'move' | 'size') => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (kind === 'move' && (e.target as HTMLElement).closest('button'))) return;
    e.preventDefault();
    const panel = e.currentTarget.closest('.activity-panel') as HTMLElement;
    const start = { x: e.clientX, y: e.clientY, p: placeRef.current, h: panel.offsetHeight };
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      setPlace(onScreen(kind === 'move'
        ? { ...start.p, left: start.p.left + dx, top: start.p.top + dy }
        : { ...start.p, width: start.p.width + dx, height: (start.p.height ?? start.h) + dy }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      store(PLACEMENT_KEY, placeRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const reset = () => { store(PLACEMENT_KEY, null); setPlace(onScreen(beside())); };

  // Stay at the bottom while following; leave the scroll position alone while the user reads.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [items, follow]);

  useEscape(true, onClose);

  const onScroll = () => {
    const el = scroller.current;
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  return (
    <div className="activity-panel" style={{ left: place.left, top: place.top, width: place.width, height: place.height, maxHeight: place.height ? undefined : maxHeightAt(place.top) }}
      onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <div className="activity-head" onPointerDown={drag('move')} onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) reset(); }}
        title="Drag to move · double-click to put it back beside the chat">
        {live ? <span className="spinner" /> : <Icon name="spark" size={14} />}
        <span className="activity-title">{live ? 'Jig is working' : "Jig's work"}</span>
        <span className="dim small">{items.length} item{items.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <button className={`icon-btn ${pinned ? 'on' : ''}`} title={pinned ? 'Unpin (closes when the mouse leaves)' : 'Pin open'} aria-label={pinned ? 'Unpin' : 'Pin open'} aria-pressed={pinned} onClick={() => onPin(!pinned)}>
          <Icon name="pin" size={14} />
        </button>
        <button className="icon-btn" title="Close (Esc)" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <div className="activity-body" ref={scroller} onScroll={onScroll}>
        {!items.length && <div className="dim">{live ? 'Waiting for Jig…' : 'Nothing was recorded for this reply.'}</div>}
        {items.map((it, i) => <Item key={i} it={it} streaming={live && i === items.length - 1} duration={it.kind === 'thinking' ? blockDuration(items, i) : undefined} onImage={onImage} />)}
      </div>
      {!follow && (
        <button className="activity-jump" onClick={() => setFollow(true)}>
          {live ? 'Paused · jump to latest' : 'Jump to end'} <span className="chev open"><Icon name="chevron" size={11} /></span>
        </button>
      )}
      <div className="activity-resize" onPointerDown={drag('size')} title="Drag to resize" aria-hidden />
    </div>
  );
}

// Memoised: while a reply streams only the newest item changes, so the rest skip re-rendering.
const Item = memo(function Item({ it, streaming, duration, onImage }: { it: ActivityItem; streaming: boolean; duration?: number; onImage: (src: string) => void }) {
  if (it.kind === 'step') {
    const s = it.step;
    return (
      <div className={`act-step ${s.kind} ${s.ok === false ? 'bad' : s.ok ? 'good' : ''}`}>
        <span className="act-time">{s.at != null ? fmtTime(s.at) : ''}</span>
        <div className="act-step-body">
          <span>{s.kind === 'user' && <b>You (while Jig worked): </b>}{s.text}{s.edit && <> <EditTags edit={s.edit} /></>}</span>
          {s.image && <button className="img-btn" onClick={() => onImage(s.image!)} aria-label="Render – enlarge"><img src={s.image} alt="Render" /></button>}
          {s.detail && (
            <details className="act-detail" open={s.detailOpen}>
              <summary>{s.detailOpen ? 'Details' : 'Show the full text'}</summary>
              <pre>{s.detail}</pre>
            </details>
          )}
        </div>
      </div>
    );
  }
  const head = it.kind === 'tool' ? it.label : it.kind === 'thinking' ? 'Thinking' : 'Reply';
  return (
    <section className={`act-block ${it.kind} ${streaming ? 'streaming' : ''}`}>
      <div className="act-head"><span className="act-time">{fmtTime(it.at)}</span> {head}{duration != null && <ThinkTime ms={duration} />}{streaming && <span className="act-cursor" />}</div>
      {it.kind === 'tool' ? <ToolBody name={it.name} fields={it.fields} /> : <Markdown text={it.text} />}
    </section>
  );
});

function ToolBody({ name, fields }: { name: string; fields: Record<string, string> }) {
  if (name === 'Write') return <pre className="act-code">{fields.content ?? ''}</pre>;
  if (name === 'Edit') {
    return (
      <>
        {fields.old_string != null && <pre className="act-code del">{fields.old_string}</pre>}
        {fields.new_string != null && <pre className="act-code add">{fields.new_string}</pre>}
      </>
    );
  }
  const shown = Object.entries(fields).filter(([k, v]) => k !== 'file_path' && v !== '' && v !== '{}');
  if (!shown.length) return null;
  return <pre className="act-args">{shown.map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>;
}

/** How long Jig thought in one thinking block (the chat's live line, each block here): set apart from the reply's own time. */
export function ThinkTime({ ms }: { ms: number }) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return <span className="think-time" title="Time on this thinking"><Icon name="spark" size={11} />{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`}</span>;
}

function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
