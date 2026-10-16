import { useEffect, useRef, useState } from 'react';
import type { AgentStep, ChatMessage, DesignVersion } from '../../shared/types';
import { prepareImage } from '../lib/files';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

interface Props {
  messages: ChatMessage[];
  versions: DesignVersion[];
  currentVersion: number;
  generating: boolean;
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
    if (p.generating || (!text.trim() && !images.length)) return;
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
          <Message key={m.id} m={m} live={p.generating && i === p.messages.length - 1} versions={p.versions} currentVersion={p.currentVersion} onRestore={p.onRestore} onImage={setLightbox} />
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
            : <button className="btn primary" onClick={send} disabled={!text.trim() && !images.length}><Icon name="send" /> {p.hasModel ? 'Update' : 'Design'}</button>}
        </div>
      </div>
      {dragOver && <div className="drop-overlay">Drop photos to attach</div>}
      {lightbox && <div className="lightbox" onClick={() => setLightbox(null)}><img src={lightbox} alt="" /></div>}
    </div>
  );
}

function Message({ m, live, versions, currentVersion, onRestore, onImage }: {
  m: ChatMessage; live: boolean; versions: DesignVersion[]; currentVersion: number;
  onRestore: (i: number) => void; onImage: (src: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (m.role === 'user') {
    return (
      <div className="msg user">
        {m.images?.length ? <div className="msg-images">{m.images.map((src, i) => <img key={i} src={src} alt="" onClick={() => onImage(src)} />)}</div> : null}
        {m.text && <div className="bubble">{m.text}</div>}
      </div>
    );
  }
  const steps = (m.steps ?? []).filter((s) => !(s.kind === 'text' && s.text === m.text));
  const renders = steps.filter((s) => s.kind === 'render' && s.image);
  const showSteps = live || open;
  const lastStatus = [...steps].reverse().find((s) => s.kind !== 'render');
  return (
    <div className="msg assistant">
      <button className="steps-toggle" onClick={() => setOpen(!open)}>
        {live ? <span className="spinner" /> : <Icon name={m.error ? 'alert' : 'check'} size={14} />}
        <span>{live ? (lastStatus ? clip(lastStatus.text, 70) : 'Starting…') : `${steps.length} steps${m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(0)} s` : ''}`}</span>
        {!live && <span className={`chev ${open ? 'open' : ''}`}><Icon name="chevron" size={12} /></span>}
      </button>
      {showSteps && (
        <ol className="steps">
          {steps.map((s, i) => <Step key={i} s={s} onImage={onImage} />)}
        </ol>
      )}
      {!showSteps && renders.length > 0 && (
        <div className="render-strip">
          {renders.slice(-1).map((s, i) => <img key={i} src={s.image} alt="render" onClick={() => onImage(s.image!)} />)}
        </div>
      )}
      {m.text && <div className="bubble md-bubble"><Markdown text={m.text} /></div>}
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

function Step({ s, onImage }: { s: AgentStep; onImage: (src: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const long = s.text.length > 160;
  return (
    <li className={`step ${s.kind} ${s.ok === false ? 'bad' : s.ok ? 'good' : ''}`}>
      <span className="step-text" onClick={() => long && setExpanded(!expanded)}>{expanded || !long ? s.text : clip(s.text, 160)}</span>
      {s.image && <img src={s.image} alt="render" onClick={() => onImage(s.image!)} />}
    </li>
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
