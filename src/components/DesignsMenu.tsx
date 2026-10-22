import { useMemo, useState, type ReactNode } from 'react';
import type { DesignSummary } from '../../shared/types';
import { DESIGN_KIND_LABEL, type DesignKind } from '../../shared/designKind';
import { builtinTag, hasTag, MAX_TAGS, withTag } from '../../shared/tags';
import { DESIGN_SORTS, liveFilter, shownDesigns, tagCounts, tagState, type DesignFilter, type DesignSort } from '../lib/designList';
import { pickIds } from '../lib/picking';
import { load, store } from '../lib/storage';
import { Icon } from './Icon';
import { TagChips, TagEditor } from './Tags';

/** Each kind's icon, as in the chat's picture menu; a plain parametric model has none. */
const KIND_ICON: Partial<Record<DesignKind, string>> = { lineart: 'lineart', layertone: 'layers', lithophane: 'lamp', figure: 'figure', artwork: 'palette' };

/** A small, quiet icon telling what kind of design it is (nothing for a parametric model). */
export function KindIcon({ kind, size }: { kind: DesignKind | undefined; size: number }) {
  const icon = kind && KIND_ICON[kind];
  return icon ? <span className="kind-icon" title={DESIGN_KIND_LABEL[kind]} aria-label={DESIGN_KIND_LABEL[kind]} role="img"><Icon name={icon} size={size} /></span> : null;
}

/** Recent designs the Designs menu lists before "Load more". */
const PAGE = 10;

interface Props {
  designs: DesignSummary[];
  /** Why the design list couldn't be loaded, or null. */
  listError: string | null;
  /** The open design. */
  currentId: string;
  onRefreshList: () => void;
  isRunning: (id: string) => boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  /** Deletes the picked designs after one question; resolves when done (or not asked). */
  onDeleteMany: (ids: string[]) => Promise<void>;
  onStar: (ids: string[], on: boolean) => void;
  onSetTags: (id: string, tags: string[]) => void;
  /** Adds a tag to the designs or takes it away. */
  onTag: (ids: string[], tag: string, on: boolean) => void;
  /** The tag (or the stars) the list shows: remembered, and new designs get Temp while it shows Temp. */
  filter: DesignFilter;
  onFilter: (f: DesignFilter) => void;
  /** The menu's foot (New design, backups). */
  children: ReactNode;
}

/**
 * The Designs menu: every saved design, newest change first (or by name or age), filtered by a tag
 * or the stars and searched by name, PAGE at a time. Each row opens, stars, tags or deletes its
 * design; the boxes pick designs (shift-click: a range) to star, tag or delete together.
 */
