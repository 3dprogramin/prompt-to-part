// A chat message: the user's words, pictures and files, or Jig's reply with its steps, activity,
// renders, assembly pictures and the version it made.
import { useEffect, useRef, useState } from 'react';
import type { AgentStep, ChatMessage, DesignVersion } from '../../../shared/types';
import { formatDuration } from '../../../shared/duration';
import { meshFormat } from '../../../shared/meshFormats';
import { SOURCE_KINDS, sourcesSummary, weakestKind, type DimensionSource } from '../../../shared/sources';
import { activityOf, INTERRUPTED, thinkingSince, wasInterrupted } from '../../lib/activity';
import { EditTags, groupEdits } from '../EditTags';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { QuestionCard } from '../QuestionCard';
import { ActivityPanel, ThinkTime } from '../ActivityPanel';
import { clip } from './text';

export function Message({ m, live, versions, currentVersion, onRestore, onImage, followed, onFollow, onAnswer, answerBlocked, answerCountdown, answerHold }: {
  m: ChatMessage; live: boolean; versions: DesignVersion[]; currentVersion: number;
  onRestore: (i: number) => void; onImage: (src: string) => void;
  /** This reply's activity is the panel that follows Claude across designs (ChatPanel shows it). */
  followed: boolean; onFollow: (on: boolean) => void;
  /** Its question card can be answered (the newest reply, not answered yet); `answerBlocked`: not just now. */
  onAnswer?: (answers: string[][]) => void; answerBlocked: boolean;
  /** The card sends Jig's picks if nobody answers in time (it arrived in this window); `answerHold`: the user is typing. */
  answerCountdown: boolean; answerHold: boolean;
}) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(live ? m.createdAt : null);
  // The current thinking's own time, beside the reply's: it starts again with each thinking block.
  const thinkingAt = live ? thinkingSince(m.activity ?? []) : null;
  // Everything Claude does, beside the chat: opens while hovering the live line, can be pinned.
  const [think, setThink] = useState<{ mode: 'hover' | 'pinned'; at: { left: number; top: number } } | null>(null);
  const hideTimer = useRef(0);
  const peek = (inside: boolean, el?: HTMLElement) => {
    clearTimeout(hideTimer.current);
    if (inside) { if (el && !followed) setThink((t) => t ?? { mode: 'hover', at: besideChat(el) }); }
    else hideTimer.current = window.setTimeout(() => setThink((t) => (t?.mode === 'hover' ? null : t)), 250);
  };
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  if (m.role === 'user') {
    return (
      <div className="msg user">
        {m.files?.length ? <div className="file-chips sent">{m.files.map((n) => <span key={n} className="file-chip"><Icon name={meshFormat(n) ? 'cube' : 'code'} size={12} /> {n}</span>)}</div> : null}
        {m.images?.length ? <div className="msg-images">{m.images.map((src, i) => <ImageButton key={i} src={src} alt={`Reference photo ${i + 1}`} onOpen={onImage} />)}</div> : null}
        {m.text && <div className="bubble">{m.text}</div>}
      </div>
    );
  }
  const assembly = (m.steps ?? []).filter((s) => s.kind === 'assembly' && s.image);
  const activity = think ? activityOf(m) : [];
  const hasActivity = !!m.activity?.length || !!m.steps?.length;
  const peekProps = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => peek(true, e.currentTarget),
    onMouseLeave: () => peek(false),
    // Clicking pins the panel open (or closes it): pinned on a live reply, it follows Claude.
    onClick: () => {
      clearTimeout(hideTimer.current);
      setThink(null);
      onFollow(!followed);
    },
    title: 'Hover to watch everything Jig is doing, click to pin it open',
  };
  const all = (m.steps ?? []).filter((s) => !(s.kind === 'text' && s.text === m.text) && s.kind !== 'assembly');
  const steps = all;
  const renders = steps.filter((s) => s.kind === 'render' && s.image && !s.verbose);
  // The full step log is open while Claude works; afterwards it folds into one line.
  const showSteps = live || open;
  const interrupted = wasInterrupted(m, live);
  const headline = live ? 'Working' : `${steps.length} steps${m.durationMs ? ` · ${formatDuration(m.durationMs)}` : ''}`;
  return (
    <div className="msg assistant">
      <div className="msg-head">
        <button className={`steps-toggle ${live ? 'peek' : ''}`} onClick={() => setOpen(!open)} {...(live ? peekProps : {})}>
          {live ? <span className="spinner" /> : <Icon name={m.error || interrupted ? 'alert' : 'check'} size={14} />}
          <span>{headline}{live && <span className="elapsed"> · {fmtElapsed(elapsed)}</span>}</span>
          {!live && <span className={`chev ${open ? 'open' : ''}`}><Icon name="chevron" size={12} /></span>}
        </button>
        {(live || hasActivity) && (
          <button className="link think-link" title="Show everything Jig did for this reply: thinking, code, tool calls and results"
            onClick={(e) => {
              if (live || followed) { setThink(null); onFollow(!followed); return; }
              setThink(think?.mode === 'pinned' ? null : { mode: 'pinned', at: besideChat(e.currentTarget) });
            }}>
            <Icon name="spark" size={12} /> activity
          </button>
        )}
      </div>
      {think && !followed && (
        <ActivityPanel
          items={activity}
          live={live}
          onImage={onImage}
          at={think.at}
          pinned={think.mode === 'pinned'}
          // Pinning the live reply hands it to the panel that follows Claude.
          onPin={(pinned) => { if (pinned && live) { setThink(null); onFollow(true); } else setThink((t) => t && { ...t, mode: pinned ? 'pinned' : 'hover' }); }}
          onClose={() => setThink(null)}
          onHover={(inside) => peek(inside)}
        />
      )}
      {showSteps && (
        <ol className="steps">
          {groupEdits(steps).map((s, i) => <Step key={i} s={s} onImage={onImage} />)}
          {live && <li className="step live peek" {...peekProps}><span className="spinner" /> <span className="step-text" role="status" aria-live="polite">{m.live ?? 'Starting…'}</span>{thinkingAt != null && <ThinkTime ms={elapsed - thinkingAt} />}</li>}
        </ol>
      )}
      {!showSteps && renders.length > 0 && (
        <div className="render-strip">
          {renders.slice(-1).map((s, i) => <ImageButton key={i} src={s.image!} alt="Latest render" onOpen={onImage} />)}
        </div>
      )}
      {m.text && <div className="bubble md-bubble"><Markdown text={m.text} /></div>}
      {m.questions?.length && !live ? <QuestionCard questions={m.questions} answers={m.answers} onSend={onAnswer} disabled={answerBlocked} countdown={answerCountdown} hold={answerHold} midway={m.versionIndex != null} /> : null}
      {assembly.length > 0 && (
        <div className="assembly">
          <div className="assembly-title">Assembly</div>
          <div className="assembly-grid">
            {assembly.map((s, i) => (
              <figure key={i}>
                <ImageButton src={s.image!} alt={s.text} onOpen={onImage} />
                <figcaption>{s.text}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
      {m.error && <div className="bubble error" role="alert"><Icon name="alert" size={14} /> {m.error}</div>}
      {interrupted && <div className="bubble error interrupted" role="status"><Icon name="alert" size={14} /> {INTERRUPTED}</div>}
      {m.versionIndex != null && versions[m.versionIndex] && (
        <div className="version-row">
          <span className="version-chip">v{m.versionIndex + 1}</span>
          <span className="dim small">{clip(versions[m.versionIndex].summary, 90)}</span>
          <SourcesChip list={versions[m.versionIndex].sources} />
          {currentVersion !== m.versionIndex && <button className="link" onClick={() => onRestore(m.versionIndex!)}><Icon name="restore" size={12} /> restore</button>}
        </div>
      )}
    </div>
  );
}

/** Seconds since `since`, ticking once a second (null = stopped). */
function useElapsed(since: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since == null ? 0 : Math.max(0, now - since);
}

function fmtElapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function Step({ s, onImage }: { s: AgentStep & { edits?: number }; onImage: (src: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const long = s.text.length > 160;
  return (
    <li className={`step ${s.kind} ${s.ok === false ? 'bad' : s.ok ? 'good' : ''}`}>
      {s.at != null && <span className="step-time">{fmtElapsed(s.at)}</span>}
      <span className="step-text" onClick={() => long && setExpanded(!expanded)}>{s.kind === 'user' && <b>You: </b>}{expanded || !long ? s.text : clip(s.text, 160)}</span>
      {s.edit && <EditTags edit={s.edit} edits={s.edits} />}
      {s.image && <ImageButton src={s.image} alt="Render" onOpen={onImage} />}
    </li>
  );
}

/** A picture that opens enlarged: a real button, so it works from the keyboard too. */
function ImageButton({ src, alt, onOpen }: { src: string; alt: string; onOpen: (src: string) => void }) {
  return <button className="img-btn" onClick={() => onOpen(src)} aria-label={`${alt} – enlarge`}><img src={src} alt={alt} /></button>;
}

/** Where the thinking panel opens: just right of the chat column, level with `el`. */
function besideChat(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const chat = el.closest('.chat-panel')?.getBoundingClientRect();
  return { left: (chat?.right ?? r.right) + 8, top: r.top };
}

/** Where the version's real-world dimensions came from, coloured by the weakest source (details in the Model tab). */
function SourcesChip({ list }: { list?: DimensionSource[] }) {
  const weakest = list && weakestKind(list);
  if (!list || !weakest) return null;
  return <span className={`src-chip ${SOURCE_KINDS[weakest].trust}`} title={`Dimension sources: ${sourcesSummary(list)} (Model tab for details)`}>{sourcesSummary(list)}</span>;
}
