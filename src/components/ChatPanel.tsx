import { useEffect, useRef, useState } from 'react';
import type { ActivityItem, AgentStep, ChatMessage, DesignVersion } from '../../shared/types';
import { isSvg, prepareImage } from '../lib/files';
import { importSvg } from '../lib/svg';
import type { SvgDrawing } from '../../shared/svgFeatures';
import { formatDuration } from '../../shared/duration';
import { EditTags, groupEdits } from './EditTags';
import { MAX_SCAD_CHARS, MAX_SCAD_FILES, scadFileName, type ScadFile } from '../../shared/scad';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { ActivityPanel } from './ActivityPanel';
import { activityOf } from '../lib/activity';
import { useEscape } from './useEscape';
import { usePopover } from './usePopover';
import type { GenerateRequest, MeshUpload } from '../../shared/api';
import { meshFormat } from '../../shared/meshFormats';
import { api } from '../lib/api';
import { load, store } from '../lib/storage';
import { startDictation, type Dictation } from '../lib/dictation';
import { SOURCE_KINDS, sourcesSummary, weakestKind, type DimensionSource } from '../../shared/sources';

interface Props {
  /** The open design (its chat starts scrolled to the bottom). */
  designId: string;
  messages: ChatMessage[];
  versions: DesignVersion[];
  currentVersion: number;
  generating: boolean;
  /** Another browser tab is generating this design. */
  busyElsewhere: boolean;
  /** `drawings`: the exact shapes of SVG files among the attachments (for H.svg); `scad`: attached OpenSCAD files; `meshes`: attached mesh files, already imported. */
  onSend: (text: string, images: string[], drawings: SvgDrawing[], scad: ScadFile[], meshes: MeshUpload[]) => void;
  /** Messages written while Claude works, sent once its reply is done. */
  queued: { text: string; images: string[]; scad: ScadFile[]; meshes: MeshUpload[] }[];
  /** The reply was stopped or failed: the queue waits for "Send now". */
  queuePaused: boolean;
  onQueue: (text: string, images: string[], drawings: SvgDrawing[], scad: ScadFile[], meshes: MeshUpload[]) => void;
  /** While Claude works: into the running reply (Claude reads it at its next step). */
  onSteer: (text: string, images: string[], drawings: SvgDrawing[], scad: ScadFile[], meshes: MeshUpload[]) => void;
  onRemoveQueued: (index: number) => void;
  onSendQueued: () => void;
  onStop: () => void;
  onRestore: (versionIndex: number) => void;
  model: string;
  onModel: (m: string) => void;
  effort: string;
  onEffort: (e: string) => void;
  hasModel: boolean;
  /** Dictation is set up on the server (ElevenLabs key). */
  dictation: boolean;
  /** Why Claude can't run (no API key), shown instead of sending. */
  claudeProblem: string | null;
  /** Claude may search the web for this design (off for every design until turned on). */
  webSearch: boolean;
  /** What Claude does with pictures (the palette menu); `artworkModel`: the image model, null when Jig has no OpenRouter key. */
  imageMode: ImageMode;
  artworkModel: string | null;
  /** 3D figures can be made (the server has a Meshy key). */
  meshy: boolean;
  onImageMode: (mode: ImageMode) => void;
  /** The server's starting model (JIG_MODEL), offered even when it is a full model ID. */
  defaultModel: string;
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
  // The enlarged picture is a modal: focus stays on its close button and goes back to the
  // thumbnail that opened it.
  const opener = useRef<HTMLElement | null>(null);
  const openLightbox = (src: string) => { opener.current = document.activeElement as HTMLElement | null; setLightbox(src); };
  const closeLightbox = () => { setLightbox(null); opener.current?.focus(); };
  useEscape(!!lightbox, closeLightbox);
  // Another design: start at the bottom of its chat, with no picture open.
  useEffect(() => {
    atBottom.current = true;
    setLightbox(null);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [p.designId]);

  // SVG attachments also bring their exact shapes (keyed by their picture), for Claude's H.svg.
  const [svgShapes, setSvgShapes] = useState<Record<string, SvgDrawing>>({});
  const [attachError, setAttachError] = useState<string | null>(null);
  const [scad, setScad] = useState<ScadFile[]>([]);
  // Mesh files are imported (repaired, stored with the design) as soon as they are attached.
  const [meshes, setMeshes] = useState<{ key: number; name: string; upload?: MeshUpload; error?: string }[]>([]);
  const meshKey = useRef(0);
  const addMeshes = (files: File[]) => {
    for (const f of files) {
      const key = ++meshKey.current;
      setMeshes((prev) => [...prev, { key, name: f.name }].slice(-4));
      api.uploadMesh(p.designId, f).then(
        (upload) => setMeshes((prev) => prev.map((m) => (m.key === key ? { ...m, upload } : m))),
        (e: Error) => setMeshes((prev) => prev.map((m) => (m.key === key ? { ...m, error: e.message } : m))),
      );
    }
  };
  const importing = meshes.some((m) => !m.upload && !m.error);
  const readyMeshes = meshes.flatMap((m) => (m.upload ? [m.upload] : []));
  const addFiles = async (files: Iterable<File>) => {
    const all = [...files];
    const imgs = all.filter((f) => f.type.startsWith('image/') || isSvg(f));
    setAttachError(null);
    addMeshes(all.filter((f) => meshFormat(f.name)));
    // OpenSCAD files go to Claude as source (the server renders them with OpenSCAD).
    const scadFiles = all.filter((f) => /\.scad$/i.test(f.name));
    if (scadFiles.length) {
      const read = await Promise.all(scadFiles.map(async (f) => (f.size > MAX_SCAD_CHARS * 4 ? null : { name: scadFileName(f.name), source: await f.text() })));
      const ok = read.filter((f): f is ScadFile => !!f && f.source.length <= MAX_SCAD_CHARS);
      if (ok.length < scadFiles.length) setAttachError(`OpenSCAD files can be up to ${MAX_SCAD_CHARS.toLocaleString('en')} characters.`);
      setScad((prev) => [...prev.filter((p) => !ok.some((f) => f.name === p.name)), ...ok].slice(0, MAX_SCAD_FILES));
    }
    const added = await Promise.all(imgs.map(async (f) => {
      const url = await prepareImage(f).catch(() => null);
      if (!url) { setAttachError(`${f.name} could not be read as a picture.`); return null; }
      if (!isSvg(f)) return { url };
      try {
        return { url, drawing: importSvg(await f.text(), f.name).drawing };
      } catch (e) {
        // Still sent as a picture; Claude just doesn't get the exact shapes.
        setAttachError(`${f.name}: ${(e as Error).message} It is attached as a picture only.`);
        return { url };
      }
    }));
    const ok = added.filter((a): a is { url: string; drawing?: SvgDrawing } => !!a);
    setImages((prev) => [...prev, ...ok.map((a) => a.url)].slice(0, 8));
    setSvgShapes((prev) => ({ ...prev, ...Object.fromEntries(ok.filter((a) => a.drawing).map((a) => [a.url, a.drawing!])) }));
  };

  const hasDraft = !!text.trim() || images.length > 0 || scad.length > 0 || readyMeshes.length > 0;
  const send = (message = text, later = false) => {
    if (p.busyElsewhere || p.claudeProblem || importing || (!message.trim() && !images.length && !scad.length && !readyMeshes.length)) return;
    // While Claude works the message goes into the reply now, or waits for its end ("Later").
    (p.generating ? (later ? p.onQueue : p.onSteer) : p.onSend)(message.trim(), images, images.flatMap((src) => (svgShapes[src] ? [svgShapes[src]] : [])), scad, readyMeshes);
    setSvgShapes({});
    setScad([]);
    setMeshes([]);
    setText('');
    setImages([]);
  };

  // ---- dictation: what is said goes into the box as it is spoken (after what was typed)
  const [listening, setListening] = useState<'off' | 'starting' | 'on' | 'stopping'>('off');
  const [dictationError, setDictationError] = useState<string | null>(null);
  const dictation = useRef<Dictation | null>(null);
  const spoken = useRef(''); // the box's text including the latest words
  const sendWhenStopped = useRef(false);
  const stopListening = async (): Promise<string> => {
    const d = dictation.current;
    if (d) {
      dictation.current = null;
      setListening('stopping');
      await d.stop();
    }
    setListening('off');
    if (sendWhenStopped.current) { sendWhenStopped.current = false; send(spoken.current); }
    return spoken.current;
  };
  const startListening = async () => {
    // Enter then goes to the text box (stop, then send), not to the microphone button.
    textarea.current?.focus();
    const before = text.trimEnd();
    const prefix = before ? `${before} ` : '';
    spoken.current = text;
    setDictationError(null);
    setListening('starting');
    try {
      const d = await startDictation(
        (words) => { spoken.current = prefix + words; setText(spoken.current); },
        (message) => { setDictationError(message); void stopListening(); },
      );
      // Stopped (or the design changed) while the microphone was starting.
      if (listeningRef.current !== 'starting') { void d.stop(); return; }
      dictation.current = d;
      setListening('on');
    } catch (e) {
      setDictationError((e as Error).message);
      setListening('off');
    }
  };
  const listeningRef = useRef(listening);
  listeningRef.current = listening;
  const toggleListening = () => { if (listening === 'off') void startListening(); else void stopListening(); };
  // Escape stops listening and keeps the text; so does opening another design.
  useEscape(listening !== 'off', () => { void stopListening(); });
  useEffect(() => () => { void dictation.current?.stop(); }, []);
  useEffect(() => { if (listeningRef.current !== 'off') void stopListening(); }, [p.designId]);
  // ---- the activity panel, pinned on a live reply, follows Claude across designs: it shows the
  // live reply of whichever design is open (and keeps showing it once it finishes), is hidden on
  // designs where Claude isn't working, and only closing it (X) stops this. On one design it keeps
  // what it has shown: the next reply (e.g. a queued message) is added below the earlier ones.
  const [followLive, setFollowLive] = useState<boolean>(() => load('followActivity', false));
  useEffect(() => store('followActivity', followLive), [followLive]);
  const lastMsg = p.messages.at(-1);
  const liveId = (p.generating || p.busyElsewhere) && lastMsg?.role === 'assistant' ? lastMsg.id : null;
  const [shownIds, setShownIds] = useState<string[]>([]);
  useEffect(() => { setShownIds(liveId ? [liveId] : []); }, [p.designId]);
  useEffect(() => {
    if (!liveId) return;
    setShownIds((ids) => (ids.includes(liveId) ? ids : followLive && ids.length ? [...ids, liveId] : [liveId]));
  }, [liveId]);
  const followedMsgs = followLive ? p.messages.filter((m) => shownIds.includes(m.id)) : [];
  const followed = followedMsgs.at(-1);
  const follow = (id: string, on: boolean) => { setFollowLive(on); setShownIds(on ? [id] : []); };
  /** The followed replies' activity, each later one after a line with the message that started it. */
  const followedItems = (): ActivityItem[] => followedMsgs.flatMap((m, i) => {
    if (!i) return activityOf(m);
    const asked = p.messages[p.messages.indexOf(m) - 1];
    const text = asked?.role === 'user' ? asked.text.split('\n')[0] || 'pictures' : 'next message';
    return [{ kind: 'step' as const, step: { kind: 'status' as const, text: `── Your next message: "${clip(text, 120)}" ──` } }, ...activityOf(m)];
  });
  const chatRoot = useRef<HTMLDivElement>(null);
  const besideChatTop = () => {
    const r = chatRoot.current?.getBoundingClientRect();
    return { left: (r?.right ?? 360) + 8, top: (r?.top ?? 0) + 120 };
  };

  /** Update while listening: stop, then send everything that was said. */
  const sendNow = async (later = false) => { send(listening === 'off' ? text : await stopListening(), later); };

  return (
    <div
      ref={chatRoot}
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
          <Message key={m.id} m={m} live={(p.generating || p.busyElsewhere) && i === p.messages.length - 1} versions={p.versions} currentVersion={p.currentVersion} onRestore={p.onRestore} onImage={openLightbox}
            followed={followedMsgs.some((f) => f.id === m.id)} onFollow={(on) => follow(m.id, on)} />
        ))}
      </div>

      <div className="composer">
        {p.queued.length > 0 && (
          <div className="queued" role="status">
            <div className="queued-head small">
              {p.queuePaused ? 'Not sent – the reply was stopped or failed:' : 'Sends when Claude has finished:'}
              {p.queuePaused && <button className="link" onClick={p.onSendQueued}>Send now</button>}
            </div>
            {p.queued.map((q, i) => (
              <div key={i} className="queued-item">
                <span className="queued-text">{clip(q.text || (q.images.length ? 'Pictures only' : 'Files only'), 140)}</span>
                {q.images.length > 0 && <span className="dim small">+{q.images.length} picture{q.images.length > 1 ? 's' : ''}</span>}
                {q.scad.length > 0 && <span className="dim small">+{q.scad.map((f) => f.name).join(', ')}</span>}
                {q.meshes.length > 0 && <span className="dim small">+{q.meshes.map((m) => m.entry.original ?? m.name).join(', ')}</span>}
                <button className="icon-btn" aria-label="Remove this queued message" title="Remove" onClick={() => p.onRemoveQueued(i)}><Icon name="x" size={12} /></button>
              </div>
            ))}
          </div>
        )}
        {attachError && <div className="bad-note small" role="alert">{attachError}</div>}
        {scad.length > 0 && (
          <div className="file-chips">
            {scad.map((f) => (
              <span key={f.name} className="file-chip" title="OpenSCAD file: Claude gets its source and a render of it">
                <Icon name="code" size={12} /> {f.name}
                <button onClick={() => setScad(scad.filter((x) => x !== f))} aria-label={`Remove ${f.name}`}><Icon name="x" size={11} /></button>
              </span>
            ))}
          </div>
        )}
        {meshes.length > 0 && (
          <div className="attachments">
            {meshes.map((m) => (
              <div key={m.key} className={`thumb mesh ${m.error ? 'failed' : ''}`} role={m.error ? 'alert' : undefined}
                title={m.error ?? (m.upload ? meshSummary(m.upload) : `Importing ${m.name}: reading, repairing and making it a solid…`)}>
                {/* The import's four-view render, cropped to its ISO view. */}
                {m.upload?.entry.preview ? <span className="thumb-crop"><img src={m.upload.entry.preview} alt={`Attached mesh ${m.name}`} /></span> : <span className="thumb-icon">{m.error ? <Icon name="alert" size={18} /> : <span className="spinner" />}</span>}
                <span className="thumb-tag">{(meshFormat(m.name) ?? 'mesh').toUpperCase()}</span>
                <button onClick={() => setMeshes(meshes.filter((x) => x !== m))} aria-label={`Remove ${m.name}`}><Icon name="x" size={12} /></button>
              </div>
            ))}
          </div>
        )}
        {meshes.some((m) => m.error) && <div className="bad-note small" role="alert">{meshes.filter((m) => m.error).map((m) => m.error).join(' ')}</div>}
        {images.length > 0 && (
          <div className="attachments">
            {images.map((src, i) => (
              <div key={i} className={`thumb ${svgShapes[src] ? 'svg' : ''}`} title={svgShapes[src] ? `${svgShapes[src].name}: Claude also gets its exact shapes` : undefined}>
                <img src={src} alt={svgShapes[src] ? `Attached drawing ${svgShapes[src].name}` : `Attached photo ${i + 1}`} />
                {svgShapes[src] && <span className="thumb-tag">SVG</span>}
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
          // Enter while listening only stops it (the text stays to be checked); the next Enter sends.
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            // The first Enter stops listening; one pressed while the last words come in sends them once they are in.
            if (listening === 'on' || listening === 'starting') void stopListening();
            else if (listening === 'stopping') sendWhenStopped.current = true;
            else send();
          }}
          readOnly={listening === 'on' || listening === 'stopping'}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files); } }}
          rows={3}
        />
        <div className="composer-bar">
          <button className="icon-btn" title="Attach photos, SVG, OpenSCAD (.scad) or 3D models (STL, 3MF, OBJ, GLB)" aria-label="Attach photos, SVG, OpenSCAD files or 3D models" onClick={() => fileInput.current?.click()}><Icon name="paperclip" /></button>
          <input ref={fileInput} type="file" accept="image/*,.svg,.scad,.stl,.3mf,.obj,.glb,.gltf" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          <select value={p.model} onChange={(e) => p.onModel(e.target.value)} title="Claude model" aria-label="Claude model">
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
            {!['opus', 'sonnet', 'haiku'].includes(p.defaultModel) && <option value={p.defaultModel}>{modelLabel(p.defaultModel)}</option>}
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
            title={p.webSearch ? 'Web search is on: Claude looks up exact dimensions of real products online (click to turn it off for this design, until you reload)' : 'Web search is off for this design: click to let Claude search the web for exact dimensions of real products'}
          >
            <Icon name="globe" size={14} />
          </button>
          <ImageModeMenu mode={p.imageMode} artworkModel={p.artworkModel} meshy={p.meshy} onMode={p.onImageMode} />
          <span className="spacer" />
          <button
            className={`icon-btn mic ${listening}`}
            aria-label={listening === 'off' ? 'Dictate' : 'Stop dictating'}
            aria-pressed={listening !== 'off'}
            disabled={!p.dictation || listening === 'stopping'}
            title={!p.dictation ? 'Dictation needs an ElevenLabs API key: set ELEVENLABS_API_KEY in .env and restart Jig'
              : listening === 'off' ? 'Dictate (English or Romanian)' : 'Stop dictating (Enter or Esc); the text stays'}
            onClick={toggleListening}
          >
            <Icon name="mic" />
          </button>
          {/* While Claude works with something typed: Stop and Later as icons, so Send keeps its room. */}
          {p.generating && (hasDraft
            ? <button className="icon-btn danger" onClick={p.onStop} title="Stop" aria-label="Stop"><Icon name="stop" /></button>
            : <button className="btn danger" onClick={p.onStop} title="Stop"><Icon name="stop" /> <span className="btn-label">Stop</span></button>)}
          {p.generating && hasDraft && (
            <button className="icon-btn" onClick={() => void sendNow(true)} disabled={listening === 'starting'} title="Later: send when Claude has finished this reply" aria-label="Send later, when Claude has finished">
              <Icon name="clock" />
            </button>
          )}
          {(!p.generating || hasDraft) && (
            <button className="btn primary" onClick={() => void sendNow()} disabled={p.busyElsewhere || !!p.claudeProblem || importing || listening === 'starting' || (!text.trim() && !images.length && !scad.length && !readyMeshes.length)}
              title={importing ? 'Importing the 3D model…' : p.generating ? 'Send now: Claude reads it at its next step, while it works' : p.hasModel ? 'Update' : 'Design'}>
              <Icon name="send" /> <span className="btn-label">{p.generating ? 'Send' : p.hasModel ? 'Update' : 'Design'}</span>
            </button>
          )}
        </div>
        {p.busyElsewhere && <div className="composer-opts"><span className="busy-note" role="status">Claude is working on this design in another tab</span></div>}
        {p.claudeProblem && <div className="composer-opts"><span className="bad-note" role="alert">{p.claudeProblem}</span></div>}
        {listening === 'on' && <div className="composer-opts"><span className="listening-note" role="status"><span className="rec-dot" /> Listening… Enter or Esc stops, the text stays</span></div>}
        {dictationError && listening === 'off' && <div className="composer-opts"><span className="bad-note" role="alert">{dictationError}</span> <button className="link" onClick={() => setDictationError(null)}>Dismiss</button></div>}
      </div>
      {followed && (
        <ActivityPanel
          items={followedItems()}
          live={followed.id === liveId}
          onImage={openLightbox}
          at={besideChatTop()}
          pinned
          onPin={(pin) => { if (!pin) follow(followed.id, false); }}
          onClose={() => follow(followed.id, false)}
          onHover={() => {}}
        />
      )}
      {dragOver && <div className="drop-overlay">Drop photos, SVG, .scad files or 3D models (STL, 3MF, OBJ, GLB) to attach</div>}
      {lightbox && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Enlarged image" onClick={closeLightbox}
          onKeyDown={(e) => { if (e.key === 'Tab') e.preventDefault(); }}>
          <img src={lightbox} alt="" />
          <button className="lightbox-close" autoFocus onClick={closeLightbox} aria-label="Close (Esc)"><Icon name="x" size={16} /></button>
        </div>
      )}
    </div>
  );
}