export function DesignsMenu(p: Props) {
  const [shown, setShown] = useState(PAGE);
  // Search by name: case and accents don't matter (ș finds s), the matches page like the list.
  const [query, setQuery] = useState('');
  const [sort, setSortState] = useState<DesignSort>(() => { const s = load<string>('designSort', 'updated'); return s in DESIGN_SORTS ? s as DesignSort : 'updated'; });
  const setSort = (s: DesignSort) => { setSortState(s); store('designSort', s); setShown(PAGE); };
  const filter = liveFilter(p.filter, p.designs);
  const setFilter = (f: DesignFilter) => { p.onFilter(f); setShown(PAGE); setEditing(null); };
  const matches = useMemo(() => shownDesigns(p.designs, filter, query, sort), [p.designs, filter, query, sort]);
  const counts = useMemo(() => tagCounts(p.designs), [p.designs]);
  const allTags = counts.map((c) => c.tag);
  // The designs picked for a bulk action: only the shown ones count, so a filter or a search can
  // never leave a hidden design picked for deleting.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const pickedShown = matches.filter((d) => picked.has(d.id));
  const ids = pickedShown.map((d) => d.id);
  const pick = (id: string, range: boolean) => { setPicked((cur) => pickIds(matches.map((d) => d.id), cur, id, anchor, range)); setAnchor(id); };
  const pickAll = (on: boolean) => { setPicked(new Set(on ? matches.map((d) => d.id) : [])); setAnchor(null); };
  // The row whose tags are being changed, the bulk tag toggles, and a bulk delete under way.
  const [editing, setEditing] = useState<string | null>(null);
  const [bulkTags, setBulkTags] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteMany = async () => {
    setDeleting(true);
    try { await p.onDeleteMany(ids); } finally { setDeleting(false); }
  };

  const chip = (f: DesignFilter, label: ReactNode, count: number, title: string, key: string, cls = '') => {
    const on = JSON.stringify(f) === JSON.stringify(filter);
    return (
      <button key={key} className={`filter-chip ${cls} ${on ? 'on' : ''}`} aria-pressed={on} title={title} onClick={() => setFilter(on ? { kind: 'all' } : f)}>
        {label} <span className="filter-count">{count}</span>
      </button>
    );
  };
  const filterName = filter.kind === 'tag' ? `tagged ${filter.tag}` : filter.kind === 'starred' ? 'starred' : filter.kind === 'untagged' ? 'without a tag' : '';

  const row = (d: DesignSummary) => (
    <div key={d.id} className="menu-row">
      <div className={`menu-item ${d.id === p.currentId ? 'on' : ''} ${d.starred ? 'starred' : ''} ${picked.has(d.id) ? 'picked' : ''}`}>
        <input type="checkbox" className="menu-pick" checked={picked.has(d.id)} readOnly aria-label={`Pick ${d.name}`}
          title="Pick it for starring, tagging or deleting several at once (shift-click: every design from the last one picked)"
          onClick={(e) => pick(d.id, e.shiftKey)} />
        <button className="menu-open" onClick={() => p.onOpen(d.id)}>
          <span>{p.isRunning(d.id) && <span className="spinner" />} {d.name} <KindIcon kind={d.kind} size={12} /></span>
          <span className="dim small menu-meta"><TagChips tags={d.tags} max={3} />{new Date(sort === 'created' ? d.createdAt : d.updatedAt).toLocaleString()} · {d.versions} {d.versions === 1 ? 'version' : 'versions'}</span>
        </button>
        <button className={`icon-btn menu-star ${d.starred ? 'on' : ''}`} title={d.starred ? 'Unstar' : 'Star: mark it as important'}
          aria-label={`${d.starred ? 'Unstar' : 'Star'} ${d.name}`} aria-pressed={!!d.starred} onClick={() => p.onStar([d.id], !d.starred)}><Icon name="star" size={14} /></button>
        <button className={`icon-btn menu-tag ${editing === d.id ? 'on' : ''}`} title="Tags: Product, Temp or your own" aria-label={`Tags of ${d.name}`} aria-expanded={editing === d.id}
          onClick={() => setEditing(editing === d.id ? null : d.id)}><Icon name="tag" size={14} /></button>
        <button className="icon-btn" title="Delete" aria-label={`Delete ${d.name}`} onClick={() => p.onDelete(d.id)}><Icon name="trash" size={14} /></button>
      </div>
      {editing === d.id && (
        <TagEditor tags={allTags} what={d.name} full={(d.tags?.length ?? 0) >= MAX_TAGS}
          stateOf={(t) => (hasTag(d.tags, t) ? 'all' : 'none')} onChange={(t, on) => p.onSetTags(d.id, withTag(d.tags, t, on))} />
      )}
    </div>
  );

  const allPicked = matches.length > 0 && pickedShown.length === matches.length;
  return (
    <div className="menu designs-menu">
      <div className="menu-top">
        {p.designs.length > 0 && (
          <div className="menu-search">
            <Icon name="search" size={13} />
            <input autoFocus type="search" placeholder="Search designs" aria-label="Search designs" value={query}
              onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) p.onOpen(matches[0].id); }} />
            {query && <button className="icon-btn" title="Clear the search" aria-label="Clear the search" onClick={() => { setQuery(''); setShown(PAGE); }}><Icon name="x" size={12} /></button>}
            <select className="menu-sort" aria-label="Sort designs" title="Sort designs" value={sort} onChange={(e) => setSort(e.target.value as DesignSort)}>
              {Object.entries(DESIGN_SORTS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>
        )}
        {p.designs.length > 0 && (
          <div className="menu-filters" role="group" aria-label="Show">
            {chip({ kind: 'all' }, 'All', p.designs.length, 'Every design', 'all')}
            {chip({ kind: 'starred' }, <Icon name="star" size={11} />, p.designs.filter((d) => d.starred).length, 'Starred designs', 'starred', 'starred')}
            {counts.map(({ tag, count }) => {
              const b = builtinTag(tag);
              return chip({ kind: 'tag', tag }, <>{b && <Icon name={b.icon} size={11} />}{tag}</>, count, b ? `${b.title}${tag === 'Temp' ? '. New designs get this tag while the list shows it.' : ''}` : `Designs tagged ${tag}`, `tag:${tag}`, b ? `tag-${b.name.toLowerCase()}` : '');
            })}
            {chip({ kind: 'untagged' }, 'No tag', p.designs.filter((d) => !d.tags?.length).length, 'Designs without a tag', 'untagged')}
          </div>
        )}
        {matches.length > 0 && (
          <div className={`menu-bulk ${pickedShown.length ? 'active' : ''}`}>
            <label className="menu-pick-all" title={allPicked ? 'Pick none' : `Pick all ${matches.length} designs listed${filterName ? ` (${filterName})` : ''}, also those under "Load more"`}>
              <input type="checkbox" checked={allPicked} ref={(el) => { if (el) el.indeterminate = pickedShown.length > 0 && !allPicked; }} onChange={() => pickAll(!allPicked)} />
              {pickedShown.length ? `${pickedShown.length} picked` : `Pick all ${matches.length}`}
            </label>
            {pickedShown.length > 0 && <>
              <span className="spacer" />
              <button className="icon-btn menu-star on" title="Star the picked designs" aria-label="Star the picked designs" onClick={() => p.onStar(ids, true)}><Icon name="star" size={13} /></button>
              <button className="icon-btn menu-star" title="Unstar the picked designs" aria-label="Unstar the picked designs" onClick={() => p.onStar(ids, false)}><Icon name="star" size={13} /></button>
              <button className={`icon-btn ${bulkTags ? 'on' : ''}`} title="Tag the picked designs" aria-label="Tag the picked designs" aria-expanded={bulkTags} onClick={() => setBulkTags(!bulkTags)}><Icon name="tag" size={13} /></button>
              <button className="btn danger small-btn" disabled={deleting} onClick={() => void deleteMany()} title="Delete the picked designs (asks once; designs Jig is working on are left alone)">
                {deleting ? <span className="spinner" /> : <Icon name="trash" size={12} />} {deleting ? 'Deleting…' : `Delete ${pickedShown.length}`}
              </button>
              <button className="icon-btn" title="Pick none" aria-label="Pick none" onClick={() => pickAll(false)}><Icon name="x" size={12} /></button>
            </>}
          </div>
        )}
        {bulkTags && pickedShown.length > 0 && (
          <TagEditor tags={allTags} what={`${pickedShown.length} designs`} stateOf={(t) => tagState(pickedShown, t)} onChange={(t, on) => p.onTag(ids, t, on)} />
        )}
      </div>
      {p.listError
        ? <div className="menu-empty">Could not load your designs: {p.listError} <button className="link" onClick={p.onRefreshList}>Try again</button></div>
        : p.designs.length === 0 ? <div className="menu-empty">No saved designs yet</div>
        : matches.length === 0 && (query.trim()
          ? <div className="menu-empty">{filterName ? `No design ${filterName} has a name containing` : 'No design\'s name contains'} “{query.trim()}”</div>
          : <div className="menu-empty">No designs {filterName} yet <button className="link" onClick={() => setFilter({ kind: 'all' })}>Show all</button></div>)}
      {matches.slice(0, shown).map(row)}
      {matches.length > shown && (
        <button className="menu-more" onClick={() => setShown((n) => n + PAGE)}>Load more ({matches.length - shown} more)</button>
      )}
      <div className="menu-foot">{p.children}</div>
    </div>
  );
}
