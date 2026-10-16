import { useEffect, useRef, useState } from 'react';
import type { DimTarget, EvalResult, NumberParam, ParamDef, ParamValue, ScriptErrorInfo, SolveResult } from '../../shared/types';
import { Icon } from './Icon';
import { TextPanel } from './TextPanel';
import { PrintPanel } from './PrintPanel';
import type { PrintProfile } from '../../shared/print';
import { useReleaseSlider } from './useReleaseSlider';
import { FontPicker } from './FontPicker';
import type { TextFeature } from '../../shared/textFeatures';
import type { FontEntry } from '../lib/api';
import type { ExportFormat } from '../lib/export';
import { PRINTER, fitProblem } from '../../shared/printer';

type Tab = 'params' | 'text' | 'print' | 'info' | 'code';

interface Props {
  result: EvalResult | null;
  lastGood: EvalResult | null;
  error: ScriptErrorInfo | null;
  code: string;
  onValue: (key: string, v: ParamValue) => void;
  onResetValues: () => void;
  onApplyCode: (code: string) => void;
  onExport: (format: ExportFormat, partName?: string) => void;
  exporting: boolean;
  exportError: string | null;
  blender: string | null;
  onValidate: () => void;
  validating: boolean;
  aiPrint: PrintProfile;
  userPrint: PrintProfile;
  onUserPrint: (p: PrintProfile) => void;
  bambu: string | null;
  /** Number of print-setting changes that would be written to a 3MF. */
  printChanges: number;
  threeMf: { colours: boolean; print: boolean };
  onThreeMf: (o: { colours: boolean; print: boolean }) => void;
  onExport3mf: () => void;
  hiddenParts: string[];
  onToggleHidden: (name: string) => void;
  onEditDimension: (target: DimTarget, goal: number) => Promise<SolveResult | null>;
  scale: number;
  onScale: (factor: number) => void;
  textFeatures: TextFeature[];
  onTextFeatures: (f: TextFeature[]) => void;
  fonts: FontEntry[];
  picking: string | null;
  onPick: (featureId: string | null) => void;
  tabRequest?: { tab: Tab; n: number };
}

const PLA_DENSITY = 1.24; // g/cm³

export function SidePanel(p: Props) {
  const [tab, setTab] = useState<Tab>('params');
  useEffect(() => { if (p.tabRequest) setTab(p.tabRequest.tab); }, [p.tabRequest]);
  const shown = p.result ?? p.lastGood;
  return (
    <div className="side-panel">
      <div className="tabs">
        <button className={tab === 'params' ? 'on' : ''} onClick={() => setTab('params')}><Icon name="sliders" size={14} /> Params</button>
        <button className={tab === 'text' ? 'on' : ''} onClick={() => setTab('text')}><span className="tab-glyph">T</span> Text{p.textFeatures.length ? <span className="count">{p.textFeatures.length}</span> : null}</button>
        <button className={tab === 'print' ? 'on' : ''} onClick={() => setTab('print')}><Icon name="printer" size={14} /> Print{p.printChanges ? <span className="count">{p.printChanges}</span> : null}</button>
        <button className={tab === 'info' ? 'on' : ''} onClick={() => setTab('info')}><Icon name="info" size={14} /> Model</button>
        <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}><Icon name="code" size={14} /> Code{p.error ? <span className="err-dot" /> : null}</button>
      </div>
      <div className="tab-body">
        {tab === 'params' && shown && <OverallSize result={shown} onEdit={p.onEditDimension} scale={p.scale} onScale={p.onScale} />}
        {tab === 'params' && <ParamsTab result={shown} onValue={p.onValue} onReset={p.onResetValues} fonts={p.fonts} />}
        {tab === 'print' && (shown
          ? <PrintPanel parts={shown.parts.map((x) => x.name)} ai={p.aiPrint} user={p.userPrint} onChange={p.onUserPrint} bambu={p.bambu} />
          : <div className="empty-note">Print settings appear once a model is generated.</div>)}
        {tab === 'text' && <TextPanel result={shown} features={p.textFeatures} onChange={p.onTextFeatures} fonts={p.fonts} picking={p.picking} onPick={p.onPick} />}
        {tab === 'info' && <InfoTab result={shown} onExport={p.onExport} hiddenParts={p.hiddenParts} onToggleHidden={p.onToggleHidden} />}
        {tab === 'code' && <CodeTab code={p.code} error={p.error} onApply={p.onApplyCode} />}
      </div>
      <div className="export-bar">
        {shown?.bbox && (
          <div className="dims-summary mono">
            {(shown.bbox.max[0] - shown.bbox.min[0]).toFixed(2)} × {(shown.bbox.max[1] - shown.bbox.min[1]).toFixed(2)} × {(shown.bbox.max[2] - shown.bbox.min[2]).toFixed(2)} mm
          </div>
        )}
<div className="export-row">
          <button className="btn ghost validate-btn" disabled={!shown || p.validating || p.exporting} onClick={p.onValidate} title="Check the export mesh for printing problems (also runs automatically on export)">
            <Icon name="check" size={14} /> {p.validating ? 'Checking…' : 'Validate'}
          </button>
          <ExportButton disabled={!shown || p.exporting} exporting={p.exporting} onExport={(f) => p.onExport(f)} blender={p.blender}
            bambu={p.bambu} printChanges={p.printChanges} threeMf={p.threeMf} onThreeMf={p.onThreeMf} onExport3mf={p.onExport3mf}
          count={shown ? shown.parts.length - p.hiddenParts.filter((n) => shown.parts.some((x) => x.name === n)).length : 0} />
        </div>
        {p.exportError && <div className="size-note bad">{p.exportError}</div>}
      </div>
    </div>
  );
}

