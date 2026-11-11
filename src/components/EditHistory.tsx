// The brush editors' History: the restore points of the hand edits (shared/editHistory), newest
// first, each going back to how the edits were before it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { historyTime, restorePoints, type HistoryEntry, type StrokeEdits } from '../../shared/editHistory';
import { useEscape } from './useEscape';
import { Icon } from './Icon';

interface Props<S> {
  /** The restore points, oldest first. */
  entries: HistoryEntry[];
  /** The edits as saved now, where going back starts. */
  current: StrokeEdits<S>;
  /** Why the edits before a point can't be used here, if they can't (beyond a broken chain). */
  unusable?: (edits: StrokeEdits<S>) => string | null;
  /** The edits before `entry`, to put in the editor as a draft. */
  onPick: (edits: StrokeEdits<S>, entry: HistoryEntry) => void;
}

/** The History button of a brush editor's bar, with its list. */
export function EditHistory<S>({ entries, current, unusable, onPick }: Props<S>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // (Escape closes the list, not the editor.)
  useEscape(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);
  const points = useMemo(() => (open ? restorePoints(entries, current) : []), [open, entries, current]);
  const now = Date.now();
  return (
    <div className="la-ed-history" ref={ref}>
      <button className={`la-ed-tool ${open ? 'on' : ''}`} disabled={!entries.length} aria-haspopup="menu" aria-expanded={open} aria-label="History" onClick={() => setOpen((o) => !o)}
        title={entries.length ? 'History: go back to how the hand edits were before an earlier change' : 'History: the changes made with Done show here'}>
        <Icon name="history" size={15} /><span className="la-ed-label">History</span>
      </button>
      {open && (
        <div className="la-ed-history-menu" role="menu" aria-label="Go back to before">
          <div className="la-ed-history-head small">Go back to before</div>
          {entries.map((e, i) => ({ e, i })).reverse().map(({ e, i }) => {
            const p = points[i], when = historyTime(e.at, now);
            const why = !p ? "The edits were changed since without a restore point (by the AI, say): they can't go back this far" : unusable?.(p) ?? null;
            return (
              <button key={`${e.at}-${i}`} role="menuitem" className="la-ed-history-row" disabled={!!why} title={why ?? `Go back to how the edits were before this change (${when}): Done saves it`}
                onClick={() => { setOpen(false); if (p) onPick(p, e); }}>
                <span className="mono">{when}</span><span className="la-ed-history-label">{e.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
