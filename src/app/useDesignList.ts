// The Designs menu's actions: deleting one design or several, starring and tagging them (a new
// design's tags wait until it is saved).
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Design, DesignSummary } from '../../shared/types';
import { cleanTags, withTag } from '../../shared/tags';
import { api, HttpError } from '../lib/api';
import { tell } from '../lib/tabs';
import { deletePlan, someNames } from '../lib/designList';
import type { useDesignSaving } from '../hooks/useDesignSaving';
import type { useCrossTabSync } from '../hooks/useCrossTabSync';
import type { Notice } from './notice';

export function useDesignList({ design, designs, setDesigns, running, remoteRunning, stopSaving, saveSoon, background, designRef, setNotice, forgetDesign, refreshList }: {
  design: Design; designs: DesignSummary[]; setDesigns: Dispatch<SetStateAction<DesignSummary[]>>;
  running: Record<string, AbortController>; remoteRunning: ReturnType<typeof useCrossTabSync>;
  stopSaving: ReturnType<typeof useDesignSaving>['stopSaving']; saveSoon: ReturnType<typeof useDesignSaving>['saveSoon'];
  background: RefObject<Map<string, Design>>; designRef: RefObject<Design>;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  /** Drops a deleted design from memory and the tabs. */
  forgetDesign: (id: string, refresh?: boolean) => void;
  refreshList: () => void;
}) {
  const deletingHere = useRef(new Set<string>());
  const deleteDesign = async (id: string) => {
    // A printed design is kept (the server refuses too): say so before asking or stopping anything.
    const printed = designs.find((d) => d.id === id)?.printed;
    if (printed?.length) {
      setNotice({ text: `Kept: it has printed versions (${printed.map((m) => `v${m.v + 1}`).join(', ')}). Unmark them first.`, level: 'warning', details: false });
      return;
    }
    if (!confirm('Delete this design permanently?')) return;
    deletingHere.current.add(id);
    const saving = stopSaving(id);
    try {
      // The server refuses to delete a design Claude is working on: stop it and wait until it has.
      running[id]?.abort();
      for (let tries = 0; ; tries++) {
        try {
          await api.deleteDesign(id);
          break;
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 409 && running[id] && tries < 40)) throw e;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } catch (e) {
      saving.undo();
      // The latest copy: a generation stopped for the delete may have changed it since the click.
      const copy = background.current.get(id) ?? (designRef.current.id === id ? designRef.current : null);
      if (copy) saveSoon(copy);
      deletingHere.current.delete(id);
      setNotice({ text: `Could not delete the design: ${(e as Error).message}`, level: 'error', details: false });
      return;
    }
    tell({ type: 'deleted', id });
    forgetDesign(id);
  };

  /**
   * Delete several designs after one question that names them. Designs being worked on (in any
   * tab) are left alone and named; each delete is the single delete's route, so one that fails
   * leaves the others deleted and is reported.
   */
  const deleteDesigns = async (ids: string[]) => {
    const busy = (id: string) => !!running[id] || remoteRunning[id] != null;
    const plan = deletePlan(designs.filter((d) => ids.includes(d.id)), busy);
    if (!plan.question) {
      if (plan.printed.length) setNotice({ text: `Nothing deleted: ${someNames(plan.printed.map((d) => d.name), 3)} ${plan.printed.length === 1 ? 'has' : 'have'} printed versions. Unmark them first.`, level: 'warning', details: false });
      else if (plan.busy.length) setNotice({ text: `Nothing deleted: still working on ${someNames(plan.busy.map((d) => d.name), 3)}. Stop it first.`, level: 'warning', details: false });
      return;
    }
    if (!confirm(plan.question)) return;
    const failed: string[] = [];
    let done = 0;
    for (const d of plan.remove) {
      deletingHere.current.add(d.id);
      const saving = stopSaving(d.id);
      try {
        await api.deleteDesign(d.id);
      } catch (e) {
        saving.undo();
        const copy = background.current.get(d.id) ?? (designRef.current.id === d.id ? designRef.current : null);
        if (copy) saveSoon(copy);
        deletingHere.current.delete(d.id);
        failed.push(`"${d.name}" (${(e as Error).message})`);
        continue;
      }
      tell({ type: 'deleted', id: d.id });
      forgetDesign(d.id, false);
      done++;
    }
    refreshList();
    const skipped = (plan.busy.length ? ` Left alone, still working on ${someNames(plan.busy.map((x) => x.name), 3)}.` : '')
      + (plan.printed.length ? ` Kept, printed: ${someNames(plan.printed.map((x) => x.name), 3)}.` : '');
    setNotice(failed.length
      ? { text: `Deleted ${done} of ${plan.remove.length} designs. Not deleted: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}.${skipped}`, level: 'error', details: false }
      : { text: `Deleted ${done === 1 ? 'the design' : `${done} designs`}.${skipped}`, level: skipped ? 'warning' : 'ok', details: false });
  };

  // Stars and tags change the list at once; the refreshed list follows. A new design's tags are
  // kept here until it is saved (only a saved design can be tagged), then sent.
  const [newTags, setNewTags] = useState<Record<string, string[]>>({});
  const patchList = (ids: string[], fn: (d: DesignSummary) => DesignSummary) => setDesigns((l) => l.map((d) => (ids.includes(d.id) ? fn(d) : d)));
  const listFailed = (what: string) => (e: Error) => setNotice({ text: `Could not ${what}: ${e.message}`, level: 'error', details: false });
  const starDesigns = (ids: string[], on: boolean) => {
    patchList(ids, (d) => ({ ...d, starred: on || undefined }));
    void Promise.all(ids.map((id) => api.starDesign(id, on))).catch(listFailed(on ? 'star them all' : 'unstar them all')).finally(refreshList);
  };
  const setDesignTags = (id: string, raw: string[]) => {
    const tags = cleanTags(raw);
    if (!designs.some((d) => d.id === id)) return setNewTags((t) => ({ ...t, [id]: tags }));
    patchList([id], (d) => ({ ...d, tags: tags.length ? tags : undefined }));
    api.tagDesign(id, tags).catch(listFailed('change the tags')).finally(refreshList);
  };
  const tagDesigns = (ids: string[], tag: string, on: boolean) => {
    patchList(ids, (d) => { const tags = withTag(d.tags, tag, on); return { ...d, tags: tags.length ? tags : undefined }; });
    api.tagDesigns(ids, tag, on).catch(listFailed(on ? `tag them "${tag}"` : `take "${tag}" away`)).finally(refreshList);
  };
  // A new design shows up in the list after its first save: its tags go to the server then.
  useEffect(() => {
    const ready = Object.keys(newTags).filter((id) => designs.some((d) => d.id === id));
    if (!ready.length) return;
    setNewTags((t) => Object.fromEntries(Object.entries(t).filter(([id]) => !ready.includes(id))));
    patchList(ready, (d) => ({ ...d, tags: newTags[d.id].length ? newTags[d.id] : undefined }));
    for (const id of ready) api.tagDesign(id, newTags[id]).catch(() => {}).finally(refreshList);
  }, [designs]);
  const designTags = newTags[design.id] ?? designs.find((d) => d.id === design.id)?.tags ?? [];
  return { deletingHere, deleteDesign, deleteDesigns, setNewTags, starDesigns, setDesignTags, tagDesigns, designTags };
}
