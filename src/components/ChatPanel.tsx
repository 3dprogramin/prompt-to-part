import { useEffect, useRef, useState } from 'react';
import type { AgentStep, ChatMessage, DesignVersion } from '../../shared/types';
import { prepareImage } from '../lib/files';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { ThinkingPanel } from './ThinkingPanel';

interface Props {
  messages: ChatMessage[];
  versions: DesignVersion[];
  currentVersion: number;
  generating: boolean;
  /** Another browser tab is generating this design. */
  busyElsewhere: boolean;
  verbose: boolean;
  onVerbose: (v: boolean) => void;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
  onRestore: (versionIndex: number) => void;
  model: string;
  onModel: (m: string) => void;
  effort: string;
  onEffort: (e: string) => void;
  hasModel: boolean;
}

export function ChatPanel(p: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [p.messages]);

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
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
    >
      <div className="chat-scroll" ref={scroller}>
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
          <Message key={m.id} m={m} live={(p.generating || p.busyElsewhere) && i === p.messages.length - 1} verbose={p.verbose} versions={p.versions} currentVersion={p.currentVersion} onRestore={p.onRestore} onImage={setLightbox} />
        ))}
      </div>

      <div className="composer">
        {images.length > 0 && (
          <div className="attachments">
            {images.map((src, i) => (
              <div key={i} className="thumb">
                <img src={src} alt="" />
                <button onClick={() => setImages(images.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          value={text}
          placeholder={p.hasModel ? 'Ask for changes, e.g. "make the spiral longer and add a bottle cap lifter"' : 'Describe the object… (paste or drop photos)'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files); } }}
          rows={3}
        />
        <div className="composer-bar">
          <button className="icon-btn" title="Attach reference photos" onClick={() => fileInput.current?.click()}><Icon name="image" /></button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          <select value={p.model} onChange={(e) => p.onModel(e.target.value)} title="Claude model">
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
          <select value={p.effort} onChange={(e) => p.onEffort(e.target.value)} title="Reasoning effort">
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">X-High</option>
            <option value="max">Max</option>
          </select>
          <span className="spacer" />
          {p.generating
            ? <button className="btn danger" onClick={p.onStop}><Icon name="stop" /> Stop</button>
            : <button className="btn primary" onClick={send} disabled={p.busyElsewhere || (!text.trim() && !images.length)}><Icon name="send" /> {p.hasModel ? 'Update' : 'Design'}</button>}
        </div>
        <div className="composer-opts">
          <label className="check" title="Show every step Claude takes (thinking, tool calls, file edits, retries) while it works">
            <input type="checkbox" checked={p.verbose} onChange={(e) => p.onVerbose(e.target.checked)} /> Verbose progress
          </label>
          {p.busyElsewhere && <span className="busy-note">Claude is working on this design in another tab</span>}
        </div>
      </div>
      {dragOver && <div className="drop-overlay">Drop photos to attach</div>}
      {lightbox && <div className="lightbox" onClick={() => setLightbox(null)}><img src={lightbox} alt="" /></div>}
    </div>
  );
}

function Message({ m, live, verbose, versions, currentVersion, onRestore, onImage }: {
  m: ChatMessage; live: boolean; verbose: boolean; versions: DesignVersion[]; currentVersion: number;
  onRestore: (i: number) => void; onImage: (src: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(live ? m.createdAt : null);
  // Claude's full thinking beside the chat: opens while hovering the live line, can be pinned.
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
        {m.images?.length ? <div className="msg-images">{m.images.map((src, i) => <img key={i} src={src} alt="" onClick={() => onImage(src)} />)}</div> : null}
        {m.text && <div className="bubble">{m.text}</div>}
      </div>
    );
  }
  const assembly = (m.steps ?? []).filter((s) => s.kind === 'assembly' && s.image);
  const thoughts = (m.steps ?? []).filter((s) => s.kind === 'thinking');
  const peekProps = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => peek(true, e.currentTarget),
    onMouseLeave: () => peek(false),
    title: "Hover to read all of Claude's thinking",
  };
  const all = (m.steps ?? []).filter((s) => !(s.kind === 'text' && s.text === m.text) && s.kind !== 'assembly');
  const steps = verbose ? all : all.filter((s) => !s.verbose);
  const renders = steps.filter((s) => s.kind === 'render' && s.image);
  // Verbose: the full log is open while Claude works. Compact: one status line unless expanded.
  const showSteps = (live && verbose) || open;
  const lastStatus = [...steps].reverse().find((s) => s.kind !== 'render');
  const headline = live
    ? (verbose ? 'Working' : m.live ?? (lastStatus ? clip(lastStatus.text, 70) : 'Starting…'))
    : `${steps.length} steps${m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(0)} s` : ''}`;
  return (
    <div className="msg assistant">
      <div className="msg-head">
        <button className={`steps-toggle ${live && !verbose ? 'peek' : ''}`} onClick={() => setOpen(!open)} {...(live && !verbose ? peekProps : {})}>
          {live ? <span className="spinner" /> : <Icon name={m.error ? 'alert' : 'check'} size={14} />}
          <span>{headline}{live && <span className="elapsed"> · {fmtElapsed(elapsed)}</span>}</span>
          {(!live || !verbose) && <span className={`chev ${open ? 'open' : ''}`}><Icon name="chevron" size={12} /></span>}
        </button>
        {(live || thoughts.length > 0) && (
          <button className="link think-link" title="Show all of Claude's thinking for this reply" onClick={(e) => setThink(think?.mode === 'pinned' ? null : { mode: 'pinned', at: besideChat(e.currentTarget) })}>
            <Icon name="spark" size={12} /> thinking
          </button>
        )}
      </div>
      {think && (
        <ThinkingPanel
          blocks={thoughts}
          current={m.thinking}
          live={live}
          at={think.at}
          pinned={think.mode === 'pinned'}
          onPin={(pinned) => setThink((t) => t && { ...t, mode: pinned ? 'pinned' : 'hover' })}
          onClose={() => setThink(null)}
          onHover={(inside) => peek(inside)}
        />
      )}
      {showSteps && (
        <ol className="steps">
          {steps.map((s, i) => <Step key={i} s={s} onImage={onImage} showTime={verbose} />)}
          {live && verbose && <li className="step live peek" {...peekProps}><span className="spinner" /> <span className="step-text">{m.live ?? 'Starting…'}</span></li>}
        </ol>
      )}
      {!showSteps && renders.length > 0 && (
        <div className="render-strip">
          {renders.slice(-1).map((s, i) => <img key={i} src={s.image} alt="render" onClick={() => onImage(s.image!)} />)}
        </div>
      )}
      {m.text && <div className="bubble md-bubble"><Markdown text={m.text} /></div>}
      {assembly.length > 0 && (
        <div className="assembly">
          <div className="assembly-title">Assembly</div>
          <div className="assembly-grid">
            {assembly.map((s, i) => (
              <figure key={i} onClick={() => onImage(s.image!)}>
                <img src={s.image} alt={s.text} />
                <figcaption>{s.text}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
      {m.error && <div className="bubble error"><Icon name="alert" size={14} /> {m.error}</div>}
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

function Step({ s, onImage, showTime }: { s: AgentStep; onImage: (src: string) => void; showTime: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = s.text.length > 160;
  return (
    <li className={`step ${s.kind} ${s.ok === false ? 'bad' : s.ok ? 'good' : ''}`}>
      {showTime && s.at != null && <span className="step-time">{fmtElapsed(s.at)}</span>}
      <span className="step-text" onClick={() => long && setExpanded(!expanded)}>{expanded || !long ? s.text : clip(s.text, 160)}</span>
      {s.image && <img src={s.image} alt="render" onClick={() => onImage(s.image!)} />}
    </li>
  );
}

/** Where the thinking panel opens: just right of the chat column, level with `el`. */
function besideChat(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const chat = el.closest('.chat-panel')?.getBoundingClientRect();
  return { left: (chat?.right ?? r.right) + 8, top: r.top };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
