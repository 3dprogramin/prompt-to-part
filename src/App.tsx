import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, Design, DesignSummary, DimTarget, EvalResult, ParamValue, ParamValues, Quality, SolveResult } from '../shared/types';
import { resolveValues, SCALE_KEY } from '../shared/params';
import { parseTextFeatures, TEXT_KEY, type TextFeature } from '../shared/textFeatures';
import { DRAWINGS_KEY, MAX_DRAWINGS, parseDrawings, parseSvgFeatures, SVG_KEY, type SvgDrawing, type SvgFeature } from '../shared/svgFeatures';
import type { FontEntry } from './lib/api';
import { api, generate, HttpError } from './lib/api';
import { addStep, applyBlock } from './lib/activity';
import { describeSettings, settingsChanged } from './lib/settings';
import { dataUrlToImage, download, slug, uid } from './lib/files';
import { exportParts, type ExportFormat } from './lib/export';
import { GeometryClient } from './geometry/client';
import { ChatPanel } from './components/ChatPanel';
import { ViewerPanel } from './components/ViewerPanel';
import { SidePanel } from './components/SidePanel';
import { Icon } from './components/Icon';
import type { DesignTab } from './components/DesignTabs';
import { TopBar } from './components/TopBar';
import { RestoreDialog } from './components/RestoreDialog';
import { useEscape } from './components/useEscape';
import { useDesignSaving } from './hooks/useDesignSaving';
import { useCrossTabSync } from './hooks/useCrossTabSync';
import { useLiveModel } from './hooks/useLiveModel';
import { STAGE_TEXT, useCost } from './hooks/useCost';
import { load, store } from './lib/storage';
import { tell } from './lib/tabs';
import type { PlaybackStep, ViewerOptions } from './viewer/Viewer';
import { summarize, type ValidationState } from './components/ValidationPanel';
import { exportedParts } from './geometry/validate';
import { pageKey } from '../shared/sources';
import { A1_DEFAULTS, defaultsFromTemplate, effectiveSettings, parseProfile, PRINT_KEY, type PrintProfile, type PrintSettings } from '../shared/print';

const UNTITLED = 'Untitled design';
const geo = new GeometryClient();
interface ChatOptions { model: string; effort: string; webSearch: boolean }
const DEFAULT_CHAT: ChatOptions = { model: 'opus', effort: 'high', webSearch: true };

function newDesign(): Design {
  const now = Date.now();
  return { id: uid(), name: UNTITLED, createdAt: now, updatedAt: now, messages: [], versions: [], currentVersion: -1, code: '', values: {} };
}

