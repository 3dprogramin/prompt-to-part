import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EvalResult, ProductPhoto, Vec3 } from '../../shared/types';
import { BACKLIT_SCENE, CUSTOM_SCENE, IDEA_SCENE, MAX_NOTES_CHARS, PHOTO_ASPECTS, PHOTO_SCENES, SCENE_VARIANTS, SHOP_SHOT_LABELS, SHOP_SHOTS, sceneById, sceneKind, shopPlan, subScenes, suggestScene, variantName, writtenPlace, type PhotoAspect, type PhotoRequest, type ScaleRef, type SceneIdea, type SceneVariant, type ShopShot, type TrueScale } from '../../shared/photos';
import type { PhotoView } from '../viewer/Viewer';
import { mainAxis } from '../../shared/sizes';
import { api } from '../lib/api';
import { dataUrlToImage, download, slug, uid } from '../lib/files';
import { pickIds } from '../lib/picking';
import { load, store } from '../lib/storage';
import { foldText } from '../../shared/tags';
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
  /** A set of photos for every sale size rather than a shop set. */
  sizes?: boolean;
  /** Another size's photo made from this one (its job id), which failed: it waits for that one. */
  after?: string;
  /** The camera of its render (stored with the photo). */
  camera?: string;
  /** The design's shape it is made of (stored with the photo). */
  shape?: string;
}

/** Photos for every sale size from one scene: the first (made first, unless it exists) and the other sizes made from it. */
export interface SizeGroup {
  base: { url: string } | { request: PhotoRequest };
  /** Their `from.photo` is filled in once the first photo is made. */
  variants: PhotoRequest[];
  camera?: string;
}

/** How many of a shop set's photos are made at the same time. */
const SHOP_PARALLEL = 2;

