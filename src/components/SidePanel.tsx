import { useEffect, useState } from 'react';
import type { EvalResult, NumberParam, ParamDef, ParamValue, ScriptErrorInfo } from '../../shared/types';
import { Icon } from './Icon';
import { PRINTER, fitProblem } from '../../shared/printer';

type Tab = 'params' | 'info' | 'code';

interface Props {
  result: EvalResult | null;
  lastGood: EvalResult | null;
  error: ScriptErrorInfo | null;
  code: string;
  onValue: (key: string, v: ParamValue) => void;
  onResetValues: () => void;
  onApplyCode: (code: string) => void;
  onExport: (partName?: string) => void;
  exporting: boolean;
  hiddenParts: string[];
  onToggleHidden: (name: string) => void;
}

const PLA_DENSITY = 1.24; // g/cm³

export function SidePanel(p: Props) {
  const [tab, setTab] = useState<Tab>('params');
  const shown = p.result ?? p.lastGood;
  return (
    <div className="side-panel">
      <div className="tabs">
        <button className={tab === 'params' ? 'on' : ''} onClick={() => setTab('params')}><Icon name="sliders" size={14} /> Parameters</button>
        <button className={tab === 'info' ? 'on' : ''} onClick={() => setTab('info')}><Icon name="info" size={14} /> Model</button>
        <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}><Icon name="code" size={14} /> Code{p.error ? <span className="err-dot" /> : null}</button>
      </div>
      <div className="tab-body">
        {tab === 'params' && <ParamsTab result={shown} onValue={p.onValue} onReset={p.onResetValues} />}
        {tab === 'info' && <InfoTab result={shown} onExport={p.onExport} hiddenParts={p.hiddenParts} onToggleHidden={p.onToggleHidden} />}
        {tab === 'code' && <CodeTab code={p.code} error={p.error} onApply={p.onApplyCode} />}
      </div>
      <div className="export-bar">
        {shown?.bbox && (
          <div className="dims-summary mono">
            {(shown.bbox.max[0] - shown.bbox.min[0]).toFixed(2)} × {(shown.bbox.max[1] - shown.bbox.min[1]).toFixed(2)} × {(shown.bbox.max[2] - shown.bbox.min[2]).toFixed(2)} mm
          </div>
        )}
        <button className="btn primary wide" disabled={!shown || p.exporting} onClick={() => p.onExport()}>
          <Icon name="download" /> {p.exporting ? 'Exporting…' : `Export STL${shown && shown.parts.length > 1 ? ` (${shown.parts.length - p.hiddenParts.filter((n) => shown.parts.some((x) => x.name === n)).length} parts)` : ''}`}
        </button>
      </div>
    </div>
  );
}

function ParamsTab({ result, onValue, onReset }: { result: EvalResult | null; onValue: Props['onValue']; onReset: () => void }) {
  if (!result) return <div className="empty-note">Parameters appear here once a model is generated.</div>;
  const entries = Object.entries(result.params);
  if (!entries.length) return <div className="empty-note">This model has no parameters.</div>;
  const groups = new Map<string, [string, ParamDef][]>();
  for (const e of entries) {
    const g = e[1].group ?? 'General';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(e);
  }
  const modified = entries.some(([k, d]) => result.values[k] !== d.value);
  return (
    <div className="params">
      {result.meta.name && (
        <div className="model-title">
          <div>{result.meta.name}</div>
          {result.meta.description && <div className="dim small">{result.meta.description}</div>}
        </div>
      )}
      {[...groups].map(([g, items]) => (
        <section key={g} className="param-group">
          <h4>{g}</h4>
          {items.map(([k, d]) => <ParamRow key={k} k={k} def={d} value={result.values[k]} onValue={onValue} />)}
        </section>
      ))}
      <button className="btn ghost wide" disabled={!modified} onClick={onReset}><Icon name="restore" size={14} /> Reset to AI defaults</button>
    </div>
  );
}

