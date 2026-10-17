import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EvalResult, ProductPhoto, Vec3 } from '../../shared/types';
import { BACKLIT_SCENE, CUSTOM_SCENE, MAX_NOTES_CHARS, PHOTO_ASPECTS, PHOTO_SCENES, sceneById, suggestScene, type PhotoAspect, type PhotoRequest } from '../../shared/photos';
import type { PhotoView } from '../viewer/Viewer';
import { api } from '../lib/api';
import { dataUrlToImage, download, slug, uid } from '../lib/files';
import { load, store } from '../lib/storage';
import { Icon } from './Icon';
import { useEscape } from './useEscape';

/** A photo being made (or that failed), per design. */
export interface PhotoJob { id: string; designId: string; scene: string; startedAt: number; error?: string }

/** Photo requests in flight: they finish into their design even when another one is open by then. */
export function usePhotoJobs(onDone: (designId: string, photo: ProductPhoto) => void) {
  const [jobs, setJobs] = useState<PhotoJob[]>([]);
  const done = useRef(onDone);
  done.current = onDone;
  const start = (designId: string, r: PhotoRequest) => {
    const job: PhotoJob = { id: uid(), designId, scene: r.scene, startedAt: Date.now() };
    setJobs((j) => [...j, job]);
    api.photo(designId, r).then((out) => {
      setJobs((j) => j.filter((x) => x.id !== job.id));
      done.current(designId, { url: out.photo, render: out.render, scene: r.scene, notes: r.notes, aspect: r.aspect, prompt: out.prompt, model: out.model, cost: out.cost, createdAt: Date.now() });
    }, (e: Error) => setJobs((j) => j.map((x) => (x.id === job.id ? { ...x, error: e.message } : x))));
  };
  const dismiss = (id: string) => setJobs((j) => j.filter((x) => x.id !== id));
  return { jobs, start, dismiss };
}

