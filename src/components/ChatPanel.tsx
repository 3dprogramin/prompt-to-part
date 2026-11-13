import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ActivityItem, ChatMessage, DesignVersion } from '../../shared/types';
import { isSvg, prepareImage } from '../lib/files';
import { importSvg } from '../lib/svg';
import type { SvgDrawing } from '../../shared/svgFeatures';
import { MAX_SCAD_CHARS, MAX_SCAD_FILES, scadFileName, type ScadFile } from '../../shared/scad';
import { Icon } from './Icon';
import { ActivityPanel } from './ActivityPanel';
import { activityOf } from '../lib/activity';
import { useEscape } from './useEscape';
import type { MeshUpload, MeshyBalance } from '../../shared/api';
import type { LineArtStyle } from '../../shared/lineart';
import { meshFormat } from '../../shared/meshFormats';
import { api } from '../lib/api';
import { load, store } from '../lib/storage';
import { startDictation, type Dictation } from '../lib/dictation';
import type { AutoBuild } from '../lib/autoBuild';
import { ModelMenu } from './chat/ModelMenu';
import { Starters } from './chat/Starters';
import { OptionsMenu } from './chat/OptionsMenu';
import { FigureMenu, ImageModeMenu, LineArtMenu, type ImageMode } from './chat/PictureModeMenus';
import { MODE_EXAMPLES } from './chat/modeImages';
import { Message } from './chat/Message';
import { AutoBuildCard } from './chat/AutoBuildCard';
import { clip, meshSummary } from './chat/text';

export type { ImageMode } from './chat/PictureModeMenus';