function ExportButton({ disabled, exporting, onExport, blender, count, bambu, printChanges, threeMf, onThreeMf, onExport3mf }: {
  disabled: boolean; exporting: boolean; onExport: (f: ExportFormat) => void; blender: string | null; count: number;
  bambu: string | null; printChanges: number; threeMf: { colours: boolean; print: boolean };
  onThreeMf: (o: { colours: boolean; print: boolean }) => void; onExport3mf: () => void;
}) {
  const [open, setOpen] = useState<false | 'menu' | '3mf'>(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const pick = (f: ExportFormat) => { setOpen(false); onExport(f); };
  const printOn = threeMf.print && !!bambu;
  return (
    <div className="export-split" ref={wrap}>
      <button className="btn primary export-main" disabled={disabled} onClick={() => onExport('stl')} title={count > 1 ? `Export ${count} parts as one STL` : 'Export STL'}>
        <Icon name="download" /> {exporting ? 'Exporting…' : 'Export STL'}
      </button>
      <button className="btn primary export-more" disabled={disabled} onClick={() => setOpen(open ? false : 'menu')} title="More formats"><Icon name="chevron" size={14} /></button>
      {open === 'menu' && (
        <div className="export-menu">
          <button onClick={() => pick('stl')}><b>STL</b><span>Single mesh, works everywhere</span></button>
          <button onClick={() => setOpen('3mf')}><b>3MF…</b><span>For Bambu Studio – choose colours (AMS) and print settings</span></button>
          <button onClick={() => pick('blend')} disabled={!blender}><b>Blender (.blend)</b><span>{blender ? `One object per part, materials, dimensions, params · Blender ${blender}` : 'Blender not found on this computer'}</span></button>
        </div>
      )}
      {open === '3mf' && (
        <div className="export-menu threemf">
          <div className="tm-title">Export 3MF for Bambu Studio</div>
          <label className="check">
            <input type="checkbox" checked={threeMf.colours} onChange={(e) => onThreeMf({ ...threeMf, colours: e.target.checked })} />
            <span><b>Colours (AMS)</b><small>One filament per part colour. Off = everything in one filament.</small></span>
          </label>
          <label className={`check ${bambu ? '' : 'off'}`}>
            <input type="checkbox" disabled={!bambu} checked={printOn} onChange={(e) => onThreeMf({ ...threeMf, print: e.target.checked })} />
            <span><b>Print settings</b><small>{!bambu ? 'Needs Bambu Studio installed on this computer.'
              : printChanges ? `A1 · PLA · 0.20 Standard with ${printChanges} changed setting${printChanges > 1 ? 's' : ''} (see the Print tab).`
                : 'A1 · PLA · 0.20 Standard profile, no changes.'}</small></span>
          </label>
          <button className="btn primary wide" onClick={() => { setOpen(false); onExport3mf(); }}><Icon name="download" size={14} /> Export 3MF</button>
        </div>
      )}
    </div>
  );
}

function OverallSize({ result, onEdit, scale, onScale }: { result: EvalResult; onEdit: Props['onEditDimension']; scale: number; onScale: (f: number) => void }) {
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const b = result.bbox;
  if (!b) return null;
  const axes = [['W', 'X'], ['D', 'Y'], ['H', 'Z']] as const;
  const edit = async (axis: 0 | 1 | 2, goal: number) => {
    setNote({ ok: true, text: `Finding the right size for ${'XYZ'[axis]}…` });
    const r = await onEdit({ kind: 'bbox', axis }, goal);
    if (!r) return;
    const label = r.key ? result.params[r.key]?.label ?? r.key : '';
    setNote(r.ok ? { ok: true, text: r.key ? `${'XYZ'[axis]} set via “${label}”` : 'Already that size' } : { ok: false, text: r.message ?? 'Not reachable' });
  };
  return (
    <section className="param-group overall">
      <h4>Overall size <span className="h4-hint">type a size, or double-click a dimension in the view</span></h4>
      <div className="size-grid">
        {axes.map(([name, ax], i) => (
          <label key={ax} className={`size-cell axis-${ax.toLowerCase()}`}>
            <span>{name} <small>{ax}</small></span>
            <CommitInput value={b.max[i] - b.min[i]} decimals={2} onCommit={(v) => edit(i as 0 | 1 | 2, v)} />
          </label>
        ))}
        <label className="size-cell">
          <span>Scale</span>
          <CommitInput value={scale * 100} decimals={1} suffix="%" onCommit={(v) => v > 0 && onScale(v / 100)} />
        </label>
      </div>
      {note && <div className={`size-note ${note.ok ? '' : 'bad'}`}>{note.text}</div>}
    </section>
  );
}

function CommitInput({ value, decimals, onCommit, suffix }: { value: number; decimals: number; onCommit: (v: number) => void; suffix?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const v = Number(draft.replace(',', '.'));
    setDraft(null);
    if (Number.isFinite(v) && Math.abs(v - value) > 1e-6) onCommit(v);
  };
  return (
    <div className="num-box">
      <input className="mono" value={draft ?? value.toFixed(decimals)} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
      <span className="unit">{suffix ?? 'mm'}</span>
    </div>
  );
}

function ParamsTab({ result, onValue, onReset, fonts }: { result: EvalResult | null; onValue: Props['onValue']; onReset: () => void; fonts: FontEntry[] }) {
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
          {items.map(([k, d]) => <ParamRow key={k} k={k} def={d} value={result.values[k]} onValue={onValue} fonts={fonts} />)}
        </section>
      ))}
      <button className="btn ghost wide" disabled={!modified} onClick={onReset}><Icon name="restore" size={14} /> Reset to AI defaults</button>
    </div>
  );
}

