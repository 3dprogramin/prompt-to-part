import { useId, useState } from 'react';
import type { SurfacePlacement, TextFace } from '../../shared/textFeatures';
import { useReleaseSlider } from './useReleaseSlider';

// Controls shared by the Text and SVG tabs: where a flat shape goes on the model, and the
// sliders and segmented buttons they use.

export const FACES: [TextFace, string][] = [['top', 'Top'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['bottom', 'Bottom']];

/** Part, face or picked point, offsets and rotation. */
export function Placement({ f, parts, picking, onPick, onChange }: {
  f: SurfacePlacement; parts: string[]; picking: string | null; onPick: (id: string | null) => void; onChange: (patch: Partial<SurfacePlacement>) => void;
}) {
  return (
    <>
      <h4>Placement</h4>
      {parts.length > 1 && (
        <Row label="Part">
          <select aria-label="Part" value={f.part ?? parts[0]} onChange={(e) => onChange({ part: e.target.value })}>{parts.map((p) => <option key={p}>{p}</option>)}</select>
        </Row>
      )}
      <div className="face-grid">
        {FACES.map(([face, label]) => (
          <button key={face} className={`chip ${f.face === face ? 'on' : ''}`} aria-pressed={f.face === face} onClick={() => onChange({ face, offset: [0, 0] })}>{label}</button>
        ))}
        <button className={`chip ${picking === f.id ? 'on pulse' : f.face === 'pick' ? 'on' : ''}`} aria-pressed={f.face === 'pick'} onClick={() => onPick(picking === f.id ? null : f.id)}>
          {picking === f.id ? 'Click the model…' : 'Pick on model'}
        </button>
      </div>
      <div className="hint-line">{faceHint(f)}</div>
      <Slider label="Move right / left" unit="mm" min={-150} max={150} step={0.5} value={f.offset[0]} onChange={(v) => onChange({ offset: [v, f.offset[1]] })} />
      <Slider label="Move up / down" unit="mm" min={-150} max={150} step={0.5} value={f.offset[1]} onChange={(v) => onChange({ offset: [f.offset[0], v] })} />
      <Slider label="Rotation" unit="°" min={-180} max={180} step={1} value={f.rotation} onChange={(rotation) => onChange({ rotation })} />
    </>
  );
}

export function faceHint(f: SurfacePlacement) {
  if (f.face === 'pick') return 'Placed where you clicked; it stays on the surface when sliders change.';
  if (f.curve === 'wrap' && (f.face === 'top' || f.face === 'bottom')) return 'Wrap only works on side faces (front/back/left/right).';
  return f.face === 'top' || f.face === 'bottom' ? 'Lying flat (width × depth).' : 'Standing up on a side (width × height).';
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="t-row"><span className="t-label">{label}</span><div className="t-ctrl">{children}</div></div>;
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <div className="seg">{options.map(([v, l]) => <button key={v} className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

export function Slider({ label, unit, min, max, step, value, onChange }: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => { if (draft != null) { const v = Number(draft.replace(',', '.')); if (Number.isFinite(v)) onChange(v); setDraft(null); } };
  const slider = useReleaseSlider(Math.min(max, Math.max(min, value)), onChange);
  const shown = slider.dragging ? slider.shown : value;
  const id = useId();
  return (
    <div className="param">
      <div className="param-head"><label htmlFor={id}>{label}</label></div>
      <div className="num-control">
        <input type="range" id={id} min={min} max={max} step={step} {...slider.inputProps} />
        <div className="num-box">
          <input aria-label={`${label} (${unit})`} className="mono" value={draft ?? String(+shown.toFixed(2))} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <span className="unit">{unit}</span>
        </div>
      </div>
    </div>
  );
}