interface Props {
  /** The open design (its chat starts scrolled to the bottom). */
  designId: string;
  messages: ChatMessage[];
  versions: DesignVersion[];
  currentVersion: number;
  generating: boolean;
  /** Another browser tab is generating this design. */
  busyElsewhere: boolean;
  /** Why the shown version can't be changed (it is printed), or null: the composer is off. */
  locked: string | null;
  /** `drawings`: the exact shapes of SVG files among the attachments (for H.svg); `scad`: attached OpenSCAD files; `meshes`: attached mesh files, already imported. */
  onSend: (text: string, images: string[], drawings: SvgDrawing[], scad: ScadFile[], meshes: MeshUpload[]) => void;
  /** "Ask first": the answers chosen on the question card under reply `messageId` (sent as the user's message). */
  onAnswer: (messageId: string, answers: string[][]) => void;
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
  /** What Claude does with pictures (the palette menu); `artworkModel`: the image model, null without an OpenRouter key. */
  imageMode: ImageMode;
  artworkModel: string | null;
  /** 3D figures can be made (the server has a Meshy key). */
  meshy: boolean;
  /** The Meshy account's credits, once known. */
  meshyCredits: MeshyBalance | null;
  onImageMode: (mode: ImageMode) => void;
  /** 3D figure mode's Colour: figures in colour, printed in up to 4 filaments (off by default). */
  figureColor: boolean;
  onFigureColor: (on: boolean) => void;
  /** Line art mode's style (its ▾ menu): outline, key holder, framed, … */
  lineArtStyle: LineArtStyle;
  onLineArtStyle: (style: LineArtStyle) => void;
  /** 3D figure mode: concept pictures wait for the user's approval (on by default); off, they are built after a countdown. */
  waitForOk: boolean;
  onWaitForOk: (on: boolean) => void;
  /** Follow-ups bring the AI the user's current view and a four-view render at their settings (on by default). */
  sendView: boolean;
  onSendView: (on: boolean) => void;
  askFirst: boolean;
  onAskFirst: (on: boolean) => void;
  /** The image tool (on by default): in 3D model mode the AI can have the image model draw a picture to model from. */
  imageTool: boolean;
  onImageTool: (on: boolean) => void;
  /** Chimes when the AI needs you and when a reply has finished. */
  sounds: boolean;
  onSounds: (on: boolean) => void;
  /** The countdown under the last reply ("Wait for my OK" off), null when there is none. */
  autoBuild: AutoBuild | null;
  onBuildNow: () => void;
  onStopAutoBuild: () => void;
  /** The server's starting model (PTP_MODEL), offered even when it is a full model ID. */
  defaultModel: string;
  /** Claude runs through OpenRouter: the model menu offers OpenRouter's models. */
  openRouterModels?: boolean;
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
  // "Try this request" in a picture mode's example: that mode, and its request in the box (after
  // what is already typed, on a new line), ready to send or change.
  const tryRequest = (mode: ImageMode, request: string) => {
    if (mode !== p.imageMode) p.onImageMode(mode);
    setText((t) => (t.trim() ? `${t.trimEnd()}\n${request}` : request));
    requestAnimationFrame(() => { const el = textarea.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  };
  // A starter idea: its text goes in the box, replacing what is there when that is empty or still
  // one of the ideas on screen; text the user typed stays, with the idea on a new line.
  const pickStarter = (mode: ImageMode, request: string, onScreen: string[]) => {
    if (mode !== p.imageMode) p.onImageMode(mode);
    setText((t) => (!t.trim() || onScreen.includes(t.trim()) ? request : `${t.trimEnd()}\n${request}`));
    requestAnimationFrame(() => { const el = textarea.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  };
  // Follow new output only while the chat is scrolled to the bottom, so earlier messages can be
  // read while Claude works; a new message (sending one) always scrolls down.
  const atBottom = useRef(true);
  const count = useRef(p.messages.length);
  useEffect(() => {
    const el = scroller.current;
    const added = p.messages.length !== count.current;
    count.current = p.messages.length;
    if (el && (atBottom.current || added)) el.scrollTop = el.scrollHeight;
  }, [p.messages, !!p.autoBuild]);

  // Photos dropped anywhere in the window come here (App forwards them): never let the browser
  // open a dropped file in place of the app.
  useEffect(() => {
    const onFiles = (e: Event) => addFiles((e as CustomEvent<File[]>).detail);
    window.addEventListener('ptp-drop-files', onFiles);
    return () => window.removeEventListener('ptp-drop-files', onFiles);
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
  // On a computer the prompt box is ready to type or paste into as the app opens, or another design does
  // (New, a tab, the Designs menu: their button gives its focus over), unless the user is typing in
  // another field. Not on touch screens, where it would pop up the keyboard.
  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches || window.matchMedia('(max-width: 700px)').matches) return;
    const f = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active?.closest('input, textarea, select, [contenteditable]')) textarea.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(f);
  }, [p.designId]);

  // SVG attachments also bring their exact shapes (keyed by their picture), for Claude's H.svg.
  const [svgShapes, setSvgShapes] = useState<Record<string, SvgDrawing>>({});
  const [attachError, setAttachError] = useState<string | null>(null);
  const [scad, setScad] = useState<ScadFile[]>([]);
  // Mesh files are imported (repaired, stored with the design) as soon as they are attached.
  const [meshes, setMeshes] = useState<{ key: number; name: string; upload?: MeshUpload; error?: string }[]>([]);
  const meshKey = useRef(0);
  // Attachments belong to the design they were added in (a mesh file is stored with it): another
  // design starts with none, and one still reading or uploading when the design changes is dropped.
  // The typed text stays, as it always has (it isn't tied to a design).
  const designId = useRef(p.designId);
  designId.current = p.designId;
  useEffect(() => {
    setImages([]);
    setSvgShapes({});
    setScad([]);
    setMeshes([]);
    setAttachError(null);
  }, [p.designId]);
  const addMeshes = (files: File[]) => {
    const forDesign = p.designId;
    for (const f of files) {
      const key = ++meshKey.current;
      setMeshes((prev) => [...prev, { key, name: f.name }].slice(-4));
      api.uploadMesh(forDesign, f).then(
        (upload) => { if (designId.current === forDesign) setMeshes((prev) => prev.map((m) => (m.key === key ? { ...m, upload } : m))); },
        (e: Error) => { if (designId.current === forDesign) setMeshes((prev) => prev.map((m) => (m.key === key ? { ...m, error: e.message } : m))); },
      );
    }
  };
  const importing = meshes.some((m) => !m.upload && !m.error);
  const readyMeshes = meshes.flatMap((m) => (m.upload ? [m.upload] : []));
  const addFiles = async (files: Iterable<File>) => {
    const forDesign = p.designId;
    const stillHere = () => designId.current === forDesign;
    const all = [...files];
    const imgs = all.filter((f) => f.type.startsWith('image/') || isSvg(f));
    setAttachError(null);
    addMeshes(all.filter((f) => meshFormat(f.name)));
    // OpenSCAD files go to Claude as source (the server renders them with OpenSCAD).
    const scadFiles = all.filter((f) => /\.scad$/i.test(f.name));
    if (scadFiles.length) {
      const read = await Promise.all(scadFiles.map(async (f) => (f.size > MAX_SCAD_CHARS * 4 ? null : { name: scadFileName(f.name), source: await f.text() })));
      const ok = read.filter((f): f is ScadFile => !!f && f.source.length <= MAX_SCAD_CHARS);
      if (!stillHere()) return;
      if (ok.length < scadFiles.length) setAttachError(`OpenSCAD files can be up to ${MAX_SCAD_CHARS.toLocaleString('en')} characters.`);
      setScad((prev) => [...prev.filter((p) => !ok.some((f) => f.name === p.name)), ...ok].slice(0, MAX_SCAD_FILES));
    }
    const added = await Promise.all(imgs.map(async (f) => {
      const url = await prepareImage(f).catch(() => null);
      if (!url) { if (stillHere()) setAttachError(`${f.name} could not be read as a picture.`); return null; }
      if (!isSvg(f)) return { url };
      try {
        return { url, drawing: importSvg(await f.text(), f.name).drawing };
      } catch (e) {
        // Still sent as a picture; Claude just doesn't get the exact shapes.
        if (stillHere()) setAttachError(`${f.name}: ${(e as Error).message} It is attached as a picture only.`);
        return { url };
      }
    }));
    if (!stillHere()) return;
    const ok = added.filter((a): a is { url: string; drawing?: SvgDrawing } => !!a);
    setImages((prev) => [...prev, ...ok.map((a) => a.url)].slice(0, 8));
    setSvgShapes((prev) => ({ ...prev, ...Object.fromEntries(ok.filter((a) => a.drawing).map((a) => [a.url, a.drawing!])) }));
  };

  const hasDraft = !!text.trim() || images.length > 0 || scad.length > 0 || readyMeshes.length > 0;
  // Replies seen generating in this window: only their question cards count down to the suggested picks
  // (one found unanswered after a reload waits for the user).
  const seenLive = useRef(new Set<string>());
  // Typing (or dictating) an answer to the concept pictures stops their countdown.
  useEffect(() => { if (text.trim() && p.autoBuild) p.onStopAutoBuild(); }, [text]);
  const send = (message = text, later = false) => {
    if (p.locked || p.busyElsewhere || p.claudeProblem || importing || (!message.trim() && !images.length && !scad.length && !readyMeshes.length)) return;
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
  // The words come in at the end of the box: keep them in view, with the caret after them. Only text
  // from dictation moves it; typing or scrolling the box otherwise is left alone.
  const followDictation = useRef(false);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!followDictation.current || !el) return;
    followDictation.current = false;
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  }, [text]);
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
        (words) => { spoken.current = prefix + words; followDictation.current = true; setText(spoken.current); },
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
            <p>You get a parametric model with sliders and dimensions. Attach photos of an existing object to recreate or redesign it. Mention any dimensions you need; anything you leave out is picked for you.</p>
            <Starters artworkModel={p.artworkModel} meshy={p.meshy} claudeProblem={p.claudeProblem} onPick={pickStarter} />
          </div>
        )}
        {p.messages.map((m, i) => {
          const live = (p.generating || p.busyElsewhere) && i === p.messages.length - 1;
          if (live) seenLive.current.add(m.id);
          // Only the newest reply's question card can be answered, once it has ended.
          const answerable = !!m.questions && !m.answers && !live && i === p.messages.length - 1;
          return (
            <Message key={m.id} m={m} live={live} versions={p.versions} currentVersion={p.currentVersion} onRestore={p.onRestore} onImage={openLightbox}
              followed={followedMsgs.some((f) => f.id === m.id)} onFollow={(on) => follow(m.id, on)}
              onAnswer={answerable ? (answers) => p.onAnswer(m.id, answers) : undefined} answerBlocked={p.busyElsewhere || !!p.claudeProblem || !!p.locked}
              answerCountdown={seenLive.current.has(m.id)} answerHold={hasDraft} />
          );
        })}
        {p.autoBuild && <AutoBuildCard key={p.autoBuild.messageId} a={p.autoBuild} onBuildNow={p.onBuildNow} onStop={p.onStopAutoBuild} />}
      </div>

      <div className="composer">
        {p.queued.length > 0 && (
          <div className="queued" role="status">
            <div className="queued-head small">
              {p.queuePaused ? 'Not sent, the reply was stopped or failed:' : 'Sends when this reply has finished:'}
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
              <span key={f.name} className="file-chip" title="OpenSCAD file: its source and a render of it are sent">
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
              <div key={i} className={`thumb ${svgShapes[src] ? 'svg' : ''}`} title={svgShapes[src] ? `${svgShapes[src].name}: its exact shapes are sent too` : undefined}>
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
          aria-label={p.hasModel ? 'Ask for changes' : 'Describe the object'}
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
          disabled={!!p.locked}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files); } }}
          rows={3}
        />
        <div className="composer-bar">
          {/* One row at any chat width: the chips shrink to icons in a narrow chat (styles.css); the microphone and send stay at the right. */}
          <div className={`composer-tools ${p.generating && hasDraft ? 'crowded' : ''}`}>
            <button className="icon-btn" title="Attach photos, SVG, OpenSCAD (.scad) or 3D models (STL, 3MF, OBJ, GLB)" aria-label="Attach photos, SVG, OpenSCAD files or 3D models" onClick={() => fileInput.current?.click()}><Icon name="paperclip" /></button>
            <input ref={fileInput} type="file" accept="image/*,.svg,.scad,.stl,.3mf,.obj,.glb,.gltf" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            <ModelMenu model={p.model} effort={p.effort} defaultModel={p.defaultModel} openRouter={!!p.openRouterModels} onModel={p.onModel} onEffort={p.onEffort} />
            {/* 3D figure and Line art modes: the picture mode button with a ▾ for the mode's options
                (the figure's Colour, Wait for my OK and credits; the line art's style). */}
            <span className="mode-split">
              <ImageModeMenu mode={p.imageMode} artworkModel={p.artworkModel} meshy={p.meshy} credits={p.meshyCredits} color={p.figureColor} lineArtStyle={p.lineArtStyle}
                split={(p.imageMode === 'figure' && p.meshy) || p.imageMode === 'lineart'} autoBuild={p.imageMode === 'figure' && p.meshy && !!p.artworkModel && !p.waitForOk} examples={MODE_EXAMPLES} onMode={p.onImageMode} onTryRequest={tryRequest} />
              {p.imageMode === 'figure' && p.meshy && (
                <FigureMenu color={p.figureColor} onColor={p.onFigureColor} waitForOk={p.artworkModel ? p.waitForOk : null} onWaitForOk={p.onWaitForOk} credits={p.meshyCredits} />
              )}
              {p.imageMode === 'lineart' && <LineArtMenu style={p.lineArtStyle} onStyle={p.onLineArtStyle} />}
            </span>
            <OptionsMenu
              onToggle={(key, on) => (key === 'web' ? p.onWebSearch(on) : key === 'ask' ? p.onAskFirst(on) : key === 'image' ? p.onImageTool(on) : key === 'view' ? p.onSendView(on) : p.onSounds(on))}
              options={[
                { key: 'web', label: 'Web search', line: 'Look up real product sizes', on: p.webSearch,
                  title: p.webSearch ? 'Web search is on: exact dimensions of real products are looked up online (click to turn it off for this design, until you reload)' : 'Web search is off for this design: click to search the web for exact dimensions of real products' },
                { key: 'ask', label: 'Ask first', line: 'A few questions when something is unclear', on: p.askFirst,
                  title: p.askFirst
                    ? 'Ask first is on: when your request leaves an important choice open, you get a few short questions (at most 5) before the build; clear requests and small changes are just done. Click to have defaults picked instead.'
                    : 'Ask first is off: no questions, defaults are picked and named. Click to get a few short questions first when something important is unclear.' },
                // Only 3D model mode draws a picture to model from; the picture modes have their own image tools.
                ...(p.artworkModel && p.imageMode === 'off' ? [{ key: 'image' as const, label: 'Image tool', line: 'A picture to model from', on: p.imageTool,
                  title: p.imageTool
                    ? `The image tool is on: the AI can have ${p.artworkModel} draw how the object should look (from your photos or the current model) and model from it, when you ask for a picture or a shape needs one. A few cents a picture. Click to turn it off.`
                    : `The image tool is off: no pictures are drawn, the AI models from your words and photos alone. Click to let it have ${p.artworkModel} draw a picture to model from (a few cents each).` }] : []),
                ...(p.hasModel ? [{ key: 'view' as const, label: 'Send my view', line: 'Your 3D view with each change', on: p.sendView,
                  title: p.sendView
                    ? 'Send my view is on: each change you ask for also sends a screenshot of your 3D view and a four-view render at your settings, so "this" is clear. Click to send only your words (the model can still be rendered on its own).'
                    : 'Send my view is off: only your words are sent (the model can still be rendered on its own). Click to send a screenshot of your 3D view and a four-view render at your settings with each change, so "this" is clear.' }] : []),
                { key: 'sounds', label: 'Sounds', line: 'A chime when you are needed', on: p.sounds,
                  title: p.sounds
                    ? 'Sounds are on: a chime when you are needed (questions to answer, concept pictures to approve, an error) and a softer one when a reply has finished. Click to turn them off.'
                    : 'Sounds are off. Click for a chime when you are needed and when a reply has finished.' },
              ]}
            />
          </div>
          <button
            className={`icon-btn mic ${listening}`}
            aria-label={listening === 'off' ? 'Dictate' : 'Stop dictating'}
            aria-pressed={listening !== 'off'}
            disabled={!p.dictation || listening === 'stopping'}
            title={!p.dictation ? 'Dictation needs an ElevenLabs API key: set ELEVENLABS_API_KEY in .env and restart prompt-to-part'
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
            <button className="icon-btn" onClick={() => void sendNow(true)} disabled={listening === 'starting'} title="Later: send when this reply has finished" aria-label="Send later, when this reply has finished">
              <Icon name="clock" />
            </button>
          )}
          {(!p.generating || hasDraft) && (
            <button className="btn primary" onClick={() => void sendNow()} disabled={!!p.locked || p.busyElsewhere || !!p.claudeProblem || importing || listening === 'starting' || (!text.trim() && !images.length && !scad.length && !readyMeshes.length)}
              title={p.locked ?? (importing ? 'Importing the 3D model…' : p.generating ? 'Send now: read at the next step, while the reply goes on' : p.hasModel ? 'Update' : 'Design')}>
              <Icon name="send" /> <span className="btn-label">{p.generating ? 'Send' : p.hasModel ? 'Update' : 'Design'}</span>
            </button>
          )}
        </div>
        {p.locked && <div className="composer-opts"><span className="busy-note" role="status">{p.locked}, or switch to another version.</span></div>}
        {p.busyElsewhere && <div className="composer-opts"><span className="busy-note" role="status">This design is being worked on in another tab</span></div>}
        {p.claudeProblem && <div className="composer-opts"><span className="bad-note" role="alert">{p.claudeProblem}</span></div>}
        {listening === 'on' && <div className="composer-opts"><span className="listening-note" role="status"><span className="rec-dot" /> Listening… Enter or Esc stops, the text stays</span></div>}
        {dictationError && listening === 'off' && <div className="composer-opts"><span className="bad-note" role="alert">{dictationError}</span> <button className="link" onClick={() => setDictationError(null)}>Dismiss</button></div>}
      </div>
      {followed && (
        <ActivityPanel
          items={followedItems()}
          live={followed.id === liveId}
          error={followed.error}
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
