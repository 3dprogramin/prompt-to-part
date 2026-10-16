import { useEffect } from 'react';

interface Props {
  /** Index of the version the user wants to switch to. */
  target: number;
  /** Number the settings would be saved as (vN). */
  nextVersion: number;
  onCancel: () => void;
  onDiscard: () => void;
  onSaveAndSwitch: () => void;
}

/** Asked before switching versions while slider, scale, text or print changes are unsaved. */
export function RestoreDialog({ target, nextVersion, onCancel, onDiscard, onSaveAndSwitch }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="restore-title" onClick={(e) => e.stopPropagation()} onKeyDown={trapFocus}>
        <h3 id="restore-title">Save your changes first?</h3>
        <p>Your slider, scale, text or print changes aren't saved in any version. Switching to v{target + 1} replaces them with that version's settings.</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn danger" onClick={onDiscard}>Discard changes</button>
          <button className="btn primary" autoFocus onClick={onSaveAndSwitch}>Save as v{nextVersion}, then switch</button>
        </div>
      </div>
    </div>
  );
}

/** Keeps Tab and Shift+Tab inside a modal dialog. */
function trapFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input, select, textarea')];
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
}
