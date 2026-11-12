import { useRef, useState } from 'react';
import type { DesignVersion } from '../../shared/types';
import { usePopover } from './usePopover';
import { whenFull, whenShort } from '../lib/when';
import { versionNote } from '../lib/pictureEdit';
import { Icon } from './Icon';

interface Props {
  versions: DesignVersion[];
  current: number;
  onRestore: (index: number) => void;
  /** Start a new design from this version (its own chat and Claude session). */
  onFork: (index: number) => void;
  /** The versions marked printed: when, and whether a 3MF was saved. */
  printed: ReadonlyMap<number, { at: number; file: boolean }>;
  /** Why the shown version can't be marked printed now, or null. */
  markDisabled: string | null;
  /** Mark the shown version printed. */
  onMark: () => void;
  onUnmark: (index: number) => void;
}

/** "v2 of 5" in the top bar; opens the version list (newest first) to jump to any of them. */
export function VersionMenu({ versions, current, onRestore, onFork, printed, markDisabled, onMark, onUnmark }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  usePopover(open, () => setOpen(false), wrap);
  return (
    <div className="menu-wrap" ref={wrap}>
      <button className={`version-btn ${open ? 'on' : ''}`} title="Versions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        v{current + 1} of {versions.length}
      </button>
      {open && (
        <div className="menu left">
          {versions.map((v, i) => ({ v, i })).reverse().map(({ v, i }) => (
            <div key={i} className={`menu-item ${i === current ? 'on' : ''}`}>
              <button className="menu-open" onClick={() => { setOpen(false); if (i !== current) onRestore(i); }}>
                <span className="version-line">
                  <span className={`version-chip ${v.source}`}>v{i + 1}</span>
                  <span className="version-summary">{v.summary}</span>
                  {printed.has(i) && <span className="printed-badge" title={`Marked printed ${whenFull(printed.get(i)!.at)}: locked`}>Printed</span>}
                </span>
                <span className="dim small">
                  <time title={whenFull(v.createdAt)}>{whenShort(v.createdAt)}</time> · {versionNote(v, versions.length)}{i === current ? ' · shown now' : ''}
                </span>
              </button>
              {i === current && (printed.has(i)
                ? <button className="icon-btn printed-mark on" title={`Unmark v${i + 1}: deletes its saved 3MF and unlocks it`} aria-label={`Unmark version ${i + 1} as printed`}
                    onClick={() => { setOpen(false); onUnmark(i); }}><Icon name="printer" size={14} /></button>
                : <button className="icon-btn printed-mark" disabled={!!markDisabled} title={markDisabled ?? 'Mark as printed: saves its 3MF and locks it'} aria-label={`Mark version ${i + 1} as printed`}
                    onClick={() => { setOpen(false); onMark(); }}><Icon name="printer" size={14} /></button>)}
              <button className="icon-btn" title={`New design from v${i + 1} (a fresh chat; this design stays as it is)`} aria-label={`New design from version ${i + 1}`} onClick={() => { setOpen(false); onFork(i); }}>
                <Icon name="branch" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
