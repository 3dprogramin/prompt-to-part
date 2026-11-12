import type { Box3, ChatMessage, Design, DesignVersion, PictureEditInfo } from '../../shared/types';
import type { PictureEditRequest, PictureEditResponse } from '../../shared/api';
import type { ArtworkStroke } from '../../shared/artworkEdits';
import type { PictureMark } from '../../shared/pictureEdit/mark';
import { EDIT_HISTORY_KEY } from '../../shared/editHistory';
import { formatCost } from '../../shared/duration';
import { request } from './api';
import { uid } from './files';

/** Two bounding boxes agree to this many mm on all six bounds. */
const BOX_TOLERANCE = 0.01;

/** The six bounds of a box, or null when it is not a box (a stored value can be anything). */
function bounds(b: Box3): number[] | null {
  if (!Array.isArray(b.min) || !Array.isArray(b.max)) return null;
  const all = [...b.min, ...b.max];
  return all.length === 6 && all.every(Number.isFinite) ? all : null;
}

/** Whether a picture edit's build lines up with the version it came from: masked, unchanged outside the mark, same bounding box. */
export function linesUp(e: { masked: boolean; outsideSame: boolean }, parentBox: Box3 | null, box: Box3 | null): boolean {
  if (!e.masked || !e.outsideSame || !parentBox || !box) return false;
  const a = bounds(parentBox);
  const b = bounds(box);
  if (!a || !b) return false;
  return a.every((x, i) => Math.abs(x - b[i]) <= BOX_TOLERANCE);
}

/** The line under a version in the version menu: where it came from. */
export function versionNote(v: DesignVersion, count?: number): string {
  const e = v.pictureEdit;
  if (e) {
    // Versions only grow in normal use, so a parent index stays valid and is not remapped; one that is
    // missing, malformed or past the list (a hand-edited backup, an older client) is not named.
    const p = e.parent as unknown;
    const named = typeof p === 'number' && Number.isInteger(p) && p >= 0 && (count === undefined || p < count);
    return e.masked && e.linesUp && named ? `your picture edit, lines up with v${(p as number) + 1}` : 'your picture edit';
  }
  return v.source === 'manual' ? 'your code edit' : v.source === 'settings' ? 'your saved settings' : 'from the chat';
}

/**
 * A picture edit as an editor shows it (usePictureEdit): running (since `startedAt`), its result
 * waiting for Keep / Try again / Discard, why it failed, being kept; and what the editor's buttons do.
 * `start`: the mark (none: the whole picture), the change, photos as data URLs, and the editor's
 * strokes not saved yet (null: none; they go with the request, as Done would save them).
 */
export interface PictureEditUi {
  busy: boolean;
  startedAt: number;
  result: PictureEditResponse | null;
  error: string | null;
  keeping: boolean;
  start: (o: { mark: PictureMark | null; change: string; photos: string[]; draft: ArtworkStroke[] | null }) => void;
  cancel: () => void;
  /** Resolves true when the edit was kept (the editor closes then). */
  keep: () => Promise<boolean>;
  retry: () => void;
  discard: () => void;
}

/** Asks the server to edit a picture with the image model (10 to 60 s); throws an HttpError with the server's words. */
export async function requestPictureEdit(designId: string, r: PictureEditRequest, signal?: AbortSignal): Promise<PictureEditResponse> {
  return (await request(`/api/designs/${designId}/picture-edit`, { method: 'POST', body: JSON.stringify(r), signal })).json() as Promise<PictureEditResponse>;
}

/** What a picture edit's result says about itself: whether outside the mark is unchanged (a masked edit only), and its warnings. */
export function pictureEditNotes(r: Pick<PictureEditResponse, 'masked' | 'outsideSame' | 'offPalette' | 'simplified'>): { text: string; warn?: boolean }[] {
  const out: { text: string; warn?: boolean }[] = [];
  if (r.masked) out.push(r.outsideSame ? { text: 'Outside the mark: unchanged' } : { text: 'Outside the mark: changed too, so it won\'t line up with the version it came from', warn: true });
  if (r.offPalette) out.push({ text: r.offPalette.note, warn: true });
  if (r.simplified) out.push({ text: 'The new shapes were simplified to stay within the drawing\'s point limit', warn: true });
  return out;
}

/** The change in a version's summary: at most this many characters. */
const SUMMARY_CHANGE = 80;
const sentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);

/**
 * The design with a picture edit kept: the values it sets merged (null deletes), a new version
 * after the current one (its parent; `linesUp` false until the build that follows is measured) made
 * current, and a chat entry: the change with its photos, then the result with its version, the
 * before / after picture and the cost. `images` are the photos and the before / after picture as
 * stored with the design (never data URLs in the messages).
 */
export function applyPictureEdit(d: Design, r: PictureEditResponse, info: Omit<PictureEditInfo, 'linesUp' | 'parent'>, images: { photos: string[]; render: string }): Design {
  const values = { ...d.values };
  for (const [k, v] of Object.entries(r.set)) if (v === null) delete values[k]; else values[k] = v;
  const { [EDIT_HISTORY_KEY]: _history, ...versionValues } = values;
  const change = info.change.trim();
  const now = Date.now();
  const short = change.length > SUMMARY_CHANGE ? `${change.slice(0, SUMMARY_CHANGE - 1).trimEnd()}…` : change;
  const versions: DesignVersion[] = [...d.versions, {
    code: d.code, summary: `Picture edit: ${short}`, createdAt: now, source: 'manual', values: versionValues,
    pictureEdit: { ...info, change, parent: d.currentVersion, linesUp: false },
  }];
  const vi = versions.length - 1;
  const said = [`Picture edit kept as v${vi + 1}`, ...pictureEditNotes(r).map((n) => n.text), ...(info.cost != null ? [`Cost ${formatCost(info.cost)}`] : [])];
  const user: ChatMessage = { id: uid(), role: 'user', text: `Picture edit: ${change}`, ...(images.photos.length ? { images: images.photos } : {}), createdAt: now };
  const reply: ChatMessage = { id: uid(), role: 'assistant', text: said.map(sentence).join(' '), steps: [{ kind: 'render', ok: true, text: 'Before / after', image: images.render }], versionIndex: vi, createdAt: now };
  return { ...d, values, versions, currentVersion: vi, messages: [...d.messages, user, reply], updatedAt: now };
}
