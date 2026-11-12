// A picture edit started in the artwork brush: the request to the image model (one at a time, sent
// for the design open then), its result waiting for Keep / Try again / Discard, Keep's new version
// and chat entry, and whether the build that follows lines up with the version it came from. Also
// the mark on each picture (PICTURE_MARKS_KEY), saved with the design as the user selects.
import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { flushSync } from 'react-dom';
import type { Box3, Design, EvalResult, ParamValue } from '../../shared/types';
import type { PictureEditRequest, PictureEditResponse } from '../../shared/api';
import { ARTWORK_EDITS_KEY, parseArtworkEdits } from '../../shared/artworkEdits';
import { DRAWINGS_KEY } from '../../shared/svgFeatures';
import { parsePictureMarks, PICTURE_MARKS_KEY, type PictureMark } from '../../shared/pictureEdit/mark';
import { api } from '../lib/api';
import { applyPictureEdit, pictureChangedSince, requestPictureEdit, type PictureEditUi } from '../lib/pictureEdit';
import { withoutEditHistory } from './designValues';
import { useLinesUp } from './useLinesUp';

/** Said when the picture was changed by something else between the request and Keep. */
export const PICTURE_CHANGED = 'The picture changed while editing; try again';

type StartArgs = Parameters<PictureEditUi['start']>[0];
/** What an edit was asked for, and the design as it was then: its id, the picture and its hand edits as saved, the model's box. */
interface Sent { designId: string; picture: string; fp: string; args: StartArgs; request: PictureEditRequest; drawings: ParamValue | undefined; edits: ParamValue | undefined; parentBox: Box3 | null }
interface Job { sent: Sent; startedAt: number; abort: AbortController | null; result: PictureEditResponse | null; error: string | null; keeping: boolean }

/** Before and after side by side on white, as one PNG data URL (for the chat). */
async function sideBySide(before: string, after: string): Promise<string> {
  const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('A picture could not be read')); im.src = src; });
  const [a, b] = await Promise.all([load(before), load(after)]);
  const h = Math.max(a.naturalHeight, b.naturalHeight), gap = Math.round(h / 40);
  const wa = Math.round((a.naturalWidth * h) / a.naturalHeight), wb = Math.round((b.naturalWidth * h) / b.naturalHeight);
  const c = document.createElement('canvas');
  c.width = wa + gap + wb; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(a, 0, 0, wa, h);
  ctx.drawImage(b, wa + gap, 0, wb, h);
  return c.toDataURL('image/png');
}

/**
 * `locked`: why the shown version can't change (it is printed, or being marked), or null. The lock
 * closes the editor (App), and an edit being kept then is not kept: no editor changes a printed version.
 */
