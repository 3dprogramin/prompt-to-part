import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, Design, DesignSummary, DimTarget, EvalResult, ParamValue, ParamValues, Quality, ScriptErrorInfo, SolveResult } from '../shared/types';
import { SCALE_KEY } from '../shared/runtime';
import { api, generate } from './lib/api';
import { dataUrlToImage, download, slug, toBinaryStl, uid } from './lib/files';
import { GeometryClient } from './geometry/client';
import { ChatPanel } from './components/ChatPanel';
import { ViewerPanel } from './components/ViewerPanel';
import { SidePanel } from './components/SidePanel';
import { Icon } from './components/Icon';
import type { ViewerOptions } from './viewer/Viewer';

const UNTITLED = 'Untitled design';
const geo = new GeometryClient();

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
  const [designs, setDesigns] = useState<DesignSummary[]>([]);
  const [showList, setShowList] = useState(false);
  const [result, setResult] = useState<EvalResult | null>(null);
  const [lastGood, setLastGood] = useState<EvalResult | null>(null);
  const [error, setError] = useState<ScriptErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [quality, setQuality] = useState<Quality>(() => load('quality', 'normal'));
  const [model, setModel] = useState(() => load('model', 'opus'));
  const [effort, setEffort] = useState(() => load('effort', 'high'));
  const [viewOpts, setViewOpts] = useState<ViewerOptions>(() => ({
    showBBox: true, showAnnotations: true, showEdges: true, ortho: false, measure: false, hiddenParts: [],
    section: { enabled: false, axis: 'z', position: 0, flip: false },
    ...load<Partial<ViewerOptions>>('viewOpts', {}),
  }));
  const abortRef = useRef<AbortController | null>(null);
  const resultCode = useRef('');
  const loaded = useRef(false);

  useEffect(() => store('quality', quality), [quality]);
  useEffect(() => store('model', model), [model]);
  useEffect(() => store('effort', effort), [effort]);
  useEffect(() => {
    const { showBBox, showAnnotations, showEdges, ortho } = viewOpts;
    store('viewOpts', { showBBox, showAnnotations, showEdges, ortho });
  }, [viewOpts]);

  const refreshList = useCallback(() => { api.listDesigns().then(setDesigns).catch(() => {}); }, []);

  // Open the last design on startup.
  useEffect(() => {
    (async () => {
      const last = new URLSearchParams(location.search).get('design') ?? load<string | null>('lastDesign', null);
      if (last) {
        const d = await api.getDesign(last).catch(() => null);
        if (d) setDesign(d);
      }
      loaded.current = true;
      refreshList();
    })();
  }, [refreshList]);

  // Autosave (debounced) once the design has content.
  useEffect(() => {
    if (!loaded.current || (!design.messages.length && !design.code)) return;
    store('lastDesign', design.id);
    const t = setTimeout(() => { api.saveDesign(design).then(refreshList).catch(() => {}); }, 600);
    return () => clearTimeout(t);
  }, [design, refreshList]);

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
    setDesign((d) => ({ ...d, messages: [...d.messages, userMsg, asst], updatedAt: now }));
    const patchAsst = (fn: (m: ChatMessage) => ChatMessage) =>
      setDesign((d) => ({ ...d, messages: d.messages.map((m) => (m.id === asst.id ? fn(m) : m)) }));
    const abort = new AbortController();
    abortRef.current = abort;
    setGenerating(true);
    try {
      await generate({
        designId: design.id,
        prompt: text,
        images: images.map(dataUrlToImage),
        code: design.code || undefined,
        values: (result ?? lastGood)?.values,
        sessionId: design.sessionId,
        model,
        effort,
      }, (ev) => {
        if (ev.type === 'session') setDesign((d) => ({ ...d, sessionId: ev.sessionId }));
        else if (ev.type === 'step') patchAsst((m) => ({ ...m, steps: [...(m.steps ?? []), ev.step] }));
        else if (ev.type === 'model') {
          setDesign((d) => {
            const versions = [...d.versions, { code: ev.code, summary: ev.summary, createdAt: Date.now(), source: 'ai' as const }];
            const vi = versions.length - 1;
            return {
              ...d, versions, currentVersion: vi, code: ev.code, values: {}, updatedAt: Date.now(),
              messages: d.messages.map((m) => (m.id === asst.id ? { ...m, versionIndex: vi } : m)),
            };
          });
          setViewOpts((o) => ({ ...o, hiddenParts: [] }));
        } else if (ev.type === 'done') patchAsst((m) => ({ ...m, text: ev.text, durationMs: ev.durationMs }));
        else if (ev.type === 'error') patchAsst((m) => ({ ...m, error: ev.message }));
      }, abort.signal);
    } catch (e) {
      if (!abort.signal.aborted) patchAsst((m) => ({ ...m, error: (e as Error).message }));
      else patchAsst((m) => ({ ...m, error: 'Stopped.' }));
    } finally {
      setGenerating(false);
      abortRef.current = null;
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

  /** Current values including the uniform scale (which is not a script parameter). */
  const fullValues = (): ParamValues => {
    const base = (result ?? lastGood)?.values ?? {};
    const sc = design.values[SCALE_KEY];
    return sc != null && sc !== 1 ? { ...base, [SCALE_KEY]: sc } : { ...base };
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

  const onExport = async (partName?: string) => {
    const base = result ?? lastGood;
    if (!base) return;
    setExporting(true);
    try {
      // Re-evaluate at high resolution for the exported mesh.
      const o = await geo.evaluate(design.code, fullValues(), 'high');
      const r = o.result ?? base;
      const parts = partName ? r.parts.filter((p) => p.name === partName) : r.parts.filter((p) => !viewOpts.hiddenParts.includes(p.name));
      if (!parts.length) return;
      const name = slug(r.meta.name || design.name) + (partName ? `-${slug(partName)}` : '');
      download(toBinaryStl(parts, name), `${name}.stl`);
    } finally {
      setExporting(false);
    }
  };

  const openDesign = async (id: string) => {
    setShowList(false);
    if (generating) return;
    const d = await api.getDesign(id);
    if (d) { setDesign(d); setViewOpts((o) => ({ ...o, hiddenParts: [], measure: false })); store('lastDesign', id); }
  };

  const createNew = () => {
    if (generating) return;
    setDesign(newDesign());
    setViewOpts((o) => ({ ...o, hiddenParts: [], measure: false }));
    store('lastDesign', null);
  };

  const deleteDesign = async (id: string) => {
    if (!confirm('Delete this design permanently?')) return;
    await api.deleteDesign(id);
    if (id === design.id) createNew();
    refreshList();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo"><Icon name="cube" size={18} /></span> AI Designer</div>
        <input className="design-name" value={design.name} onChange={(e) => setDesign((d) => ({ ...d, name: e.target.value }))} />
        {design.versions.length > 0 && <span className="dim small">v{design.currentVersion + 1} of {design.versions.length}</span>}
        <span className="spacer" />
        <button className="btn ghost" onClick={createNew} disabled={generating}><Icon name="plus" size={14} /> New</button>
        <div className="menu-wrap">
          <button className="btn ghost" onClick={() => { refreshList(); setShowList(!showList); }}><Icon name="folder" size={14} /> Designs</button>
          {showList && (
            <div className="menu" onMouseLeave={() => setShowList(false)}>
              {designs.length === 0 && <div className="menu-empty">No saved designs yet</div>}
              {designs.map((d) => (
                <div key={d.id} className={`menu-item ${d.id === design.id ? 'on' : ''}`}>
                  <button className="menu-open" onClick={() => openDesign(d.id)}>
                    <span>{d.name}</span>
                    <span className="dim small">{new Date(d.updatedAt).toLocaleString()} · {d.versions} versions</span>
                  </button>
                  <button className="icon-btn" title="Delete" onClick={() => deleteDesign(d.id)}><Icon name="trash" size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </header>
      <main className="workspace">
        <ChatPanel
          messages={design.messages}
          versions={design.versions}
          currentVersion={design.currentVersion}
          generating={generating}
          onSend={onSend}
          onStop={() => abortRef.current?.abort()}
          onRestore={onRestore}
          model={model} onModel={setModel}
          effort={effort} onEffort={setEffort}
          hasModel={!!design.code}
        />
        <ViewerPanel
          result={result ?? lastGood}
          error={error}
          busy={busy}
          fitKey={fitKey}
          options={viewOpts}
          onOptions={setViewOpts}
          quality={quality}
          onQuality={setQuality}
          onEditDimension={onEditDimension}
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
          onResetValues={() => setDesign((d) => ({ ...d, values: {} }))}
          onEditDimension={onEditDimension}
          scale={Number(design.values[SCALE_KEY] ?? 1)}
          onScale={onScale}
          onApplyCode={onApplyCode}
          onExport={onExport}
          exporting={exporting}
          hiddenParts={viewOpts.hiddenParts}
          onToggleHidden={(n) => setViewOpts((o) => ({ ...o, hiddenParts: o.hiddenParts.includes(n) ? o.hiddenParts.filter((x) => x !== n) : [...o.hiddenParts, n] }))}
        />
      </main>
    </div>
  );
}
