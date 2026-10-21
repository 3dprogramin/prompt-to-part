import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EvalResult, ProductPhoto, Vec3 } from '../../shared/types';
import { BACKLIT_SCENE, CUSTOM_SCENE, MAIN_SCENES, MAX_NOTES_CHARS, PHOTO_ASPECTS, PHOTO_SCENES, SHOP_SHOT_LABELS, SHOP_SHOTS, sceneById, shopPlan, suggestScene, type PhotoAspect, type PhotoRequest, type ShopShot } from '../../shared/photos';
import type { PhotoView } from '../viewer/Viewer';
import { api } from '../lib/api';
import { dataUrlToImage, download, slug, uid } from '../lib/files';
import { load, store } from '../lib/storage';
import { Icon } from './Icon';
import { useEscape } from './useEscape';

/** A photo being made (or waiting its turn, or that failed), per design. */
export interface PhotoJob {
  id: string; designId: string; scene: string; startedAt: number; error?: string; change?: string;
  /** A shop set's photo: its shot, its set and how many photos the set has. */
  shop?: ShopShot; set?: string; setSize?: number;
  /** Waiting for an earlier photo of its set to finish. */
  waiting?: boolean;
  /** What was asked for, to try again after a failure. */
  request: PhotoRequest;
}

/** How many of a shop set's photos are made at the same time. */
const SHOP_PARALLEL = 2;

/** Photo requests in flight: they finish into their design even when another one is open by then. */
export function usePhotoJobs(onDone: (designId: string, photo: ProductPhoto) => void) {
  const [jobs, setJobs] = useState<PhotoJob[]>([]);
  const done = useRef(onDone);
  done.current = onDone;
  const patch = (id: string, change: Partial<PhotoJob>) => setJobs((j) => j.map((x) => (x.id === id ? { ...x, ...change } : x)));
  const newJob = (designId: string, r: PhotoRequest, set?: { id: string; size: number }): PhotoJob =>
    ({ id: uid(), designId, scene: r.scene, startedAt: Date.now(), change: r.change, request: r, ...(r.shop ? { shop: r.shop } : {}), ...(set ? { set: set.id, setSize: set.size } : {}) });
  // Settles either way: the photo goes into its design, or the job shows the error.
  const run = (job: PhotoJob): Promise<void> => {
    const r = job.request;
    return api.photo(job.designId, r).then((out) => {
      setJobs((j) => j.filter((x) => x.id !== job.id));
      done.current(job.designId, { url: out.photo, render: out.render, scene: r.scene, notes: r.notes, ...(r.from ? { editOf: r.from.photo, change: r.change } : {}), ...(r.shop ? { shop: r.shop } : {}), aspect: r.aspect, prompt: out.prompt, model: out.model, cost: out.cost, createdAt: Date.now() });
    }, (e: Error) => patch(job.id, { error: e.message }));
  };
  const start = (designId: string, r: PhotoRequest) => {
    const job = newJob(designId, r);
    setJobs((j) => [...j, job]);
    void run(job);
  };
  // A shop set: its photos in order, a few at a time, each landing in the design as it is made (a
  // failed one doesn't stop the others).
  const startSet = (designId: string, rs: PhotoRequest[]) => {
    const set = { id: uid(), size: rs.length };
    const queue = rs.map((r) => ({ ...newJob(designId, r, set), waiting: true }));
    setJobs((j) => [...j, ...queue]);
    let next = 0;
    const pump = () => {
      const job = queue[next++];
      if (!job) return;
      const startedAt = Date.now();
      patch(job.id, { waiting: false, startedAt });
      void run({ ...job, startedAt }).then(pump);
    };
    for (let i = 0; i < SHOP_PARALLEL; i++) pump();
  };
  // A failed photo, asked for again.
  const retry = (id: string) => {
    const job = jobs.find((x) => x.id === id);
    if (!job?.error) return;
    const again = { ...job, error: undefined, waiting: false, startedAt: Date.now() };
    patch(id, { error: undefined, startedAt: again.startedAt });
    void run(again);
  };
  const dismiss = (id: string) => setJobs((j) => j.filter((x) => x.id !== id));
  return { jobs, start, startSet, retry, dismiss };
}

