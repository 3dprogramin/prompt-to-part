import { useState } from 'react';
import type { EvalResult } from '../../shared/types';
import { newTextFeature, type TextFeature } from '../../shared/textFeatures';
import type { FontEntry } from '../lib/api';
import { uid } from '../lib/files';
import { FontPicker } from './FontPicker';
import { Icon } from './Icon';
import { Placement, Row, Seg, Slider } from './PlacementControls';

interface Props {
  result: EvalResult | null;
  features: TextFeature[];
  onChange: (features: TextFeature[]) => void;
  fonts: FontEntry[];
  picking: string | null;
  onPick: (featureId: string | null) => void;
}

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
            <button className="text-select" aria-pressed={f.id === selected} aria-label={`Edit text "${f.text.split('\n')[0] || 'empty'}"`} onClick={(e) => { e.stopPropagation(); setSelected(f.id); }}>
              <span className={`text-mode ${f.mode}`}>{f.mode === 'emboss' ? 'Raised' : 'Engraved'}</span>
              <span className="text-preview">{f.text.split('\n')[0] || '(empty)'}</span>
            </button>
            <button className="icon-btn" title={f.enabled ? 'Hide' : 'Show'} aria-label={f.enabled ? 'Hide this text' : 'Show this text'} onClick={(e) => { e.stopPropagation(); update(f.id, { enabled: !f.enabled }); }}><Icon name={f.enabled ? 'eye' : 'eyeOff'} size={14} /></button>
            <button className="icon-btn" title="Delete" aria-label="Delete this text" onClick={(e) => { e.stopPropagation(); remove(f.id); }}><Icon name="trash" size={14} /></button>
          </div>
        ))}
        <button className="btn ghost wide" onClick={add}><Icon name="plus" size={14} /> Add text</button>
      </div>

      {sel && (
        <div className="text-editor">
          <textarea className="text-input" rows={2} aria-label="Text" value={sel.text} onChange={(e) => update(sel.id, { text: e.target.value })} placeholder="Your text (Enter for a new line)" />
          <Row label="Font"><FontPicker fonts={fonts} value={sel.font} onChange={(font) => update(sel.id, { font })} /></Row>

          <Row label="Style">
            <Seg value={sel.mode} options={[['emboss', 'Raised'], ['engrave', 'Engraved']]} onChange={(mode) => update(sel.id, { mode })} />
          </Row>
          <Slider label="Letter height" unit="mm" min={1} max={60} step={0.5} value={sel.size} onChange={(size) => update(sel.id, { size })} />
          <Slider label={sel.mode === 'emboss' ? 'Raise height' : 'Engrave depth'} unit="mm" min={0.2} max={10} step={0.1} value={sel.depth} onChange={(depth) => update(sel.id, { depth })} />

          <Placement f={sel} parts={parts} picking={picking} onPick={onPick} onChange={(patch) => update(sel.id, patch)} />

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
