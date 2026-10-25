// Product photos in flight: each asked of the image model, a shop set or the photos for every
// sale size a few at a time, failed ones tried again; each lands in its own design.
import { useRef, useState } from 'react';
import type { ProductPhoto } from '../../../shared/types';
import type { PhotoRequest, ShopShot } from '../../../shared/photos';
import { api } from '../../lib/api';
import { uid } from '../../lib/files';
import { lookOf } from './photoHelpers';

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
