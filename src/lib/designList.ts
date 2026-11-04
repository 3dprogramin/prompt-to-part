// The Designs menu's list: filtered by a tag (or the stars), searched by name and sorted, and what
// a bulk action on the picked designs does.
import type { DesignSummary } from '../../shared/types';
import { BUILTIN_TAGS, builtinTag, foldText, hasTag } from '../../shared/tags';

export type DesignFilter = { kind: 'all' } | { kind: 'starred' } | { kind: 'untagged' } | { kind: 'tag'; tag: string };
export type DesignSort = 'updated' | 'created' | 'name';
export const DESIGN_SORTS: Record<DesignSort, string> = { updated: 'Last changed', created: 'Newest', name: 'Name' };

export const ALL: DesignFilter = { kind: 'all' };

/** How many designs have each tag: the built-ins first (even with none), then the user's tags by name. */
export function tagCounts(list: readonly DesignSummary[]): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const b of BUILTIN_TAGS) counts.set(foldText(b.name), { tag: b.name, count: 0 });
  for (const d of list) {
    for (const t of d.tags ?? []) {
      const c = counts.get(foldText(t)) ?? { tag: t, count: 0 };
      c.count++;
      counts.set(foldText(t), c);
    }
  }
  const all = [...counts.values()];
  const own = all.filter((c) => !builtinTag(c.tag)).sort((a, b) => foldText(a.tag).localeCompare(foldText(b.tag)));
  return [...all.filter((c) => builtinTag(c.tag)), ...own];
}

/** The filter as it applies now: a user tag no design has any more shows every design. */
export function liveFilter(filter: DesignFilter, list: readonly DesignSummary[]): DesignFilter {
  return filter.kind === 'tag' && !builtinTag(filter.tag) && !list.some((d) => hasTag(d.tags, filter.tag)) ? ALL : filter;
}

/** Whether a design passes the filter. */
export function inFilter(d: DesignSummary, filter: DesignFilter): boolean {
  switch (filter.kind) {
    case 'all': return true;
    case 'starred': return !!d.starred;
    case 'untagged': return !d.tags?.length;
    case 'tag': return hasTag(d.tags, filter.tag);
  }
}

/** The designs the menu lists: in the filter, with the search in their name (case and accents don't matter), sorted. */
export function shownDesigns(list: readonly DesignSummary[], filter: DesignFilter, query: string, sort: DesignSort): DesignSummary[] {
  const q = foldText(query.trim());
  const out = list.filter((d) => inFilter(d, filter) && (!q || foldText(d.name).includes(q)));
  if (sort === 'name') return out.sort((a, b) => foldText(a.name).localeCompare(foldText(b.name)) || b.updatedAt - a.updatedAt);
  if (sort === 'created') return out.sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt);
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A saved filter (localStorage) if it is still one, else every design. */
export function cleanFilter(v: unknown): DesignFilter {
  const f = v as DesignFilter | null;
  if (f?.kind === 'starred' || f?.kind === 'untagged') return { kind: f.kind };
  if (f?.kind === 'tag' && typeof f.tag === 'string' && f.tag.trim()) return { kind: 'tag', tag: f.tag };
  return ALL;
}

/** Whether all, some or none of the designs have the tag. */
export function tagState(list: readonly DesignSummary[], tag: string): 'all' | 'some' | 'none' {
  const n = list.filter((d) => hasTag(d.tags, tag)).length;
  return n === 0 ? 'none' : n === list.length ? 'all' : 'some';
}

/** Up to `max` names, then how many more. */
export function someNames(names: readonly string[], max = 8): string {
  const shown = names.slice(0, max).map((n) => `"${n}"`).join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

/**
 * A bulk delete: the designs to delete, those being worked on (left alone: stop them first), and
 * the question asked once for all of them (null when there is nothing to delete).
 */
export function deletePlan(list: readonly DesignSummary[], isRunning: (id: string) => boolean): { remove: DesignSummary[]; busy: DesignSummary[]; question: string | null } {
  const remove = list.filter((d) => !isRunning(d.id)), busy = list.filter((d) => isRunning(d.id));
  const skip = busy.length ? `\n\nNot deleted, ${busy.length === 1 ? 'it is' : 'they are'} still being worked on: ${someNames(busy.map((d) => d.name), 3)}.` : '';
  const what = remove.length === 1 ? 'this design' : `these ${remove.length} designs`;
  const lines = remove.slice(0, 12).map((d) => `- ${d.name}`).join('\n') + (remove.length > 12 ? `\nand ${remove.length - 12} more` : '');
  return { remove, busy, question: remove.length ? `Delete ${what} permanently, with ${remove.length === 1 ? 'its' : 'their'} photos?\n\n${lines}${skip}` : null };
}
