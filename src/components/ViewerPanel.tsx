import { useEffect, useRef, useState } from 'react';
import { Viewer, type Measurement, type PhotoView, type PlaybackStep, type RepaintView, type ViewName, type ViewerOptions } from '../viewer/Viewer';
import type { DimTarget, EvalResult, Quality, ScriptErrorInfo, SolveResult, Vec3 } from '../../shared/types';
import type { LayerColor } from '../../shared/layertone';
import { Icon } from './Icon';
import { ValidationPanel, type ValidationState } from './ValidationPanel';

interface Props {
  /** A cost calculation under way (slicing in Bambu Studio), shown in the status bar from any tab. */
  costStatus?: { text: string; since: number } | null | false;
  result: EvalResult | null;
  /** A LayerTone part shown with other filaments until its rebuild arrives (Viewer.recolor). */
  recolor?: { part: string; layers: LayerColor[] } | null;
  error: ScriptErrorInfo | null;
  busy: boolean;
  fitKey: string;
  options: ViewerOptions;
  onOptions: (o: ViewerOptions) => void;
  quality: Quality;
  onQuality: (q: Quality) => void;
  emptyState: React.ReactNode;
  onEditDimension: (target: DimTarget, goal: number) => Promise<SolveResult | null>;
  onPickSurface: (hit: { part: string; point: Vec3; normal: Vec3 }) => void;
  /** Repainting a coloured mesh by hand (Viewer.setRepaint): a click picks a patch, a brush stroke paints. */
  repaint?: RepaintView | null;
  onRepaintPick?: (face: number) => void;
  onRepaintStroke?: (faces: number[]) => void;
  /** Receives a function that shows stored triangles of a coloured mesh in a colour at once (Viewer.paintStored). */
  paintRef?: React.MutableRefObject<((mesh: string, mask: Uint8Array, color: string) => void) | null>;
  /** Receives a function that captures the current view as a JPEG data URL. */
  snapshotRef?: React.MutableRefObject<(() => string | null) | null>;
  /** Receives a function that renders the model alone for a product photo (PNG data URL). */
  photoRef?: React.MutableRefObject<((view: PhotoView, aspect: number) => string | null) | null>;
  /** The product photos panel: open or not, toggled by the camera button; photos being made. */
  photos?: { open: boolean; onToggle: () => void; busy: number; panel: React.ReactNode };
  /** The model has an assembly sequence that can be played. */
  canAssemble?: boolean;
  /** Assembly playback in progress (result prop is then the assembled layout). */
  assembly?: PlaybackStep[] | null;
  assemblyLoading?: boolean;
  onAssemble?: () => void;
  onAssemblyClose?: () => void;
  /** The model's layout parameter (print / assembled / exploded), if it has one. */
  layout?: { value: string; options: { value: string; label: string }[] } | null;
  onLayout?: (value: string) => void;
  leftOpen?: boolean;
  rightOpen?: boolean;
  onToggleLeft?: () => void;
  onToggleRight?: () => void;
  validation?: ValidationState | null;
  validationOpen?: boolean;
  onValidationClose?: () => void;
  /** Short message after export / validation, e.g. "Exported x.stl · 2 warnings". */
  notice?: { text: string; level: 'ok' | 'error' | 'warning' | 'info'; details: boolean } | null;
  onNoticeDetails?: () => void;
  onNoticeClose?: () => void;
}

const STEP_SECONDS = 1.6;

const VIEWS: [ViewName, string][] = [['iso', 'Iso'], ['front', 'Front'], ['top', 'Top'], ['right', 'Right'], ['left', 'Left'], ['back', 'Back'], ['bottom', 'Bottom']];
const f2 = (n: number) => n.toFixed(2);

