// What a reply's events do to its design: the values a picture edit sets (edit_picture), and the
// version a submitted model makes, recording the reply's picture edits when it made any.
import type { AgentEvent } from '../../shared/api';
import type { Design, PictureEditInfo } from '../../shared/types';
import { pageKey } from '../../shared/sources';
import { withSet } from '../lib/pictureEdit';
import { keepAppValues, withoutEditHistory } from './designValues';

/** The picture edits of one reply so far, as its version will record them. */
export type ReplyEdit = Extract<AgentEvent, { type: 'pictureEdited' }>['info'];
type ModelEvent = Extract<AgentEvent, { type: 'model' }>;

/** The design with the values a picture edit in the chat sets (null deletes). */
export function withPictureEdited(d: Design, set: Record<string, string | null>): Design {
  return { ...d, values: withSet(d.values, set) };
}

/**
 * One more picture edit in the same reply (`prev`: the ones before, or null). The version records
 * one edit, so (my call) it takes the last edit's picture and change, masked and unchanged outside
 * only if every edit was, and the costs summed (unknown only when none is known).
 */
export function addReplyEdit(prev: ReplyEdit | null, e: ReplyEdit): ReplyEdit {
  if (!prev) return { ...e };
  return {
    ...e, masked: prev.masked && e.masked, outsideSame: prev.outsideSame && e.outsideSame,
    cost: prev.cost == null && e.cost == null ? null : (prev.cost ?? 0) + (e.cost ?? 0),
  };
}

/**
 * The design with the version a submitted model makes, made current and linked from the reply
 * `asstId`. With `edit` (the reply edited a picture), the version records it: `parent` is the
 * version that was current when the reply started; lines up stays false until its build is measured.
 */
export function withReplyVersion(d: Design, ev: ModelEvent, asstId: string, edit?: { edit: ReplyEdit; parent: number }): Design {
  const values = keepAppValues(d.values);
  // A page Claude opened in an earlier generation of this design counts as opened.
  const seen = new Set(d.versions.flatMap((v) => v.sources ?? []).filter((s) => s.opened).map((s) => pageKey(s.url)));
  const sources = (ev.sources ?? []).map((s) => (s.url && !s.opened && seen.has(pageKey(s.url)) ? { ...s, opened: true } : s));
  const pictureEdit: PictureEditInfo | undefined = edit && {
    picture: edit.edit.picture, change: edit.edit.change, masked: edit.edit.masked, parent: edit.parent, linesUp: false, cost: edit.edit.cost,
  };
  const versions = [...d.versions, { code: ev.code, summary: ev.summary, createdAt: Date.now(), source: 'ai' as const, values: withoutEditHistory(values), sources, ...(ev.stability && { stability: ev.stability }), ...(pictureEdit && { pictureEdit }) }];
  const vi = versions.length - 1;
  return {
    ...d, versions, currentVersion: vi, code: ev.code, values, updatedAt: Date.now(),
    messages: d.messages.map((m) => (m.id === asstId ? { ...m, versionIndex: vi } : m)),
  };
}
