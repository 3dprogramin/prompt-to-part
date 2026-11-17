import type { PhotoRequest } from '../../../shared/photos';

interface SizeGroupLike { base: { url: string } | { request: PhotoRequest }; variants: PhotoRequest[]; camera?: string }
type JobLike = { id: string; request: PhotoRequest };

/** A size's request made from the first photo `url` (it starts with an empty `from.photo`, filled in once that photo exists). */
export const fromFirstPhoto = <T extends { request: PhotoRequest }>(job: T, url: string): T =>
  ({ ...job, request: { ...job.request, from: { ...job.request.from, photo: url } } });

/** A size still without its first photo: it cannot be made (or tried again) until that one is. */
export const lacksFirstPhoto = (job: { request: PhotoRequest }) => !!job.request.resize && !job.request.from?.photo;

/**
 * The jobs of every-size groups as they go into the list, and which can start now. A group whose
 * first photo exists has its sizes carry that photo already: nothing can patch them in later, as
 * the jobs are not in the list yet. A group whose first photo is made now starts that photo; its
 * sizes (`later`) wait for it.
 */
export function planSizes<J extends JobLike>(groups: SizeGroupLike[], make: (r: PhotoRequest, camera?: string) => J) {
  const all: J[] = [], ready: J[] = [], later: { first: J; variants: J[] }[] = [];
  for (const g of groups) {
    const variants = g.variants.map((r) => make(r, g.camera));
    if ('url' in g.base) {
      const made = variants.map((v) => fromFirstPhoto(v, (g.base as { url: string }).url));
      all.push(...made);
      ready.push(...made);
      continue;
    }
    const first = make(g.base.request, g.camera);
    all.push(first, ...variants);
    ready.push(first);
    later.push({ first, variants });
  }
  return { all, ready, later };
}