const ASPECT_RATIO: Record<PhotoAspect, number> = { '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 };
const ASPECT_HINT: Record<PhotoAspect, string> = { '1:1': 'Square', '4:5': 'Portrait, for shop listings', '16:9': 'Wide, for banners' };
const sceneLabel = (id: string) => sceneById(id)?.label ?? 'Custom scene';
const money = (usd: number | null) => (usd == null ? 'cost unknown' : `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`);

interface Props {
  open: boolean;
  onClose: () => void;
  designId: string;
  designName: string;
  /** Claude's summary of the shown version. */
  summary?: string;
  result: EvalResult | null;
  hiddenParts: string[];
  photos: ProductPhoto[];
  onDelete: (url: string) => void;
  /** Clean render of the model (Viewer.photo). */
  capture: (view: PhotoView, aspect: number) => string | null;
  jobs: PhotoJob[];
  onStart: (r: PhotoRequest) => void;
  onDismiss: (jobId: string) => void;
  /** The image model (OPENROUTER_API_KEY set), or null. */
  imageModel: string | null;
  /** A multi-part design shown in another layout than assembled. */
  notAssembled?: boolean;
}

/** Product photos: a scene, a format and a camera; the image model turns a clean render into a photo of the print. */
export function PhotosPanel(p: Props) {
  const id = useId();
  // The scene is chosen per design (the suggested one until then); format and camera are remembered.
  const [scenes, setScenes] = useState<Record<string, { scene: string; notes: string }>>({});
  const [aspect, setAspect] = useState<PhotoAspect>(() => load('photoAspect', '4:5'));
  const [camera, setCamera] = useState<'best' | 'current'>(() => load('photoCamera', 'best'));
  useEffect(() => store('photoAspect', aspect), [aspect]);
  useEffect(() => store('photoCamera', camera), [camera]);
  const [error, setError] = useState<string | null>(null);
  const [big, setBig] = useState<ProductPhoto | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openBig = (ph: ProductPhoto) => { opener.current = document.activeElement as HTMLElement | null; setBig(ph); };
  const closeBig = () => { setBig(null); opener.current?.focus(); };
  useEscape(!!big, closeBig);
  useEscape(p.open && !big, p.onClose);
  useEffect(() => { setBig(null); setError(null); }, [p.designId]);

  const parts = useMemo(() => p.result?.parts.filter((x) => !p.hiddenParts.includes(x.name)) ?? [], [p.result, p.hiddenParts]);
  const size = useMemo((): Vec3 | null => {
    if (!parts.length) return null;
    const min = [0, 1, 2].map((k) => Math.min(...parts.map((x) => x.bbox.min[k])));
    const max = [0, 1, 2].map((k) => Math.max(...parts.map((x) => x.bbox.max[k])));
    return [0, 1, 2].map((k) => +(max[k] - min[k]).toFixed(1)) as Vec3;
  }, [parts]);
  const about = [p.designName, p.result?.meta.name, p.result?.meta.description, p.summary].filter(Boolean).join('. ');
  // A lithophane is best shown glowing.
  const lithophane = !!p.result?.parts.some((x) => x.lithophane);
  const suggested = useMemo(() => (lithophane ? BACKLIT_SCENE : suggestScene(about, size ?? undefined)), [about, size, lithophane]);
  const choice = scenes[p.designId] ?? { scene: suggested, notes: '' };
  const setChoice = (patch: Partial<typeof choice>) => setScenes((s) => ({ ...s, [p.designId]: { ...choice, ...patch } }));
  const custom = choice.scene === CUSTOM_SCENE;
  const preset = sceneById(choice.scene);
  // A flat print (wall art, a sign) goes on the wall face-on; anything else from a 3/4 angle.
  const flat = !!size && size[2] < 0.25 * Math.min(size[0], size[1]);
  const faceOn = camera === 'best' && !!preset?.wall && flat;
  const jobs = p.jobs.filter((j) => j.designId === p.designId);
  const photos = [...p.photos].reverse();
  const elapsed = useTicker(jobs.some((j) => !j.error));

  if (!p.open) return null;

  const generate = () => {
    setError(null);
    if (!size || !p.result) return setError('There is no model to photograph yet.');
    if (custom && !choice.notes.trim()) return setError('Describe the scene first.');
    let shot: string | null = null;
    try {
      shot = p.capture(camera === 'current' ? 'current' : faceOn ? 'face' : 'angle', ASPECT_RATIO[aspect]);
    } catch (e) {
      return setError(`Couldn't render the model: ${(e as Error).message}`);
    }
    if (!shot) return setError('Every part is hidden: show at least one to photograph it.');
    p.onStart({
      render: dataUrlToImage(shot),
      scene: choice.scene,
      aspect,
      notes: choice.notes.trim() || undefined,
      product: {
        name: p.result.meta.name || p.designName, description: p.summary || p.result.meta.description, size, faceOn, lithophane,
        // Per-vertex (HueForge) parts are many colours: the render shows them.
        colors: [...new Set(parts.filter((x) => !x.vertexColors).map((x) => x.color.toLowerCase()))].filter((c) => /^#[0-9a-f]{6}$/.test(c)).slice(0, 16),
      },
    });
  };

  const save = async (ph: ProductPhoto, n: number) => {
    try {
      const blob = await (await fetch(ph.url)).blob();
      const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
      download(blob, `${slug(p.designName)}-${slug(sceneLabel(ph.scene))}-${n}.${ext}`);
    } catch {
      setError('The photo could not be downloaded – is the Jig server running?');
    }
  };

  return (
    <div className="photos-panel" role="dialog" aria-labelledby={`${id}-title`}>
      <div className="vp-head">
        <div className="vp-title" id={`${id}-title`}><Icon name="camera" size={13} /> Product photos</div>
        <button className="icon-btn" onClick={p.onClose} title="Close (Esc)" aria-label="Close product photos"><Icon name="x" size={14} /></button>
      </div>
      {!p.imageModel && <div className="bad-note small" role="note">Product photos need an image model: set OPENROUTER_API_KEY in .env and restart Jig.</div>}

      <div className="ph-label" id={`${id}-scene`}>Scene</div>
      <div className="ph-scenes" role="radiogroup" aria-labelledby={`${id}-scene`}>
        {[...PHOTO_SCENES, { id: CUSTOM_SCENE, label: 'Custom…', icon: 'pen' }].map((s) => (
          <button key={s.id} role="radio" aria-checked={choice.scene === s.id} className={choice.scene === s.id ? 'on' : ''} onClick={() => setChoice({ scene: s.id })}
            title={s.id === suggested ? `${s.label} – suggested for this design` : s.label}>
            <Icon name={s.icon} size={18} />
            <span>{s.label}</span>
            {s.id === suggested && <i className="ph-suggested" aria-label="suggested">★</i>}
          </button>
        ))}
      </div>
      <textarea className="text-param ph-notes" rows={custom ? 3 : 2} maxLength={MAX_NOTES_CHARS} value={choice.notes} onChange={(e) => setChoice({ notes: e.target.value })}
        aria-label={custom ? 'Describe the scene' : 'Extra details (optional)'}
        placeholder={custom ? 'Describe the scene, e.g. "on a bedside table next to a book, warm evening lamp light"' : 'Extra details (optional), e.g. "autumn leaves around it", "evening light"'} />

      <div className="ph-row">
        <span className="ph-label" id={`${id}-aspect`}>Format</span>
        <div className="seg" role="radiogroup" aria-labelledby={`${id}-aspect`}>
          {PHOTO_ASPECTS.map((a) => <button key={a} role="radio" aria-checked={aspect === a} className={aspect === a ? 'on' : ''} title={ASPECT_HINT[a]} onClick={() => setAspect(a)}>{a}</button>)}
        </div>
      </div>
      <div className="ph-row">
        <span className="ph-label" id={`${id}-camera`}>Camera</span>
        <div className="seg" role="radiogroup" aria-labelledby={`${id}-camera`}>
          <button role="radio" aria-checked={camera === 'best'} className={camera === 'best' ? 'on' : ''} onClick={() => setCamera('best')}
            title="A product angle Jig picks (wall art face-on)">Best angle</button>
          <button role="radio" aria-checked={camera === 'current'} className={camera === 'current' ? 'on' : ''} onClick={() => setCamera('current')}
            title="The angle you turned the 3D view to">Current view</button>
        </div>
      </div>

      <button className="btn primary wide" disabled={!p.imageModel || !size} onClick={generate}>
        <Icon name="camera" size={14} /> Generate photo
      </button>
      <div className="dim small ph-note">{p.imageModel ?? 'Image model'} · about $0.04–0.07 and 10–30 s each · the photo is made from a clean render of the model as shown (hidden parts stay hidden).</div>
      {p.notAssembled && <div className="dim small">Tip: the photo shows the parts as laid out in the view – choose <b>Assembled</b> below the view for the finished object.</div>}
      {error && <div className="bad-note small" role="alert">{error}</div>}

      {(jobs.length > 0 || photos.length > 0) && <div className="ph-label ph-gallery-head">Photos{photos.length ? ` (${photos.length})` : ''}</div>}
      <div className="ph-gallery">
        {jobs.map((j) => (
          <div key={j.id} className={`ph-tile pending ${j.error ? 'failed' : ''}`} role={j.error ? 'alert' : 'status'}>
            {j.error
              ? <><Icon name="alert" size={16} /><span className="small">{sceneLabel(j.scene)}: {j.error}</span>
                <button className="link" onClick={() => p.onDismiss(j.id)}>Dismiss</button></>
              : <><span className="spinner" /><span className="small">{sceneLabel(j.scene)}</span>
                <span className="dim small mono">{Math.max(0, Math.round((elapsed - j.startedAt) / 1000))} s</span></>}
          </div>
        ))}
        {photos.map((ph, i) => (
          <div key={ph.url + ph.createdAt} className="ph-tile">
            <button className="ph-thumb" onClick={() => openBig(ph)} aria-label={`${sceneLabel(ph.scene)} photo – enlarge`}>
              <img src={ph.url} alt="" loading="lazy" />
            </button>
            <div className="ph-tile-bar">
              <span className="small" title={ph.notes}>{sceneLabel(ph.scene)}</span>
              <button className="icon-btn" onClick={() => void save(ph, photos.length - i)} title="Download" aria-label={`Download the ${sceneLabel(ph.scene)} photo`}><Icon name="download" size={13} /></button>
              <DeleteButton label={`${sceneLabel(ph.scene)} photo`} onDelete={() => p.onDelete(ph.url)} />
            </div>
          </div>
        ))}
      </div>

      {/* On the page itself: the panel's backdrop blur would make it the box a fixed overlay fills. */}
      {big && createPortal(
        <div className="lightbox ph-lightbox" role="dialog" aria-modal="true" aria-label="Product photo" onClick={closeBig}>
          <BigPhoto photo={big} onSave={() => void save(big, photos.length - photos.indexOf(big))} onDelete={() => { p.onDelete(big.url); closeBig(); }} onClose={closeBig} />
        </div>,
        document.body,
      )}
    </div>
  );
}

/** The enlarged photo with what it was made from: scene, model, cost, the render and the prompt. */
function BigPhoto({ photo, onSave, onDelete, onClose }: { photo: ProductPhoto; onSave: () => void; onDelete: () => void; onClose: () => void }) {
  const [render, setRender] = useState(false);
  return (
    <div className="ph-big" onClick={(e) => e.stopPropagation()} onKeyDown={trapFocus}>
      <img src={render && photo.render ? photo.render : photo.url} alt={render ? 'The render it was made from' : `Product photo: ${sceneLabel(photo.scene)}`} />
      <div className="ph-big-side">
        <div className="ph-big-head">
          <b>{sceneLabel(photo.scene)}</b>
          <button className="icon-btn" autoFocus onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)"><Icon name="x" size={14} /></button>
        </div>
        {photo.notes && <div className="small">{photo.notes}</div>}
        <div className="dim small">{photo.aspect} · {photo.model} · {money(photo.cost)} · {new Date(photo.createdAt).toLocaleString()}</div>
        <div className="ph-big-actions">
          <button className="btn small-btn" onClick={onSave}><Icon name="download" size={13} /> Download</button>
          {photo.render && <button className="btn small-btn" aria-pressed={render} onClick={() => setRender(!render)}><Icon name="cube" size={13} /> {render ? 'Show the photo' : 'Show the render'}</button>}
          <DeleteButton label="photo" onDelete={onDelete} text />
        </div>
        <details className="ph-prompt">
          <summary>Prompt</summary>
          <pre>{photo.prompt}</pre>
        </details>
      </div>
    </div>
  );
}

/** Delete, confirmed by a second click within a few seconds. */
function DeleteButton({ label, onDelete, text }: { label: string; onDelete: () => void; text?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const click = () => (armed ? onDelete() : setArmed(true));
  if (text) return <button className={`btn small-btn ${armed ? 'danger' : ''}`} onClick={click}><Icon name="trash" size={13} /> {armed ? 'Click again to delete' : 'Delete'}</button>;
  return (
    <button className={`icon-btn ${armed ? 'ph-armed' : ''}`} onClick={click} title={armed ? 'Click again to delete' : 'Delete'} aria-label={armed ? `Click again to delete the ${label}` : `Delete the ${label}`}>
      <Icon name={armed ? 'check' : 'trash'} size={13} />
    </button>
  );
}

/** Date.now(), updated every half second while `on`. */
function useTicker(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** Keeps Tab and Shift+Tab inside the enlarged photo. */
function trapFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary')];
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
}