function ParamRow({ k, def, value, onValue }: { k: string; def: ParamDef; value: ParamValue; onValue: Props['onValue'] }) {
  const changed = value !== def.value;
  const head = (
    <div className="param-head">
      <label title={def.description}>{def.label ?? k}{changed && <button className="mod-dot" title={`Reset to ${String(def.value)}`} onClick={() => onValue(k, def.value)} />}</label>
      {def.description && <span className="hint" title={def.description}>?</span>}
    </div>
  );
  if (def.type === 'boolean') {
    return (
      <div className="param bool">
        <label className="switch">
          <input type="checkbox" checked={!!value} onChange={(e) => onValue(k, e.target.checked)} />
          <span className="track" />
          <span className="switch-label" title={def.description}>{def.label ?? k}</span>
        </label>
        {changed && <button className="mod-dot" title="Reset" onClick={() => onValue(k, def.value)} />}
      </div>
    );
  }
  if (def.type === 'select') {
    return (
      <div className="param">
        {head}
        <div className="seg">
          {def.options.length <= 4
            ? def.options.map((o) => <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onValue(k, o.value)}>{o.label}</button>)
            : <select value={String(value)} onChange={(e) => onValue(k, e.target.value)}>{def.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}
        </div>
      </div>
    );
  }
  return (
    <div className="param">
      {head}
      <NumberControl def={def} value={Number(value)} onChange={(v) => onValue(k, v)} />
    </div>
  );
}

function decimals(step: number) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

function NumberControl({ def, value, onChange }: { def: NumberParam; value: number; onChange: (v: number) => void }) {
  const step = def.step ?? (def.type === 'integer' ? 1 : 0.1);
  const dec = def.type === 'integer' ? 0 : Math.min(4, Math.max(decimals(step), 1));
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const v = Number(draft.replace(',', '.'));
    if (Number.isFinite(v)) onChange(def.type === 'integer' ? Math.round(v) : v);
    setDraft(null);
  };
  const out = value < def.min || value > def.max;
  return (
    <div className="num-control">
      <input type="range" min={def.min} max={def.max} step={step} value={Math.min(def.max, Math.max(def.min, value))}
        onChange={(e) => onChange(Number(e.target.value))} />
      <div className={`num-box ${out ? 'out' : ''}`} title={out ? `Outside the suggested range ${def.min}–${def.max}` : `${def.min} – ${def.max}`}>
        <input
          className="mono"
          value={draft ?? value.toFixed(dec)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const mult = e.shiftKey ? 10 : 1;
              const nv = +(value + (e.key === 'ArrowUp' ? 1 : -1) * step * mult).toFixed(6);
              onChange(nv); setDraft(null);
            }
          }}
        />
        {def.unit && <span className="unit">{def.unit}</span>}
      </div>
    </div>
  );
}