function ParamRow({ k, def, value: resultValue, onValue, fonts }: { k: string; def: ParamDef; value: ParamValue; onValue: Props['onValue']; fonts: FontEntry[] }) {
  // Show the user's choice immediately; the evaluated result catches up when the rebuild finishes.
  const [pending, setPending] = useState<ParamValue | undefined>(undefined);
  useEffect(() => setPending(undefined), [resultValue]);
  const value = pending ?? resultValue;
  const set = (key: string, v: ParamValue) => { setPending(v); onValue(key, v); };
  const changed = value !== def.value;
  const head = (
    <div className="param-head">
      <label title={def.description}>{def.label ?? k}{changed && <button className="mod-dot" title={`Reset to ${String(def.value)}`} onClick={() => set(k, def.value)} />}</label>
      {def.description && <span className="hint" title={def.description}>?</span>}
    </div>
  );
  if (def.type === 'boolean') {
    return (
      <div className="param bool">
        <label className="switch">
          <input type="checkbox" checked={!!value} onChange={(e) => set(k, e.target.checked)} />
          <span className="track" />
          <span className="switch-label" title={def.description}>{def.label ?? k}</span>
        </label>
        {changed && <button className="mod-dot" title="Reset" onClick={() => set(k, def.value)} />}
      </div>
    );
  }
  if (def.type === 'text') {
    return (
      <div className="param">
        {head}
        {def.font
          ? <FontPicker fonts={fonts} value={String(value)} onChange={(v) => set(k, v)} />
          : <TextValue value={String(value)} onCommit={(v) => set(k, v)} />}
      </div>
    );
  }
  if (def.type === 'select') {
    return (
      <div className="param">
        {head}
        <div className="seg">
          {def.options.length <= 4
            ? def.options.map((o) => <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => set(k, o.value)}>{o.label}</button>)
            : <select value={String(value)} onChange={(e) => set(k, e.target.value)}>{def.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}
        </div>
      </div>
    );
  }
  return (
    <div className="param">
      {head}
      <NumberControl def={def} value={Number(value)} onChange={(v) => set(k, v)} />
    </div>
  );
}

function TextValue({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // Live update while typing (debounced) – text geometry is cheap enough.
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onCommit(draft), 250);
    return () => clearTimeout(t);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  return <input className="text-param" value={draft} onChange={(e) => setDraft(e.target.value)} />;
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
  const slider = useReleaseSlider(Math.min(def.max, Math.max(def.min, value)), onChange);
  const shown = slider.dragging ? slider.shown : value;
  return (
    <div className="num-control">
      <input type="range" min={def.min} max={def.max} step={step} {...slider.inputProps} />
      <div className={`num-box ${out ? 'out' : ''}`} title={out ? `Outside the suggested range ${def.min}–${def.max}` : `${def.min} – ${def.max}`}>
        <input
          className="mono"
          value={draft ?? shown.toFixed(dec)}
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
              <button className="icon-btn" title="Export this part as STL" onClick={() => onExport('stl', p.name)}><Icon name="download" size={14} /></button>
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
