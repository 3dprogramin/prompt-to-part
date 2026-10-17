import { useState } from 'react';

/** A number field in mm that commits on Enter or blur (clamped to min–max); Escape drops the edit. */
export function NumBox({ value, min, max, label, onCommit }: { value: number; min: number; max: number; label: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const v = Number(draft.replace(',', '.'));
    setDraft(null);
    if (Number.isFinite(v) && v !== value) onCommit(Math.min(max, Math.max(min, v)));
  };
  return (
    <div className="num-box">
      <input className="mono" aria-label={`${label} (mm)`} value={draft ?? String(+value.toFixed(2))} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.preventDefault(); setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
      <span className="unit">mm</span>
    </div>
  );
}
