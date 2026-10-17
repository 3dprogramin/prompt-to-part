import { useRef, useState } from 'react';
import type { EvalResult } from '../../shared/types';
import { defaultColors, drawingColors, newSvgFeature, type SvgFeature } from '../../shared/svgFeatures';
import { importSvg } from '../lib/svg';
import { uid } from '../lib/files';
import { Icon } from './Icon';
import { Placement, Row, Seg, Slider } from './PlacementControls';

interface Props {
  result: EvalResult | null;
  features: SvgFeature[];
  onChange: (features: SvgFeature[]) => void;
  picking: string | null;
  onPick: (featureId: string | null) => void;
}

/** SVG tab: logos and artwork from SVG files, raised or engraved on the model like text. */
export function SvgPanel({ result, features, onChange, picking, onPick }: Props) {
  const [selected, setSelected] = useState<string | null>(features[0]?.id ?? null);
  // What an import left out, per drawing (shown until the page reloads).
  const [notes, setNotes] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const sel = features.find((f) => f.id === selected) ?? null;
  const parts = result?.parts.map((p) => p.name) ?? [];

  const update = (id: string, patch: Partial<SvgFeature>) => onChange(features.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const add = async (files: FileList | null) => {
    const f0 = files?.[0];
    if (!f0) return;
    setError(null);
    try {
      if (f0.size > 5 * 2 ** 20) throw new Error('This SVG is over 5 MB.');
      const { drawing, notes: n } = importSvg(await f0.text(), f0.name);
      // Start at a sensible size: 20 mm high, or narrower for very wide drawings.
      const size = Math.max(2, Math.min(20, +(60 / drawing.aspect).toFixed(1)));
      const f = newSvgFeature(uid(), drawing, { part: parts[0], size, colors: defaultColors(drawing) });
      onChange([...features, f]);
      setSelected(f.id);
      setNotes((m) => ({ ...m, [f.id]: n }));
    } catch (e) {
      setError(`${f0.name}: ${(e as Error).message}`);
    }
  };
  const remove = (id: string) => {
    onChange(features.filter((f) => f.id !== id));
    if (selected === id) setSelected(null);
  };
  const duplicate = (f: SvgFeature) => {
    const copy = { ...f, id: uid(), offset: [f.offset[0] + f.size * f.drawing.aspect * 1.2, f.offset[1]] as [number, number] };
    onChange([...features, copy]);
    setSelected(copy.id);
  };

  if (!result) return <div className="empty-note">Generate a model first, then add SVG drawings to it.</div>;

  return (
    <div className="text-panel">
      <div className="text-list">
        {features.map((f) => (
          <div key={f.id} className={`text-item ${f.id === selected ? 'on' : ''} ${f.enabled ? '' : 'off'}`} onClick={() => setSelected(f.id)}>
            <button className="text-select" aria-pressed={f.id === selected} aria-label={`Edit SVG "${f.drawing.name}"`} onClick={(e) => { e.stopPropagation(); setSelected(f.id); }}>
              <span className={`text-mode ${f.mode}`}>{f.mode === 'emboss' ? 'Raised' : 'Engraved'}</span>
              <span className="text-preview">{f.drawing.name}</span>
            </button>
            <button className="icon-btn" title={f.enabled ? 'Hide' : 'Show'} aria-label={f.enabled ? 'Hide this drawing' : 'Show this drawing'} onClick={(e) => { e.stopPropagation(); update(f.id, { enabled: !f.enabled }); }}><Icon name={f.enabled ? 'eye' : 'eyeOff'} size={14} /></button>
            <button className="icon-btn" title="Delete" aria-label="Delete this drawing" onClick={(e) => { e.stopPropagation(); remove(f.id); }}><Icon name="trash" size={14} /></button>
          </div>
        ))}
        <button className="btn ghost wide" onClick={() => file.current?.click()}><Icon name="plus" size={14} /> Add SVG…</button>
        <input ref={file} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        {error && <div className="bad-note small" role="alert">{error}</div>}
      </div>

      {sel && (
        <div className="text-editor">
          {notes[sel.id]?.length ? <ul className="svg-notes small">{notes[sel.id].map((n, i) => <li key={i}><Icon name="alert" size={12} /> {n}</li>)}</ul> : null}
          <Row label="Style">
            <Seg value={sel.mode} options={[['emboss', 'Raised'], ['engrave', 'Engraved']]} onChange={(mode) => update(sel.id, { mode })} />
          </Row>
          {drawingColors(sel.drawing).length > 1 && <Colours f={sel} onChange={(colors) => update(sel.id, { colors })} />}
          <Slider label="Height" unit="mm" min={1} max={200} step={0.5} value={sel.size} onChange={(size) => update(sel.id, { size })} />
          <div className="hint-line">Width {(sel.size * sel.drawing.aspect).toFixed(1)} mm (the drawing keeps its proportions).</div>
          <Slider label={sel.mode === 'emboss' ? 'Raise height' : 'Engrave depth'} unit="mm" min={0.2} max={10} step={0.1} value={sel.depth} onChange={(depth) => update(sel.id, { depth })} />

          <Placement f={sel} parts={parts} picking={picking} onPick={onPick} onChange={(patch) => update(sel.id, patch)} />

          <h4>Shape</h4>
          <Row label="Curve">
            <Seg value={sel.curve === 'wrap' ? 'wrap' : 'none'} options={[['none', 'Flat'], ['wrap', 'Wrap']]} onChange={(curve) => update(sel.id, { curve })} />
          </Row>
          {sel.curve === 'wrap' && <Slider label="Wrap radius (0 = auto)" unit="mm" min={0} max={200} step={0.5} value={sel.wrapRadius} onChange={(wrapRadius) => update(sel.id, { wrapRadius })} />}
          <button className="btn ghost wide" onClick={() => duplicate(sel)}>Duplicate</button>
        </div>
      )}
      <p className="dim small text-tip">Filled shapes are imported; strokes, text and pictures inside the SVG are not (convert them to paths first). Details thinner than about 0.8 mm may not print.</p>
    </div>
  );
}

/** Which of the drawing's colours make the shape; colours painted on top of them cut it. */
function Colours({ f, onChange }: { f: SvgFeature; onChange: (colors: string[] | undefined) => void }) {
  const all = drawingColors(f.drawing);
  const on = f.colors ?? all;
  const toggle = (c: string) => {
    const next = on.includes(c) ? on.filter((x) => x !== c) : all.filter((x) => on.includes(x) || x === c);
    onChange(next.length === all.length ? undefined : next);
  };
  return (
    <div className="param">
      <div className="param-head"><span className="param-label">Colours to {f.mode === 'emboss' ? 'raise' : 'engrave'}</span></div>
      <div className="svg-colours" role="group" aria-label={`Colours to ${f.mode === 'emboss' ? 'raise' : 'engrave'}`}>
        {all.map((c) => (
          <button key={c} className={`chip ${on.includes(c) ? 'on' : ''}`} aria-pressed={on.includes(c)} title={c} onClick={() => toggle(c)}>
            <span className="swatch" style={{ background: /^(#|rgb|[a-z]+$)/.test(c) ? c : 'transparent' }} /> {c.startsWith('url(') ? 'gradient' : c || 'unset'}
          </button>
        ))}
      </div>
      <div className="hint-line">Colours painted on top of the chosen ones cut through them, as in the drawing.</div>
    </div>
  );
}