/** Photo requests in flight: they finish into their design even when another one is open by then. */
export function usePhotoJobs(onDone: (designId: string, photo: ProductPhoto) => void) {
  const [jobs, setJobs] = useState<PhotoJob[]>([]);
  const done = useRef(onDone);
  done.current = onDone;
  const patch = (id: string, change: Partial<PhotoJob>) => setJobs((j) => j.map((x) => (x.id === id ? { ...x, ...change } : x)));
  const newJob = (designId: string, r: PhotoRequest, set?: { id: string; size: number }, more: Partial<PhotoJob> = {}): PhotoJob =>
    ({ id: uid(), designId, scene: r.scene, startedAt: Date.now(), change: r.change, request: r, ...(r.shop ? { shop: r.shop } : {}), ...(set ? { set: set.id, setSize: set.size } : {}), ...more });
  // Settles either way: the photo goes into its design (its URL is returned), or the job shows the error.
  const run = (job: PhotoJob): Promise<string | null> => {
    const r = job.request;
    return api.photo(job.designId, r).then((out) => {
      setJobs((j) => j.filter((x) => x.id !== job.id));
      done.current(job.designId, {
        url: out.photo, render: out.render, scene: r.scene, notes: r.notes, ...lookOf(r),
        ...(r.from && r.resize ? { sizeOf: r.from.photo, ...(r.change ? { change: r.change } : {}) } : r.from ? { editOf: r.from.photo, change: r.change } : {}),
        ...(r.shop ? { shop: r.shop } : {}), ...(r.scaleRef ? { scaleRef: r.scaleRef } : {}), ...(r.saleSize ? { saleSize: r.saleSize } : {}), dims: r.product.size,
        ...(job.camera ? { camera: job.camera } : {}), ...(job.shape ? { shape: job.shape } : {}),
        aspect: r.aspect, prompt: out.prompt, model: out.model, cost: out.cost, createdAt: Date.now(),
      });
      return out.photo;
    }, (e: Error) => { patch(job.id, { error: e.message }); return null; });
  };
  const start = (designId: string, r: PhotoRequest, more?: Partial<PhotoJob>) => {
    const job = newJob(designId, r, undefined, more);
    setJobs((j) => [...j, job]);
    void run(job);
  };
  // A shop set: its photos in order, a few at a time, each landing in the design as it is made (a
  // failed one doesn't stop the others).
  const startSet = (designId: string, rs: PhotoRequest[], more?: Partial<PhotoJob>[]) => {
    const set = { id: uid(), size: rs.length };
    const queue = rs.map((r, i) => ({ ...newJob(designId, r, set, more?.[i]), waiting: true }));
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
  // Photos for every sale size: in each group the first photo, then the other sizes made from it in
  // its scene, a few at a time; a size whose first photo failed waits for that one to be tried again.
  const startSizes = (designId: string, groups: SizeGroup[], more: Partial<PhotoJob> = {}) => {
    const set = { id: uid(), size: groups.reduce((n, g) => n + g.variants.length + ('request' in g.base ? 1 : 0), 0) };
    const all: PhotoJob[] = [], ready: PhotoJob[] = [];
    const then = new Map<string, (url: string | null) => void>();
    let active = 0;
    const pump = () => {
      while (active < SHOP_PARALLEL && ready.length) {
        const job = ready.shift()!;
        active++;
        const startedAt = Date.now();
        patch(job.id, { waiting: false, startedAt });
        void run({ ...job, startedAt }).then((url) => { active--; then.get(job.id)?.(url); pump(); });
      }
    };
    for (const g of groups) {
      const variants = g.variants.map((r) => ({ ...newJob(designId, r, set, { ...more, camera: g.camera, sizes: true }), waiting: true }));
      const release = (url: string | null, baseId?: string) => {
        for (const v of variants) {
          if (!url) { patch(v.id, { waiting: false, error: 'Its first photo failed: try that one again', after: baseId }); continue; }
          const job = { ...v, request: { ...v.request, from: { ...v.request.from, photo: url } } };
          patch(v.id, { request: job.request });
          ready.push(job);
        }
      };
      if ('url' in g.base) { all.push(...variants); release(g.base.url); continue; }
      const first = { ...newJob(designId, g.base.request, set, { ...more, camera: g.camera, sizes: true }), waiting: true };
      all.push(first, ...variants);
      ready.push(first);
      then.set(first.id, (url) => release(url, first.id));
    }
    setJobs((j) => [...j, ...all]);
    pump();
  };
  // A failed photo, asked for again (a size waiting for its first photo: that one); the sizes that
  // waited for it go on once it is made.
  const retry = (id: string) => {
    const job = jobs.find((x) => x.id === id);
    if (!job?.error) return;
    if (job.request.resize && !job.request.from?.photo) { if (job.after && jobs.some((x) => x.id === job.after)) retry(job.after); return; }
    const again = { ...job, error: undefined, waiting: false, startedAt: Date.now() };
    patch(id, { error: undefined, startedAt: again.startedAt });
    void run(again).then((url) => {
      if (!url) return;
      for (const w of jobs.filter((x) => x.after === id && x.error)) {
        const next = { ...w, error: undefined, after: undefined, startedAt: Date.now(), request: { ...w.request, from: { ...w.request.from, photo: url } } };
        patch(w.id, next);
        void run(next);
      }
    });
  };
  const dismiss = (id: string) => setJobs((j) => j.filter((x) => x.id !== id));
  return { jobs, start, startSet, startSizes, retry, dismiss };
}

const ASPECT_RATIO: Record<PhotoAspect, number> = { '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 };
const ASPECT_HINT: Record<PhotoAspect, string> = { '1:1': 'Square', '4:5': 'Portrait, for shop listings', '16:9': 'Wide, for banners' };
const sceneLabel = (id: string) => sceneById(id)?.label ?? 'Your idea';
const shopShot = (shot?: string) => (SHOP_SHOTS as readonly string[]).includes(shot ?? '') ? shot as ShopShot : undefined;
/** A photo's (or request's) sub-scene, as a request or a photo keeps it: sub-scene 1 is left out; an idea's scene as written. */
const lookOf = (x: { scene: string; variant?: SceneVariant; sceneText?: string }): Pick<PhotoRequest, 'variant' | 'sceneText'> =>
  x.scene === IDEA_SCENE ? (x.sceneText ? { sceneText: x.sceneText } : {})
  : x.variant && x.variant !== 1 && SCENE_VARIANTS.includes(x.variant) ? { variant: x.variant, ...(x.variant === 'random' && x.sceneText ? { sceneText: x.sceneText } : {}) } : {};
/** A photo's sub-scene in words: "Sub-scene 2: Scandinavian, warm white", the random scene written for it, or the idea's. */
const lookTitle = (ph: { scene: string; variant?: SceneVariant; sceneText?: string }) => {
  if (ph.scene === IDEA_SCENE) return ph.sceneText ? `Written out by Jig: ${ph.sceneText}` : 'Your idea as you wrote it (Jig couldn\'t write it out)';
  if (ph.scene === CUSTOM_SCENE) return 'Your idea as you wrote it (Improve your idea was off)';
  const v = lookOf(ph).variant;
  return !v ? undefined : v === 'random' ? `Random setting: ${ph.sceneText ?? `one the image model invented (${sceneKind(ph.scene)})`}` : `Sub-scene ${v}: ${variantName(ph.scene, v)}`;
};
/** A random sub-scene's setting or the idea written out, by Claude; none (the image model invents it, or gets the idea as written) when Jig can't reach Claude. */
const writeScene = (scene: string, size?: Vec3, idea?: SceneIdea) => api.photoScene(scene, size, idea).catch(() => undefined);
/** A photo's name: its scene, or for a shop set's photo its shot; and the sale size it shows. */
const photoLabel = (scene: string, shop?: string, size?: string) => { const s = shopShot(shop); return (s ? `Shop · ${SHOP_SHOT_LABELS[s]}` : sceneLabel(scene)) + (size ? ` · ${size}` : ''); };
/** The shop shots that are the same for every sale size (the shape is the same; the size doesn't show). */
const STUDIO_SHOTS: readonly string[] = ['main', 'angle', 'top', 'detail'];
/** The design was changed since a photo was made from it: what a refresh asks for. */
const UPDATED = 'The design was updated since the earlier photo: show the product exactly as in the new render';
const mmText = (v: number) => (v >= 100 ? Math.round(v) : +v.toFixed(1)).toString();

/** A sale size as the photos panel knows it. */
export interface SaleSizeInfo { id: string; label: string; mm: number; axis: number; dims?: Vec3 }
/** A size's own render (or the design's, for null) for a photo, and the product's size in it. */
export type SizeShot = (sizeId: string | null, view: PhotoView, aspect: number, scale?: TrueScale) => Promise<{ shot: string; dims: Vec3 } | { error: string }>;
/** A shop photo's place in the set, for its file name (the order a listing shows them in). */
const SHOP_ORDER: Record<ShopShot, number> = { main: 1, angle: 2, top: 3, detail: 3, lifestyle: 4, size: 5 };
const money = (usd: number | null) => (usd == null ? 'cost unknown' : `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`);

interface Props {
  open: boolean;
  onClose: () => void;
  designId: string;
  designName: string;
  /** Claude's summary of the shown version: after the first, what changed, so the product is told by meta.description first. */
  summary?: string;
  result: EvalResult | null;
  hiddenParts: string[];
  /** "Print in one colour": the one filament's colour (#rrggbb), which the photos show too. */
  oneColour?: string | null;
  photos: ProductPhoto[];
  onDelete: (url: string) => void;
  /** Deletes several photos at once (asked first, here). */
  onDeleteMany: (urls: string[]) => void;
  /** Clean render of the model (Viewer.photo); `scale`: at true scale beside a light switch or a mug. */
  capture: (view: PhotoView, aspect: number, scale?: TrueScale) => string | null;
  jobs: PhotoJob[];
  onStart: (r: PhotoRequest, more?: Partial<PhotoJob>) => void;
  /** A shop set: its photos, made a few at a time. */
  onStartSet: (rs: PhotoRequest[], more?: Partial<PhotoJob>[]) => void;
  /** The design's sale sizes; the one the 3D view shows (its photos are of that size). */
  sizes?: SaleSizeInfo[];
  viewedSize?: string | null;
  /** The design's own W × D × H as photographed (hidden parts left out), and its shape (useSizes). */
  designDims?: Vec3 | null;
  shape?: string;
  /** Renders a sale size (or the design) for a photo, whatever the view shows. */
  sizeShot?: SizeShot;
  /** Photos for every sale size from the same scene. */
  onStartSizes?: (groups: SizeGroup[], more?: Partial<PhotoJob>) => void;
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
  const [scenes, setScenes] = useState<Record<string, { scene: string; notes: string; variant: SceneVariant }>>({});
  const [allScenes, setAllScenes] = useState(false);
  // The scenes searched by (on "More scenes"), and those picked last (newest first, kept across reloads).
  const [sceneQuery, setSceneQuery] = useState('');
  const [recentScenes, setRecentScenes] = useState<string[]>(() => load('photoRecentScenes', []));
  useEffect(() => store('photoRecentScenes', recentScenes), [recentScenes]);
  const [aspect, setAspect] = useState<PhotoAspect>(() => load('photoAspect', '4:5'));
  const [camera, setCamera] = useState<'best' | 'current'>(() => load('photoCamera', 'best'));
  useEffect(() => store('photoAspect', aspect), [aspect]);
  useEffect(() => store('photoCamera', camera), [camera]);
  // Your idea: Jig writes it out in detail (on) or it goes to the image model as written (off, the 'custom' scene).
  const [improve, setImprove] = useState<boolean>(() => load('photoImprove', true));
  useEffect(() => store('photoImprove', improve), [improve]);
  // A wall photo's render with a light switch beside the piece at true size, so the photo keeps its scale.
  const [trueScale, setTrueScale] = useState<boolean>(() => load('photoTrueScale', false));
  useEffect(() => store('photoTrueScale', trueScale), [trueScale]);
  const [error, setError] = useState<string | null>(null);
  // A random sub-scene being written for a photo, the shop set or the photos for all sizes.
  const [writing, setWriting] = useState<'photo' | 'shop' | 'sizes' | null>(null);
  // The shop set's renders being taken (1-based), before its photos are asked for.
  const [rendering, setRendering] = useState<number | null>(null);
  // The photos for every size: their renders being taken, and a note when there was nothing to make.
  const [sizeRendering, setSizeRendering] = useState<string | null>(null);
  const [sizeNote, setSizeNote] = useState<string | null>(null);
  // The gallery shows every photo, one size's (with the studio shots every size shares) or those without a size.
  const [filter, setFilter] = useState<string>('all');
  const [big, setBig] = useState<ProductPhoto | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openBig = (ph: ProductPhoto) => { opener.current = document.activeElement as HTMLElement | null; setBig(ph); };
  const closeBig = () => { setBig(null); opener.current?.focus(); };
  useEscape(!!big, closeBig);
  useEscape(p.open && !big, p.onClose);
  // Picking photos to delete several at once: a click on a photo picks it (shift-click: a range).
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [pickAnchor, setPickAnchor] = useState<string | null>(null);
  const stopPicking = () => { setPicking(false); setPicked(new Set()); setPickAnchor(null); };
  useEffect(() => { setBig(null); setError(null); setSizeNote(null); setFilter('all'); stopPicking(); }, [p.designId]);

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
  const choice = scenes[p.designId] ?? { scene: suggested, notes: '', variant: 1 as SceneVariant };
  const setChoice = (patch: Partial<typeof choice>) => setScenes((s) => ({ ...s, [p.designId]: { ...choice, ...patch } }));
  // Your idea: written out by Jig before the photo is asked for (idea), or as written (custom).
  const own = choice.scene === IDEA_SCENE || choice.scene === CUSTOM_SCENE;
  const idea = own && improve;
  const custom = own && !improve;
  const ownScene = idea ? IDEA_SCENE : custom ? CUSTOM_SCENE : choice.scene;
  const preset = sceneById(choice.scene);
  // The scenes after the first few show on "More scenes", or right away when one of them is picked or suggested.
  // Folded: the scene picked (else the one suggested), the suggested one (else the one picked before)
  // and Your idea; "More scenes" shows them all, searched by name, sub-scene or what is in them.
  const first = preset ? preset.id : suggested;
  const second = first !== suggested ? suggested : recentScenes.find((x) => x !== first && sceneById(x)) ?? PHOTO_SCENES.find((x) => x.id !== first)!.id;
  const q = foldText(sceneQuery.trim());
  const shownScenes = !allScenes ? [sceneById(first), sceneById(second)].filter((x): x is NonNullable<typeof x> => !!x)
    : !q ? PHOTO_SCENES
    : PHOTO_SCENES.filter((x) => foldText([x.label, x.scene, ...subScenes(x.id).map((v) => v.name)].join(' ')).includes(q));
  const pickScene = (scene: string) => {
    setChoice({ scene, variant: 1 });
    if (sceneById(scene)) setRecentScenes((r) => [scene, ...r.filter((x) => x !== scene)].slice(0, 10));
  };
  // A flat print (wall art, a sign, an ornament on the tree, its close-up) is shown face-on; anything else from a 3/4 angle.
  const flat = !!size && size[2] < 0.25 * Math.min(size[0], size[1]);
  const faceOn = camera === 'best' && !!(preset?.wall || preset?.hang || preset?.closeup) && flat;
  // A flat piece on a wall (not a fridge door) can have the light switch in its render.
  const canSwitch = faceOn && !!preset?.wall && preset.id !== 'fridge';
  const jobs = p.jobs.filter((j) => j.designId === p.designId);
  /**
   * The chosen sub-scene for requests in the chosen scene; a random one's setting (or the idea's
   * scene) is written now, once for all the photos asked for together (without Claude the image
   * model invents it, or gets the idea as written).
   */
  const look = async (what: 'photo' | 'shop' | 'sizes'): Promise<Pick<PhotoRequest, 'variant' | 'sceneText'>> => {
    if (!idea && (!preset || choice.variant === 1)) return {};
    if (!idea && choice.variant !== 'random') return { variant: choice.variant };
    setWriting(what);
    try {
      const text = await writeScene(ownScene, size ?? undefined, idea ? { idea: choice.notes.trim(), suggested, product: p.result?.meta.name || p.designName } : undefined);
      return idea ? (text ? { sceneText: text } : {}) : { variant: 'random', ...(text ? { sceneText: text } : {}) };
    } finally {
      setWriting(null);
    }
  };
  // A shop set (or a set for every size) still being made: how many of its photos have landed.
  const progress = (sizes: boolean) => {
    const first = jobs.find((j) => j.set && !j.error && !!j.sizes === sizes);
    return first ? `${first.setSize! - jobs.filter((j) => j.set === first.set).length} / ${first.setSize}` : null;
  };
  const shopProgress = progress(false);
  const sizesProgress = progress(true);
  const sizeList = p.sizes ?? [];
  // A photo's size by its current name (a renamed size), or as it was called.
  const sizeName = (s?: { id: string; label: string }) => (s ? sizeList.find((x) => x.id === s.id)?.label ?? s.label : undefined);
  const nameOf = (ph: { scene: string; shop?: string; saleSize?: { id: string; label: string } }) => photoLabel(ph.scene, ph.shop, sizeName(ph.saleSize));
  const saleOf = (sid?: string | null) => { const s = sizeList.find((x) => x.id === sid); return s ? { id: s.id, label: s.label, mm: s.mm } : undefined; };
  const viewedSale = saleOf(p.viewedSize);
  const allPhotos = [...p.photos].reverse();
  const photos = filter === 'all' ? allPhotos : allPhotos.filter((ph) => {
    const own = ph.saleSize && sizeList.some((x) => x.id === ph.saleSize!.id) ? ph.saleSize.id : null;
    return filter === 'none' ? !own : own === filter || (!own && STUDIO_SHOTS.includes(ph.shop ?? ''));
  });
  const filters = sizeList.length > 0 || allPhotos.some((ph) => ph.saleSize);
  // Only the shown photos count as picked: the size filter never leaves a hidden one picked.
  const pickedShown = photos.filter((ph) => picked.has(ph.url));
  const allPicked = photos.length > 0 && pickedShown.length === photos.length;
  const pickPhoto = (url: string, range: boolean) => { setPicked((cur) => pickIds(photos.map((ph) => ph.url), cur, url, pickAnchor, range)); setPickAnchor(url); };
  /**
   * Deletes the picked photos after one question, as a single delete does (out of the design's
   * list). Photos made from them in other sizes stay; a remake from a deleted one says so.
   */
  const deletePicked = () => {
    const urls = [...new Set(pickedShown.map((ph) => ph.url))];
    if (!urls.length) return;
    const madeFrom = allPhotos.filter((ph) => !urls.includes(ph.url) && !!ph.sizeOf && urls.includes(ph.sizeOf)).length;
    const note = madeFrom ? `\n\n${madeFrom === 1 ? 'Another photo was' : `${madeFrom} other photos were`} made from them in other sizes: ${madeFrom === 1 ? 'it stays' : 'they stay'}, but can't be made again from these.` : '';
    if (!confirm(`Delete ${urls.length === 1 ? 'this photo' : `these ${urls.length} photos`} of "${p.designName}"?${note}`)) return;
    p.onDeleteMany(urls);
    stopPicking();
  };
  /** Why a photo is out of date: its size's dimension changed (or the design's), or the design's shape. */
  const outdated = (ph: ProductPhoto): string | null => {
    const notes: string[] = [];
    const s = ph.saleSize && sizeList.find((x) => x.id === ph.saleSize!.id);
    if (s && ph.saleSize!.mm != null && Math.abs(s.mm - ph.saleSize!.mm) > 0.05) notes.push(`made for ${mmText(ph.saleSize!.mm)} mm, now ${mmText(s.mm)} mm`);
    else if (!ph.saleSize && ph.dims && p.designDims && !STUDIO_SHOTS.includes(ph.shop ?? '')) {
      const a = mainAxis(p.designDims), was = ph.dims[a], now = p.designDims[a];
      if (Math.abs(was - now) > Math.max(0.5, now * 0.01)) notes.push(`made for ${mmText(was)} mm, now ${mmText(now)} mm`);
    }
    if (ph.shape && p.shape && ph.shape !== p.shape) notes.push('made for an earlier version of the design');
    return notes.length ? notes.join('; ') : null;
  };
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
    name: p.result.meta.name || p.designName, description: p.result.meta.description || p.summary, size, faceOn, lithophane,
    // Per-vertex (LayerTone) parts are many colours: the render shows them.
    // A coloured mesh's part: its filaments' colours. Printed in one colour: that one.
    colors: p.oneColour ? [p.oneColour.toLowerCase()] : [...new Set(parts.filter((x) => !x.vertexColors).flatMap((x) => (x.paint ? x.paint.filaments.map((f) => f.color) : [x.color])).map((c) => c.toLowerCase()))].filter((c) => /^#[0-9a-f]{6}$/.test(c)).slice(0, 16),
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
    // A photo of an idea: face-on if its render was (the idea hung it on a wall).
    else if (ph.scene === IDEA_SCENE) prod.faceOn = !fromView && ph.camera === 'face';
    // A size's photo stays that size's (its product as it was, unless taken from the view again).
    if (ph.dims && !fromView) prod.size = ph.dims;
    // Its own render shows the light switch or mug; a new one from the view does not.
    const scaleRef = !fromView && ph.scaleRef ? { scaleRef: ph.scaleRef } : {};
    p.onStart({ from: { photo: ph.url, ...(ph.render ? { render: ph.render } : {}) }, ...(shot ? { render: dataUrlToImage(shot) } : {}), change, scene: ph.scene, ...lookOf(ph), aspect: shape, notes: ph.notes, ...(shop ? { shop } : {}), ...scaleRef, ...(ph.saleSize ? { saleSize: ph.saleSize } : {}), product: prod },
      { camera: fromView ? 'current' : ph.camera, shape: fromView ? p.shape : ph.shape });
    closeBig();
  };

  /** A size's render (the design's for null): its own build when the panel can make one, else the view. */
  const renderAt = async (sizeId: string | null, view: PhotoView, ratio: number, scale?: TrueScale): Promise<{ shot: string; dims: Vec3 } | { error: string }> => {
    await new Promise((r) => setTimeout(r, 30));
    try {
      if (p.sizeShot) return await p.sizeShot(sizeId, view, ratio, scale);
      const shot = p.capture(view, ratio, scale);
      return shot && size ? { shot, dims: size } : { error: 'Every part is hidden: show at least one to photograph it.' };
    } catch (e) {
      return { error: `Couldn't render the model: ${(e as Error).message}` };
    }
  };
  /** How a photo's render was taken: a shop shot's camera from the plan, else the one it kept. */
  const cameraOf = (ph: ProductPhoto, dims: Vec3) => {
    const shop = shopShot(ph.shop);
    const item = shop ? shopPlan({ size: dims, suggested }).find((x) => x.shot === shop) : undefined;
    const view = (item?.camera ?? ph.camera ?? 'angle') as PhotoView;
    return { view, faceOn: item?.faceOn ?? (view === 'face' || (view === 'detail' && dims[2] < 0.25 * Math.min(dims[0], dims[1]))) };
  };

  /**
   * An out-of-date photo made again in one click, in its own scene: from a new render of its size
   * (or of the design), told the new size (sizeVariantPrompt) and/or that the design changed.
   * The old photo stays.
   */
  const refresh = async (ph: ProductPhoto) => {
    const prod = product();
    if (!prod) return setError('There is no model to describe the product with yet.');
    setError(null);
    const sale = ph.saleSize ? saleOf(ph.saleSize.id) : undefined;
    if (ph.saleSize && !sale) return setError(`The ${ph.saleSize.label} size was removed: there is nothing to make this photo for.`);
    const was = ph.dims ?? prod.size;
    const cam = cameraOf(ph, was);
    const shape = (PHOTO_ASPECTS as readonly string[]).includes(ph.aspect) ? ph.aspect as PhotoAspect : aspect;
    closeBig();
    // A photo beside a light switch or mug: the same one, on the same spot and framing as before.
    const shot = await renderAt(sale?.id ?? null, cam.view === 'current' ? 'angle' : cam.view, ASPECT_RATIO[shape], ph.scaleRef ? { ref: ph.scaleRef, base: was } : undefined);
    if ('error' in shot) return setError(shot.error);
    const resized = shot.dims.some((v, k) => Math.abs(v - was[k]) > Math.max(0.3, was[k] * 0.005));
    const reshaped = !!ph.shape && !!p.shape && ph.shape !== p.shape;
    p.onStart({
      from: { photo: ph.url }, render: dataUrlToImage(shot.shot), scene: ph.scene, ...lookOf(ph), aspect: shape, notes: ph.notes,
      ...(shopShot(ph.shop) ? { shop: shopShot(ph.shop) } : {}), ...(ph.scaleRef ? { scaleRef: ph.scaleRef } : {}), ...(sale ? { saleSize: sale } : {}),
      ...(resized ? { resize: { base: { label: sizeName(ph.saleSize), size: was } } } : {}),
      ...(reshaped || !resized ? { change: UPDATED } : {}),
      product: { ...prod, size: shot.dims, faceOn: cam.faceOn },
    }, { camera: cam.view, shape: p.shape });
  };

  /**
   * One scene shot in every sale size: the first photo (`from`, an existing one, or made now in
   * `first` size) and each other size from its own render, with the first photo as the scene to keep.
   * Sizes that already have an up-to-date photo from that first one are left out.
   */
  const sizeGroup = async (item: { view: PhotoView; faceOn: boolean; scene: string; /** The sub-scene of a first photo made now. */ look?: Pick<PhotoRequest, 'variant' | 'sceneText'>; shop?: ShopShot; scaleRef?: ScaleRef; aspect: PhotoAspect; notes?: string }, start: { from: ProductPhoto } | { first: NonNullable<ReturnType<typeof saleOf>> },
    prod: PhotoRequest['product'], tick: () => void): Promise<SizeGroup | string> => {
    // An existing first photo keeps its own sub-scene (its random setting too), and its light switch or mug if its render has one.
    const ref = 'from' in start ? start.from.scaleRef : item.scaleRef;
    const common = { scene: item.scene, ...('from' in start ? lookOf(start.from) : item.look), aspect: item.aspect, ...(item.notes ? { notes: item.notes } : {}), ...(item.shop ? { shop: item.shop } : {}), ...(ref ? { scaleRef: ref } : {}) };
    let base: SizeGroup['base'], baseDims: Vec3, baseLabel: string | undefined, baseId: string | undefined;
    if ('from' in start) {
      base = { url: start.from.url };
      baseDims = start.from.dims ?? prod.size;
      baseLabel = sizeName(start.from.saleSize);
      baseId = start.from.saleSize?.id;
    } else {
      tick();
      const shot = await renderAt(start.first.id, item.view, ASPECT_RATIO[item.aspect], ref ? { ref } : undefined);
      if ('error' in shot) return shot.error;
      base = { request: { ...common, render: dataUrlToImage(shot.shot), saleSize: start.first, product: { ...prod, size: shot.dims, faceOn: item.faceOn } } };
      baseDims = shot.dims;
      baseLabel = start.first.label;
      baseId = start.first.id;
    }
    const variants: PhotoRequest[] = [];
    for (const s of sizeList) {
      if (s.id === baseId) continue;
      if ('from' in start && allPhotos.some((x) => x.sizeOf === start.from.url && x.saleSize?.id === s.id && !outdated(x))) continue;
      tick();
      // The reference on the first photo's spot, in its framing: only the product's size changes.
      const shot = await renderAt(s.id, item.view, ASPECT_RATIO[item.aspect], ref ? { ref, base: baseDims } : undefined);
      if ('error' in shot) return shot.error;
      variants.push({ ...common, render: dataUrlToImage(shot.shot), from: { photo: '' }, saleSize: { id: s.id, label: s.label, mm: s.mm },
        resize: { base: { label: baseLabel, size: baseDims } }, product: { ...prod, size: shot.dims, faceOn: item.faceOn } });
    }
    return { base, variants, camera: item.view };
  };

  // Photos for all sizes: the shop set's scene shots (lifestyle and size), where the size shows, one
  // per sale size, all in the scene of the first one (the size shown in the view, else the middle
  // one). The studio shots stay shared: the shape is the same in every size.
  const allSizes = async () => {
    setError(null);
    setSizeNote(null);
    const prod = product();
    if (!size || !prod || sizeList.length < 2 || !p.onStartSizes) return setError('There is no model to photograph yet.');
    const first = saleOf(p.viewedSize) ?? saleOf(sizeList[Math.floor((sizeList.length - 1) / 2)].id)!;
    const firstDims = sizeList.find((s) => s.id === first.id)?.dims ?? size;
    const plan = shopPlan({ size: firstDims, suggested }).filter((x) => x.shot === 'lifestyle' || x.shot === 'size');
    // Those in the chosen scene take its chosen sub-scene, as in the shop set.
    const chosen = plan.some((x) => x.scene === choice.scene) ? await look('sizes') : {};
    const groups: SizeGroup[] = [];
    let n = 0;
    const total = plan.length * sizeList.length;
    try {
      for (const item of plan) {
        const from = allPhotos.find((ph) => ph.shop === item.shot && ph.saleSize?.id === first.id && !ph.sizeOf && !outdated(ph));
        const g = await sizeGroup({ view: item.camera, faceOn: item.faceOn, scene: item.scene, ...(item.scene === choice.scene ? { look: chosen } : {}), shop: item.shot, scaleRef: item.scaleRef, aspect: '1:1' }, from ? { from } : { first }, prod, () => setSizeRendering(`${++n} / ${total}`));
        if (typeof g === 'string') return setError(g);
        if (g.variants.length || 'request' in g.base) groups.push(g);
      }
    } finally {
      setSizeRendering(null);
    }
    if (!groups.length) return setSizeNote('Every size has its lifestyle and size photos already. Open one to make it again.');
    p.onStartSizes(groups, { shape: p.shape });
  };

  // A scene photo made in every other size, in its scene (from its enlarged view).
  const everySize = async (ph: ProductPhoto) => {
    setError(null);
    setSizeNote(null);
    const prod = product();
    if (!prod || !p.onStartSizes) return setError('There is no model to describe the product with yet.');
    const cam = cameraOf(ph, ph.dims ?? prod.size);
    const shape = (PHOTO_ASPECTS as readonly string[]).includes(ph.aspect) ? ph.aspect as PhotoAspect : aspect;
    closeBig();
    let n = 0;
    try {
      const g = await sizeGroup({ view: cam.view === 'current' ? 'angle' : cam.view, faceOn: cam.faceOn, scene: ph.scene, shop: shopShot(ph.shop), aspect: shape, notes: ph.notes }, { from: ph }, prod,
        () => setSizeRendering(`${++n} / ${sizeList.length}`));
      if (typeof g === 'string') return setError(g);
      if (!g.variants.length) return setSizeNote('Every size has this photo already.');
      p.onStartSizes([g], { shape: p.shape });
    } finally {
      setSizeRendering(null);
    }
  };

  // A size's photo made again from the same first photo (another try of the image model).
  const remake = (ph: ProductPhoto) => {
    const prod = product();
    const first = allPhotos.find((x) => x.url === ph.sizeOf);
    if (!prod || !first || !ph.sizeOf) return setError('Its first photo was deleted: make this size from another photo.');
    const shape = (PHOTO_ASPECTS as readonly string[]).includes(ph.aspect) ? ph.aspect as PhotoAspect : aspect;
    p.onStart({ from: { photo: ph.sizeOf, ...(ph.render ? { render: ph.render } : {}) }, scene: ph.scene, ...lookOf(ph), aspect: shape, notes: ph.notes, ...(shopShot(ph.shop) ? { shop: shopShot(ph.shop) } : {}), ...(ph.scaleRef ? { scaleRef: ph.scaleRef } : {}),
      ...(ph.saleSize ? { saleSize: ph.saleSize } : {}), resize: { base: { label: sizeName(first.saleSize), size: first.dims ?? prod.size } },
      product: { ...prod, size: ph.dims ?? prod.size, faceOn: cameraOf(ph, ph.dims ?? prod.size).faceOn } }, { camera: ph.camera, shape: ph.shape });
    closeBig();
  };

  const generate = async () => {
    setError(null);
    if (!size || !p.result) return setError('There is no model to photograph yet.');
    if ((custom || idea) && !choice.notes.trim()) return setError('Write your idea first.');
    // The idea is written out first: a flat print it hangs on a wall is shown face-on.
    const written = idea ? await look('photo') : null;
    const onFace = faceOn || (camera === 'best' && flat && !!written?.sceneText && writtenPlace(written.sceneText) === 'wall');
    let shot: string | null = null;
    const view: PhotoView = camera === 'current' ? 'current' : preset?.closeup ? 'detail' : onFace ? 'face' : 'angle';
    // On a wall, face-on: at true scale in its frame, beside a switch when asked.
    const scaleRef = canSwitch && view === 'face' ? (trueScale ? 'switch' as const : 'wall' as const) : undefined;
    try {
      shot = p.capture(view, ASPECT_RATIO[aspect], scaleRef ? { ref: scaleRef } : undefined);
    } catch (e) {
      return setError(`Couldn't render the model: ${(e as Error).message}`);
    }
    if (!shot) return setError('Every part is hidden: show at least one to photograph it.');
    const chosen = written ?? await look('photo');
    p.onStart({
      render: dataUrlToImage(shot),
      scene: ownScene,
      ...chosen,
      aspect,
      notes: choice.notes.trim() || undefined,
      ...(scaleRef ? { scaleRef } : {}),
      ...(viewedSale ? { saleSize: viewedSale } : {}),
      product: { ...product()!, faceOn: onFace },
    }, { camera: view, shape: p.shape });
  };

  // Shop photos: a set of square 2K listing photos in one click (shopPlan), each from its own render
  // (the image model keeps the render's angle), taken one by one so the panel shows how far it got.
  // The view's own camera is never moved: the renders use a camera of their own.
  const shopSet = async () => {
    setError(null);
    const prod = product();
    if (!size || !prod) return setError('There is no model to photograph yet.');
    const plan = shopPlan({ size, suggested });
    // Its scene shots (lifestyle, size) in the chosen scene take its chosen sub-scene, one random
    // setting for both; the studio shots stay the same for every product.
    const scened = (item: (typeof plan)[number]) => item.scene === choice.scene && !STUDIO_SHOTS.includes(item.shot);
    const chosen = plan.some(scened) ? await look('shop') : {};
    const rs: PhotoRequest[] = [];
    try {
      for (const [i, item] of plan.entries()) {
        setRendering(i + 1);
        await new Promise((r) => setTimeout(r, 30));
        let shot: string | null;
        try {
          shot = p.capture(item.camera, 1, item.scaleRef ? { ref: item.scaleRef } : undefined);
        } catch (e) {
          return setError(`Couldn't render the model: ${(e as Error).message}`);
        }
        if (!shot) return setError('Every part is hidden: show at least one to photograph it.');
        // The studio shots are every size's; the scene ones are of the size shown, if one is.
        const sale = viewedSale && !STUDIO_SHOTS.includes(item.shot) ? { saleSize: viewedSale } : {};
        rs.push({ render: dataUrlToImage(shot), scene: item.scene, ...(scened(item) ? chosen : {}), aspect: '1:1', shop: item.shot, ...(item.scaleRef ? { scaleRef: item.scaleRef } : {}), ...sale, product: { ...prod, faceOn: item.faceOn } });
      }
    } finally {
      setRendering(null);
    }
    p.onStartSet(rs, plan.map((item) => ({ camera: item.camera, shape: p.shape })));
  };

  const save = async (ph: ProductPhoto, n: number) => {
    try {
      const blob = await (await fetch(ph.url)).blob();
      const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
      const shop = shopShot(ph.shop);
      const sz = sizeName(ph.saleSize) ? `-${slug(sizeName(ph.saleSize)!)}` : '';
      download(blob, shop ? `${slug(p.designName)}${sz}-shop-${SHOP_ORDER[shop]}-${shop}-${n}.${ext}` : `${slug(p.designName)}${sz}-${slug(sceneLabel(ph.scene))}-${n}.${ext}`);
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
      {allScenes && (
        <div className="menu-search ph-scene-search">
          <Icon name="search" size={13} />
          <input autoFocus type="search" placeholder="Search scenes, e.g. wall, christmas, marble" aria-label="Search scenes" value={sceneQuery}
            onChange={(e) => setSceneQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q && shownScenes[0]) pickScene(shownScenes[0].id); }} />
          {sceneQuery && <button className="icon-btn" title="Clear the search" aria-label="Clear the search" onClick={() => setSceneQuery('')}><Icon name="x" size={12} /></button>}
        </div>
      )}
      <div className="ph-scenes" role="radiogroup" aria-labelledby={`${id}-scene`}>
        {[...shownScenes, { id: IDEA_SCENE, label: 'Your idea…', icon: 'spark', hint: 'Describe the scene yourself: Jig writes a few words out in detail, or (Improve your idea off) it goes to the image model as you write it' }].map((s) => (
          <button key={s.id} role="radio" aria-checked={s.id === IDEA_SCENE ? own : choice.scene === s.id} className={(s.id === IDEA_SCENE ? own : choice.scene === s.id) ? 'on' : ''} onClick={() => pickScene(s.id)}
            title={'hint' in s ? s.hint : s.id === suggested ? `${s.label}: suggested for this design` : s.label}>
            <Icon name={s.icon} size={18} />
            <span>{s.label}</span>
            {s.id === suggested && <i className="ph-suggested" aria-label="suggested">★</i>}
          </button>
        ))}
      </div>
      {allScenes && q && !shownScenes.length && <div className="dim small">No scene matches "{sceneQuery.trim()}": Your idea… makes any scene you describe.</div>}
      <button className="ph-more" onClick={() => { setAllScenes(!allScenes); setSceneQuery(''); }}>
        {allScenes ? 'Fewer scenes' : `More scenes (${PHOTO_SCENES.length - shownScenes.length} more)`}
      </button>
      {preset && (
        <div className="ph-row">
          <span className="ph-label" id={`${id}-look`}>Variant</span>
          <div className="seg ph-variants" role="radiogroup" aria-labelledby={`${id}-look`}>
            {SCENE_VARIANTS.map((v) => (
              <button key={v} role="radio" aria-checked={choice.variant === v} className={choice.variant === v ? 'on' : ''} onClick={() => setChoice({ variant: v })}
                aria-label={v === 'random' ? 'Random' : `${v}: ${variantName(preset.id, v)}`}
                title={v === 'random' ? `Random: a fresh ${preset.label.toLowerCase()} setting, new for each photo` : `${v}: ${variantName(preset.id, v)}${v === 1 ? ' (the scene as it was)' : ''}`}>
                {v === 'random' ? <Icon name="dice" size={13} /> : v}
              </button>
            ))}
          </div>
          <span className="dim small ph-variant-name">{variantName(preset.id, choice.variant)}</span>
        </div>
      )}
      <textarea className="text-param ph-notes" rows={own ? 3 : 2} maxLength={MAX_NOTES_CHARS} value={choice.notes} onChange={(e) => setChoice({ notes: e.target.value })}
        aria-label={own ? 'Your idea for the scene' : 'Extra details (optional)'}
        placeholder={custom ? 'Describe the scene, e.g. "on a bedside table next to a book, warm evening lamp light"' : idea ? 'A few words, e.g. "cosy cabin, snowy evening"' : 'Extra details (optional), e.g. "autumn leaves around it", "evening light"'} />
      {own && (
        <label className="switch ph-improve" title="On: Jig writes your few words out into a detailed scene (shown on the photo). Off: the image model gets your text exactly as you wrote it.">
          <input type="checkbox" checked={improve} onChange={(e) => setImprove(e.target.checked)} />
          <span className="track" />
          <span className="switch-label">Improve your idea</span>
        </label>
      )}

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
      {canSwitch && (
        <label className="switch ph-true-scale" title="The render shows a standard light switch (85 mm) beside the piece at true size, and the photo keeps both as large as in the render, so the piece is not blown up. The shop set's size photo always has it.">
          <input type="checkbox" checked={trueScale} onChange={(e) => setTrueScale(e.target.checked)} />
          <span className="track" />
          <span className="switch-label">Light switch for scale</span>
        </label>
      )}

      <button className="btn primary wide" disabled={!p.imageModel || !size || writing === 'photo'} onClick={() => void generate()}>
        <Icon name="camera" size={14} /> {writing === 'photo' ? (idea ? 'Writing out your idea…' : 'Writing a random scene…') : 'Generate photo'}
      </button>
      <div className="dim small ph-note">{p.imageModel ?? 'Image model'} · about $0.04–0.07 and 10–30 s each · the photo is made from a clean render of the model as shown (hidden parts stay hidden).</div>
      <button className="btn wide ph-shop" disabled={!p.imageModel || !size || rendering != null || writing === 'shop' || !!shopProgress} onClick={() => void shopSet()}
        title="5 square photos at 2K for a shop listing: main (front), 3/4 view, detail or top view in a light grey studio, a lifestyle photo and a size photo">
        <Icon name="tag" size={14} /> {writing === 'shop' ? 'Writing a random scene…' : rendering != null ? `Rendering ${rendering} / 5…` : shopProgress ? `Making shop photos · ${shopProgress}` : 'Shop photos'}
      </button>
      <div className="dim small ph-note">Shop photos: 5 square photos at 2K (2048 × 2048) for a listing, the studio ones in the same light grey studio for every product · about $0.50 and 1 to 2 min a set · the details above don't apply; its lifestyle and size photos take the variant above when they are in that scene.</div>
      {sizeList.length > 1 && p.onStartSizes && <>
        <button className="btn wide ph-sizes" disabled={!p.imageModel || !size || sizeRendering != null || writing === 'sizes' || !!sizesProgress} onClick={() => void allSizes()}
          title="The shop set's lifestyle and size photos once for every sale size, all in the same scene: the first one is made (or kept), the others from it with only the product's size changed">
          <Icon name="ruler" size={14} /> {writing === 'sizes' ? 'Writing a random scene…' : sizeRendering != null ? `Rendering ${sizeRendering}…` : sizesProgress ? `Making photos for all sizes · ${sizesProgress}` : `Photos for all sizes (${sizeList.map((s) => s.label).join(', ')})`}
        </button>
        <div className="dim small ph-note">The lifestyle and size photos for each size, in one scene: the {(saleOf(p.viewedSize) ?? sizeList[Math.floor((sizeList.length - 1) / 2)]).label} photo first, then the other sizes in its scene · the studio shots are the same for every size.</div>
        {sizeNote && <div className="dim small" role="status">{sizeNote}</div>}
      </>}
      {p.notAssembled && <div className="dim small">Tip: the photo shows the parts as laid out in the view – choose <b>Assembled</b> below the view for the finished object.</div>}
      {error && <div className="bad-note small" role="alert">{error}</div>}

      {(jobs.length > 0 || allPhotos.length > 0) && (
        <div className="ph-label ph-gallery-head">
          <span>Photos{photos.length ? ` (${photos.length})` : ''}</span>
          {allPhotos.length > 1 && (
            <button className="link" onClick={() => (picking ? stopPicking() : setPicking(true))} aria-pressed={picking} title={picking ? 'Stop picking photos' : 'Pick several photos to delete them at once'}>
              {picking ? 'Done' : 'Select'}
            </button>
          )}
        </div>
      )}
      {picking && photos.length > 0 && (
        <div className="ph-pick-bar">
          <label title={allPicked ? 'Pick none' : `Pick all ${photos.length} photos shown`}>
            <input type="checkbox" checked={allPicked} ref={(el) => { if (el) el.indeterminate = pickedShown.length > 0 && !allPicked; }}
              onChange={() => { setPicked(new Set(allPicked ? [] : photos.map((ph) => ph.url))); setPickAnchor(null); }} />
            {pickedShown.length ? `${pickedShown.length} picked` : `Pick all ${photos.length}`}
          </label>
          <span className="spacer" />
          <button className="btn danger small-btn" disabled={!pickedShown.length} onClick={deletePicked}><Icon name="trash" size={12} /> Delete{pickedShown.length ? ` ${pickedShown.length}` : ''}</button>
        </div>
      )}
      {filters && allPhotos.length > 0 && (
        <div className="seg ph-filter" role="radiogroup" aria-label="Show the photos of">
          {[['all', 'All'], ...sizeList.map((s) => [s.id, s.label]), ['none', 'No size']].map(([k, label]) => (
            <button key={k} role="radio" aria-checked={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}
              title={k === 'all' ? 'Every photo' : k === 'none' ? 'Photos not made for a size' : `The ${label} photos and the studio shots every size shares`}>{label}</button>
          ))}
        </div>
      )}
      <div className={`ph-gallery ${picking ? 'picking' : ''}`}>
        {jobs.map((j) => (
          <div key={j.id} className={`ph-tile pending ${j.error ? 'failed' : ''}`} role={j.error ? 'alert' : 'status'}>
            {j.error
              ? <><Icon name="alert" size={16} /><span className="small">{nameOf({ ...j, saleSize: j.request.saleSize })}: {j.error}</span>
                <span className="ph-job-actions">
                  {p.imageModel && <button className="link" onClick={() => p.onRetry(j.id)}>Try again</button>}
                  <button className="link" onClick={() => p.onDismiss(j.id)}>Dismiss</button>
                </span></>
              : <><span className="spinner" /><span className="small" title={j.change ?? (j.shop ? sceneLabel(j.scene) : undefined)}>{nameOf({ ...j, saleSize: j.request.saleSize })}{j.change && !j.request.resize ? ' · changed' : ''}</span>
                <span className="dim small mono">{j.waiting ? 'waiting' : `${Math.max(0, Math.round((elapsed - j.startedAt) / 1000))} s`}</span></>}
          </div>
        ))}
        {photos.map((ph, i) => {
          const old = outdated(ph);
          return (
            <div key={ph.url + ph.createdAt} className={`ph-tile ${old ? 'outdated' : ''} ${picking && picked.has(ph.url) ? 'picked' : ''}`}>
              <button className="ph-thumb" onClick={(e) => (picking ? pickPhoto(ph.url, e.shiftKey) : openBig(ph))}
                aria-label={picking ? `Pick the ${nameOf(ph)} photo` : `${nameOf(ph)} photo, enlarge`} aria-pressed={picking ? picked.has(ph.url) : undefined}>
                <img src={ph.url} alt="" loading="lazy" />
                {picking && <span className={`ph-pick ${picked.has(ph.url) ? 'on' : ''}`} aria-hidden="true"><Icon name="check" size={12} /></span>}
              </button>
              {old && <button className="ph-outdated" onClick={() => void refresh(ph)} disabled={!p.imageModel} title={`Out of date: ${old}. Click to make it again in the same scene (the old photo stays).`}><Icon name="restore" size={11} /> {old.startsWith('made for an') ? 'Design changed' : old.split(',')[0].replace('made', 'Made')}</button>}
              <div className="ph-tile-bar">
                {sizeName(ph.saleSize) && <b className="ph-size" title={`Size ${sizeName(ph.saleSize)}`}>{sizeName(ph.saleSize)}</b>}
                <span className="small" title={[ph.change ?? ph.notes ?? (ph.shop ? sceneLabel(ph.scene) : undefined), lookTitle(ph)].filter(Boolean).join('\n') || undefined}>
                  {photoLabel(ph.scene, ph.shop)}{lookOf(ph).variant ? ` · ${lookOf(ph).variant}` : ''}{ph.editOf ? ' · changed' : ''}
                </span>
                <button className="icon-btn" onClick={() => void save(ph, photos.length - i)} title="Download" aria-label={`Download the ${nameOf(ph)} photo`}><Icon name="download" size={13} /></button>
                <DeleteButton label={`${nameOf(ph)} photo`} onDelete={() => p.onDelete(ph.url)} />
              </div>
            </div>
          );
        })}
      </div>

      {/* On the page itself: the panel's backdrop blur would make it the box a fixed overlay fills. */}
      {big && createPortal(
        <div className="lightbox ph-lightbox" role="dialog" aria-modal="true" aria-label="Product photo" onClick={closeBig}>
          <BigPhoto key={big.url} photo={big} label={nameOf(big)} onSave={() => void save(big, photos.length - photos.indexOf(big))} onDelete={() => { p.onDelete(big.url); closeBig(); }} onClose={closeBig}
            onRedo={p.imageModel ? (change, fromView) => redo(big, change, fromView) : undefined}
            sizes={p.imageModel ? {
              outdated: outdated(big),
              onRefresh: () => void refresh(big),
              // Scene photos, where the size shows: the studio ones are every size's already.
              onEverySize: sizeList.length > 1 && p.onStartSizes && !sceneById(big.scene)?.studio && big.scene !== 'studio' && !STUDIO_SHOTS.includes(big.shop ?? '') ? () => void everySize(big) : undefined,
              onRemake: big.sizeOf ? () => remake(big) : undefined,
              firstLabel: sizeName(allPhotos.find((x) => x.url === big.sizeOf)?.saleSize),
            } : undefined}
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
function BigPhoto({ photo, label, onSave, onDelete, onClose, onSwipe, onRedo, sizes }: {
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
