import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentStep } from '../../shared/types';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

interface Props {
  /** Finished thinking blocks of this reply. */
  blocks: AgentStep[];
  /** The block Claude is thinking right now (streams in). */
  current?: string;
  live: boolean;
  /** Screen position to open at (beside the chat, level with the line that opened it). */
  at: { left: number; top: number };
  pinned: boolean;
  onPin: (pinned: boolean) => void;
  onClose: () => void;
  onHover: (inside: boolean) => void;
}

/**
 * Everything Claude has thought during one reply, beside the chat. Follows the newest text
 * unless the user scrolls up to read, in which case it stays put until they jump back down.
 */
export function ThinkingPanel({ blocks, current, live, at, pinned, onPin, onClose, onHover }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const width = Math.max(280, Math.min(620, window.innerWidth - at.left - 16));
  const maxHeight = window.innerHeight * 0.75;
  const top = Math.max(12, Math.min(at.top - 40, window.innerHeight - maxHeight - 12));

  // Stay at the bottom while following; leave the scroll position alone while the user reads.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [blocks.length, current, follow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const empty = !blocks.length && !current;
  return (
    <div
      className="thinking-panel"
      style={{ left: at.left, top, width, maxHeight }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div className="thinking-head">
        {live && current != null ? <span className="spinner" /> : <Icon name="spark" size={14} />}
        <span className="thinking-title">Claude's thinking</span>
        <span className="dim small">{blocks.length + (current ? 1 : 0)} block{blocks.length + (current ? 1 : 0) === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <button className={`icon-btn ${pinned ? 'on' : ''}`} title={pinned ? 'Unpin (closes when the mouse leaves)' : 'Pin open'} onClick={() => onPin(!pinned)}>
          <Icon name="pin" size={14} />
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <div className="thinking-body" ref={scroller} onScroll={onScroll}>
        {empty && <div className="dim">{live ? 'Claude has not started thinking yet…' : 'No thinking was recorded for this reply.'}</div>}
        {blocks.map((b, i) => (
          <section key={i} className="thinking-block">
            {b.at != null && <div className="thinking-time">{fmtTime(b.at)}</div>}
            <Markdown text={b.text} />
          </section>
        ))}
        {current && (
          <section className="thinking-block current">
            <div className="thinking-time">now</div>
            <Markdown text={current} />
          </section>
        )}
      </div>
      {!follow && (
        <button className="thinking-jump" onClick={() => setFollow(true)}>
          {live ? 'Paused · jump to latest' : 'Jump to end'} <span className="chev open"><Icon name="chevron" size={11} /></span>
        </button>
      )}
    </div>
  );
}

function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
