import { useState } from 'react';
import type { EvalResult } from '../../shared/types';
import { newTextFeature, type TextFace, type TextFeature } from '../../shared/textFeatures';
import type { FontEntry } from '../lib/api';
import { uid } from '../lib/files';
import { FontPicker } from './FontPicker';
import { Icon } from './Icon';
import { useReleaseSlider } from './useReleaseSlider';

interface Props {
  result: EvalResult | null;
  features: TextFeature[];
  onChange: (features: TextFeature[]) => void;
  fonts: FontEntry[];
  picking: string | null;
  onPick: (featureId: string | null) => void;
}

const FACES: [TextFace, string][] = [['top', 'Top'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['bottom', 'Bottom']];

export function TextPanel({ result, features, onChange, fonts, picking, onPick }: Props) {
  const [selected, setSelected] = useState<string | null>(features[0]?.id ?? null);
  const sel = features.find((f) => f.id === selected) ?? null;
  const parts = result?.parts.map((p) => p.name) ?? [];

  const update = (id: string, patch: Partial<TextFeature>) => onChange(features.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const add = () => {
    const f = newTextFeature(uid(), { part: parts[0] });
    onChange([...features, f]);
    setSelected(f.id);
  };
  const remove = (id: string) => {
    onChange(features.filter((f) => f.id !== id));
    if (selected === id) setSelected(null);
  };
  const duplicate = (f: TextFeature) => {
    const copy = { ...f, id: uid(), offset: [f.offset[0], f.offset[1] - f.size * 1.6] as [number, number] };
    onChange([...features, copy]);
    setSelected(copy.id);
  };

  if (!result) return <div className="empty-note">Generate a model first, then add text to it.</div>;

  return (
    <div className="text-panel">
      <div className="text-list">
        {features.map((f) => (
          <div key={f.id} className={`text-item ${f.id === selected ? 'on' : ''} ${f.enabled ? '' : 'off'}`} onClick={() => setSelected(f.id)}>
            <span className={`text-mode ${f.mode}`}>{f.mode === 'emboss' ? 'Raised' : 'Engraved'}</span>
            <span className="text-preview">{f.text.split('\n')[0] || '(empty)'}</span>
            <button className="icon-btn" title={f.enabled ? 'Hide' : 'Show'} onClick={(e) => { e.stopPropagation(); update(f.id, { enabled: !f.enabled }); }}><Icon name={f.enabled ? 'eye' : 'eyeOff'} size={14} /></button>
            <button className="icon-btn" title="Delete" onClick={(e) => { e.stopPropagation(); remove(f.id); }}><Icon name="trash" size={14} /></button>
          </div>
        ))}
        <button className="btn ghost wide" onClick={add}><Icon name="plus" size={14} /> Add text</button>
      </div>

      {sel && (
        <div className="text-editor">
          <textarea className="text-input" rows={2} value={sel.text} onChange={(e) => update(sel.id, { text: e.target.value })} placeholder="Your text (Enter for a new line)" />
          <Row label="Font"><FontPicker fonts={fonts} value={sel.font} onChange={(font) => update(sel.id, { font })} /></Row>

          <Row label="Style">
            <Seg value={sel.mode} options={[['emboss', 'Raised'], ['engrave', 'Engraved']]} onChange={(mode) => update(sel.id, { mode })} />
          </Row>
          <Slider label="Letter height" unit="mm" min={1} max={60} step={0.5} value={sel.size} onChange={(size) => update(sel.id, { size })} />
          <Slider label={sel.mode === 'emboss' ? 'Raise height' : 'Engrave depth'} unit="mm" min={0.2} max={10} step={0.1} value={sel.depth} onChange={(depth) => update(sel.id, { depth })} />

          <h4>Placement</h4>
          {parts.length > 1 && (
            <Row label="Part">
              <select value={sel.part ?? parts[0]} onChange={(e) => update(sel.id, { part: e.target.value })}>{parts.map((p) => <option key={p}>{p}</option>)}</select>
            </Row>
          )}
          <div className="face-grid">
            {FACES.map(([face, label]) => (
              <button key={face} className={`chip ${sel.face === face ? 'on' : ''}`} onClick={() => update(sel.id, { face, offset: [0, 0] })}>{label}</button>
            ))}
            <button className={`chip ${picking === sel.id ? 'on pulse' : sel.face === 'pick' ? 'on' : ''}`} onClick={() => onPick(picking === sel.id ? null : sel.id)}>
              {picking === sel.id ? 'Click the model…' : 'Pick on model'}
            </button>
          </div>
          <div className="hint-line">{faceHint(sel)}</div>
          <Slider label="Move right / left" unit="mm" min={-150} max={150} step={0.5} value={sel.offset[0]} onChange={(v) => update(sel.id, { offset: [v, sel.offset[1]] })} />
          <Slider label="Move up / down" unit="mm" min={-150} max={150} step={0.5} value={sel.offset[1]} onChange={(v) => update(sel.id, { offset: [sel.offset[0], v] })} />
          <Slider label="Rotation" unit="°" min={-180} max={180} step={1} value={sel.rotation} onChange={(rotation) => update(sel.id, { rotation })} />

          <h4>Shape</h4>
          <Row label="Curve">
            <Seg value={sel.curve} options={[['none', 'Straight'], ['arc', 'Arc'], ['wrap', 'Wrap']]} onChange={(curve) => update(sel.id, { curve })} />
          </Row>
          {sel.curve === 'arc' && <Slider label="Arc radius (− flips)" unit="mm" min={-200} max={200} step={1} value={sel.arcRadius} onChange={(arcRadius) => update(sel.id, { arcRadius: Math.abs(arcRadius) < 3 ? 3 * Math.sign(arcRadius || 1) : arcRadius })} />}
          {sel.curve === 'wrap' && <Slider label="Wrap radius (0 = auto)" unit="mm" min={0} max={200} step={0.5} value={sel.wrapRadius} onChange={(wrapRadius) => update(sel.id, { wrapRadius })} />}
          <Slider label="Letter spacing" unit="mm" min={-3} max={15} step={0.1} value={sel.letterSpacing} onChange={(letterSpacing) => update(sel.id, { letterSpacing })} />
          {sel.text.includes('\n') && (
            <>
              <Slider label="Line spacing" unit="×" min={0.8} max={3} step={0.05} value={sel.lineHeight} onChange={(lineHeight) => update(sel.id, { lineHeight })} />
              <Row label="Align"><Seg value={sel.halign} options={[['left', 'Left'], ['center', 'Center'], ['right', 'Right']]} onChange={(halign) => update(sel.id, { halign })} /></Row>
            </>
          )}
          <button className="btn ghost wide" onClick={() => duplicate(sel)}>Duplicate</button>
        </div>
      )}
      <p className="dim small text-tip">For text the tool can't do (twisted, stacked, cut through, following a path…) just ask Claude in the chat.</p>
    </div>
  );
}

function faceHint(f: TextFeature) {
  if (f.face === 'pick') return 'Placed where you clicked; it stays on the surface when sliders change.';
  if (f.curve === 'wrap' && (f.face === 'top' || f.face === 'bottom')) return 'Wrap only works on side faces (front/back/left/right).';
  return f.face === 'top' || f.face === 'bottom' ? 'Lying flat (width × depth).' : 'Standing up on a side (width × height).';
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="t-row"><span className="t-label">{label}</span><div className="t-ctrl">{children}</div></div>;
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <div className="seg">{options.map(([v, l]) => <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

function Slider({ label, unit, min, max, step, value, onChange }: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => { if (draft != null) { const v = Number(draft.replace(',', '.')); if (Number.isFinite(v)) onChange(v); setDraft(null); } };
  const slider = useReleaseSlider(Math.min(max, Math.max(min, value)), onChange);
  const shown = slider.dragging ? slider.shown : value;
  return (
    <div className="param">
      <div className="param-head"><label>{label}</label></div>
      <div className="num-control">
        <input type="range" min={min} max={max} step={step} {...slider.inputProps} />
        <div className="num-box">
          <input className="mono" value={draft ?? String(+shown.toFixed(2))} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <span className="unit">{unit}</span>
        </div>
      </div>
    </div>
  );
}
