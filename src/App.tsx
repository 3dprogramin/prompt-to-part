import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, Design, DesignSummary, DimTarget, EvalResult, ParamValue, ParamValues, Quality, ScriptErrorInfo, SolveResult } from '../shared/types';
import { SCALE_KEY } from '../shared/runtime';
import { parseTextFeatures, TEXT_KEY, type TextFeature } from '../shared/textFeatures';
import type { FontEntry } from './lib/api';
import { api, generate } from './lib/api';
import { dataUrlToImage, download, slug, uid } from './lib/files';
import { exportParts, type ExportFormat } from './lib/export';
import { GeometryClient } from './geometry/client';
import { ChatPanel } from './components/ChatPanel';
import { ViewerPanel } from './components/ViewerPanel';
import { SidePanel } from './components/SidePanel';
import { Icon } from './components/Icon';
import { DesignTabs, type DesignTab } from './components/DesignTabs';
import { VersionMenu } from './components/VersionMenu';
import type { PlaybackStep, ViewerOptions } from './viewer/Viewer';
import { summarize, type ValidationState } from './components/ValidationPanel';
import type { ValidationReport } from './geometry/validate';
import { A1_DEFAULTS, effectiveSettings, parseProfile, PRINT_KEY, type PrintProfile } from '../shared/print';

const UNTITLED = 'Untitled design';
const geo = new GeometryClient();
const TAB_ID = uid();
const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ai-designer') : null;
type TabMessage =
  | { type: 'saved'; tab: string; design: Design }
  | { type: 'running'; tab: string; id: string; on: boolean }
  | { type: 'hello'; tab: string };

function newDesign(): Design {
  const now = Date.now();
  return { id: uid(), name: UNTITLED, createdAt: now, updatedAt: now, messages: [], versions: [], currentVersion: -1, code: '', values: {} };
}

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function store(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
}