const ASPECT_RATIO: Record<PhotoAspect, number> = { '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 };
const ASPECT_HINT: Record<PhotoAspect, string> = { '1:1': 'Square', '4:5': 'Portrait, for shop listings', '16:9': 'Wide, for banners' };
const sceneLabel = (id: string) => sceneById(id)?.label ?? 'Custom scene';
const shopShot = (shot?: string) => (SHOP_SHOTS as readonly string[]).includes(shot ?? '') ? shot as ShopShot : undefined;
/** A photo's name: its scene, or for a shop set's photo its shot. */
const photoLabel = (scene: string, shop?: string) => { const s = shopShot(shop); return s ? `Shop · ${SHOP_SHOT_LABELS[s]}` : sceneLabel(scene); };
/** A shop photo's place in the set, for its file name (the order a listing shows them in). */
const SHOP_ORDER: Record<ShopShot, number> = { main: 1, angle: 2, top: 3, detail: 3, lifestyle: 4, size: 5 };
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
  /** A shop set: its photos, made a few at a time. */
  onStartSet: (rs: PhotoRequest[]) => void;
  onRetry: (jobId: string) => void;
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
  const [allScenes, setAllScenes] = useState(false);
  const [aspect, setAspect] = useState<PhotoAspect>(() => load('photoAspect', '4:5'));
  const [camera, setCamera] = useState<'best' | 'current'>(() => load('photoCamera', 'best'));
  useEffect(() => store('photoAspect', aspect), [aspect]);
  useEffect(() => store('photoCamera', camera), [camera]);
  const [error, setError] = useState<string | null>(null);
  // The shop set's renders being taken (1-based), before its photos are asked for.
  const [rendering, setRendering] = useState<number | null>(null);
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
  // The scenes after the first few show on "More scenes", or right away when one of them is picked or suggested.
  const expanded = allScenes || [choice.scene, suggested].some((x) => PHOTO_SCENES.findIndex((sc) => sc.id === x) >= MAIN_SCENES);
  const shownScenes = expanded ? PHOTO_SCENES : PHOTO_SCENES.slice(0, MAIN_SCENES);
  // A flat print (wall art, a sign, an ornament on the tree) is shown face-on; anything else from a 3/4 angle.
  const flat = !!size && size[2] < 0.25 * Math.min(size[0], size[1]);
  const faceOn = camera === 'best' && !!(preset?.wall || preset?.hang) && flat;
  const jobs = p.jobs.filter((j) => j.designId === p.designId);
  // A shop set still being made: how many of its photos have landed.
  const setJob = jobs.find((j) => j.set && !j.error);
  const setLeft = setJob ? jobs.filter((j) => j.set === setJob.set).length : 0;
  const shopProgress = setJob ? `${setJob.setSize! - setLeft} / ${setJob.setSize}` : null;
  const photos = [...p.photos].reverse();
  // The enlarged photo's neighbours: the arrow buttons, ← and →, or a swipe; at either end it wraps around.
  const step = (by: number) => setBig((b) => {
    const i = b ? photos.findIndex((ph) => ph.url === b.url) : -1;
    return i < 0 ? b : photos[(i + by + photos.length) % photos.length];
  });
  useEffect(() => {
    if (!big || photos.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const elapsed = useTicker(jobs.some((j) => !j.error && !j.waiting));

  if (!p.open) return null;

  // What the image model is told about the product (name, size, colours).
  const product = (): PhotoRequest['product'] | null => (!size || !p.result ? null : {
    name: p.result.meta.name || p.designName, description: p.summary || p.result.meta.description, size, faceOn, lithophane,
    // Per-vertex (LayerTone) parts are many colours: the render shows them.
    // A coloured mesh's part: its filaments' colours.
    colors: [...new Set(parts.filter((x) => !x.vertexColors).flatMap((x) => (x.paint ? x.paint.filaments.map((f) => f.color) : [x.color])).map((c) => c.toLowerCase()))].filter((c) => /^#[0-9a-f]{6}$/.test(c)).slice(0, 16),
  });
  // A photo made again with a change (the photo and its render go to the image model).
  // `fromView`: the product from a new render at the 3D view's current angle (to change how it sits).
  const redo = (ph: ProductPhoto, change: string, fromView: boolean) => {
    const prod = product();
    if (!prod) return setError('There is no model to describe the product with yet.');
    setError(null);
    const shape = (PHOTO_ASPECTS as readonly string[]).includes(ph.aspect) ? ph.aspect as PhotoAspect : aspect;
    let shot: string | null = null;
    if (fromView) {
      try { shot = p.capture('current', ASPECT_RATIO[shape]); } catch (e) { return setError(`Couldn't render the model: ${(e as Error).message}`); }
      if (!shot) return setError('Every part is hidden: show at least one to photograph it.');
    }
    // A shop photo stays one (2K, its shot); its product as it was shown (face-on or not).
    const shop = shopShot(ph.shop);
    if (shop) prod.faceOn = shopPlan({ size: prod.size, suggested }).find((x) => x.shot === shop)?.faceOn ?? false;
    p.onStart({ from: { photo: ph.url, ...(ph.render ? { render: ph.render } : {}) }, ...(shot ? { render: dataUrlToImage(shot) } : {}), change, scene: ph.scene, aspect: shape, notes: ph.notes, ...(shop ? { shop } : {}), product: prod });
    closeBig();
  };

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
      product: product()!,
    });
  };

  // Shop photos: a set of square 2K listing photos in one click (shopPlan), each from its own render
  // (the image model keeps the render's angle), taken one by one so the panel shows how far it got.
  // The view's own camera is never moved: the renders use a camera of their own.
  const shopSet = async () => {
    setError(null);
    const prod = product();
    if (!size || !prod) return setError('There is no model to photograph yet.');
    const plan = shopPlan({ size, suggested });
    const rs: PhotoRequest[] = [];
    try {
      for (const [i, item] of plan.entries()) {
        setRendering(i + 1);
        await new Promise((r) => setTimeout(r, 30));
        let shot: string | null;
        try {
          shot = p.capture(item.camera, 1);
        } catch (e) {
          return setError(`Couldn't render the model: ${(e as Error).message}`);
        }
        if (!shot) return setError('Every part is hidden: show at least one to photograph it.');
        rs.push({ render: dataUrlToImage(shot), scene: item.scene, aspect: '1:1', shop: item.shot, product: { ...prod, faceOn: item.faceOn } });
      }
    } finally {
      setRendering(null);
    }
    p.onStartSet(rs);
  };

  const save = async (ph: ProductPhoto, n: number) => {
    try {
      const blob = await (await fetch(ph.url)).blob();
      const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
      const shop = shopShot(ph.shop);
      download(blob, shop ? `${slug(p.designName)}-shop-${SHOP_ORDER[shop]}-${shop}-${n}.${ext}` : `${slug(p.designName)}-${slug(sceneLabel(ph.scene))}-${n}.${ext}`);
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
        {[...shownScenes, { id: CUSTOM_SCENE, label: 'Custom…', icon: 'pen' }].map((s) => (
          <button key={s.id} role="radio" aria-checked={choice.scene === s.id} className={choice.scene === s.id ? 'on' : ''} onClick={() => setChoice({ scene: s.id })}
            title={s.id === suggested ? `${s.label} – suggested for this design` : s.label}>
            <Icon name={s.icon} size={18} />
            <span>{s.label}</span>
            {s.id === suggested && <i className="ph-suggested" aria-label="suggested">★</i>}
          </button>
        ))}
      </div>
      {!expanded && (
        <button className="ph-more" onClick={() => setAllScenes(true)}>More scenes ({PHOTO_SCENES.length - MAIN_SCENES} more)</button>
      )}
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
      <button className="btn wide ph-shop" disabled={!p.imageModel || !size || rendering != null || !!shopProgress} onClick={() => void shopSet()}
        title="5 square photos at 2K for a shop listing: main (front), 3/4 view, detail or top view in a light grey studio, a lifestyle photo and a size photo">
        <Icon name="tag" size={14} /> {rendering != null ? `Rendering ${rendering} / 5…` : shopProgress ? `Making shop photos · ${shopProgress}` : 'Shop photos'}
      </button>
      <div className="dim small ph-note">Shop photos: 5 square photos at 2K (2048 × 2048) for a listing, the studio ones in the same light grey studio for every product · about $0.50 and 1 to 2 min a set · the scene and details above don't apply.</div>
      {p.notAssembled && <div className="dim small">Tip: the photo shows the parts as laid out in the view – choose <b>Assembled</b> below the view for the finished object.</div>}
      {error && <div className="bad-note small" role="alert">{error}</div>}

      {(jobs.length > 0 || photos.length > 0) && <div className="ph-label ph-gallery-head">Photos{photos.length ? ` (${photos.length})` : ''}</div>}
      <div className="ph-gallery">
        {jobs.map((j) => (
          <div key={j.id} className={`ph-tile pending ${j.error ? 'failed' : ''}`} role={j.error ? 'alert' : 'status'}>
            {j.error
              ? <><Icon name="alert" size={16} /><span className="small">{photoLabel(j.scene, j.shop)}: {j.error}</span>
                <span className="ph-job-actions">
                  {p.imageModel && <button className="link" onClick={() => p.onRetry(j.id)}>Try again</button>}
                  <button className="link" onClick={() => p.onDismiss(j.id)}>Dismiss</button>
                </span></>
              : <><span className="spinner" /><span className="small" title={j.change ?? (j.shop ? sceneLabel(j.scene) : undefined)}>{photoLabel(j.scene, j.shop)}{j.change ? ' · changed' : ''}</span>
                <span className="dim small mono">{j.waiting ? 'waiting' : `${Math.max(0, Math.round((elapsed - j.startedAt) / 1000))} s`}</span></>}
          </div>
        ))}
        {photos.map((ph, i) => (
          <div key={ph.url + ph.createdAt} className="ph-tile">
            <button className="ph-thumb" onClick={() => openBig(ph)} aria-label={`${photoLabel(ph.scene, ph.shop)} photo, enlarge`}>
              <img src={ph.url} alt="" loading="lazy" />
            </button>
            <div className="ph-tile-bar">
              <span className="small" title={ph.change ?? ph.notes ?? (ph.shop ? sceneLabel(ph.scene) : undefined)}>{photoLabel(ph.scene, ph.shop)}{ph.editOf ? ' · changed' : ''}</span>
              <button className="icon-btn" onClick={() => void save(ph, photos.length - i)} title="Download" aria-label={`Download the ${photoLabel(ph.scene, ph.shop)} photo`}><Icon name="download" size={13} /></button>
              <DeleteButton label={`${photoLabel(ph.scene, ph.shop)} photo`} onDelete={() => p.onDelete(ph.url)} />
            </div>
          </div>
        ))}
      </div>

      {/* On the page itself: the panel's backdrop blur would make it the box a fixed overlay fills. */}
      {big && createPortal(
        <div className="lightbox ph-lightbox" role="dialog" aria-modal="true" aria-label="Product photo" onClick={closeBig}>
          <BigPhoto key={big.url} photo={big} onSave={() => void save(big, photos.length - photos.indexOf(big))} onDelete={() => { p.onDelete(big.url); closeBig(); }} onClose={closeBig}
            onRedo={p.imageModel ? (change, fromView) => redo(big, change, fromView) : undefined}
            onSwipe={photos.length > 1 ? step : undefined} />
          {photos.length > 1 && <>
            <button className="lightbox-nav prev" onClick={(e) => { e.stopPropagation(); step(-1); }} title="Previous photo (←)" aria-label="Previous photo"><Icon name="chevron" size={20} /></button>
            <button className="lightbox-nav next" onClick={(e) => { e.stopPropagation(); step(1); }} title="Next photo (→)" aria-label="Next photo"><Icon name="chevron" size={20} /></button>
            <div className="lightbox-count" aria-live="polite">{photos.findIndex((ph) => ph.url === big.url) + 1} / {photos.length}</div>
          </>}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** The enlarged photo with what it was made from: scene, model, cost, the render and the prompt. */
function BigPhoto({ photo, onSave, onDelete, onClose, onSwipe, onRedo }: { photo: ProductPhoto; onSave: () => void; onDelete: () => void; onClose: () => void; onSwipe?: (by: number) => void; onRedo?: (change: string, fromView: boolean) => void }) {
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
      <img src={render && photo.render ? photo.render : photo.url} alt={render ? 'The render it was made from' : `Product photo: ${photoLabel(photo.scene, photo.shop)}`}
        onLoad={(e) => { if (!render) setPixels(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`); }} />
      <div className="ph-big-side">
        <div className="ph-big-head">
          <b>{photoLabel(photo.scene, photo.shop)}</b>
          <button className="icon-btn" autoFocus onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)"><Icon name="x" size={14} /></button>
        </div>
        {photo.change ? <div className="small">Changed: {photo.change}</div> : photo.notes && <div className="small">{photo.notes}</div>}
        {photo.shop && <div className="dim small">Shop set · {sceneLabel(photo.scene)}</div>}
        <div className="dim small">{photo.aspect}{pixels ? ` (${pixels})` : ''} · {photo.model} · {money(photo.cost)} · {new Date(photo.createdAt).toLocaleString()}</div>
        <div className="ph-big-actions">
          <button className="btn small-btn" onClick={onSave}><Icon name="download" size={13} /> Download</button>
          {photo.render && <button className="btn small-btn" aria-pressed={render} onClick={() => setRender(!render)}><Icon name="cube" size={13} /> {render ? 'Show the photo' : 'Show the render'}</button>}
          <DeleteButton label="photo" onDelete={onDelete} text />
        </div>
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
