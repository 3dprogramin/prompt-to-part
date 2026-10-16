import { useEffect, useRef, useState } from 'react';
import type { AgentStep, ChatMessage, DesignVersion } from '../../shared/types';
import { prepareImage } from '../lib/files';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { ActivityPanel } from './ActivityPanel';
import { activityOf } from '../lib/activity';

interface Props {
  messages: ChatMessage[];
  versions: DesignVersion[];
  currentVersion: number;
  generating: boolean;
  /** Another browser tab is generating this design. */
  busyElsewhere: boolean;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
  onRestore: (versionIndex: number) => void;
  model: string;
  onModel: (m: string) => void;
  effort: string;
  onEffort: (e: string) => void;
  hasModel: boolean;
  /** Claude may search the web for this design (off for every design until turned on). */
  webSearch: boolean;
  onWebSearch: (on: boolean) => void;
}

export function ChatPanel(p: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Follow new output only while the chat is scrolled to the bottom, so earlier messages can be
  // read while Claude works; a new message (sending one) always scrolls down.
  const atBottom = useRef(true);
  const count = useRef(p.messages.length);
  useEffect(() => {
    const el = scroller.current;
    const added = p.messages.length !== count.current;
    count.current = p.messages.length;
    if (el && (atBottom.current || added)) el.scrollTop = el.scrollHeight;
  }, [p.messages]);

  // Photos dropped anywhere in the window come here (App forwards them): never let the browser
  // open a dropped file in place of Jig.
  useEffect(() => {
    const onFiles = (e: Event) => addFiles((e as CustomEvent<File[]>).detail);
    window.addEventListener('jig-drop-files', onFiles);
    return () => window.removeEventListener('jig-drop-files', onFiles);
  });
  useEffect(() => {
    const reset = () => setDragOver(false);
    window.addEventListener('drop', reset);
    window.addEventListener('dragend', reset);
    return () => { window.removeEventListener('drop', reset); window.removeEventListener('dragend', reset); };
  }, []);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const addFiles = async (files: Iterable<File>) => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'));
    const urls = await Promise.all(imgs.map((f) => prepareImage(f).catch(() => null)));
    setImages((prev) => [...prev, ...urls.filter((u): u is string => !!u)].slice(0, 8));
  };

  const send = () => {
    if (p.generating || p.busyElsewhere || (!text.trim() && !images.length)) return;
    p.onSend(text.trim(), images);
    setText('');
    setImages([]);
  };

  return (
    <div
      className={`chat-panel ${dragOver ? 'drag' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); addFiles(e.dataTransfer.files); }}
    >
      <div className="chat-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {p.messages.length === 0 && (
          <div className="chat-intro">
            <h3>Describe what you want to print</h3>
            <p>Claude designs a parametric model with sliders and dimensions. Attach photos of an existing object to recreate or redesign it. Mention any dimensions you need; anything you leave out, Claude picks for you.</p>
            <div className="examples">
              {[
                'A wine bottle opener: T-handle with a 5-turn corkscrew spiral',
                'Wall-mounted holder for 3 screwdrivers, screw holes countersunk',
                'Cable clip for a 6 mm cable that clamps onto a 20 mm desk edge',
                'M8 knurled thumb nut with a captive hex nut pocket',
              ].map((ex) => (
                <button key={ex} className="example" onClick={() => { setText(ex); textarea.current?.focus(); }}>{ex}</button>
              ))}
            </div>
          </div>
        )}
        {p.messages.map((m, i) => (
          <Message key={m.id} m={m} live={(p.generating || p.busyElsewhere) && i === p.messages.length - 1} versions={p.versions} currentVersion={p.currentVersion} onRestore={p.onRestore} onImage={setLightbox} />
        ))}
      </div>

      <div className="composer">
        {images.length > 0 && (
          <div className="attachments">
            {images.map((src, i) => (
              <div key={i} className="thumb">
                <img src={src} alt={`Attached photo ${i + 1}`} />
                <button onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label={`Remove photo ${i + 1}`}><Icon name="x" size={12} /></button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          value={text}
          placeholder={p.hasModel ? 'Ask for changes, e.g. "make the spiral longer and add a bottle cap lifter"' : 'Describe the object… (paste or drop photos)'}
          onChange={(e) => setText(e.target.value)}
          aria-label={p.hasModel ? 'Ask Claude for changes' : 'Describe the object'}
          // Enter that confirms an input-method (IME) candidate is not a send.
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); } }}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files); } }}
          rows={3}
        />
        <div className="composer-bar">
          <button className="icon-btn" title="Attach reference photos" aria-label="Attach reference photos" onClick={() => fileInput.current?.click()}><Icon name="image" /></button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          <select value={p.model} onChange={(e) => p.onModel(e.target.value)} title="Claude model" aria-label="Claude model">
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
          <select value={p.effort} onChange={(e) => p.onEffort(e.target.value)} title="Reasoning effort" aria-label="Reasoning effort">
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">X-High</option>
            <option value="max">Max</option>
          </select>
          <button
            className={`web-toggle ${p.webSearch ? 'on' : ''}`}
            aria-label="Web search"
            aria-pressed={p.webSearch}
            onClick={() => p.onWebSearch(!p.webSearch)}
            title={p.webSearch ? 'Web search is on: Claude looks up exact dimensions of real products online (this design only, until you reload)' : 'Let Claude search the web for exact dimensions of real products (off for every new design)'}
          >
            <Icon name="globe" size={14} />
          </button>
          <span className="spacer" />
          {p.generating
            ? <button className="btn danger" onClick={p.onStop} title="Stop"><Icon name="stop" /> <span className="btn-label">Stop</span></button>
            : <button className="btn primary" onClick={send} disabled={p.busyElsewhere || (!text.trim() && !images.length)} title={p.hasModel ? 'Update' : 'Design'}><Icon name="send" /> <span className="btn-label">{p.hasModel ? 'Update' : 'Design'}</span></button>}
        </div>
        {p.busyElsewhere && <div className="composer-opts"><span className="busy-note" role="status">Claude is working on this design in another tab</span></div>}
      </div>
      {dragOver && <div className="drop-overlay">Drop photos to attach</div>}
      {lightbox && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Enlarged image" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
          <button className="lightbox-close" autoFocus onClick={() => setLightbox(null)} aria-label="Close (Esc)"><Icon name="x" size={16} /></button>
        </div>
      )}
    </div>
  );
}

function Message({ m, live, versions, currentVersion, onRestore, onImage }: {
  m: ChatMessage; live: boolean; versions: DesignVersion[]; currentVersion: number;
  onRestore: (i: number) => void; onImage: (src: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(live ? m.createdAt : null);
  // Everything Claude does, beside the chat: opens while hovering the live line, can be pinned.
  const [think, setThink] = useState<{ mode: 'hover' | 'pinned'; at: { left: number; top: number } } | null>(null);
  const hideTimer = useRef(0);
  const peek = (inside: boolean, el?: HTMLElement) => {
    clearTimeout(hideTimer.current);
    if (inside) { if (el) setThink((t) => t ?? { mode: 'hover', at: besideChat(el) }); }
    else hideTimer.current = window.setTimeout(() => setThink((t) => (t?.mode === 'hover' ? null : t)), 250);
  };
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  if (m.role === 'user') {
    return (
      <div className="msg user">
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
    // Clicking pins the panel open (or unpins it).
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      clearTimeout(hideTimer.current);
      const at = besideChat(e.currentTarget);
      setThink((t) => (t?.mode === 'pinned' ? { ...t, mode: 'hover' } : { mode: 'pinned', at: t?.at ?? at }));
    },
    title: 'Hover to watch everything Claude is doing, click to pin it open',
  };
  const all = (m.steps ?? []).filter((s) => !(s.kind === 'text' && s.text === m.text) && s.kind !== 'assembly');
  const steps = all;
  const renders = steps.filter((s) => s.kind === 'render' && s.image);
  // The full step log is open while Claude works; afterwards it folds into one line.
  const showSteps = live || open;
  const headline = live ? 'Working' : `${steps.length} steps${m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(0)} s` : ''}`;
  return (
    <div className="msg assistant">
      <div className="msg-head">
        <button className={`steps-toggle ${live ? 'peek' : ''}`} onClick={() => setOpen(!open)} {...(live ? peekProps : {})}>
          {live ? <span className="spinner" /> : <Icon name={m.error ? 'alert' : 'check'} size={14} />}
          <span>{headline}{live && <span className="elapsed"> · {fmtElapsed(elapsed)}</span>}</span>
          {!live && <span className={`chev ${open ? 'open' : ''}`}><Icon name="chevron" size={12} /></span>}
        </button>
        {(live || hasActivity) && (
          <button className="link think-link" title="Show everything Claude did for this reply: thinking, code, tool calls and results" onClick={(e) => setThink(think?.mode === 'pinned' ? null : { mode: 'pinned', at: besideChat(e.currentTarget) })}>
            <Icon name="spark" size={12} /> activity
          </button>
        )}
      </div>
      {think && (
        <ActivityPanel
          items={activity}
          live={live}
          onImage={onImage}
          at={think.at}
          pinned={think.mode === 'pinned'}
          onPin={(pinned) => setThink((t) => t && { ...t, mode: pinned ? 'pinned' : 'hover' })}
          onClose={() => setThink(null)}
          onHover={(inside) => peek(inside)}
        />
      )}
      {showSteps && (
        <ol className="steps">
          {steps.map((s, i) => <Step key={i} s={s} onImage={onImage} />)}
          {live && <li className="step live peek" {...peekProps}><span className="spinner" /> <span className="step-text" role="status" aria-live="polite">{m.live ?? 'Starting…'}</span></li>}
        </ol>
      )}
      {!showSteps && renders.length > 0 && (
        <div className="render-strip">
          {renders.slice(-1).map((s, i) => <ImageButton key={i} src={s.image!} alt="Latest render" onOpen={onImage} />)}
        </div>
      )}
      {m.text && <div className="bubble md-bubble"><Markdown text={m.text} /></div>}
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
      {m.versionIndex != null && versions[m.versionIndex] && (
        <div className="version-row">
          <span className="version-chip">v{m.versionIndex + 1}</span>
          <span className="dim small">{clip(versions[m.versionIndex].summary, 90)}</span>
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

function Step({ s, onImage }: { s: AgentStep; onImage: (src: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const long = s.text.length > 160;
  return (
    <li className={`step ${s.kind} ${s.ok === false ? 'bad' : s.ok ? 'good' : ''}`}>
      {s.at != null && <span className="step-time">{fmtElapsed(s.at)}</span>}
      <span className="step-text" onClick={() => long && setExpanded(!expanded)}>{expanded || !long ? s.text : clip(s.text, 160)}</span>
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

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