export type ImageMode = NonNullable<GenerateRequest['imageMode']>;

const IMAGE_MODES: { mode: ImageMode; label: string; short?: string; icon: string; hint: (artworkModel: string | null, meshy: boolean) => string }[] = [
  { mode: 'off', label: '3D model (no picture)', icon: 'cube', hint: () => 'Claude models people, characters and animals as 3D objects.' },
  { mode: 'artwork', label: 'AI artwork (flat colour layers)', short: 'Artwork', icon: 'palette', hint: (m) => `For people, characters, animals and scenes ${m ?? 'an image model'} draws flat artwork, which Claude turns into colour layers for wall art, reliefs and signs.` },
  { mode: 'hueforge', label: 'HueForge (filament painting)', short: 'HueForge', icon: 'layers', hint: (art) => `A picture printed flat as a thin relief, painted by stacked filaments that let the ones below show through. Attach a photo${art ? ', or describe the picture and Claude has one made' : ''}; set the filaments in the Print tab.` },
  { mode: 'lithophane', label: 'Lithophane (backlit photo)', short: 'Lithophane', icon: 'lamp', hint: (art) => `A photo in white PLA, thick where it is dark and thin where bright, that glows lit from behind: night lights, frames, lamp shades. Attach a photo${art ? ', or describe one and Claude has it made' : ''}.` },
  { mode: 'figure', label: '3D figure (AI mesh)', short: 'Figure', icon: 'figure', hint: (_a, meshy) => (meshy
    ? 'Meshy sculpts a real 3D model of a person, character or animal from your description or an attached photo (1–3 min, Meshy credits); Claude adds the base, name or mount.'
    : 'Needs a Meshy API key: set MESHY_API_KEY in .env and restart Jig.') },
];

