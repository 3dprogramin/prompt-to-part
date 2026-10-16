import { useEffect, useRef, useState } from 'react';
import { Viewer, type Measurement, type ViewName, type ViewerOptions } from '../viewer/Viewer';
import type { EvalResult, Quality, ScriptErrorInfo, Vec3 } from '../../shared/types';
import { Icon } from './Icon';

interface Props {
  result: EvalResult | null;
  error: ScriptErrorInfo | null;
  busy: boolean;
  fitKey: string;
  options: ViewerOptions;
  onOptions: (o: ViewerOptions) => void;
  quality: Quality;
  onQuality: (q: Quality) => void;
  emptyState: React.ReactNode;
}

const VIEWS: [ViewName, string][] = [['iso', 'Iso'], ['front', 'Front'], ['top', 'Top'], ['right', 'Right'], ['left', 'Left'], ['back', 'Back'], ['bottom', 'Bottom']];
const f2 = (n: number) => n.toFixed(2);

export function ViewerPanel({ result, error, busy, fitKey, options, onOptions, quality, onQuality, emptyState }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [hover, setHover] = useState<{ p: Vec3; snapped: boolean } | null>(null);
  const [measures, setMeasures] = useState<Measurement[]>([]);
  const lastFit = useRef('');

  useEffect(() => {
    const v = new Viewer(host.current!, options);
    v.onHover = (p, snapped) => setHover(p ? { p, snapped } : null);
    v.onMeasurementsChange = setMeasures;
    viewer.current = v;
    return () => { v.dispose(); viewer.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const fit = fitKey !== lastFit.current;
    lastFit.current = fitKey;
    viewer.current?.setModel(result, fit);
  }, [result, fitKey]);

  useEffect(() => { viewer.current?.setOptions(options); }, [options]);

  const set = (patch: Partial<ViewerOptions>) => onOptions({ ...options, ...patch });
  const setSection = (patch: Partial<ViewerOptions['section']>) => onOptions({ ...options, section: { ...options.section, ...patch } });
  const bbox = result?.bbox;
  const axisIdx = { x: 0, y: 1, z: 2 }[options.section.axis];
  const secMin = bbox ? bbox.min[axisIdx] : 0;
  const secMax = bbox ? bbox.max[axisIdx] : 100;
  const parts = result?.parts ?? [];

  return (
    <div className="viewer-panel">
      <div className="viewer-host" ref={host} />

      <div className="viewer-toolbar">
        <div className="tb-group">
          {VIEWS.map(([k, l]) => (
            <button key={k} className="tb-btn text" onClick={() => viewer.current?.setView(k)}>{l}</button>
          ))}
          <button className="tb-btn" title="Fit to model" onClick={() => viewer.current?.fit()}><Icon name="fit" /></button>
        </div>
        <div className="tb-group">
          <Toggle on={options.ortho} onClick={() => set({ ortho: !options.ortho })} icon="ortho" title="Orthographic camera (no perspective distortion)" />
          <Toggle on={options.showBBox} onClick={() => set({ showBBox: !options.showBBox })} icon="dims" title="Overall dimensions" />
          <Toggle on={options.showAnnotations} onClick={() => set({ showAnnotations: !options.showAnnotations })} icon="tag" title="Feature dimension callouts" />
          <Toggle on={options.showEdges} onClick={() => set({ showEdges: !options.showEdges })} icon="edges" title="Edge lines" />
          <Toggle on={options.section.enabled} onClick={() => setSection({ enabled: !options.section.enabled, position: options.section.enabled ? options.section.position : (secMin + secMax) / 2 })} icon="section" title="Section view" />
          <Toggle on={options.measure} onClick={() => set({ measure: !options.measure })} icon="ruler" title="Measure: click two points (snaps to vertices). Esc cancels." />
        </div>
        <div className="tb-group">
          <select className="tb-select" value={quality} onChange={(e) => onQuality(e.target.value as Quality)} title="Preview resolution (export always uses high)">
            <option value="draft">Draft preview</option>
            <option value="normal">Normal preview</option>
            <option value="high">High preview</option>
          </select>
        </div>
      </div>

      {options.section.enabled && (
        <div className="section-bar">
          <span>Section</span>
          {(['x', 'y', 'z'] as const).map((a) => (
            <button key={a} className={`chip ${options.section.axis === a ? 'on' : ''}`} onClick={() => setSection({ axis: a, position: bbox ? (bbox.min[{ x: 0, y: 1, z: 2 }[a]] + bbox.max[{ x: 0, y: 1, z: 2 }[a]]) / 2 : 0 })}>{a.toUpperCase()}</button>
          ))}
          <input type="range" min={secMin} max={secMax} step={(secMax - secMin) / 400 || 0.1} value={options.section.position}
            onChange={(e) => setSection({ position: Number(e.target.value) })} />
          <span className="mono">{f2(options.section.position)} mm</span>
          <button className="chip" onClick={() => setSection({ flip: !options.section.flip })}>Flip</button>
        </div>
      )}

      {parts.length > 1 && (
        <div className="parts-legend">
          {parts.map((p) => {
            const hidden = options.hiddenParts.includes(p.name);
            return (
              <button key={p.name} className={`legend-item ${hidden ? 'off' : ''}`} onClick={() => set({ hiddenParts: hidden ? options.hiddenParts.filter((n) => n !== p.name) : [...options.hiddenParts, p.name] })}>
                <span className="swatch" style={{ background: p.color }} />{p.name}
              </button>
            );
          })}
        </div>
      )}

      {!result && !error && !busy && <div className="viewer-empty">{emptyState}</div>}

      {error && (
        <div className="viewer-error">
          <Icon name="alert" /> <b>Model error</b>{error.line ? ` (line ${error.line})` : ''}: {error.message}
        </div>
      )}

      <div className="statusbar">
        <span className="mono">
          {hover ? <>X {f2(hover.p[0])} · Y {f2(hover.p[1])} · Z {f2(hover.p[2])}{hover.snapped ? ' · vertex' : ''}</> : options.measure ? 'Click two points to measure' : 'Left-drag rotate · Right-drag pan · Wheel zoom'}
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
        {busy && <span className="busy-dot">evaluating…</span>}
        {result && <span className="mono dim">{Math.round(result.timeMs)} ms · {result.parts.reduce((s, p) => s + p.triCount, 0).toLocaleString()} tris</span>}
      </div>
    </div>
  );
}

function Toggle({ on, onClick, icon, title }: { on: boolean; onClick: () => void; icon: string; title: string }) {
  return <button className={`tb-btn ${on ? 'on' : ''}`} title={title} onClick={onClick}><Icon name={icon} /></button>;
}
