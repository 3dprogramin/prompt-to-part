import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ActivityItem } from '../../shared/types';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

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

/**
 * Everything Claude does during one reply, beside the chat: thinking, the reply, model.js as it
 * is typed, tool calls and their results. Follows the newest output unless the user scrolls up.
 */
export function ActivityPanel({ items, live, at, pinned, onPin, onClose, onHover, onImage }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const width = Math.max(300, Math.min(760, window.innerWidth - at.left - 16));
  const maxHeight = window.innerHeight * 0.8;
  const top = Math.max(12, Math.min(at.top - 40, window.innerHeight - maxHeight - 12));

  // Stay at the bottom while following; leave the scroll position alone while the user reads.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [items, follow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  return (
    <div className="activity-panel" style={{ left: at.left, top, width, maxHeight }} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <div className="activity-head">
        {live ? <span className="spinner" /> : <Icon name="spark" size={14} />}
        <span className="activity-title">{live ? 'Claude is working' : "Claude's work"}</span>
        <span className="dim small">{items.length} item{items.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <button className={`icon-btn ${pinned ? 'on' : ''}`} title={pinned ? 'Unpin (closes when the mouse leaves)' : 'Pin open'} onClick={() => onPin(!pinned)}>
          <Icon name="pin" size={14} />
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <div className="activity-body" ref={scroller} onScroll={onScroll}>
        {!items.length && <div className="dim">{live ? 'Waiting for Claude…' : 'Nothing was recorded for this reply.'}</div>}
        {items.map((it, i) => <Item key={i} it={it} streaming={live && i === items.length - 1} onImage={onImage} />)}
      </div>
      {!follow && (
        <button className="activity-jump" onClick={() => setFollow(true)}>
          {live ? 'Paused · jump to latest' : 'Jump to end'} <span className="chev open"><Icon name="chevron" size={11} /></span>
        </button>
      )}
    </div>
  );
}

// Memoised: while a reply streams only the newest item changes, so the rest skip re-rendering.
const Item = memo(function Item({ it, streaming, onImage }: { it: ActivityItem; streaming: boolean; onImage: (src: string) => void }) {
  if (it.kind === 'step') {
    const s = it.step;
    return (
      <div className={`act-step ${s.kind} ${s.ok === false ? 'bad' : s.ok ? 'good' : ''}`}>
        <span className="act-time">{s.at != null ? fmtTime(s.at) : ''}</span>
        <div className="act-step-body">
          <span>{s.text}</span>
          {s.image && <img src={s.image} alt="render" onClick={() => onImage(s.image!)} />}
        </div>
      </div>
    );
  }
  const head = it.kind === 'tool' ? it.label : it.kind === 'thinking' ? 'Thinking' : 'Reply';
  return (
    <section className={`act-block ${it.kind} ${streaming ? 'streaming' : ''}`}>
      <div className="act-head"><span className="act-time">{fmtTime(it.at)}</span> {head}{streaming && <span className="act-cursor" />}</div>
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

function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
