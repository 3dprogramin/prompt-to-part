// A closer look at one picture mode's example, opened from its card in the picture mode menu:
// the print (and the picture it came from), the request that was typed and what Jig made.
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../Icon';
import { useEscape } from '../useEscape';
import type { ImageMode } from './PictureModeMenus';
import type { ModeExample } from './modeImages';

export function ModeExamplePanel({ mode, example, label, icon, unavailable, onUse, onTry, onClose }: {
  mode: ImageMode; example: ModeExample; label: string; icon: string;
  /** Why the mode can't be picked (a 3D figure without a Meshy key): "Use" is then off. */
  unavailable?: string;
  onUse: () => void; onTry: () => void; onClose: () => void;
}) {
  const titleId = useId();
  const [showSource, setShowSource] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  // Escape closes only this panel: it opened after the menu, so it is the innermost layer.
  useEscape(true, onClose);
  useEffect(() => { (unavailable ? close.current : first.current)?.focus(); }, []);
  const source = example.source;
  const big = showSource && source ? source.src : example.image ?? example.thumb;
  const alt = showSource && source ? source.caption : `What Jig made for: ${example.request}`;
  // The panel is in a portal but its React events still bubble to the menu: keys and presses stay
  // here (the menu would move its cards, close on Tab or close on a press "outside" it). Escape goes
  // on to the window, where the layers send it to this panel only.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') return;
    e.stopPropagation();
    if (e.key !== 'Tab') return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    const a = items[0], z = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === a || document.activeElement === e.currentTarget)) { e.preventDefault(); z?.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a?.focus(); }
  };
  return createPortal(
    <div className="mx-backdrop" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mx-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown} data-mode={mode}>
        <div className="mx-body">
          <div className="mx-media">
            <div className="mx-big">
              {big ? <img src={big} alt={alt} /> : <Icon name={icon} size={48} />}
            </div>
            {source && (
              <div className="mx-strip" role="group" aria-label="Pictures">
                {[{ src: example.thumb ?? example.image, label: 'The print', on: !showSource }, { src: source.src, label: source.caption, on: showSource }].map((t, i) => (
                  <button key={i} className={t.on ? 'on' : ''} aria-pressed={t.on} aria-label={t.label} title={t.label} onClick={() => setShowSource(i === 1)}>
                    {t.src && <img src={t.src} alt="" />}
                  </button>
                ))}
                <span className="mx-caption">{showSource ? source.caption : 'The print'}</span>
              </div>
            )}
          </div>
          <div className="mx-side">
            <div className="mx-head">
              <h3 id={titleId}><Icon name={icon} size={16} /> {label}</h3>
              <button ref={close} className="mx-close" aria-label="Close" title="Close (Esc)" onClick={onClose}><Icon name="x" size={14} /></button>
            </div>
            <div className="mx-label">The request</div>
            <p className="mx-request">{example.request}</p>
            <div className="mx-label">What Jig made</div>
            <ul className="mx-facts">{example.facts.map((f) => <li key={f}>{f}</li>)}</ul>
            <div className="mx-actions">
              <button ref={first} className="btn primary" disabled={!!unavailable} title={unavailable} onClick={onUse}>Use {label}</button>
              <button className="btn ghost" disabled={!!unavailable} onClick={onTry} title={unavailable ?? 'Put this request in the message box'}>Try this request</button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