export function usePictureEdit({ design, setDesign, result, busy, locked }: {
  design: Design; setDesign: Dispatch<SetStateAction<Design>>; result: EvalResult | null; busy: boolean; locked: string | null;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef(job);
  jobRef.current = job;
  const designRef = useRef(design);
  designRef.current = design;
  const resultRef = useRef(result);
  resultRef.current = result;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // Lines up is measured on the build of the kept edit's values (once).
  const watchLinesUp = useLinesUp({ design, setDesign, result, busy });

  /** Sends `sent` (dropping an edit still running), its answer or error kept for the editor. */
  const run = (sent: Sent) => {
    jobRef.current?.abort?.abort();
    const abort = new AbortController();
    setJob({ sent, startedAt: Date.now(), abort, result: null, error: null, keeping: false });
    requestPictureEdit(sent.designId, sent.request, abort.signal).then(
      (r) => setJob((j) => (j?.abort === abort ? { ...j, abort: null, result: r } : j)),
      (e: Error) => { if (!abort.signal.aborted) setJob((j) => (j?.abort === abort ? { ...j, abort: null, error: e.message } : j)); },
    );
  };
  /** The request for the open design as it is now: its values with the editor's unsaved strokes in, as Done would save them. */
  const start = (picture: string, fp: string, args: StartArgs) => {
    const d = designRef.current, saved = d.values[ARTWORK_EDITS_KEY];
    const values = withoutEditHistory(d.values);
    if (args.draft) {
      const { [picture]: _old, ...rest } = parseArtworkEdits(saved);
      const next = args.draft.length ? { ...rest, [picture]: { fp, strokes: args.draft } } : rest;
      if (Object.keys(next).length) values[ARTWORK_EDITS_KEY] = JSON.stringify(next); else delete values[ARTWORK_EDITS_KEY];
    }
    const request: PictureEditRequest = { mode: 'artwork', picture, values, ...(args.mark ? { mark: args.mark } : {}), change: args.change, photos: args.photos };
    run({ designId: d.id, picture, fp, args, request, drawings: d.values[DRAWINGS_KEY], edits: saved, parentBox: resultRef.current?.bbox ?? null });
  };
  const drop = () => { jobRef.current?.abort?.abort(); setJob(null); };
  /** The same edit asked again, of the picture as it is now. */
  const retry = () => { const j = jobRef.current; if (j) start(j.sent.picture, j.sent.fp, j.sent.args); };

  /**
   * Keeps the result in the design it was asked for: its pictures stored with the design, the values
   * set, a version and the chat entry. Refused when the picture or its hand edits changed meanwhile.
   */
  const keep = async (): Promise<boolean> => {
    const j = jobRef.current;
    if (!j?.result || j.keeping) return false;
    const { sent, result: r } = j;
    const changed = (d: Design) => pictureChangedSince(d, sent);
    // (A result made from a picture that has changed since can't be kept at all: it goes.)
    const refuse = (error: string) => { setJob((x) => (x?.sent === sent ? { ...x, result: error === PICTURE_CHANGED ? null : x.result, keeping: false, error } : x)); return false; };
    // A printed version shown (marked here or in another tab, also while the pictures are stored): nothing is kept.
    if (lockedRef.current) return refuse(`${lockedRef.current}.`);
    if (changed(designRef.current)) return refuse(PICTURE_CHANGED);
    setJob({ ...j, keeping: true, error: null });
    let images: { photos: string[]; render: string };
    try {
      const [render, ...photos] = await Promise.all([sideBySide(r.before, r.after).then((src) => api.storeImage(sent.designId, src)), ...sent.request.photos.map((src) => api.storeImage(sent.designId, src))]);
      images = { photos, render };
    } catch (e) {
      return refuse(`The edit could not be kept: ${(e as Error).message}`);
    }
    if (lockedRef.current) return refuse(`${lockedRef.current}.`);
    if (changed(designRef.current)) return refuse(PICTURE_CHANGED);
    const info = { picture: sent.picture, change: sent.request.change, masked: r.masked, cost: r.cost };
    // Applied at once (flushSync), so whether the design had changed by then is known here.
    let kept = false as boolean;
    flushSync(() => setDesign((d) => {
      kept = false;
      if (changed(d)) return d;
      // The hand edits as sent (with the editor's unsaved strokes), then what the edit sets.
      const values = { ...d.values };
      const sentEdits = sent.request.values[ARTWORK_EDITS_KEY];
      if (sentEdits != null) values[ARTWORK_EDITS_KEY] = sentEdits; else delete values[ARTWORK_EDITS_KEY];
      const next = applyPictureEdit({ ...d, values }, r, info, images);
      watchLinesUp({ designId: d.id, version: next.currentVersion, values: next.values, parentBox: sent.parentBox, masked: r.masked, outsideSame: r.outsideSame });
      kept = true;
      return next;
    }));
    if (!kept) return refuse(PICTURE_CHANGED);
    setJob(null);
    return true;
  };

  /** The mark on a picture saved with the design (with the picture's fingerprint), or taken away. */
  const setMark = (picture: string, fp: string, mark: PictureMark | null) => setDesign((d) => {
    const { [picture]: _old, ...rest } = parsePictureMarks(d.values[PICTURE_MARKS_KEY]);
    const all = mark?.strokes.length ? { ...rest, [picture]: { fp, mark } } : rest;
    const values = { ...d.values };
    if (Object.keys(all).length) values[PICTURE_MARKS_KEY] = JSON.stringify(all); else delete values[PICTURE_MARKS_KEY];
    return { ...d, values, updatedAt: Date.now() };
  });

  /** The edit as the editor of `picture` (fingerprint `fp`) shows it. */
  const ui = (picture: string, fp: string): PictureEditUi => {
    const mine = job?.sent.picture === picture ? job : null;
    return {
      busy: !!mine?.abort, startedAt: mine?.startedAt ?? 0, result: mine?.result ?? null, error: mine?.error ?? null, keeping: !!mine?.keeping,
      start: (args) => start(picture, fp, args), cancel: drop, keep, retry, discard: drop,
    };
  };
  return { ui, setMark };
}
