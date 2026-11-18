// When the Designs menu asks again for a picture (or its size) the server has not given yet: never at
// once, so no path can turn into a loop of back-to-back requests, and at most MAX_TRIES asks in all.

/** Milliseconds between asks (the server's Retry-After). */
export const RETRY_MS = 3000;
/** The most asks for one picture, or for one picture's size. */
export const MAX_TRIES = 40;

/** The info route's answer: the size; null for no picture, for good; 'pending' while it is not drawn yet. */
export type ThumbInfo = { size: [number, number, number] } | null | 'pending';

/**
 * After an ask that did not give what was wanted: `tries` asks made so far, `info` what the info route
 * said ('error': it could not be reached). The milliseconds to wait before asking again, or null to stop.
 * A size means the picture is there but did not load: that waits too, as long as any other answer.
 */
export function nextTry(tries: number, info: ThumbInfo | 'error'): number | null {
  if (info === null || tries >= MAX_TRIES) return null;
  return RETRY_MS;
}
