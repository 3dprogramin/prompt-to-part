// The Edit panel of the picture editors: what to change (and photos of the real subject) in the
// area marked, or in the whole picture; the wait while the image model works; then the result as
// before / after with its checks and cost, to Keep, Try again or Discard.
import { useEffect, useRef, useState } from 'react';
import type { PictureEditResponse } from '../../../shared/api';
import type { PictureMark } from '../../../shared/pictureEdit/mark';
import { formatCost } from '../../../shared/duration';
import { pictureEditNotes } from '../../lib/pictureEdit';
import { prepareImage } from '../../lib/files';
import { Icon } from '../Icon';

/** The most photos sent with an edit (the server's limit), and the kinds it takes. */
const MAX_PHOTOS = 4;
const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** The longest change the server takes. */
const MAX_CHANGE = 2000;

interface Props {
  /** The area marked (none: the whole picture is edited). */
  mark: PictureMark | null;
  /** The image model is working on it. */
  busy: boolean;
  onEdit: (change: string, photos: string[]) => void;
  onCancel: () => void;
  /** The edit made, waiting for Keep, Try again or Discard. */
  result: PictureEditResponse | null;
  onKeep: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  /** Why the last edit failed (the server's words) or couldn't be kept. */
  error?: string | null;
  /** When the edit under way started (ms), for the seconds shown. */
  startedAt?: number;
  /** The result is being kept (its pictures stored). */
  keeping?: boolean;
}

export function EditPicturePanel(p: Props) {
  const [change, setChange] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!p.busy) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [p.busy]);
  const locked = p.busy || !!p.result || !!p.keeping;

  /** Photos added (file picker, paste or drop): made small enough to send, at most MAX_PHOTOS. */
  const add = async (files: File[]) => {
    const pics = files.filter((f) => PHOTO_TYPES.includes(f.type));
    if (!pics.length) { setProblem('Attach a PNG, JPEG or WebP photo'); return; }
    const room = MAX_PHOTOS - photos.length;
    try {
      const urls = await Promise.all(pics.slice(0, Math.max(0, room)).map(prepareImage));
      setPhotos((ps) => [...ps, ...urls].slice(0, MAX_PHOTOS));
      setProblem(pics.length > room ? `At most ${MAX_PHOTOS} photos` : null);
    } catch {
      setProblem('That photo could not be read');
    }
  };
  const files = (list: FileList | null | undefined) => [...(list ?? [])];

  const notes = p.result ? pictureEditNotes(p.result) : [];
  const secs = Math.max(0, Math.round((now - (p.startedAt ?? now)) / 1000));
  return (
    <section className="la-ed-edit" aria-label="Edit the picture"
      // (Photos dropped here are for the edit, not the chat.)
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); } }}
      onDrop={(e) => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); e.stopPropagation(); if (!locked) void add(files(e.dataTransfer.files)); }}>
      <div className="la-ed-edit-head"><Icon name="spark" size={14} /> {p.mark ? 'Edit this picture here' : 'Edit the whole picture'}</div>
      {p.result ? (
        <>
          <div className="la-ed-edit-compare">
            <figure><img src={p.result.before} alt="Before" /><figcaption>Before</figcaption></figure>
            <figure><img src={p.result.after} alt="After" /><figcaption>After</figcaption></figure>
          </div>
          {notes.length > 0 && (
            <ul className="la-ed-edit-checks">
              {notes.map((n, i) => <li key={i} className={n.warn ? 'warn' : ''}><Icon name={n.warn ? 'alert' : 'check'} size={13} /> {n.text}</li>)}
            </ul>
          )}
          {p.result.cost != null && <div className="la-ed-edit-cost small">Cost {formatCost(p.result.cost)}</div>}
          {p.error && <div className="la-ed-edit-note warn" role="alert"><Icon name="alert" size={13} /> {p.error}</div>}
          <div className="la-ed-edit-actions">
            <button className="btn" disabled={p.keeping} onClick={p.onDiscard} title="Drop this result">Discard</button>
            <button className="btn" disabled={p.keeping} onClick={p.onRetry} title="Ask the image model again, for the same change">Try again</button>
            <button className="btn primary" disabled={p.keeping} onClick={p.onKeep} title="Save it as a new version of the design">
              {p.keeping && <span className="spinner" />}Keep
            </button>
          </div>
        </>
      ) : (
        <>
          <textarea className="la-ed-edit-change" value={change} rows={3} maxLength={MAX_CHANGE} disabled={locked} aria-label="What to change"
            placeholder="What to change, e.g. make him look like the man in the photo"
            onChange={(e) => setChange(e.target.value)}
            onPaste={(e) => { const f = files(e.clipboardData.files); if (f.length) { e.preventDefault(); void add(f); } }} />
          {photos.length > 0 && (
            <div className="la-ed-edit-photos">
              {photos.map((src, i) => (
                <span key={i} className="la-ed-edit-photo">
                  <img src={src} alt={`Photo ${i + 1}`} />
                  {!locked && <button onClick={() => setPhotos((ps) => ps.filter((_, k) => k !== i))} title="Remove this photo" aria-label={`Remove photo ${i + 1}`}><Icon name="x" size={11} /></button>}
                </span>
              ))}
            </div>
          )}
          {problem && !locked && <div className="la-ed-edit-note warn"><Icon name="alert" size={13} /> {problem}</div>}
          {p.error && !p.busy && <div className="la-ed-edit-note warn" role="alert"><Icon name="alert" size={13} /> {p.error}</div>}
          <div className="la-ed-edit-actions">
            {p.busy ? (
              <>
                <span className="la-ed-edit-wait" role="status"><span className="spinner" /> Editing the picture... {secs} s</span>
                <button className="btn" onClick={p.onCancel} title="Stop the edit">Cancel</button>
              </>
            ) : (
              <>
                <input ref={file} type="file" accept={PHOTO_TYPES.join(',')} multiple hidden
                  onChange={(e) => { void add(files(e.target.files)); e.target.value = ''; }} />
                <button className="btn" disabled={photos.length >= MAX_PHOTOS} onClick={() => file.current?.click()}
                  title={`Photos of the real person or subject for the part changed (pick, paste or drop), at most ${MAX_PHOTOS}`}>
                  <Icon name="paperclip" size={14} />Attach photo
                </button>
                {p.error && <button className="btn" onClick={p.onRetry} title="Ask the image model again">Try again</button>}
                <button className="btn primary" disabled={!change.trim()} onClick={() => p.onEdit(change.trim(), photos)}
                  title={p.mark ? 'Change the area marked with the image model' : 'Change the whole picture with the image model'}>Edit</button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