function InfoTab({ result, onExport, hiddenParts, onToggleHidden }: { result: EvalResult | null; onExport: Props['onExport']; hiddenParts: string[]; onToggleHidden: (n: string) => void }) {
  if (!result) return <div className="empty-note">No model yet.</div>;
  const vol = result.parts.reduce((s, p) => s + p.volume, 0) / 1000;
  const area = result.parts.reduce((s, p) => s + p.surfaceArea, 0) / 100;
  const tris = result.parts.reduce((s, p) => s + p.triCount, 0);
  const b = result.bbox;
  const warnings = [...result.warnings];
  const fit = fitProblem(b);
  if (fit) warnings.push(fit);
  if (b && Math.abs(b.min[2]) > 0.01) warnings.push(`Model does not sit on the build plate (min Z = ${b.min[2].toFixed(2)} mm)`);
  for (const p of result.parts) if (p.components > 1) warnings.push(`"${p.name}" has ${p.components} disconnected pieces`);
  return (
    <div className="info">
      {b && (
        <table className="kv">
          <tbody>
            <tr><th>Width (X)</th><td className="mono">{(b.max[0] - b.min[0]).toFixed(2)} mm</td></tr>
            <tr><th>Depth (Y)</th><td className="mono">{(b.max[1] - b.min[1]).toFixed(2)} mm</td></tr>
            <tr><th>Height (Z)</th><td className="mono">{(b.max[2] - b.min[2]).toFixed(2)} mm</td></tr>
            <tr><th>Volume</th><td className="mono">{vol.toFixed(2)} cm³</td></tr>
            <tr><th>Mass, solid PLA</th><td className="mono">{(vol * PLA_DENSITY).toFixed(1)} g</td></tr>
            <tr><th>Surface area</th><td className="mono">{area.toFixed(1)} cm²</td></tr>
            <tr><th>Fits {PRINTER.name}</th><td className={fit ? 'bad-text' : 'good-text'}>{fit ? 'No' : 'Yes'}</td></tr>
            <tr><th>Triangles</th><td className="mono">{tris.toLocaleString()}</td></tr>
          </tbody>
        </table>
      )}
      <h4>Parts</h4>
      <ul className="part-list">
        {result.parts.map((p) => {
          const hidden = hiddenParts.includes(p.name);
          return (
            <li key={p.name}>
              <button className="icon-btn" onClick={() => onToggleHidden(p.name)} title={hidden ? 'Show' : 'Hide'}><Icon name={hidden ? 'eyeOff' : 'eye'} size={14} /></button>
              <span className="swatch" style={{ background: p.color }} />
              <div className="part-meta">
                <div>{p.name}</div>
                <div className="mono dim small">{(p.bbox.max[0] - p.bbox.min[0]).toFixed(1)} × {(p.bbox.max[1] - p.bbox.min[1]).toFixed(1)} × {(p.bbox.max[2] - p.bbox.min[2]).toFixed(1)} mm · {(p.volume / 1000).toFixed(2)} cm³</div>
              </div>
              <button className="icon-btn" title="Export this part as STL" onClick={() => onExport(p.name)}><Icon name="download" size={14} /></button>
            </li>
          );
        })}
      </ul>
      {result.dimensions.length > 0 && (
        <>
          <h4>Callouts</h4>
          <table className="kv">
            <tbody>
              {result.dimensions.map((d, i) => (
                <tr key={i}><th>{d.label ?? `Dimension ${i + 1}`}</th><td className="mono">{Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]).toFixed(2)} mm</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {warnings.length > 0 && (
        <>
          <h4>Warnings</h4>
          <ul className="warnings">{warnings.map((w, i) => <li key={i}><Icon name="alert" size={13} /> {w}</li>)}</ul>
        </>
      )}
      {result.logs.length > 0 && (
        <>
          <h4>Console</h4>
          <pre className="console">{result.logs.join('\n')}</pre>
        </>
      )}
    </div>
  );
}

function CodeTab({ code, error, onApply }: { code: string; error: ScriptErrorInfo | null; onApply: (c: string) => void }) {
  const [draft, setDraft] = useState(code);
  useEffect(() => setDraft(code), [code]);
  const dirty = draft !== code;
  return (
    <div className="code-tab">
      {error && <div className="code-error"><Icon name="alert" size={14} /> {error.line ? `Line ${error.line}: ` : ''}{error.message}</div>}
      <textarea className="code-editor mono" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (dirty) onApply(draft); }
          if (e.key === 'Tab') {
            e.preventDefault();
            const t = e.currentTarget, s = t.selectionStart;
            setDraft(draft.slice(0, s) + '  ' + draft.slice(t.selectionEnd));
            requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2; });
          }
        }}
        placeholder="The model script appears here." />
      <div className="code-actions">
        <button className="btn ghost" disabled={!dirty} onClick={() => setDraft(code)}>Revert</button>
        <button className="btn primary" disabled={!dirty} onClick={() => onApply(draft)}>Apply (Ctrl+S)</button>
        <span className="spacer" />
        <button className="btn ghost" disabled={!code} onClick={() => {
          const blob = new Blob([code], { type: 'text/javascript' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = 'model.js'; a.click();
        }}><Icon name="download" size={14} /> .js</button>
      </div>
    </div>
  );
}