export function ViewerPanel({ costStatus, result, recolor, error, busy, fitKey, options, onOptions, quality, onQuality, emptyState, onEditDimension, onPickSurface, repaint, onRepaintPick, onRepaintStroke, paintRef, snapshotRef, canAssemble, assembly, assemblyLoading, onAssemble, onAssemblyClose, layout, onLayout, leftOpen = true, rightOpen = true, onToggleLeft, onToggleRight, validation, validationOpen, onValidationClose, notice, onNoticeDetails, onNoticeClose, photoRef, photos }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [hover, setHover] = useState<{ p: Vec3; snapped: boolean } | null>(null);
  const [measures, setMeasures] = useState<Measurement[]>([]);
  const lastFit = useRef('');
  const panel = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ target: DimTarget; x: number; y: number; value: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [solving, setSolving] = useState(false);
  const [hideUi, setHideUi] = useState(false);
  const [idle, setIdle] = useState(false);
  // The toolbar wraps onto more rows in a narrow window: the overlays below it (section bar,
  // notices, validation, model errors) follow its real height instead of covering it.
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tb = toolbar.current, pnl = panel.current;
    if (!tb || !pnl) return;
    const ro = new ResizeObserver(() => pnl.style.setProperty('--toolbar-bottom', `${tb.offsetTop + tb.offsetHeight}px`));
    ro.observe(tb);
    return () => ro.disconnect();
  }, []);

  // Fullscreen shows only this panel; leaving fullscreen always brings the controls back.
  useEffect(() => {
    const onFs = () => {
      const on = document.fullscreenElement === panel.current;
      setFullscreen(on);
      if (!on) setHideUi(false);
      // The pressed button goes away (the corner one in fullscreen, the exit one after it): give
      // the focus to its counterpart instead of losing it.
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        panel.current?.querySelector<HTMLElement>(on ? '.fs-exit' : '.tb-corner .tb-btn')?.focus();
      });
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void panel.current?.requestFullscreen();
  };

  // With controls hidden, the toggle button fades out after 2 s without mouse movement.
  useEffect(() => {
    if (!hideUi) { setIdle(false); return; }
    let t = setTimeout(() => setIdle(true), 2000);
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 2000); };
    const el = panel.current;
    el?.addEventListener('pointermove', wake);
    return () => { clearTimeout(t); el?.removeEventListener('pointermove', wake); };
  }, [hideUi]);
  const editRef = useRef<typeof onEditDimension>(onEditDimension);
  editRef.current = onEditDimension;
  const pickRef = useRef(onPickSurface);
  pickRef.current = onPickSurface;
  const repaintRef = useRef({ pick: onRepaintPick, stroke: onRepaintStroke });
  repaintRef.current = { pick: onRepaintPick, stroke: onRepaintStroke };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const commitEdit = async () => {
    if (!editing) return;
    const goal = Number(editing.value.replace(',', '.'));
    const target = editing.target;
    setEditing(null);
    if (!Number.isFinite(goal)) return;
    setSolving(true);
    let r: SolveResult | null;
    try {
      r = await editRef.current(target, goal);
    } finally {
      setSolving(false);
    }
    if (!r) return;
    const what = target.kind === 'bbox' ? 'XYZ'[target.axis] : result?.dimensions[target.index]?.label ?? 'Dimension';
    const param = r.key ? result?.params[r.key]?.label ?? r.key : '';
    if (r.ok) setToast({ ok: true, text: r.key ? `${what} → ${goal.toFixed(2)} mm  ·  ${param} = ${+r.value!.toFixed(3)}` : `${what} is already ${goal.toFixed(2)} mm` });
    else setToast({ ok: false, text: r.message ?? 'Could not reach that size.' });
  };

  useEffect(() => {
    const v = new Viewer(host.current!, options);
    v.onHover = (p, snapped) => setHover(p ? { p, snapped } : null);
    v.onMeasurementsChange = setMeasures;
    v.onPickSurface = (hit) => pickRef.current(hit);
    v.onRepaintPick = (face) => repaintRef.current.pick?.(face);
    v.onRepaintStroke = (faces) => repaintRef.current.stroke?.(faces);
    if (paintRef) paintRef.current = (mesh, mask, color) => v.paintStored(mesh, mask, color);
    if (snapshotRef) snapshotRef.current = () => v.snapshot();
    if (photoRef) photoRef.current = (view, aspect) => v.photo(view, aspect);
    v.onDimEdit = (target, rect, current) => {
      const p = panel.current!.getBoundingClientRect();
      setEditing({ target, x: rect.left - p.left + rect.width / 2, y: rect.top - p.top + rect.height / 2, value: current.toFixed(2) });
    };
    viewer.current = v;
    return () => { v.dispose(); viewer.current = null; if (snapshotRef) snapshotRef.current = null; if (photoRef) photoRef.current = null; if (paintRef) paintRef.current = null; };
    // Created once; callbacks are read through refs (editRef, pickRef, repaintRef).
  }, []);

  useEffect(() => {
    // Only consume the one-time fit once a model exists – otherwise the camera frames an empty scene.
    const fit = !!result && fitKey !== lastFit.current;
    if (result) lastFit.current = fitKey;
    viewer.current?.setModel(result, fit);
  }, [result, fitKey]);
  useEffect(() => { viewer.current?.recolor(recolor?.part ?? null, recolor?.layers ?? null); }, [recolor, result]);

  useEffect(() => { viewer.current?.setOptions(options); }, [options]);
  useEffect(() => { viewer.current?.setRepaint(repaint ?? null); }, [repaint]);

  // ---- validation overlay ----
  const [highlight, setHighlight] = useState(true);
  useEffect(() => {
    viewer.current?.setValidationOverlay(validation && validationOpen && highlight ? validation.report.overlay : null);
  }, [validation, validationOpen, highlight, result]);

  // ---- assembly playback ----
  const [asmT, setAsmT] = useState(0);
  const [asmPlaying, setAsmPlaying] = useState(false);
  const steps = assembly?.length ?? 0;
  useEffect(() => {
    // Declared after the setModel effect, so the assembled model is in place first.
    viewer.current?.setAssembly(assembly ?? null);
    setAsmT(0);
    setAsmPlaying(!!assembly?.length);
  }, [assembly]);
  useEffect(() => { viewer.current?.setAssemblyTime(asmT); }, [asmT]);
  useEffect(() => {
    if (!asmPlaying || !steps) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      // rAF timestamps can be slightly earlier than performance.now() at start – never go backwards.
      const dt = Math.max(0, (now - last) / 1000);
      last = Math.max(last, now);
      setAsmT((t) => {
        const next = Math.max(0, Math.min(steps, t + dt / STEP_SECONDS));
        if (next >= steps) setAsmPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [asmPlaying, steps]);
  const stepIndex = Math.max(0, Math.min(steps - 1, Math.floor(asmT + 1e-6)));
  const goStep = (i: number) => { setAsmPlaying(false); setAsmT(Math.max(0, Math.min(steps, i))); };
  useEffect(() => { viewer.current?.setClean(fullscreen && hideUi); }, [fullscreen, hideUi]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if ((t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Home') { e.preventDefault(); viewer.current?.home(); }
      if (e.key === 'f' || e.key === 'F') viewer.current?.fit();
      if ((e.key === 'u' || e.key === 'U') && document.fullscreenElement) setHideUi((h) => !h);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const set = (patch: Partial<ViewerOptions>) => onOptions({ ...options, ...patch });
  const setSection = (patch: Partial<ViewerOptions['section']>) => onOptions({ ...options, section: { ...options.section, ...patch } });
  const bbox = result?.bbox;
  const axisIdx = { x: 0, y: 1, z: 2 }[options.section.axis];
  const secMin = bbox ? bbox.min[axisIdx] : 0;
  const secMax = bbox ? bbox.max[axisIdx] : 100;
  const parts = result?.parts ?? [];

  return (
    <div className={`viewer-panel ${fullscreen ? 'is-fullscreen' : ''} ${fullscreen && hideUi ? 'ui-hidden' : ''}`} ref={panel}>
      <div className="viewer-host" ref={host} />

      <div className="viewer-toolbar" ref={toolbar}>
        <div className="tb-group">
          {VIEWS.map(([k, l]) => (
            <button key={k} className="tb-btn text" onClick={() => viewer.current?.setView(k)}>{l}</button>
          ))}
          <button className="tb-btn" title="Home view (Home key)" aria-label="Home view" onClick={() => viewer.current?.home()}><Icon name="home" /></button>
        </div>
        <div className="tb-group">
          <Toggle on={options.ortho} onClick={() => set({ ortho: !options.ortho })} icon="ortho" title="Orthographic camera (no perspective distortion)" />
          <Toggle on={options.showBBox} onClick={() => set({ showBBox: !options.showBBox })} icon="dims" title="Overall dimensions" />
          <Toggle on={options.showAnnotations} onClick={() => set({ showAnnotations: !options.showAnnotations })} icon="tag" title="Feature dimension callouts" />
          <Toggle on={options.showEdges} onClick={() => set({ showEdges: !options.showEdges })} icon="edges" title="Edge lines" />
          <Toggle on={options.colors !== false} onClick={() => set({ colors: options.colors === false })} icon="palette" title="Part colours (off = one neutral colour)" />
          <Toggle on={options.section.enabled} onClick={() => setSection({ enabled: !options.section.enabled, position: options.section.enabled ? options.section.position : (secMin + secMax) / 2 })} icon="section" title="Section view" />
          <Toggle on={options.measure} onClick={() => set({ measure: !options.measure })} icon="ruler" title="Measure: click two points (snaps to vertices). Esc cancels." />
        </div>
        <div className="tb-group">
          <select className="tb-select" value={quality} onChange={(e) => onQuality(e.target.value as Quality)} title="Preview quality (export always uses high)" aria-label="Preview quality">
            <option value="draft">Draft</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>
      {/* Top-right corner; in fullscreen the exit button sits with the other fullscreen controls (.fs-controls). */}
      {!fullscreen && (
        <div className="tb-group tb-corner">
          {photos && (
            <button className={`tb-btn ph-btn ${photos.open ? 'on' : ''}`} title="Product photos – realistic listing photos of the print, made from the model" aria-label="Product photos" aria-pressed={photos.open} onClick={photos.onToggle}>
              <Icon name="camera" />{photos.busy > 0 && <span className="spinner ph-busy" aria-label={`${photos.busy} photos being made`} />}
            </button>
          )}
          <button className="tb-btn" title="Fullscreen – only the 3D view" aria-label="Fullscreen" onClick={toggleFullscreen}><Icon name="fullscreen" /></button>
        </div>
      )}

      {options.section.enabled && (
        <div className="section-bar" role="group" aria-label="Section view">
          <span>Section</span>
          {(['x', 'y', 'z'] as const).map((a) => (
            <button key={a} className={`chip ${options.section.axis === a ? 'on' : ''}`} aria-pressed={options.section.axis === a} aria-label={`Cut along ${a.toUpperCase()}`} onClick={() => setSection({ axis: a, position: bbox ? (bbox.min[{ x: 0, y: 1, z: 2 }[a]] + bbox.max[{ x: 0, y: 1, z: 2 }[a]]) / 2 : 0 })}>{a.toUpperCase()}</button>
          ))}
          <input type="range" aria-label="Section position" min={secMin} max={secMax} step={(secMax - secMin) / 400 || 0.1} value={options.section.position}
            onChange={(e) => setSection({ position: Number(e.target.value) })} />
          <span className="mono">{f2(options.section.position)} mm</span>
          <button className="chip" aria-pressed={options.section.flip} onClick={() => setSection({ flip: !options.section.flip })}>Flip</button>
        </div>
      )}

      {(parts.length > 1 || !!options.oneColour) && (
        <div className="parts-legend">
          {options.oneColour && (
            <div className="legend-item oc" role="note" title="“Print in one colour” is on (Print tab): the model shows in the one filament it prints with">
              <span className="swatch" style={{ background: options.oneColour }} />Printing in one colour
            </div>
          )}
          {parts.length > 1 && parts.map((p) => {
            const hidden = options.hiddenParts.includes(p.name);
            return (
              <button key={p.name} className={`legend-item ${hidden ? 'off' : ''}`} aria-pressed={!hidden} title={hidden ? `Show ${p.name}` : `Hide ${p.name}`} onClick={() => set({ hiddenParts: hidden ? options.hiddenParts.filter((n) => n !== p.name) : [...options.hiddenParts, p.name] })}>
                <span className="swatch" style={{ background: options.oneColour ?? p.color }} />{p.name}
              </button>
            );
          })}
        </div>
      )}

      {editing && (
        <div className="dim-editor" style={{ left: editing.x, top: editing.y }}>
          <input
            autoFocus
            aria-label="Size in mm (Enter to apply, Esc to cancel)"
            className="mono"
            value={editing.value}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') { e.preventDefault(); setEditing(null); } }}
            onBlur={() => setEditing(null)}
          />
          <span>mm ↵</span>
        </div>
      )}
      {toast && <div className={`viewer-toast ${toast.ok ? '' : 'bad'}`} role="status">{toast.text}</div>}

      {photos?.panel}
      {validation && validationOpen && (
        <ValidationPanel state={validation} highlight={highlight} onHighlight={setHighlight} onClose={() => onValidationClose?.()} />
      )}
      {notice && (
        <div className={`export-notice ${notice.level}`} role={notice.level === 'error' ? 'alert' : 'status'}>
          <Icon name={notice.level === 'ok' ? 'check' : 'alert'} size={15} />
          <span>{notice.text}</span>
          {notice.details && <button className="link" onClick={() => onNoticeDetails?.()}>Details</button>}
          <button className="icon-btn" onClick={() => onNoticeClose?.()} title="Dismiss" aria-label="Dismiss"><Icon name="x" size={13} /></button>
        </div>
      )}

      {onToggleLeft && (
        <button className={`edge-tab left ${leftOpen ? '' : 'closed'}`} onClick={onToggleLeft} title={leftOpen ? 'Hide the chat sidebar (T)' : 'Show the chat sidebar (T)'} aria-label={leftOpen ? 'Hide the chat sidebar' : 'Show the chat sidebar'} aria-expanded={leftOpen}>
          <Icon name="chevron" size={12} />
        </button>
      )}
      {onToggleRight && (
        <button className={`edge-tab right ${rightOpen ? '' : 'closed'}`} onClick={onToggleRight} title={rightOpen ? 'Hide the parameters sidebar (N)' : 'Show the parameters sidebar (N)'} aria-label={rightOpen ? 'Hide the parameters sidebar' : 'Show the parameters sidebar'} aria-expanded={rightOpen}>
          <Icon name="chevron" size={12} />
        </button>
      )}

      {!assembly && (layout || canAssemble) && result && (
        <div className="layout-bar">
          {layout && layout.options.map((o) => (
            <button key={o.value} className={layout.value === o.value ? 'on' : ''} aria-pressed={layout.value === o.value} onClick={() => onLayout?.(o.value)} title={`Show the ${o.label} layout`}>
              {o.label.charAt(0).toUpperCase() + o.label.slice(1)}
            </button>
          ))}
          {canAssemble && (
            <button className="assemble" disabled={assemblyLoading} onClick={() => onAssemble?.()} title="Watch the parts being put together step by step">
              <Icon name="play" size={13} /> {assemblyLoading ? 'Preparing…' : 'Assemble'}
            </button>
          )}
        </div>
      )}

      {assembly && steps > 0 && (
        <div className="asm-player">
          <div className="asm-caption">
            {asmT >= steps - 1e-6
              ? <><b>Assembled</b> · all {steps} steps done</>
              : <><b>Step {stepIndex + 1} of {steps}</b> · {assembly[stepIndex]?.label}</>}
          </div>
          <div className="asm-controls">
            <button className="icon-btn" title="Previous step" onClick={() => goStep(Math.ceil(asmT - 1e-6) - 1)}><Icon name="prev" /></button>
            <button className="icon-btn play" title={asmPlaying ? 'Pause' : 'Play'} onClick={() => { if (asmT >= steps) setAsmT(0); setAsmPlaying(!asmPlaying); }}>
              <Icon name={asmPlaying ? 'pause' : 'play'} />
            </button>
            <button className="icon-btn" title="Next step" onClick={() => goStep(Math.floor(asmT + 1e-6) + 1)}><Icon name="next" /></button>
            <input type="range" min={0} max={steps} step={0.001} value={asmT} onChange={(e) => { setAsmPlaying(false); setAsmT(Number(e.target.value)); }} />
            <button className="icon-btn" title="Close assembly view" onClick={() => onAssemblyClose?.()}><Icon name="x" /></button>
          </div>
        </div>
      )}

      {fullscreen && (
        <div className={`fs-controls ${hideUi && idle ? 'idle' : ''}`}>
          <button className="fs-btn" onClick={() => setHideUi(!hideUi)} title={hideUi ? 'Show controls (U)' : 'Hide all controls (U)'}>
            <Icon name={hideUi ? 'eye' : 'eyeOff'} size={15} /> {hideUi ? 'Show controls' : 'Hide controls'}
          </button>
          <button className="fs-btn fs-exit" onClick={toggleFullscreen} title="Exit fullscreen (Esc)" aria-label="Exit fullscreen"><Icon name="fullscreenExit" size={15} /></button>
        </div>
      )}

      {!result && !error && !busy && <div className="viewer-empty">{emptyState}</div>}

      {error && (
        <div className="viewer-error" role="alert">
          <Icon name="alert" /> <b>Model error</b>{error.line ? ` (line ${error.line})` : ''}: {error.message}
        </div>
      )}

      <div className="statusbar">
        <span className="mono">
          {options.pickText ? 'Click on the model where the text should go (Esc to cancel)' : hover ? <>X {f2(hover.p[0])} · Y {f2(hover.p[1])} · Z {f2(hover.p[2])}{hover.snapped ? ' · vertex' : ''}</> : options.measure ? 'Click two points to measure' : 'Left-drag rotate · Right-drag pan · Wheel zoom'}
        </span>
        {measures.length > 0 && (
          <span className="measures">
            {measures.slice(-3).map((m, i) => {
              const d = [m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]];
              return <span key={i} className="mono measure-chip">{f2(Math.hypot(d[0], d[1], d[2]))} mm <small>(Δ {f2(Math.abs(d[0]))}, {f2(Math.abs(d[1]))}, {f2(Math.abs(d[2]))})</small></span>;
            })}
            <button className="link" onClick={() => viewer.current?.clearMeasurements()}>clear</button>
          </span>
        )}
        <span className="spacer" />
        {costStatus && <CostStatus {...costStatus} />}
        <span className="busy-dot" role="status">{(busy || solving) && (solving ? 'finding size…' : 'evaluating…')}</span>
        {result && <span className="mono dim tri-count">{Math.round(result.timeMs)} ms · {result.parts.reduce((s, p) => s + p.triCount, 0).toLocaleString()} tris</span>}
      </div>
    </div>
  );
}

function Toggle({ on, onClick, icon, title }: { on: boolean; onClick: () => void; icon: string; title: string }) {
  return <button className={`tb-btn ${on ? 'on' : ''}`} title={title} aria-label={title.split(/[(:.]/)[0].trim()} aria-pressed={on} onClick={onClick}><Icon name={icon} /></button>;
}

/** "Bambu Studio is slicing the model… 12 s" while the Cost tab calculates. */
function CostStatus({ text, since }: { text: string; since: number }) {
  const [now, setNow] = useState(performance.now());
  useEffect(() => { const t = setInterval(() => setNow(performance.now()), 500); return () => clearInterval(t); }, []);
  // The status bar is one line: the stage's first clause only.
  return <span className="cost-status" role="status" title={text}><span className="spinner" /> Cost: {text.split(' (')[0]}… {Math.round((now - since) / 1000)} s</span>;
}