export default function App() {
  const [design, setDesign] = useState<Design>(newDesign);
  const currentId = useRef(design.id);
  currentId.current = design.id;
  const [designs, setDesigns] = useState<DesignSummary[]>([]);
  const [showList, setShowList] = useState(false);
  const [result, setResult] = useState<EvalResult | null>(null);
  const [lastGood, setLastGood] = useState<EvalResult | null>(null);
  const [error, setError] = useState<ScriptErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // Generations started in this tab, per design (they keep running when another design is opened).
  const [running, setRunning] = useState<Record<string, AbortController>>({});
  const runningRef = useRef(running);
  runningRef.current = running;
  // Designs generating in other tabs (id → last heartbeat).
  const [remoteRunning, setRemoteRunning] = useState<Record<string, number>>({});
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
  const [verbose, setVerbose] = useState<boolean>(() => load('verbose', true));
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
  const [exporting, setExporting] = useState(false);
  const [quality, setQuality] = useState<Quality>(() => load('quality', 'normal'));
  const [model, setModel] = useState(() => load('model', 'opus'));
  const [effort, setEffort] = useState(() => load('effort', 'high'));
  const [viewOpts, setViewOpts] = useState<ViewerOptions>(() => ({
    showBBox: true, showAnnotations: true, showEdges: true, ortho: false, measure: false, hiddenParts: [],
    section: { enabled: false, axis: 'z', position: 0, flip: false },
    ...load<Partial<ViewerOptions>>('viewOpts', {}),
  }));
  const resultCode = useRef('');
  const snapshotRef = useRef<(() => string | null) | null>(null);
  const [playback, setPlayback] = useState<{ result: EvalResult; steps: PlaybackStep[] } | null>(null);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [validation, setValidation] = useState<ValidationState | null>(null);
  const [validationOpen, setValidationOpen] = useState(false);
  const [validating, setValidating] = useState(false);
  const [notice, setNotice] = useState<{ text: string; level: 'ok' | 'error' | 'warning' | 'info'; details: boolean } | null>(null);
  // In-memory copies of designs that are generating while another design is open.
  const background = useRef(new Map<string, Design>());
  const lastRemote = useRef<Design | null>(null);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [fonts, setFonts] = useState<FontEntry[]>([]);
  const [blender, setBlender] = useState<string | null>(null);
  const [bambu, setBambu] = useState<string | null>(null);
  const [threeMf, setThreeMf] = useState<{ colours: boolean; print: boolean }>(() => load('threeMf', { colours: true, print: true }));
  useEffect(() => store('threeMf', threeMf), [threeMf]);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => { fetch('/api/capabilities').then((r) => r.json()).then((c) => { setBlender(c.blender ?? null); setBambu(c.bambu ?? null); }).catch(() => {}); }, []);
  const [picking, setPicking] = useState<string | null>(null);

  useEffect(() => { api.listFonts().then(setFonts).catch(() => {}); }, []);
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicking(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking]);

  const textFeatures = useMemo(() => parseTextFeatures(design.values[TEXT_KEY]), [design.values]);
  const setTextFeatures = (list: TextFeature[]) => setDesign((d) => {
    const values = { ...d.values };
    if (list.length) values[TEXT_KEY] = JSON.stringify(list); else delete values[TEXT_KEY];
    return { ...d, values, updatedAt: Date.now() };
  });

  const onPickSurface = (hit: { part: string; point: [number, number, number]; normal: [number, number, number] }) => {
    const r = result ?? lastGood;
    const part = r?.parts.find((p) => p.name === hit.part);
    if (!picking || !part) return;
    const anchor = [0, 1, 2].map((k) => {
      const span = part.bbox.max[k] - part.bbox.min[k];
      return span > 1e-6 ? (hit.point[k] - part.bbox.min[k]) / span : 0.5;
    }) as [number, number, number];
    setTextFeatures(textFeatures.map((f) => (f.id === picking ? { ...f, face: 'pick', anchor, normal: hit.normal, part: hit.part, offset: [0, 0] } : f)));
    setPicking(null);
  };
  const loaded = useRef(false);

  useEffect(() => store('quality', quality), [quality]);
  useEffect(() => store('model', model), [model]);
  useEffect(() => store('effort', effort), [effort]);
  useEffect(() => store('verbose', verbose), [verbose]);
  useEffect(() => {
    const { showBBox, showAnnotations, showEdges, ortho, colors } = viewOpts;
    store('viewOpts', { showBBox, showAnnotations, showEdges, ortho, colors });
  }, [viewOpts]);

  const refreshList = useCallback(() => { api.listDesigns().then(setDesigns).catch(() => {}); }, []);

  const saveNow = useCallback(async (d: Design) => {
    await api.saveDesign(d);
    channel?.postMessage({ type: 'saved', tab: TAB_ID, design: d } satisfies TabMessage);
    refreshList();
  }, [refreshList]);

  const saveSoon = useCallback((d: Design) => {
    const timers = saveTimers.current;
    clearTimeout(timers.get(d.id));
    timers.set(d.id, setTimeout(() => { timers.delete(d.id); saveNow(d).catch(() => {}); }, 600));
  }, [saveNow]);

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

  /** Switch the open design, keeping a still-generating one alive in memory. */
  const switchTo = useCallback((next: Design) => {
    setDesign((cur) => {
      if (cur.id === next.id) return cur;
      if (runningRef.current[cur.id]) background.current.set(cur.id, cur);
      const live = background.current.get(next.id);
      background.current.delete(next.id);
      return live ?? next;
    });
    setViewOpts((o) => ({ ...o, hiddenParts: [], measure: false }));
  }, []);

  // Cross-tab sync: other tabs' saves and generation status.
  useEffect(() => {
    if (!channel) return;
    const onMsg = (ev: MessageEvent<TabMessage>) => {
      const m = ev.data;
      if (!m || m.tab === TAB_ID) return;
      if (m.type === 'hello') {
        for (const id of Object.keys(runningRef.current)) channel.postMessage({ type: 'running', tab: TAB_ID, id, on: true } satisfies TabMessage);
      } else if (m.type === 'running') {
        setRemoteRunning((r) => {
          const next = { ...r };
          if (m.on) next[m.id] = Date.now(); else delete next[m.id];
          return next;
        });
      } else if (m.type === 'saved') {
        setDesign((d) => {
          if (d.id !== m.design.id || runningRef.current[d.id]) return d;
          lastRemote.current = m.design;
          return m.design;
        });
      }
    };
    channel.addEventListener('message', onMsg);
    channel.postMessage({ type: 'hello', tab: TAB_ID } satisfies TabMessage);
    // Heartbeat our generations; forget other tabs' that went quiet (tab closed).
    const beat = setInterval(() => {
      for (const id of Object.keys(runningRef.current)) channel.postMessage({ type: 'running', tab: TAB_ID, id, on: true } satisfies TabMessage);
      setRemoteRunning((r) => {
        const now = Date.now();
        const stale = Object.entries(r).filter(([, t]) => now - t > 12000);
        if (!stale.length) return r;
        const next = { ...r };
        for (const [id] of stale) delete next[id];
        return next;
      });
    }, 4000);
    return () => { channel.removeEventListener('message', onMsg); clearInterval(beat); };
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
        const d = await api.getDesign(last).catch(() => null);
        if (d) setDesign(d);
      }
      loaded.current = true;
      refreshList();
    })();
  }, [refreshList]);

  // Keep the URL pointing at the open design so a reload reopens it.
  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.get('design') === design.id) return;
    if (!design.messages.length && !design.code) url.searchParams.delete('design');
    else url.searchParams.set('design', design.id);
    history.replaceState(null, '', url);
  }, [design.id, design.messages.length, design.code]);

  // Autosave (debounced) once the design has content.
  useEffect(() => {
    if (!loaded.current || (!design.messages.length && !design.code)) return;
    if (design === lastRemote.current) return; // came from another tab – already saved there
    const t = setTimeout(() => { saveNow(design).catch(() => {}); }, 600);
    return () => clearTimeout(t);
  }, [design, saveNow]);

  // Live evaluation whenever code, values or quality change.
  useEffect(() => {
    if (!design.code.trim()) { resultCode.current = ''; setResult(null); setLastGood(null); setError(null); return; }
    let cancelled = false;
    setBusy(true);
    geo.preview(design.code, design.values, quality).then((o) => {
      if (cancelled || !o) return;
      setBusy(false);
      if (o.result) { resultCode.current = design.code; setResult(o.result); setLastGood(o.result); setError(null); }
      else { setError(o.error); setResult(null); }
    });
    return () => { cancelled = true; };
  }, [design.code, design.values, quality]);

  // Name untitled designs after the model.
  useEffect(() => {
    const name = result?.meta.name;
    if (name && design.name === UNTITLED && design.code && resultCode.current === design.code) setDesign((d) => ({ ...d, name }));
  }, [result?.meta.name, design.name, design.code]);

  // Re-fit the camera only when a new script version arrives.
  const fitKey = useMemo(() => `${design.id}:${design.currentVersion}:${design.code.length}`, [design.id, design.currentVersion, design.code.length]);

  const onSend = async (text: string, images: string[]) => {
    const now = Date.now();
    const userMsg: ChatMessage = { id: uid(), role: 'user', text, images, createdAt: now };
    const asst: ChatMessage = { id: uid(), role: 'assistant', text: '', steps: [], createdAt: now };
    const designId = design.id;
    // For follow-ups, capture exactly what the user is looking at before the chat changes anything.
    const current = followUpContext();
    setDesign((d) => ({ ...d, messages: [...d.messages, userMsg, asst], updatedAt: now }));
    // Updates always go to the design this generation belongs to, even if another one is open by now.
    const update = (fn: (d: Design) => Design) => updateDesign(designId, fn);
    const patchAsst = (fn: (m: ChatMessage) => ChatMessage) =>
      update((d) => ({ ...d, messages: d.messages.map((m) => (m.id === asst.id ? fn(m) : m)) }));
    const abort = new AbortController();
    setRunning((r) => ({ ...r, [designId]: abort }));
    channel?.postMessage({ type: 'running', tab: TAB_ID, id: designId, on: true } satisfies TabMessage);
    let finished = false;
    try {
      await generate({
        designId: design.id,
        prompt: text,
        images: images.map(dataUrlToImage),
        code: design.code || undefined,
        values: (result ?? lastGood)?.values,
        textNote: describeText(textFeatures),
        ...current,
        sessionId: design.sessionId,
        model,
        effort,
      }, (ev) => {
        if (ev.type === 'session') update((d) => ({ ...d, sessionId: ev.sessionId }));
        else if (ev.type === 'step') patchAsst((m) => ({ ...m, steps: [...(m.steps ?? []), ev.step], thinking: ev.step.kind === 'thinking' ? undefined : m.thinking }));
        else if (ev.type === 'live') patchAsst((m) => ({ ...m, live: ev.text }));
        else if (ev.type === 'thinking') patchAsst((m) => ({ ...m, thinking: (m.thinking ?? '') + ev.delta }));
        else if (ev.type === 'model') {
          update((d) => {
            const versions = [...d.versions, { code: ev.code, summary: ev.summary, createdAt: Date.now(), source: 'ai' as const }];
            const vi = versions.length - 1;
            return {
              ...d, versions, currentVersion: vi, code: ev.code, values: keepAppValues(d.values), updatedAt: Date.now(),
              messages: d.messages.map((m) => (m.id === asst.id ? { ...m, versionIndex: vi } : m)),
            };
          });
          if (currentId.current === designId) setViewOpts((o) => ({ ...o, hiddenParts: [] }));
        } else if (ev.type === 'done') { finished = true; patchAsst((m) => ({ ...m, text: ev.text, durationMs: ev.durationMs })); }
        else if (ev.type === 'error') { finished = true; patchAsst((m) => ({ ...m, error: ev.message })); }
      }, abort.signal);
      if (!finished) patchAsst((m) => ({ ...m, error: 'Connection to the server was lost before Claude finished (the server may have restarted). Please send the request again.' }));
    } catch (e) {
      if (!abort.signal.aborted) patchAsst((m) => ({ ...m, error: (e as Error).message }));
      else patchAsst((m) => ({ ...m, error: 'Stopped.' }));
    } finally {
      patchAsst((m) => ({ ...m, live: undefined, thinking: undefined }));
      setRunning((r) => { const next = { ...r }; delete next[designId]; return next; });
      if (currentId.current !== designId) setUnseen((u) => (u.includes(designId) ? u : [...u, designId]));
      channel?.postMessage({ type: 'running', tab: TAB_ID, id: designId, on: false } satisfies TabMessage);
      // A design that finished in the background is persisted, then dropped from memory.
      setTimeout(() => {
        const bg = background.current.get(designId);
        if (bg && currentId.current !== designId) {
          clearTimeout(saveTimers.current.get(designId));
          saveNow(bg).finally(() => { if (currentId.current !== designId) background.current.delete(designId); });
        }
      }, 0);
    }
  };

  const onRestore = (vi: number) => {
    const v = design.versions[vi];
    if (v) setDesign((d) => ({ ...d, code: v.code, currentVersion: vi, values: {}, updatedAt: Date.now() }));
  };

  const onApplyCode = (code: string) => {
    setDesign((d) => {
      const versions = [...d.versions, { code, summary: 'Manual code edit', createdAt: Date.now(), source: 'manual' as const }];
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
  // Number of print settings (as shown in the Print tab) that differ from the A1 profile on any part.
  const printChanges = useMemo(() => {
    const changed = new Set<string>();
    for (const name of partNames.length ? partNames : [undefined]) {
      const eff = effectiveSettings(aiPrint, userPrint, name);
      for (const k of Object.keys(A1_DEFAULTS) as (keyof typeof A1_DEFAULTS)[]) if (eff[k] !== A1_DEFAULTS[k]) changed.add(k);
    }
    return changed.size;
  }, [aiPrint, userPrint, partNames.join('\u0000')]);
  /** Which parts will print with supports / an explicit brim (validation takes these into account). */
  const printHints = () => ({
    supportParts: partNames.filter((n) => effectiveSettings(aiPrint, userPrint, n).supports !== 'off'),
    brimParts: partNames.filter((n) => typeof effectiveSettings(aiPrint, userPrint, n).brim === 'number'),
  });

  // ---- assembly animation ----
  const shown = result ?? lastGood;
  const layoutKey = shown ? Object.entries(shown.params).find(([, d]) => d.type === 'select' && d.options.some((o) => o.value === 'assembled'))?.[0] : undefined;
  const canAssemble = !!layoutKey && !!shown?.assembly.length;
  // Any change to the model ends the animation and makes validation results stale.
  useEffect(() => {
    setPlayback(null);
    setValidation(null);
    setValidationOpen(false);
    setNotice(null);
  }, [design.id, design.code, design.values]);

  // A clean result fades away by itself; problems stay until dismissed.
  useEffect(() => {
    if (!notice || notice.level !== 'ok') return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  /** Keep only issues about the exported parts (plus model-wide ones). */
  const forParts = (report: ValidationReport, names: string[]): ValidationReport => ({
    ...report,
    issues: report.issues.filter((i) => !i.part || names.includes(i.part)),
  });

  const layoutValue = layoutKey ? String(design.values[layoutKey] ?? shown?.values[layoutKey] ?? '') : undefined;

  const onValidate = async () => {
    if (!design.code || !shown) return;
    setValidating(true);
    try {
      const o = await geo.evaluate(design.code, fullValues(), 'high', { layoutValue, ...printHints() });
      if (!o.report || !o.result) { setNotice({ text: `Validation failed: ${o.error?.message ?? 'no result'}`, level: 'error', details: false }); return; }
      const names = o.result.parts.filter((p) => !viewOpts.hiddenParts.includes(p.name)).map((p) => p.name);
      setValidation({ report: forParts(o.report, names), label: 'Validation' });
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
      const a = await geo.evaluate(design.code, { ...base, [layoutKey]: 'assembled' }, quality);
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

  /** Current values including the uniform scale (which is not a script parameter). */
  /** Everything needed to rebuild exactly what is shown: sliders, uniform scale and text-tool text. */
  const fullValues = (): ParamValues => {
    const out: ParamValues = { ...((result ?? lastGood)?.values ?? {}) };
    const sc = design.values[SCALE_KEY];
    if (sc != null && sc !== 1) out[SCALE_KEY] = sc;
    if (design.values[TEXT_KEY] != null) out[TEXT_KEY] = design.values[TEXT_KEY];
    return out;
  };

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
    const base = result ?? lastGood;
    if (!base) return;
    setExporting(true);
    setExportError(null);
    try {
      // Re-evaluate at high resolution for the exported mesh, and validate exactly that mesh.
      const o = await geo.evaluate(design.code, fullValues(), 'high', { layoutValue, ...printHints() });
      const r = o.result ?? base;
      const parts = partName ? r.parts.filter((p) => p.name === partName) : r.parts.filter((p) => !viewOpts.hiddenParts.includes(p.name));
      if (!parts.length) return;
      const name = slug(r.meta.name || design.name) + (partName ? `-${slug(partName)}` : '');
      const file = `${name}.${format}`;
      const blob = await exportParts(format, r, parts, r.meta.name || design.name, design.code, {
        colours: threeMf.colours,
        print: threeMf.print && bambu ? { ai: r.print, user: userPrint } : null,
      });
      download(blob, file); // always export – problems are reported, not blocking
      if (o.report) {
        const report = forParts(o.report, parts.map((p) => p.name));
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
    setShowList(false);
    if (id === design.id) return;
    const d = background.current.get(id) ?? (await api.getDesign(id));
    if (d) switchTo(d);
  };

  const createNew = () => switchTo(newDesign());

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

  const deleteDesign = async (id: string) => {
    if (!confirm('Delete this design permanently?')) return;
    running[id]?.abort();
    background.current.delete(id);
    await api.deleteDesign(id);
    setTabIds((t) => t.filter((x) => x !== id));
    if (id === design.id) createNew();
    refreshList();
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={createNew} title="New design"><span className="logo"><Icon name="cube" size={18} /></span> AI Designer</button>
        <input className="design-name" value={design.name} onChange={(e) => setDesign((d) => ({ ...d, name: e.target.value }))} />
        {design.versions.length > 0 && <VersionMenu versions={design.versions} current={design.currentVersion} onRestore={onRestore} />}
        {designTabs.length > 1 ? <DesignTabs tabs={designTabs} current={design.id} onOpen={openDesign} onClose={closeTab} /> : <span className="spacer" />}
        <button className="btn ghost" onClick={createNew}><Icon name="plus" size={14} /> New</button>
        <div className="menu-wrap">
          <button className="btn ghost" onClick={() => { refreshList(); setShowList(!showList); }}><Icon name="folder" size={14} /> Designs</button>
          {showList && (
            <div className="menu" onMouseLeave={() => setShowList(false)}>
              {designs.length === 0 && <div className="menu-empty">No saved designs yet</div>}
              {designs.map((d) => (
                <div key={d.id} className={`menu-item ${d.id === design.id ? 'on' : ''}`}>
                  <button className="menu-open" onClick={() => openDesign(d.id)}>
                    <span>{(running[d.id] || remoteRunning[d.id] != null) && <span className="spinner" />} {d.name}</span>
                    <span className="dim small">{new Date(d.updatedAt).toLocaleString()} · {d.versions} versions</span>
                  </button>
                  <button className="icon-btn" title="Delete" onClick={() => deleteDesign(d.id)}><Icon name="trash" size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </header>
      <main className={`workspace ${leftOpen ? '' : 'left-closed'} ${rightOpen ? '' : 'right-closed'}`}>
        <ChatPanel
          messages={design.messages}
          versions={design.versions}
          currentVersion={design.currentVersion}
          generating={generating}
          busyElsewhere={busyElsewhere}
          verbose={verbose}
          onVerbose={setVerbose}
          onSend={onSend}
          onStop={() => running[design.id]?.abort()}
          onRestore={onRestore}
          model={model} onModel={setModel}
          effort={effort} onEffort={setEffort}
          hasModel={!!design.code}
        />
        <ViewerPanel
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
          result={result}
          lastGood={lastGood}
          error={error}
          code={design.code}
          onValue={onValue}
          onResetValues={() => setDesign((d) => ({ ...d, values: keepAppValues(d.values) }))}
          onEditDimension={onEditDimension}
          textFeatures={textFeatures}
          onTextFeatures={setTextFeatures}
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
          onUserPrint={setUserPrint}
          bambu={bambu}
          printChanges={printChanges}
          threeMf={threeMf}
          onThreeMf={setThreeMf}
          onExport3mf={() => onExport('3mf')}
          blender={blender}
          hiddenParts={viewOpts.hiddenParts}
          onToggleHidden={(n) => setViewOpts((o) => ({ ...o, hiddenParts: o.hiddenParts.includes(n) ? o.hiddenParts.filter((x) => x !== n) : [...o.hiddenParts, n] }))}
        />
      </main>
    </div>
  );
}

/** Values owned by the app rather than the script ($scale, $text) survive resets and new AI versions. */
function keepAppValues(values: ParamValues): ParamValues {
  return Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith('$')));
}

function describeText(features: TextFeature[]): string | undefined {
  const on = features.filter((f) => f.enabled && f.text.trim());
  if (!on.length) return undefined;
  return on.map((f) => `"${f.text.replace(/\n/g, ' / ')}" ${f.mode === 'emboss' ? 'raised' : 'engraved'} ${f.depth} mm, ${f.size} mm letters, on the ${f.face === 'pick' ? 'picked surface' : f.face} of part "${f.part ?? 'first part'}"${f.curve !== 'none' ? `, ${f.curve}` : ''}`).join('; ');
}