export default function App() {
  const [design, setDesign] = useState<Design>(newDesign);
  const currentId = useRef(design.id);
  currentId.current = design.id;
  const [designs, setDesigns] = useState<DesignSummary[]>([]);
  // Generations started in this tab, per design (they keep running when another design is opened).
  const [running, setRunning] = useState<Record<string, AbortController>>({});
  const runningRef = useRef(running);
  runningRef.current = running;
  // The open design as last rendered, for handlers that run later (e.g. after a failed delete).
  const designRef = useRef(design);
  designRef.current = design;
  const { saveNow, saveSoon, saveErrors, clearSaveError, saveTimers, lastLoaded, adopted, stopSaving, cancelPending, isUnsaved } = useDesignSaving({
    setDesign, currentId, runningRef,
    onSaved: (saved) => {
      refreshList();
      // A design kept in memory only because it wasn't saved yet can go now.
      if (saved.id !== currentId.current && !runningRef.current[saved.id] && background.current.get(saved.id) === saved) background.current.delete(saved.id);
    },
    onAdopted: () => setNotice({ text: 'This design was changed in another tab or window – showing the newest version.', level: 'info', details: false }),
    onGone: (id) => forgetDesign(id),
  });
  // Designs generating in other tabs (id → last heartbeat); their saves replace the open copy.
  const remoteRunning = useCrossTabSync(runningRef, (saved) => setDesign((d) => {
    if (d.id !== saved.id || runningRef.current[d.id]) return d;
    // The other tab's copy is newer: an autosave of this one still waiting would undo it.
    cancelPending(d.id);
    lastLoaded.current = saved;
    return saved;
  }), (id) => {
    stopSaving(id);
    forgetDesign(id);
  });
  const generating = !!running[design.id];
  // Designs open as tabs in the top bar (kept across reloads), and those that finished in the background unseen.
  const [tabIds, setTabIds] = useState<string[]>(() => load('designTabs', []));
  useEffect(() => store('designTabs', tabIds), [tabIds]);
  const [unseen, setUnseen] = useState<string[]>([]);
  const hasContent = design.messages.length > 0 || !!design.code;
  useEffect(() => {
    if (hasContent) setTabIds((t) => (t.includes(design.id) ? t : [...t, design.id]));
    setUnseen((u) => (u.includes(design.id) ? u.filter((x) => x !== design.id) : u));
  }, [design.id, hasContent]);
  const busyElsewhere = !generating && remoteRunning[design.id] != null;
  // Collapsible sidebars (Blender-style: T = left, N = right).
  const [leftOpen, setLeftOpen] = useState<boolean>(() => load('leftOpen', true));
  const [rightOpen, setRightOpen] = useState<boolean>(() => load('rightOpen', true));
  useEffect(() => store('leftOpen', leftOpen), [leftOpen]);
  useEffect(() => store('rightOpen', rightOpen), [rightOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if ((t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 't' || e.key === 'T') setLeftOpen((o) => !o);
      if (e.key === 'n' || e.key === 'N') setRightOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Photos dropped anywhere go to the chat; the browser must never open a dropped file in place of
  // Jig (that would also stop a running generation).
  useEffect(() => {
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const onOver = (e: DragEvent) => { if (isFiles(e)) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('jig-drop-files', { detail: [...e.dataTransfer!.files] }));
      setLeftOpen(true);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => { window.removeEventListener('dragover', onOver); window.removeEventListener('drop', onDrop); };
  }, []);
  const [exporting, setExporting] = useState(false);
  const [quality, setQuality] = useState<Quality>(() => load('quality', 'normal'));
  // Model, effort and web search per design, in memory only: every new design (and every reload)
  // starts with Opus, High effort and web search on.
  const [chatOpts, setChatOpts] = useState<Record<string, ChatOptions>>({});
  const chat = chatOpts[design.id] ?? DEFAULT_CHAT;
  const setChat = (patch: Partial<ChatOptions>) => setChatOpts((o) => ({ ...o, [design.id]: { ...(o[design.id] ?? DEFAULT_CHAT), ...patch } }));
  const [viewOpts, setViewOpts] = useState<ViewerOptions>(() => ({
    showBBox: true, showAnnotations: true, showEdges: true, ortho: false, measure: false, hiddenParts: [],
    section: { enabled: false, axis: 'z', position: 0, flip: false },
    ...load<Partial<ViewerOptions>>('viewOpts', {}),
  }));
  const { result, lastGood, error, busy, resultCode } = useLiveModel(geo, design, quality);
  const snapshotRef = useRef<(() => string | null) | null>(null);
  const [playback, setPlayback] = useState<{ result: EvalResult; steps: PlaybackStep[] } | null>(null);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [validation, setValidation] = useState<ValidationState | null>(null);
  const [validationOpen, setValidationOpen] = useState(false);
  const [validating, setValidating] = useState(false);
  type Notice = { text: string; level: 'ok' | 'error' | 'warning' | 'info'; details: boolean };
  const [notice, setNotice] = useState<Notice | null>(null);
  const switchNotice = useRef<Notice | null>(null);
  // In-memory copies of designs that are generating, or not saved yet, while another design is open.
  const background = useRef(new Map<string, Design>());
  const [fonts, setFonts] = useState<FontEntry[]>([]);
  const [blender, setBlender] = useState<{ version: string; problem: string | null } | null>(null);
  const [bambu, setBambu] = useState<string | null>(null);
  const [threeMf, setThreeMf] = useState<{ colours: boolean; print: boolean }>(() => load('threeMf', { colours: true, print: true }));
  useEffect(() => store('threeMf', threeMf), [threeMf]);
  const [exportError, setExportError] = useState<string | null>(null);
  const [dictation, setDictation] = useState(false);
  // The print baseline: the profile in the user's Bambu Studio template (what the 3MF starts from).
  const [printBase, setPrintBase] = useState<Required<PrintSettings>>(A1_DEFAULTS);
  useEffect(() => { api.capabilities().then((c) => { setBlender(c.blender ? { version: c.blender, problem: c.blenderProblem ?? null } : null); setBambu(c.bambu ?? null); setDictation(!!c.speech); if (c.printDefaults) setPrintBase(c.printDefaults); }).catch(() => {}); }, []);
  const [picking, setPicking] = useState<string | null>(null);

  useEffect(() => { api.listFonts().then(setFonts).catch(() => {}); }, []);
  useEscape(!!picking, () => setPicking(null));

  const textFeatures = useMemo(() => parseTextFeatures(design.values[TEXT_KEY]), [design.values]);
  const setTextFeatures = (list: TextFeature[]) => setDesign((d) => {
    const values = { ...d.values };
    if (list.length) values[TEXT_KEY] = JSON.stringify(list); else delete values[TEXT_KEY];
    return { ...d, values, updatedAt: Date.now() };
  });
  const svgFeatures = useMemo(() => parseSvgFeatures(design.values[SVG_KEY]), [design.values]);
  const setSvgFeatures = (list: SvgFeature[]) => setDesign((d) => {
    const values = { ...d.values };
    if (list.length) values[SVG_KEY] = JSON.stringify(list); else delete values[SVG_KEY];
    return { ...d, values, updatedAt: Date.now() };
  });

  const onPickSurface = (hit: { part: string; point: [number, number, number]; normal: [number, number, number] }) => {
    const r = result ?? lastGood;
    const part = r?.parts.find((p) => p.name === hit.part);
    if (!picking || !part) return;
    // Relative to the part without text or SVG, as placeOnSurface maps it back.
    const box = part.textBase ?? part.bbox;
    const anchor = [0, 1, 2].map((k) => {
      const span = box.max[k] - box.min[k];
      return span > 1e-6 ? (hit.point[k] - box.min[k]) / span : 0.5;
    }) as [number, number, number];
    const placed = { face: 'pick' as const, anchor, normal: hit.normal, part: hit.part, offset: [0, 0] as [number, number] };
    if (svgFeatures.some((f) => f.id === picking)) setSvgFeatures(svgFeatures.map((f) => (f.id === picking ? { ...f, ...placed } : f)));
    else setTextFeatures(textFeatures.map((f) => (f.id === picking ? { ...f, ...placed } : f)));
    setPicking(null);
  };
  const loaded = useRef(false);
  // A design named in the URL that couldn't be loaded because the server was down.
  const unreachable = useRef<string | null>(null);

  useEffect(() => store('quality', quality), [quality]);
  useEffect(() => {
    const { showBBox, showAnnotations, showEdges, ortho, colors } = viewOpts;
    store('viewOpts', { showBBox, showAnnotations, showEdges, ortho, colors });
  }, [viewOpts]);

  // Why the design list couldn't be loaded (the server is down), so the menu doesn't claim there are none.
  const [listError, setListError] = useState<string | null>(null);
  const refreshList = useCallback(() => {
    api.listDesigns().then((l) => { setDesigns(l); setListError(null); }, (e: Error) => setListError(e.message));
  }, []);

  /** Apply a change to a design whether it is open (React state) or generating in the background. */
  const updateDesign = useCallback((id: string, fn: (d: Design) => Design) => {
    setDesign((d) => {
      if (d.id === id) return fn(d);
      const bg = background.current.get(id);
      if (bg) {
        const next = fn(bg);
        background.current.set(id, next);
        saveSoon(next);
      }
      return d;
    });
  }, [saveSoon]);

  /** Switch the open design, keeping a still-generating or unsaved one alive in memory. */
  const switchTo = useCallback((next: Design) => {
    setDesign((cur) => {
      if (cur.id === next.id) return cur;
      // An unsaved copy (pending or failed save) is reopened from memory, not reloaded without its changes.
      if (runningRef.current[cur.id] || isUnsaved(cur.id)) background.current.set(cur.id, cur);
      const live = background.current.get(next.id);
      background.current.delete(next.id);
      // A background copy saves itself as it changes; a loaded one is saved already.
      lastLoaded.current = live ?? next;
      return live ?? next;
    });
    setViewOpts((o) => ({ ...o, hiddenParts: [], measure: false }));
  }, []);

  // Open the last design on startup (guarded: hot reload re-runs effects).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      // A bare URL (new tab) starts a fresh design; ?design=<id> reopens that one.
      const last = new URLSearchParams(location.search).get('design');
      if (last) {
        try {
          const d = await api.getDesign(last);
          if (d) { lastLoaded.current = d; setDesign(d); }
        } catch (e) {
          // Keep ?design= so a reload once the server is back opens it again.
          unreachable.current = last;
          setNotice({ text: `${(e as Error).message} Reload this page once it is running.`, level: 'error', details: false });
        }
      }
      loaded.current = true;
      refreshList();
    })();
  }, [refreshList]);

  // Keep the URL pointing at the open design so a reload reopens it.
  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.get('design') === design.id) return;
    if (!design.messages.length && !design.code) {
      if (unreachable.current) return; // the design in the URL couldn't be loaded yet
      url.searchParams.delete('design');
    } else {
      unreachable.current = null;
      url.searchParams.set('design', design.id);
    }
    history.replaceState(null, '', url);
  }, [design.id, design.messages.length, design.code]);

  // Autosave once the design has content. The timer belongs to the design, so opening another
  // design right after a change still saves it.
  useEffect(() => {
    if (!loaded.current || (!design.messages.length && !design.code)) return;
    if (design === lastLoaded.current) return; // as loaded from the server or another tab
    saveSoon(design);
  }, [design, saveSoon]);

  // Name untitled designs after the model.
  useEffect(() => {
    const name = result?.meta.name;
    if (name && design.name === UNTITLED && design.code && resultCode.current === design.code) setDesign((d) => ({ ...d, name }));
  }, [result?.meta.name, design.name, design.code]);

  // Sources of the dimensions the shown version was built around: those of Claude's version it is
  // (or that a manual edit or saved settings were based on).
  const dimensionSources = useMemo(() => {
    for (let i = design.currentVersion; i >= 0; i--) if (design.versions[i]?.source === 'ai') return design.versions[i].sources;
    return undefined;
  }, [design.versions, design.currentVersion]);

  // Re-fit the camera only when a new script version arrives.
  const fitKey = useMemo(() => `${design.id}:${design.currentVersion}:${design.code.length}`, [design.id, design.currentVersion, design.code.length]);

  const onSend = async (text: string, images: string[], attached: SvgDrawing[] = []) => {
    const now = Date.now();
    const userMsg: ChatMessage = { id: uid(), role: 'user', text, images, createdAt: now };
    const asst: ChatMessage = { id: uid(), role: 'assistant', text: '', steps: [], createdAt: now };
    const designId = design.id;
    // For follow-ups, capture exactly what the user is looking at before the chat changes anything.
    const current = followUpContext();
    // Attached SVG drawings are kept with the design, so scripts can use them (H.svg) everywhere.
    const drawings = withDrawings(parseDrawings(design.values[DRAWINGS_KEY]), attached);
    setDesign((d) => ({
      ...d, messages: [...d.messages, userMsg, asst], updatedAt: now,
      values: attached.length ? { ...d.values, [DRAWINGS_KEY]: JSON.stringify(drawings) } : d.values,
    }));
    // Updates always go to the design this generation belongs to, even if another one is open by now.
    const update = (fn: (d: Design) => Design) => updateDesign(designId, fn);
    const patchAsst = (fn: (m: ChatMessage) => ChatMessage) =>
      update((d) => ({ ...d, messages: d.messages.map((m) => (m.id === asst.id ? fn(m) : m)) }));
    const abort = new AbortController();
    setRunning((r) => ({ ...r, [designId]: abort }));
    tell({ type: 'running', id: designId, on: true });
    let finished = false;
    // Messages queued meanwhile go out only after a reply that ended normally.
    let completed = false;
    try {
      await generate({
        designId: design.id,
        prompt: text,
        images: images.map(dataUrlToImage),
        code: design.code || undefined,
        values: (result ?? lastGood) ? resolveValues((result ?? lastGood)!.params, design.values) : undefined,
        textNote: [describeText(textFeatures), describeSvg(svgFeatures)].filter(Boolean).join('; ') || undefined,
        ...current,
        sessionId: design.sessionId,
        model: chat.model,
        effort: chat.effort,
        webSearch: chat.webSearch,
        drawings: Object.keys(drawings).length ? drawings : undefined,
      }, (ev) => {
        if (ev.type === 'session') update((d) => ({ ...d, sessionId: ev.sessionId }));
        else if (ev.type === 'step') patchAsst((m) => ({ ...m, steps: [...(m.steps ?? []), ev.step], activity: addStep(m.activity ?? [], ev.step) }));
        else if (ev.type === 'live') patchAsst((m) => ({ ...m, live: ev.text }));
        else if (ev.type === 'block') patchAsst((m) => ({ ...m, activity: applyBlock(m.activity ?? [], ev) }));
        else if (ev.type === 'model') {
          update((d) => {
            const values = keepAppValues(d.values);
            // A page Claude opened in an earlier generation of this design counts as opened.
            const seen = new Set(d.versions.flatMap((v) => v.sources ?? []).filter((s) => s.opened).map((s) => pageKey(s.url)));
            const sources = (ev.sources ?? []).map((s) => (s.url && !s.opened && seen.has(pageKey(s.url)) ? { ...s, opened: true } : s));
            const versions = [...d.versions, { code: ev.code, summary: ev.summary, createdAt: Date.now(), source: 'ai' as const, values, sources }];
            const vi = versions.length - 1;
            return {
              ...d, versions, currentVersion: vi, code: ev.code, values, updatedAt: Date.now(),
              messages: d.messages.map((m) => (m.id === asst.id ? { ...m, versionIndex: vi } : m)),
            };
          });
          if (currentId.current === designId) setViewOpts((o) => ({ ...o, hiddenParts: [] }));
        } else if (ev.type === 'done') { finished = true; completed = true; patchAsst((m) => ({ ...m, text: ev.text, durationMs: ev.durationMs })); }
        else if (ev.type === 'error') { finished = true; patchAsst((m) => ({ ...m, error: ev.message })); }
      }, abort.signal);
      if (!finished) patchAsst((m) => ({ ...m, error: 'Connection to the server was lost before Claude finished (the server may have restarted). Please send the request again.' }));
    } catch (e) {
      if (!abort.signal.aborted) patchAsst((m) => ({ ...m, error: (e as Error).message }));
      else patchAsst((m) => ({ ...m, error: 'Stopped.' }));
    } finally {
      patchAsst((m) => ({ ...m, live: undefined }));
      // Stopped or failed: messages queued for after this reply wait for the user ("Send now").
      if (!completed) setQueues((s) => (s[designId]?.items.length ? { ...s, [designId]: { ...s[designId], paused: true } } : s));
      setRunning((r) => { const next = { ...r }; delete next[designId]; return next; });
      if (currentId.current !== designId) setUnseen((u) => (u.includes(designId) ? u : [...u, designId]));
      tell({ type: 'running', id: designId, on: false });
      // A design that finished in the background is persisted, then dropped from memory (by
      // onSaved; a failed save keeps it, so "Retry" still has the changes).
      setTimeout(() => {
        const bg = background.current.get(designId);
        if (bg && currentId.current !== designId) {
          clearTimeout(saveTimers.current.get(designId));
          saveNow(bg).catch(() => {});
        }
      }, 0);
    }
  };

  // ---- messages sent while Claude works: queued per design, sent together once the reply is done
  const [queues, setQueues] = useState<Record<string, { items: QueuedMessage[]; paused: boolean }>>({});
  const queue = queues[design.id];
  const enqueue = (text: string, images: string[], drawings: SvgDrawing[]) =>
    setQueues((s) => ({ ...s, [design.id]: { items: [...(s[design.id]?.items ?? []), { text, images, drawings }], paused: false } }));
  const removeQueued = (i: number) => setQueues((s) => {
    const items = (s[design.id]?.items ?? []).filter((_, j) => j !== i);
    const next = { ...s };
    if (items.length) next[design.id] = { ...s[design.id], items }; else delete next[design.id];
    return next;
  });
  const sendQueued = () => {
    const q = queues[design.id];
    if (!q?.items.length) return;
    setQueues((s) => { const next = { ...s }; delete next[design.id]; return next; });
    void onSend(q.items.map((m) => m.text).filter(Boolean).join('\n\n'), q.items.flatMap((m) => m.images).slice(0, 8), q.items.flatMap((m) => m.drawings));
  };
  // When the open design's reply is done (and its new model is on screen), the queue goes out.
  useEffect(() => {
    if (queue?.items.length && !queue.paused && !running[design.id] && remoteRunning[design.id] == null && !busy) sendQueued();
  }, [queue, running, remoteRunning, busy, design.id]);

  const restore = (vi: number) => {
    const v = design.versions[vi];
    if (v) setDesign((d) => ({ ...d, code: v.code, currentVersion: vi, values: { ...v.values }, updatedAt: Date.now() }));
  };
  // Switching versions replaces the sliders with that version's settings: ask first if yours aren't saved.
  const [pendingRestore, setPendingRestore] = useState<number | null>(null);
  const onRestore = (vi: number) => {
    if (vi !== design.currentVersion && unsavedSettings) setPendingRestore(vi);
    else restore(vi);
  };

  const onApplyCode = (code: string) => {
    setDesign((d) => {
      const versions = [...d.versions, { code, summary: 'Manual code edit', createdAt: Date.now(), source: 'manual' as const, values: { ...d.values } }];
      return { ...d, code, versions, currentVersion: versions.length - 1, updatedAt: Date.now() };
    });
  };

  // ---- print settings (AI suggestions in the script, user overrides in $print) ----
  const aiPrint: PrintProfile = (result ?? lastGood)?.print ?? {};
  const userPrint = useMemo(() => parseProfile(design.values[PRINT_KEY]), [design.values]);
  const setUserPrint = (p: PrintProfile) => setDesign((d) => {
    const values = { ...d.values };
    if (Object.keys(p).length) values[PRINT_KEY] = JSON.stringify(p); else delete values[PRINT_KEY];
    return { ...d, values, updatedAt: Date.now() };
  });
  const partNames = (result ?? lastGood)?.parts.map((p) => p.name) ?? [];
  // Number of print settings (as shown in the Print tab) that differ from the profile on any part.
  const printChanges = useMemo(() => {
    const changed = new Set<string>();
    for (const name of partNames.length ? partNames : [undefined]) {
      const eff = effectiveSettings(aiPrint, userPrint, name, printBase);
      for (const k of Object.keys(printBase) as (keyof typeof printBase)[]) if (eff[k] !== printBase[k]) changed.add(k);
    }
    return changed.size;
  }, [aiPrint, userPrint, printBase, partNames.join('\u0000')]);
  /** Which parts will print with supports / an explicit brim (validation takes these into account). */
  const printHints = () => ({
    supportParts: partNames.filter((n) => effectiveSettings(aiPrint, userPrint, n, printBase).supports !== 'off'),
    brimParts: partNames.filter((n) => typeof effectiveSettings(aiPrint, userPrint, n, printBase).brim === 'number'),
  });

  // ---- assembly animation ----
  const shown = result ?? lastGood;

  // ---- saving slider / scale / text / print settings as a version ----
  const unsavedSettings = !!shown && !!design.code && design.versions.length > 0 && !generating
    && settingsChanged(design.versions[design.currentVersion]?.values ?? {}, design.values, shown.params);
  const saveSettings = () => {
    if (!shown) return;
    setDesign((d) => {
      const base = d.versions[d.currentVersion]?.values ?? {};
      const versions = [...d.versions, { code: d.code, summary: describeSettings(base, d.values, shown.params), createdAt: Date.now(), source: 'settings' as const, values: { ...d.values } }];
      return { ...d, versions, currentVersion: versions.length - 1, updatedAt: Date.now() };
    });
  };
  const layoutKey = shown ? Object.entries(shown.params).find(([, d]) => d.type === 'select' && d.options.some((o) => o.value === 'assembled'))?.[0] : undefined;
  const canAssemble = !!layoutKey && !!shown?.assembly.length;
  // The layout option that lays the parts out for printing ('print', or the first that isn't a view).
  const layoutDef = layoutKey ? shown?.params[layoutKey] : undefined;
  const printLayout = layoutDef?.type === 'select'
    ? (layoutDef.options.find((o) => o.value === 'print') ?? layoutDef.options.find((o) => o.value !== 'assembled' && o.value !== 'exploded'))?.value
    : undefined;

  // ---- cost: slice the exported parts in Bambu Studio (the print layout, not an assembled view)
  const cost = useCost(geo, {
    design,
    values: printLayout && layoutKey ? { ...design.values, [layoutKey]: printLayout } : design.values,
    hiddenParts: viewOpts.hiddenParts,
    userPrint,
    onTemplate: (tpl) => setPrintBase(defaultsFromTemplate(tpl.settings)),
  });

  // Any change to the model ends the animation and makes validation results stale.
  useEffect(() => {
    if (design === adopted.current) { adopted.current = null; return; }
    setPlayback(null);
    setValidation(null);
    setValidationOpen(false);
    // A notice about the switch itself (e.g. the design was deleted elsewhere) outlives it.
    setNotice(switchNotice.current);
    switchNotice.current = null;
  }, [design.id, design.code, design.values]);

  // A clean result fades away by itself; problems stay until dismissed.
  useEffect(() => {
    if (!notice || notice.level !== 'ok') return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const layoutValue = layoutKey ? String(design.values[layoutKey] ?? shown?.values[layoutKey] ?? '') : undefined;

  const onValidate = async () => {
    if (!design.code || !shown) return;
    setValidating(true);
    try {
      const o = await geo.evaluate(design.code, fullValues(), 'high', { validate: { layoutValue, exclude: viewOpts.hiddenParts, ...printHints() } });
      if (!o.report || !o.result) { setNotice({ text: `Validation failed: ${o.error?.message ?? 'no result'}`, level: 'error', details: false }); return; }
      setValidation({ report: o.report, label: 'Validation' });
      setValidationOpen(true);
      setNotice(null);
    } finally {
      setValidating(false);
    }
  };

  const startAssembly = async () => {
    if (!layoutKey || !shown) return;
    setPlaybackLoading(true);
    try {
      const base: ParamValues = fullValues();
      const a = await geo.evaluate(design.code, { ...base, [layoutKey]: 'assembled' }, quality, { display: true });
      if (!a.result || !a.result.assembly.length) return;
      const def = shown.params[layoutKey];
      const hasExploded = def.type === 'select' && def.options.some((o) => o.value === 'exploded');
      const e = hasExploded ? (await geo.evaluate(design.code, { ...base, [layoutKey]: 'exploded' }, quality)).result : undefined;
      const center = (b: { min: number[]; max: number[] }) => [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
      const size = a.result.bbox ? Math.max(...[0, 1, 2].map((k) => a.result!.bbox!.max[k] - a.result!.bbox!.min[k])) : 50;
      const steps: PlaybackStep[] = a.result.assembly.map((st) => ({
        label: st.label,
        parts: st.parts.map((name) => {
          let from = st.from;
          if (!from) {
            const pa = a.result!.parts.find((p) => p.name === name);
            const pe = e?.parts.find((p) => p.name === name);
            if (pa && pe) {
              const ca = center(pa.bbox), ce = center(pe.bbox);
              from = [ce[0] - ca[0], ce[1] - ca[1], ce[2] - ca[2]];
            }
            if (!from || Math.hypot(...from) < 1e-3) from = [0, 0, size * 0.6];
          }
          return { name, from, rotate: st.rotate };
        }),
      }));
      setPlayback({ result: a.result, steps });
    } finally {
      setPlaybackLoading(false);
    }
  };

  /** What Claude needs to see the model exactly as the user does (follow-ups only). */
  const followUpContext = () => {
    if (!design.code || !(result ?? lastGood)) return {};
    let currentView: { mediaType: string; data: string } | undefined;
    try {
      const shot = snapshotRef.current?.();
      if (shot) currentView = dataUrlToImage(shot);
    } catch { /* screenshot is optional */ }
    const renderValues: ParamValues = fullValues();
    const scale = Number(design.values[SCALE_KEY] ?? 1);
    const latest = design.versions.length - 1;
    const cur = design.versions[design.currentVersion];
    const versionNote = design.currentVersion >= 0 && design.currentVersion < latest
      ? `The user restored version ${design.currentVersion + 1} of ${latest + 1} ("${cur.summary}"). The current script is that version, not your latest one – work from it.`
      : cur?.source === 'manual' ? 'The user edited the script by hand after your last version – keep their edits.' : undefined;
    return { currentView, renderValues, scale: scale !== 1 ? scale : undefined, versionNote };
  };

  /**
   * Everything needed to rebuild the model as the user has set it: the sliders as they are now
   * (not as last evaluated – a slow preview may still be running), uniform scale and text-tool text.
   */
  // The runtime resolves values against the script it actually runs (defaults for anything new),
  // so they are passed as they are, not resolved against a preview that may be of older code.
  const fullValues = (): ParamValues => ({ ...design.values });

  const onEditDimension = async (target: DimTarget, goal: number): Promise<SolveResult | null> => {
    if (!design.code || !(result ?? lastGood)) return null;
    const r = await geo.solve(design.code, fullValues(), quality, target, goal);
    if (r.ok && r.key && r.value != null) {
      const v = +r.value.toFixed(4);
      setDesign((d) => ({ ...d, values: { ...d.values, [r.key!]: v } }));
    }
    return r;
  };

  const onScale = (factor: number) => setDesign((d) => {
    const values = { ...d.values };
    if (Math.abs(factor - 1) < 1e-9) delete values[SCALE_KEY]; else values[SCALE_KEY] = factor;
    return { ...d, values };
  });

  const onValue = (key: string, v: ParamValue) => setDesign((d) => ({ ...d, values: { ...d.values, [key]: v } }));

  const onExport = async (format: ExportFormat, partName?: string) => {
    if (!design.code) return;
    setExporting(true);
    setExportError(null);
    try {
      // Re-evaluate at high resolution for the exported mesh, and validate exactly that mesh (only
      // the parts being exported). If that fails, nothing is exported: the preview mesh is coarser
      // or may be from other settings, and the file would not be what the user expects.
      const choice = { exclude: viewOpts.hiddenParts, only: partName };
      const o = await geo.evaluate(design.code, fullValues(), 'high', { validate: { layoutValue, ...choice, ...printHints() } });
      if (!o.result) {
        setNotice({ text: `Not exported: the high-resolution model failed – ${o.error.message}${o.error.line ? ` (line ${o.error.line})` : ''}`, level: 'error', details: false });
        return;
      }
      const r = o.result;
      const parts = exportedParts(r, choice);
      if (!parts.length) {
        setNotice({ text: partName ? `Not exported: the model has no part "${partName}" any more.` : 'Not exported: every part is hidden in the viewer.', level: 'warning', details: false });
        return;
      }
      const name = slug(r.meta.name || design.name) + (partName ? `-${slug(partName)}` : '');
      const file = `${name}.${format}`;
      const blob = await exportParts(format, r, parts, r.meta.name || design.name, design.code, {
        colours: threeMf.colours,
        print: threeMf.print && bambu ? { ai: r.print, user: userPrint } : null,
        // The template's profile becomes the baseline shown in the Print tab.
        onTemplate: (tpl) => setPrintBase(defaultsFromTemplate(tpl.settings)),
      });
      download(blob, file); // always export – problems are reported, not blocking
      if (o.report) {
        const report = o.report;
        const sum = summarize(report.issues);
        setValidation({ report, label: `Exported ${file}` });
        setValidationOpen(false);
        setNotice(sum.level === 'ok'
          ? { text: `Exported ${file} · checked, no problems found`, level: 'ok', details: true }
          : { text: `Exported ${file} · ${sum.text} found`, level: sum.level === 'error' ? 'error' : 'warning', details: true });
      } else {
        setNotice({ text: `Exported ${file} · could not validate`, level: 'warning', details: false });
      }
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const openDesign = async (id: string) => {
    if (id === design.id) return;
    try {
      const d = background.current.get(id) ?? (await api.getDesign(id));
      if (d) switchTo(d);
      else { setNotice({ text: 'That design no longer exists.', level: 'warning', details: false }); refreshList(); }
    } catch (e) {
      setNotice({ text: `Could not open the design: ${(e as Error).message}`, level: 'error', details: false });
    }
  };

  const createNew = () => switchTo(newDesign());

  /**
   * A new design from one version: its script and settings (text, SVG, print, attached drawings)
   * as v1, with an empty chat and its own Claude session. The original design is unchanged.
   */
  const forkVersion = (vi: number) => {
    const v = design.versions[vi];
    if (!v) return;
    const values: ParamValues = { ...v.values };
    // Drawings attached later in the chat may be what this version's script uses.
    if (!values[DRAWINGS_KEY] && design.values[DRAWINGS_KEY]) values[DRAWINGS_KEY] = design.values[DRAWINGS_KEY];
    const d = newDesign();
    const forked: Design = {
      ...d,
      name: `${design.name} (from v${vi + 1})`,
      code: v.code,
      values,
      versions: [{ ...v, values, summary: `From "${design.name}" v${vi + 1}: ${v.summary}`, createdAt: d.createdAt }],
      currentVersion: 0,
    };
    switchTo(forked);
    // Opened designs count as saved (switchTo); this one is new, so save it now.
    saveSoon(forked);
  };

  // The open design always has a tab (an empty new one only until another is opened).
  const designTabs: DesignTab[] = [...tabIds, ...(tabIds.includes(design.id) ? [] : [design.id])].flatMap((id) => {
    const name = id === design.id ? design.name : background.current.get(id)?.name ?? designs.find((d) => d.id === id)?.name;
    return name == null ? [] : [{ id, name, running: !!running[id] || remoteRunning[id] != null, unseen: unseen.includes(id) }];
  });

  // Forget tabs of designs that no longer exist (deleted, e.g. in another browser tab).
  useEffect(() => {
    if (!designs.length) return;
    setTabIds((t) => {
      const kept = t.filter((id) => id === currentId.current || runningRef.current[id] || designs.some((d) => d.id === id));
      return kept.length === t.length ? t : kept;
    });
  }, [designs]);

  const closeTab = (id: string) => {
    setTabIds((t) => t.filter((x) => x !== id));
    if (id !== design.id) return;
    const ids = designTabs.map((t) => t.id);
    const i = ids.indexOf(id);
    const next = ids[i + 1] ?? ids[i - 1];
    if (next) openDesign(next); else createNew();
  };

  /** Close every tab except designs Claude is working on; a closed open design becomes a new one. */
  const closeAllTabs = () => {
    const busy = (id: string) => !!running[id] || remoteRunning[id] != null;
    setTabIds((t) => t.filter(busy));
    if (!busy(design.id)) createNew();
  };

  const deletingHere = useRef(new Set<string>());
  const deleteDesign = async (id: string) => {
    if (!confirm('Delete this design permanently?')) return;
    deletingHere.current.add(id);
    const saving = stopSaving(id);
    try {
      // The server refuses to delete a design Claude is working on: stop it and wait until it has.
      running[id]?.abort();
      for (let tries = 0; ; tries++) {
        try {
          await api.deleteDesign(id);
          break;
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 409 && running[id] && tries < 40)) throw e;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } catch (e) {
      saving.undo();
      // The latest copy: a generation stopped for the delete may have changed it since the click.
      const copy = background.current.get(id) ?? (designRef.current.id === id ? designRef.current : null);
      if (copy) saveSoon(copy);
      deletingHere.current.delete(id);
      setNotice({ text: `Could not delete the design: ${(e as Error).message}`, level: 'error', details: false });
      return;
    }
    tell({ type: 'deleted', id });
    forgetDesign(id);
  };

  /** Drop a deleted design from memory and the tabs; the open one is replaced by a new design. */
  function forgetDesign(id: string) {
    background.current.delete(id);
    clearSaveError(id);
    setTabIds((t) => t.filter((x) => x !== id));
    setUnseen((u) => u.filter((x) => x !== id));
    if (currentId.current === id) {
      const name = designRef.current.name;
      createNew();
      // Not after our own delete: only when it happened elsewhere.
      if (!deletingHere.current.has(id)) switchNotice.current = { text: `"${name}" was deleted in another tab or window.`, level: 'info', details: false };
    }
    deletingHere.current.delete(id);
    refreshList();
  }

  return (
    <div className="app">
      <TopBar
        design={design}
        onRename={(name) => setDesign((d) => ({ ...d, name }))}
        onRestore={onRestore}
        onFork={forkVersion}
        unsavedSettings={unsavedSettings}
        onSaveSettings={saveSettings}
        saveError={saveErrors[design.id]}
        onRetrySave={() => saveNow(design).catch(() => {})}
        tabs={designTabs}
        onOpen={openDesign}
        onCloseTab={closeTab}
        onCloseAllTabs={closeAllTabs}
        onNew={createNew}
        designs={designs}
        listError={listError}
        onRefreshList={refreshList}
        isRunning={(id) => !!running[id] || remoteRunning[id] != null}
        onDelete={deleteDesign}
      />
      <main className={`workspace ${leftOpen ? '' : 'left-closed'} ${rightOpen ? '' : 'right-closed'}`}>
        <ChatPanel
          designId={design.id}
          messages={design.messages}
          versions={design.versions}
          currentVersion={design.currentVersion}
          generating={generating}
          busyElsewhere={busyElsewhere}
          onSend={onSend}
          onStop={() => running[design.id]?.abort()}
          queued={queue?.items ?? []}
          queuePaused={!!queue?.paused}
          onQueue={enqueue}
          onRemoveQueued={removeQueued}
          onSendQueued={sendQueued}
          onRestore={onRestore}
          model={chat.model} onModel={(model) => setChat({ model })}
          effort={chat.effort} onEffort={(effort) => setChat({ effort })}
          webSearch={chat.webSearch}
          onWebSearch={(webSearch) => setChat({ webSearch })}
          hasModel={!!design.code}
          dictation={dictation}
        />
        <ViewerPanel
          costStatus={cost.running && { text: STAGE_TEXT[cost.running.stage], since: cost.running.since }}
          result={playback ? playback.result : result ?? lastGood}
          error={error}
          busy={busy}
          fitKey={fitKey}
          options={picking ? { ...viewOpts, pickText: true, measure: false } : viewOpts}
          onOptions={setViewOpts}
          quality={quality}
          onQuality={setQuality}
          onEditDimension={onEditDimension}
          onPickSurface={onPickSurface}
          snapshotRef={snapshotRef}
          canAssemble={canAssemble}
          assembly={playback?.steps ?? null}
          assemblyLoading={playbackLoading}
          onAssemble={startAssembly}
          onAssemblyClose={() => setPlayback(null)}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          onToggleLeft={() => setLeftOpen((o) => !o)}
          onToggleRight={() => setRightOpen((o) => !o)}
          validation={validation}
          validationOpen={validationOpen}
          onValidationClose={() => setValidationOpen(false)}
          notice={notice}
          onNoticeDetails={() => { setValidationOpen(true); setNotice(null); }}
          onNoticeClose={() => setNotice(null)}
          layout={layoutKey && shown && shown.params[layoutKey].type === 'select' ? {
            value: String(design.values[layoutKey] ?? shown.values[layoutKey]),
            options: (shown.params[layoutKey] as { options: { value: string; label: string }[] }).options,
          } : null}
          onLayout={(v) => layoutKey && onValue(layoutKey, v)}
          emptyState={generating
            ? <div className="empty-inner"><span className="spinner big" /><p>Claude is designing your model…</p></div>
            : <div className="empty-inner"><Icon name="cube" size={44} /><p>Describe an object or drop reference photos in the chat to start.</p></div>}
        />
        <SidePanel
          designId={design.id}
          designName={design.name}
          summary={design.versions[design.currentVersion]?.summary}
          cost={cost}
          sources={dimensionSources}
          result={result}
          lastGood={lastGood}
          error={error}
          code={design.code}
          onValue={onValue}
          onResetValues={() => setDesign((d) => ({ ...d, values: keepAppValues(d.values) }))}
          onEditDimension={onEditDimension}
          textFeatures={textFeatures}
          onTextFeatures={setTextFeatures}
          svgFeatures={svgFeatures}
          onSvgFeatures={setSvgFeatures}
          fonts={fonts}
          picking={picking}
          onPick={setPicking}
          scale={Number(design.values[SCALE_KEY] ?? 1)}
          onScale={onScale}
          onApplyCode={onApplyCode}
          onExport={onExport}
          exporting={exporting}
          exportError={exportError}
          onValidate={onValidate}
          validating={validating}
          aiPrint={aiPrint}
          userPrint={userPrint}
          printBase={printBase}
          onUserPrint={setUserPrint}
          bambu={bambu}
          printChanges={printChanges}
          threeMf={threeMf}
          onThreeMf={setThreeMf}
          onExport3mf={() => onExport('3mf')}
          blender={blender}
          hiddenParts={viewOpts.hiddenParts}
          onToggleHidden={(n) => setViewOpts((o) => ({ ...o, hiddenParts: o.hiddenParts.includes(n) ? o.hiddenParts.filter((x) => x !== n) : [...o.hiddenParts, n] }))}
          onHiddenParts={(hiddenParts) => setViewOpts((o) => ({ ...o, hiddenParts }))}
        />
      </main>
      {pendingRestore != null && (
        <RestoreDialog
          target={pendingRestore}
          nextVersion={design.versions.length + 1}
          onCancel={() => setPendingRestore(null)}
          onDiscard={() => { restore(pendingRestore); setPendingRestore(null); }}
          onSaveAndSwitch={() => { saveSettings(); restore(pendingRestore); setPendingRestore(null); }}
        />
      )}
    </div>
  );
}

/** Values owned by the app rather than the script ($scale, $text, $print) survive resets and new AI versions. */
function keepAppValues(values: ParamValues): ParamValues {
  return Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith('$')));
}

/** A message written while Claude was working, sent after its reply. */
interface QueuedMessage { text: string; images: string[]; drawings: SvgDrawing[] }

/** `known` plus newly attached drawings; a different drawing with a name in use gets "-2", "-3"… */
function withDrawings(known: Record<string, SvgDrawing>, attached: SvgDrawing[]): Record<string, SvgDrawing> {
  const out = { ...known };
  for (const d of attached) {
    let name = d.name, n = 2;
    while (out[name] && JSON.stringify(out[name].shapes) !== JSON.stringify(d.shapes)) name = d.name.replace(/(\.svg)?$/i, `-${n++}$1`);
    out[name] = { ...d, name };
  }
  // The newest ones are kept when there are too many.
  return Object.fromEntries(Object.entries(out).slice(-MAX_DRAWINGS));
}

function describeSvg(features: SvgFeature[]): string | undefined {
  const on = features.filter((f) => f.enabled);
  if (!on.length) return undefined;
  return on.map((f) => `SVG drawing "${f.drawing.name}" ${f.mode === 'emboss' ? 'raised' : 'engraved'} ${f.depth} mm, ${f.size} × ${(f.size * f.drawing.aspect).toFixed(1)} mm (height × width), on the ${f.face === 'pick' ? 'picked surface' : f.face} of part "${f.part ?? 'first part'}"${f.curve === 'wrap' ? ', wrapped' : ''}`).join('; ');
}

function describeText(features: TextFeature[]): string | undefined {
  const on = features.filter((f) => f.enabled && f.text.trim());
  if (!on.length) return undefined;
  return on.map((f) => `"${f.text.replace(/\n/g, ' / ')}" ${f.mode === 'emboss' ? 'raised' : 'engraved'} ${f.depth} mm, ${f.size} mm letters, on the ${f.face === 'pick' ? 'picked surface' : f.face} of part "${f.part ?? 'first part'}"${f.curve !== 'none' ? `, ${f.curve}` : ''}`).join('; ');
}
