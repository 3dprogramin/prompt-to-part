import type { PhotoRequest } from '../../../shared/photos';

/** A size's request made from the first photo `url` (it starts with an empty `from.photo`, filled in once that photo exists). */
export const fromFirstPhoto = <T extends { request: PhotoRequest }>(job: T, url: string): T =>
  ({ ...job, request: { ...job.request, from: { ...job.request.from, photo: url } } });

/** A size still without its first photo: it cannot be made (or tried again) until that one is. */
export const lacksFirstPhoto = (job: { request: PhotoRequest }) => !!job.request.resize && !job.request.from?.photo;
