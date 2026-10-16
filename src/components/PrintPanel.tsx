import { useState } from 'react';
import {
  A1_DEFAULTS, bambuOverrides, describeSetting, effectiveSettings, INFILL_PATTERNS, LAYER_HEIGHTS, SETTING_LABELS,
  type Brim, type PrintProfile, type PrintSettings, type Supports,
} from '../../shared/print';
import { Icon } from './Icon';
import { useReleaseSlider } from './useReleaseSlider';

type Key = keyof PrintSettings;
const KEYS: Key[] = ['layerHeight', 'walls', 'topLayers', 'bottomLayers', 'infill', 'infillPattern', 'supports', 'brim'];

interface Props {
  parts: string[];
  ai: PrintProfile;
  user: PrintProfile;
  onChange: (user: PrintProfile) => void;
  bambu: string | null;
}

/** Who decided the value shown for this key in this scope. */
function source(ai: PrintProfile, user: PrintProfile, key: Key, part: string | null): 'you' | 'ai' | 'default' {
  const get = (p: PrintProfile) => (part ? (p.parts?.[part] as PrintSettings | undefined)?.[key] ?? p[key] : p[key]);
  if (get(user) !== undefined) return 'you';
  if (get(ai) !== undefined) return 'ai';
  return 'default';
}

export function PrintPanel({ parts, ai, user, onChange, bambu }: Props) {
  const [scope, setScope] = useState<string | null>(null); // null = whole model
  const part = scope && parts.includes(scope) ? scope : null;
  const eff = effectiveSettings(ai, user, part ?? undefined);

  const own = (p: PrintProfile): PrintSettings => (part ? (p.parts?.[part] ?? {}) : p);
  const setValue = (key: Key, value: PrintSettings[Key] | undefined) => {
    const next: PrintProfile = structuredClone(user);
    if (part) {
      const ps = { ...(next.parts?.[part] ?? {}) } as PrintSettings;
      if (value === undefined) delete ps[key]; else (ps as Record<string, unknown>)[key] = value;
      next.parts = { ...(next.parts ?? {}), [part]: ps };
      if (!Object.keys(ps).length) delete next.parts[part];
      if (next.parts && !Object.keys(next.parts).length) delete next.parts;
    } else {
      if (value === undefined) delete next[key]; else (next as Record<string, unknown>)[key] = value;
    }
    onChange(next);
  };

  // What will differ from the A1 profile, per part.
  const changes = parts.map((name) => ({ name, keys: bambuOverrides(effectiveSettings(ai, user, name)) })).filter((c) => Object.keys(c.keys).length);
  const aiHasAny = Object.keys(ai).length > 0;

  return (
    <div className="print-panel">
      <div className="pp-profile">
        <b>Bambu Lab A1 · PLA · 0.20 mm Standard</b>
        <span className="dim small">Only changes from this profile go into the 3MF (tick “Print settings” when exporting).{!bambu && ' Needs Bambu Studio installed.'}</span>
      </div>

      {parts.length > 1 && (
        <div className="pp-scope">
          <button className={`chip ${part === null ? 'on' : ''}`} onClick={() => setScope(null)}>Whole model</button>
          {parts.map((n) => {
            const marked = !!(ai.parts?.[n] || user.parts?.[n]);
            return <button key={n} className={`chip ${part === n ? 'on' : ''}`} onClick={() => setScope(n)}>{n}{marked && <i className="pp-dot" />}</button>;
          })}
        </div>
      )}

      {KEYS.filter((k) => !(part && k === 'layerHeight')).map((key) => {
        const src = source(ai, user, key, part);
        const ownUser = (own(user) as PrintSettings)[key] !== undefined;
        return (
          <div className="pp-row" key={key}>
            <div className="pp-label">
              <span>{SETTING_LABELS[key]}</span>
              <span className={`pp-src ${src}`} title={src === 'default' ? `A1 default: ${describeSetting(key, A1_DEFAULTS[key])}` : undefined}>
                {src === 'you' ? 'You' : src === 'ai' ? 'AI' : 'Default'}
              </span>
              {ownUser && <button className="icon-btn pp-reset" title="Reset" onClick={() => setValue(key, undefined)}><Icon name="restore" size={12} /></button>}
            </div>
            <Control k={key} value={eff[key]} onChange={(v) => setValue(key, v)} />
          </div>
        );
      })}

      <div className="pp-summary">
        <h4>Written to the 3MF</h4>
        {changes.length === 0
          ? <div className="dim small">Nothing – the standard A1 profile is used as is.</div>
          : <ul>{changes.map((c) => (
            <li key={c.name}><b>{c.name}</b>: {Object.entries(c.keys).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')}</li>
          ))}</ul>}
      </div>
      <div className="pp-actions">
        <button className="btn ghost" disabled={!Object.keys(user).length} onClick={() => onChange({})}><Icon name="restore" size={14} /> {aiHasAny ? 'Back to AI settings' : 'Back to A1 defaults'}</button>
      </div>
    </div>
  );
}

function Control({ k, value, onChange }: { k: Key; value: PrintSettings[Key]; onChange: (v: PrintSettings[Key]) => void }) {
  switch (k) {
    case 'layerHeight':
      return <select value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>{LAYER_HEIGHTS.map((h) => <option key={h} value={h}>{h.toFixed(2)} mm{h === 0.2 ? ' (standard)' : ''}</option>)}</select>;
    case 'walls': case 'topLayers': case 'bottomLayers':
      return <Stepper value={Number(value)} min={k === 'walls' ? 1 : 0} max={k === 'walls' ? 10 : 30} onChange={onChange} />;
    case 'infill':
      return <InfillSlider value={Number(value)} onChange={onChange} />;
    case 'infillPattern':
      return <select value={String(value)} onChange={(e) => onChange(e.target.value)}>{INFILL_PATTERNS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>;
    case 'supports':
      return (
        <div className="seg">{(['off', 'normal', 'tree'] as Supports[]).map((s) => (
          <button key={s} className={value === s ? 'on' : ''} onClick={() => onChange(s)}>{describeSetting('supports', s)}</button>))}
        </div>
      );
    case 'brim': {
      const b = value as Brim;
      const width = typeof b === 'number';
      return (
        <div className="pp-brim">
          <div className="seg">
            <button className={b === 'auto' ? 'on' : ''} onClick={() => onChange('auto')}>Auto</button>
            <button className={b === 'none' ? 'on' : ''} onClick={() => onChange('none')}>None</button>
            <button className={width ? 'on' : ''} onClick={() => onChange(width ? b : 5)}>Width</button>
          </div>
          {width && <Stepper value={b} min={1} max={20} unit="mm" onChange={onChange} />}
        </div>
      );
    }
  }
}

function Stepper({ value, min, max, unit, onChange }: { value: number; min: number; max: number; unit?: string; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  return (
    <div className="pp-stepper">
      <button onClick={() => onChange(clamp(value - 1))} disabled={value <= min}>−</button>
      <span className="mono">{value}{unit ? ` ${unit}` : ''}</span>
      <button onClick={() => onChange(clamp(value + 1))} disabled={value >= max}>+</button>
    </div>
  );
}

function InfillSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const s = useReleaseSlider(value, onChange);
  return (
    <div className="num-control">
      <input type="range" min={0} max={100} step={5} {...s.inputProps} />
      <span className="mono pp-pct">{Math.round(s.shown)} %</span>
    </div>
  );
}
