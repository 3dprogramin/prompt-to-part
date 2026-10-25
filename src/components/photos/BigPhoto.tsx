// A product photo enlarged: what it was made from (scene, model, cost, render, prompt), its
// download and delete, and making it again (with a change, fresh, or in every sale size).
import { useRef, useState } from 'react';
import type { ProductPhoto } from '../../../shared/types';
import { MAX_NOTES_CHARS } from '../../../shared/photos';
import { Icon } from '../Icon';
import { DeleteButton } from './DeleteButton';
import { lookTitle, mmText, money, sceneLabel } from './photoHelpers';

/** The enlarged photo with what it was made from: scene, model, cost, the render and the prompt. */
export function BigPhoto({ photo, label, onSave, onDelete, onClose, onSwipe, onRedo, sizes }: {
  photo: ProductPhoto; label: string; onSave: () => void; onDelete: () => void; onClose: () => void; onSwipe?: (by: number) => void; onRedo?: (change: string, fromView: boolean) => void;
  /** Sale sizes: why it is out of date and a refresh; the photo in every other size; a size's photo made again from its first one. */
  sizes?: { outdated: string | null; onRefresh: () => void; onEverySize?: () => void; onRemake?: () => void; firstLabel?: string };
}) {
  const [render, setRender] = useState(false);
  // The photo's size in pixels, once it has loaded (a shop photo is 2K).
  const [pixels, setPixels] = useState<string | null>(null);
  // Redo with a change: what to change, this photo as the scene, and the product from its render or from the 3D view's angle.
  const [change, setChange] = useState('');
  const [fromView, setFromView] = useState(false);
  // A sideways swipe on a touch screen goes to the next (left) or previous (right) photo.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  return (
    <div className="ph-big" onClick={(e) => e.stopPropagation()} onKeyDown={trapFocus}
      onTouchStart={(e) => { const t = e.touches[0]; swipe.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null; }}
      onTouchEnd={(e) => {
        const from = swipe.current, t = e.changedTouches[0];
        swipe.current = null;
        if (!from || !onSwipe) return;
        const dx = t.clientX - from.x, dy = t.clientY - from.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > 2 * Math.abs(dy)) onSwipe(dx < 0 ? 1 : -1);
      }}>
      <img src={render && photo.render ? photo.render : photo.url} alt={render ? 'The render it was made from' : `Product photo: ${label}`}
        onLoad={(e) => { if (!render) setPixels(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`); }} />
      <div className="ph-big-side">
        <div className="ph-big-head">
          <b>{label}</b>
          <button className="icon-btn" autoFocus onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)"><Icon name="x" size={14} /></button>
        </div>
        {photo.change ? <div className="small">Changed: {photo.change}</div> : photo.notes && <div className="small">{photo.notes}</div>}
        {photo.shop && <div className="dim small">Shop set · {sceneLabel(photo.scene)}</div>}
        {lookTitle(photo) && <div className="dim small">{lookTitle(photo)}</div>}
        <div className="dim small">{photo.aspect}{pixels ? ` (${pixels})` : ''} · {photo.model} · {money(photo.cost)} · {new Date(photo.createdAt).toLocaleString()}</div>
        <div className="ph-big-actions">
          <button className="btn small-btn" onClick={onSave}><Icon name="download" size={13} /> Download</button>
          {photo.render && <button className="btn small-btn" aria-pressed={render} onClick={() => setRender(!render)}><Icon name="cube" size={13} /> {render ? 'Show the photo' : 'Show the render'}</button>}
          <DeleteButton label="photo" onDelete={onDelete} text />
        </div>
        {sizes?.outdated && (
          <div className="ph-outdated-note small" role="note">
            <Icon name="alert" size={12} /> Out of date: {sizes.outdated}.{' '}
            <button className="btn primary small-btn" onClick={sizes.onRefresh} title="A new photo in the same scene from a new render (the old one stays)"><Icon name="restore" size={12} /> Make it again</button>
          </div>
        )}
        {photo.sizeOf && <div className="dim small">Made from the {sizes?.firstLabel ?? 'first'} photo, in its scene{photo.dims ? `, at ${photo.dims.map(mmText).join(' × ')} mm` : ''}.</div>}
        {(sizes?.onEverySize || sizes?.onRemake) && (
          <div className="ph-big-actions">
            {sizes.onEverySize && <button className="btn small-btn" onClick={sizes.onEverySize} title="The same scene with the product in each other sale size (each from its own render)"><Icon name="ruler" size={13} /> Make it in every size</button>}
            {sizes.onRemake && <button className="btn small-btn" onClick={sizes.onRemake} title="Another try from the same first photo and render"><Icon name="restore" size={13} /> Make again from the {sizes.firstLabel ?? 'first'} photo</button>}
          </div>
        )}
        {onRedo && (
          <div className="ph-redo">
            <textarea className="text-param" rows={3} maxLength={MAX_NOTES_CHARS} value={change} onChange={(e) => setChange(e.target.value)} aria-label="What to change in this photo"
              placeholder={'What to change, e.g. "lay it flat on the table", "warmer evening light", "add a plant behind it"'}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && change.trim()) onRedo(change.trim(), fromView); }} />
            <label className="ph-redo-view small" title="To change how the product sits or is seen: turn the 3D view to that angle first (Esc closes this photo), then redo">
              <input type="checkbox" checked={fromView} onChange={(e) => setFromView(e.target.checked)} /> Product at the 3D view's current angle
            </label>
            <button className="btn primary small-btn" disabled={!change.trim()} onClick={() => onRedo(change.trim(), fromView)} title={`Make this photo again with the change (Ctrl+Enter): the same setting, the product as in the render; about $${photo.shop ? '0.10' : '0.07'}`}>
              <Icon name="camera" size={13} /> Redo with this change
            </button>
          </div>
        )}
        <details className="ph-prompt">
          <summary>Prompt</summary>
          <pre>{photo.prompt}</pre>
        </details>
      </div>
    </div>
  );
}

/** Keeps Tab and Shift+Tab inside the enlarged photo. */
function trapFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary')];
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
}