/** The palette button: what Claude does with pictures for this design (until you reload). */
function ImageModeMenu({ mode, artworkModel, meshy, onMode }: { mode: ImageMode; artworkModel: string | null; meshy: boolean; onMode: (m: ImageMode) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  usePopover(open, () => setOpen(false), wrap, trigger);
  const modes = IMAGE_MODES.filter((m) => m.mode !== 'artwork' || artworkModel || mode === 'artwork');
  const current = IMAGE_MODES.find((m) => m.mode === mode) ?? IMAGE_MODES[0];
  // Opening puts the focus on the chosen mode; arrows, Home and End move it.
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(); }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowDown' ? (i + 1) % items.length : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (to >= 0) { e.preventDefault(); items[to]?.focus(); }
    if (e.key === 'Tab') setOpen(false);
  };
  // Picking keeps the menu open (to compare the modes); Escape, Tab or a click outside closes it.
  const pick = (m: ImageMode) => onMode(m);
  return (
    <span className="mode-wrap" ref={wrap}>
      <button
        ref={trigger}
        className={`web-toggle art mode-btn ${mode !== 'off' ? 'on' : ''}`}
        aria-label={`Picture mode: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } }}
        title={`Picture mode: ${current.label}. ${current.hint(artworkModel, meshy)} Click to choose.`}
      >
        <Icon name={current.icon} size={14} />
        {current.short && <span className="mode-label">{current.short}</span>}
      </button>
      {open && (
        <div className="mode-menu" role="menu" aria-label="Picture mode" ref={menu} onKeyDown={onKey}>
          {modes.map((m) => {
            // Without a Meshy key the mode is shown, saying what it needs, but can't be chosen.
            const off = m.mode === 'figure' && !meshy && mode !== 'figure';
            return (
              <button key={m.mode} role="menuitemradio" aria-checked={m.mode === mode} aria-disabled={off || undefined} className={`${m.mode === mode ? 'on' : ''} ${off ? 'unavailable' : ''}`} onClick={() => { if (!off) pick(m.mode); }}>
                <span className="mode-check" aria-hidden>{m.mode === mode && <Icon name="check" size={13} />}</span>
                <span className="mode-icon" aria-hidden><Icon name={m.icon} size={16} /></span>
                <span><b>{m.label}{m.mode === 'off' && <i className="mode-default">Default</i>}</b><span>{m.hint(artworkModel, meshy)}</span></span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

function Message({ m, live, versions, currentVersion, onRestore, onImage, followed, onFollow }: {
  m: ChatMessage; live: boolean; versions: DesignVersion[]; currentVersion: number;
  onRestore: (i: number) => void; onImage: (src: string) => void;
  /** This reply's activity is the panel that follows Claude across designs (ChatPanel shows it). */
  followed: boolean; onFollow: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(live ? m.createdAt : null);
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
    title: 'Hover to watch everything Claude is doing, click to pin it open',
  };
  const all = (m.steps ?? []).filter((s) => !(s.kind === 'text' && s.text === m.text) && s.kind !== 'assembly');
  const steps = all;
  const renders = steps.filter((s) => s.kind === 'render' && s.image && !s.verbose);
  // The full step log is open while Claude works; afterwards it folds into one line.
  const showSteps = live || open;
  const headline = live ? 'Working' : `${steps.length} steps${m.durationMs ? ` · ${formatDuration(m.durationMs)}` : ''}`;
  return (
    <div className="msg assistant">
      <div className="msg-head">
        <button className={`steps-toggle ${live ? 'peek' : ''}`} onClick={() => setOpen(!open)} {...(live ? peekProps : {})}>
          {live ? <span className="spinner" /> : <Icon name={m.error ? 'alert' : 'check'} size={14} />}
          <span>{headline}{live && <span className="elapsed"> · {fmtElapsed(elapsed)}</span>}</span>
          {!live && <span className={`chev ${open ? 'open' : ''}`}><Icon name="chevron" size={12} /></span>}
        </button>
        {(live || hasActivity) && (
          <button className="link think-link" title="Show everything Claude did for this reply: thinking, code, tool calls and results"
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

/** The import of an attached mesh in one line (its chip's tooltip). */
function meshSummary(u: MeshUpload) {
  const [x, y, z] = u.entry.size.map((v) => v.toFixed(0));
  return `${u.entry.original ?? u.name}: ${x} × ${y} × ${z} mm, ${u.entry.triangles.toLocaleString('en')} triangles. ${u.report.repairs.length ? `Repairs: ${u.report.repairs.join('; ')}.` : 'No repairs needed.'} Claude gets a render and this report.`;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** Where the version's real-world dimensions came from, coloured by the weakest source (details in the Model tab). */
function SourcesChip({ list }: { list?: DimensionSource[] }) {
  const weakest = list && weakestKind(list);
  if (!list || !weakest) return null;
  return <span className={`src-chip ${SOURCE_KINDS[weakest].trust}`} title={`Dimension sources: ${sourcesSummary(list)} (Model tab for details)`}>{sourcesSummary(list)}</span>;
}

/** "claude-opus-5-5" → "Opus 5.5"; other IDs as they are. */
function modelLabel(id: string) {
  const m = /^(?:anthropic\/)?claude-([a-z]+)-(\d+)[.-](\d+)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}
