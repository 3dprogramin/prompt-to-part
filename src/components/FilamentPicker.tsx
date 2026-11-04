import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { hexToRgb, luma, type LayerToneFilament } from '../../shared/layertone';
import { COMMON_FILAMENTS, filamentLines, libraryFilament, MY_TD_RANGE, myFilamentKey, pickerFilaments, searchMyFilaments, type FilamentLookup, type LibraryFilament } from '../../shared/filaments';
import { siteName } from '../../shared/sources';
import { api, lookupFilament } from '../lib/api';
import { Icon } from './Icon';
import { NumBox } from './NumBox';
import { usePopover } from './usePopover';

const LINES = filamentLines();
/** Tab labels: Bambu Lab's lines by their own name ("Matte"), other brands with theirs ("eSUN PLA+"). */
const short = (l: { brand: string; line: string }) => (l.brand === 'Bambu Lab' ? l.line.replace(/^PLA /, '') : `${l.brand} ${l.line}`);

const CONFIDENCE: Record<FilamentLookup['confidence'], [string, 'high' | 'medium' | 'low']> = {
  listed: ['Published TD', 'high'],
  similar: ['From a similar filament', 'medium'],
  estimate: ['Estimate', 'low'],
};

/** A swatch in the grid: a library filament or one of the user's own. */
type Option = LayerToneFilament & { unverified?: boolean };

const sameFilament = (a: { brand?: string; name: string }, b: { brand?: string; name: string }) => (a.brand ?? '') === (b.brand ?? '') && a.name === b.name;
const optionKey = (group: string, f: Option) => `${group}:${f.brand ?? ''} ${f.name}`;
const describe = (f: Option) => `${f.name}${f.brand ? `, ${f.brand}` : ''}, TD ${f.td} mm${f.unverified ? ' (estimated)' : ''}`;

// The user's own filaments (GET/PUT /api/filaments/mine), shared by every open picker. Fetched each
// time a picker opens, so a change made in another tab shows up.
const mine = { list: [] as LayerToneFilament[], subs: new Set<(l: LayerToneFilament[]) => void>() };
const setMine = (list: LayerToneFilament[]) => { mine.list = list; mine.subs.forEach((f) => f(list)); };
const saveMine = async (list: LayerToneFilament[]) => setMine(await api.saveMyFilaments(list));
function useMyFilaments(): LayerToneFilament[] {
  const [list, setList] = useState(mine.list);
  useEffect(() => {
    mine.subs.add(setList);
    api.myFilaments().then(setMine, () => {});
    return () => { mine.subs.delete(setList); };
  }, []);
  return list;
}

interface Props {
  /** The filament being changed; none when adding one. */
  current?: LayerToneFilament;
  /** The control that opened the picker: pressing it again closes it, and the focus goes back to it. */
  trigger: RefObject<HTMLElement | null>;
  /** A library filament or a custom one: replace `current` with it, or add it. */
  onPick: (f: LayerToneFilament) => void;
  onClose: () => void;
}

/**
 * The filament picker, a popover under (or over) its anchor, the nearest positioned ancestor: search,
 * the library's lines, a swatch grid with the common colours first, and a custom colour.
 */
export function FilamentPicker({ current, trigger, onPick, onClose }: Props) {
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  usePopover(true, onClose, pop, trigger);
  const id = useId();
  const [query, setQuery] = useState('');
  const [line, setLine] = useState('');
  const myFilaments = useMyFilaments();
  const [editing, setEditing] = useState(false);
  const selected: Option | undefined = useMemo(() => (current ? myFilaments.find((f) => myFilamentKey(f) === myFilamentKey(current)) ?? libraryFilament(current) : undefined), [current, myFilaments]);

  // The grid: the search results, or the user's own and the common colours and every line (or the
  // chosen one). The user's own are a list of their own while they are edited.
  const groups = useMemo(() => {
    const own = editing ? [] : myFilaments;
    if (query.trim()) return [{ key: 'found', label: undefined, filaments: [...(line ? [] : searchMyFilaments(own, query)), ...pickerFilaments(query, line || undefined)] as Option[] }];
    const lines = LINES.filter((l) => !line || l.key === line).map((l) => ({ key: l.key, label: l.key, filaments: l.filaments as Option[] }));
    return line ? lines : [...(own.length ? [{ key: 'mine', label: 'My filaments', filaments: own as Option[] }] : []), { key: 'common', label: 'Common', filaments: COMMON_FILAMENTS as Option[] }, ...lines];
  }, [query, line, myFilaments, editing]);
  const options = groups.flatMap((g) => g.filaments.map((f: Option) => ({ key: optionKey(g.key, f), f })));
  // The option the grid's one tab stop is on: the current filament, else the first.
  const [active, setActive] = useState<string | null>(null);
  const activeKey = options.find((o) => o.key === active)?.key ?? options.find((o) => selected && sameFilament(o.f, selected))?.key ?? options[0]?.key;
  const [hover, setHover] = useState<Option | null>(null);
  const focused = options.find((o) => o.key === active)?.f;
  const shown: Option | undefined = hover ?? focused ?? selected;

  // The custom colour being made; `original` = the key of the saved filament it edits.
  const [custom, setCustom] = useState<(LayerToneFilament & { original?: string }) | null>(null);
  const openCustom = () => setCustom(current ? { ...stackFields(current) } : { name: query.trim(), brand: '', color: '#808080', td: 1 });

  // Under the anchor, or over it when it doesn't fit below but does above; then scrolled into view.
  // Above, it must fit in the panel's content: what sticks out over the top can't be scrolled to.
  // Checked again when it grows (the user's filaments arrive, the custom colour opens).
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    const el = pop.current, anchor = el?.offsetParent;
    if (!el || !anchor) return;
    const scroller = el.closest('.tab-body') ?? document.documentElement;
    const a = anchor.getBoundingClientRect(), s = scroller.getBoundingClientRect(), h = el.offsetHeight + 4;
    const below = s.bottom - a.bottom, above = a.top - s.top;
    setUp(h > below && h <= above + scroller.scrollTop && above > below);
  }, [myFilaments.length > 0, !!custom, editing]);
  useEffect(() => { pop.current?.scrollIntoView({ block: 'nearest' }); }, [up, !!custom, editing, myFilaments.length > 0]);
  // The current filament in view in the grid.
  useEffect(() => { grid.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, []);

  const pick = (f: LayerToneFilament) => onPick({ name: f.name, brand: f.brand, color: f.color, td: f.td });
  const focusOption = (el: HTMLElement | undefined) => {
    if (!el) return;
    setActive(el.dataset.key ?? null);
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
  };
  // Arrows move by the swatches' places on screen, so they follow the grid however many fit a row.
  const onGridKey = (e: React.KeyboardEvent) => {
    const els = [...(grid.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    let to: HTMLElement | undefined;
    if (e.key === 'ArrowRight') to = els[i + 1];
    else if (e.key === 'ArrowLeft') to = els[i - 1];
    else if (e.key === 'Home') to = els[0];
    else if (e.key === 'End') to = els.at(-1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const r = els[i].getBoundingClientRect(), x = r.left + r.width / 2, down = e.key === 'ArrowDown';
      const rows = els.filter((el) => (down ? el.getBoundingClientRect().top > r.top + 2 : el.getBoundingClientRect().top < r.top - 2));
      const rowTop = rows.length ? (down ? Math.min : Math.max)(...rows.map((el) => el.getBoundingClientRect().top)) : undefined;
      const row = rows.filter((el) => Math.abs(el.getBoundingClientRect().top - rowTop!) < 2);
      to = row.sort((a, b) => Math.abs(a.getBoundingClientRect().left + a.offsetWidth / 2 - x) - Math.abs(b.getBoundingClientRect().left + b.offsetWidth / 2 - x))[0];
      if (!to && !down) { e.preventDefault(); search.current?.focus(); return; }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const o = options.find((o) => o.key === els[i].dataset.key);
      if (o) pick(o.f);
      return;
    } else return;
    e.preventDefault();
    focusOption(to);
  };
  const onTabsKey = (e: React.KeyboardEvent) => {
    const keys = ['', ...LINES.map((l) => l.key)];
    const i = keys.indexOf(line);
    const to = e.key === 'ArrowRight' ? (i + 1) % keys.length : e.key === 'ArrowLeft' ? (i - 1 + keys.length) % keys.length : -1;
    if (to < 0) return;
    e.preventDefault();
    setLine(keys[to]);
    pop.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };
  // Tab and Shift+Tab go round the picker's controls.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !pop.current) return;
    const els = [...pop.current.querySelectorAll<HTMLElement>('input, button, [tabindex]')].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length);
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey ? i <= 0 : i === els.length - 1) { e.preventDefault(); els[e.shiftKey ? els.length - 1 : 0]?.focus(); }
  };

  return (
    <div ref={pop} className={`layertone-picker ${up ? 'up' : ''}`} role="dialog" aria-label={current ? `Change ${current.name}` : 'Add a filament'} onKeyDown={onKey}>
      <input ref={search} className="text-param" autoFocus value={query} placeholder='Search, e.g. "matte black", "esun red"' aria-label="Search the filaments" aria-controls={`${id}-grid`}
        onChange={(e) => { setQuery(e.target.value); setActive(null); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); focusOption(grid.current?.querySelector<HTMLElement>('[tabindex="0"]') ?? undefined); }
          if (e.key === 'Enter' && query.trim() && options[0]) { e.preventDefault(); pick(options[0].f); }
        }} />
      <div className="seg layertone-lines" role="tablist" aria-label="Filament lines" onKeyDown={onTabsKey}>
        {[{ key: '', label: 'All', title: 'Every filament' }, ...LINES.map((l) => ({ key: l.key, label: short(l), title: l.key }))].map((t) => (
          <button key={t.key} role="tab" className={line === t.key ? 'on' : ''} aria-selected={line === t.key} tabIndex={line === t.key ? 0 : -1} aria-controls={`${id}-grid`} title={t.title}
            onClick={() => { setLine(t.key); setActive(null); }}>{t.label}</button>
        ))}
      </div>
      <div ref={grid} id={`${id}-grid`} className="layertone-grid" role="listbox" aria-label={query.trim() ? `Filaments matching "${query.trim()}"` : 'Filaments'} onKeyDown={onGridKey} onMouseLeave={() => setHover(null)}>
        {groups.map((g) => (
          <div key={g.key} role="group" aria-labelledby={g.label ? `${id}-${g.key}` : undefined}>
            {g.label && <div className="layertone-grid-head" id={`${id}-${g.key}`}>{g.label}</div>}
            <div className="layertone-swatches">
              {g.filaments.map((f) => {
                const key = optionKey(g.key, f);
                const on = !!selected && sameFilament(f, selected);
                return (
                  <div key={key} data-key={key} role="option" aria-selected={on} aria-label={describe(f)} title={describe(f)} tabIndex={key === activeKey ? 0 : -1}
                    className="layertone-option" style={{ background: f.color }}
                    onClick={() => pick(f)} onMouseEnter={() => setHover(f)} onFocus={() => setActive(key)}>
                    {on && <span className={luma(hexToRgb(f.color)) > 0.55 ? 'ink-dark' : 'ink-light'}><Icon name="check" size={13} /></span>}
                    {f.unverified && <span className="layertone-est-mark" aria-hidden>~</span>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {!options.length && <div className="layertone-grid-empty dim small">No filament in the library matches: use a custom colour.</div>}
      </div>
      {myFilaments.length > 0 && !query.trim() && !line && (
        <MyFilamentsEdit list={myFilaments} editing={editing} onEditing={setEditing} onEdit={(f) => setCustom({ ...f, brand: f.brand ?? '', original: myFilamentKey(f) })} />
      )}
      <div className="layertone-pick-detail small" aria-hidden>
        {shown
          ? <><span className="swatch" style={{ background: shown.color }} /><span className="layertone-title">{shown.name}</span><span className="dim">{shown.brand}</span><span className="mono">TD {shown.td}{shown.unverified ? '~' : ''}</span></>
          : <span className="dim">{current ? `${current.name} is not in the library` : 'Pick a colour'}</span>}
      </div>
      <div className="dim small"><span className="layertone-est">~</span> TD estimated, not measured</div>
      {!custom
        ? <button className="link layertone-custom-open" onClick={openCustom}><Icon name="pen" size={12} /> Custom colour…</button>
        : <CustomFilament value={custom} onChange={setCustom} adding={!current} onDone={pick} mine={myFilaments} />}
    </div>
  );
}

/** A colour and name of the user's own, with a TD to type or look up (library, then the web). */
function CustomFilament({ value, onChange, adding, onDone, mine: list }: {
  value: LayerToneFilament & { original?: string }; onChange: (f: LayerToneFilament & { original?: string }) => void; adding: boolean; onDone: (f: LayerToneFilament) => void;
  /** The user's saved filaments, which "Save as mine" adds to (or, editing one, changes). */
  mine: LayerToneFilament[];
}) {
  const [lookup, setLookup] = useState<{ busy: boolean; result?: FilamentLookup; error?: string } | null>(null);
  const [saved, setSaved] = useState<{ busy?: boolean; ok?: boolean; error?: string } | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const look = async () => {
    setLookup({ busy: true });
    try {
      const r = await lookupFilament(value.brand ?? '', value.name);
      setLookup({ busy: false, result: r });
      onChange({ ...latest.current, td: r.filament.td, color: r.filament.color });
    } catch (e) {
      setLookup({ busy: false, error: (e as Error).message });
    }
  };
  const name = value.name.trim();
  const save = async () => {
    const f = stackFields({ ...latest.current, name, brand: latest.current.brand?.trim() || undefined });
    const key = myFilamentKey(f);
    setSaved({ busy: true });
    try {
      // In place when editing a saved one (or saving one again), else at the end.
      const at = list.findIndex((m) => myFilamentKey(m) === (value.original ?? key));
      const rest = list.filter((m, i) => i !== at && myFilamentKey(m) !== key);
      await saveMine(at < 0 ? [...rest, f] : [...rest.slice(0, at), f, ...rest.slice(at)]);
      onChange({ ...latest.current, original: key });
      setSaved({ ok: true });
    } catch (e) {
      setSaved({ error: (e as Error).message });
    }
  };
  return (
    <div className="layertone-custom-box">
      {value.original && <div className="dim small">Editing a saved filament: “Save changes” keeps it for every design.</div>}
      <div className="layertone-custom">
        <label className="layertone-swatch big" style={{ background: value.color }} title={value.color}>
          <input type="color" value={value.color} aria-label="Colour" onChange={(e) => onChange({ ...value, color: e.target.value })} />
        </label>
        <input className="text-param" autoFocus value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Name, e.g. PLA Matte Ivory White" aria-label="Filament name" />
        <input className="text-param" value={value.brand ?? ''} onChange={(e) => onChange({ ...value, brand: e.target.value })} placeholder="Brand, e.g. Bambu Lab" aria-label="Brand" />
        <label className="layertone-td" title="Transmission distance: the thickness at which this filament hides what is under it">
          <span className="dim small">TD</span>
          <NumBox value={value.td} min={MY_TD_RANGE[0]} max={MY_TD_RANGE[1]} label="TD" onCommit={(td) => onChange({ ...latest.current, td })} />
        </label>
      </div>
      {lookup?.result && <LookupNote r={lookup.result} />}
      {lookup?.error && <div className="bad-note small" role="alert">{lookup.error}</div>}
      {saved?.error && <div className="bad-note small" role="alert">{saved.error}</div>}
      <div className="layertone-add-actions">
        <button className="btn ghost" disabled={!name || lookup?.busy} onClick={() => void look()} title="Find this filament's TD and colour (library and the web)">
          {lookup?.busy ? <><span className="spinner" /> Looking up…</> : 'Look up TD'}
        </button>
        <button className="btn ghost" disabled={!name || saved?.busy} onClick={() => void save()} title="Keep it in My filaments, to pick in any design (suggestions prefer them too)">
          {saved?.ok ? <><Icon name="check" size={13} /> Saved</> : value.original ? 'Save changes' : 'Save as mine'}
        </button>
        <span className="spacer" />
        <button className="btn primary" disabled={!name} onClick={() => onDone({ ...latest.current, name, brand: latest.current.brand?.trim() || undefined })}>
          {adding ? <><Icon name="plus" size={14} /> Add</> : 'Use'}
        </button>
      </div>
    </div>
  );
}

/** Name, brand, colour and TD only. */
const stackFields = (f: LayerToneFilament): LayerToneFilament => ({ name: f.name, ...(f.brand ? { brand: f.brand } : {}), color: f.color, td: f.td });

/** The user's saved filaments while they are edited: change one, or remove it (a second click confirms). */
function MyFilamentsEdit({ list, editing, onEditing, onEdit }: { list: LayerToneFilament[]; editing: boolean; onEditing: (on: boolean) => void; onEdit: (f: LayerToneFilament) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = async (key: string) => {
    setError(null);
    try {
      await saveMine(list.filter((f) => myFilamentKey(f) !== key));
    } catch (e) {
      setError((e as Error).message);
    }
    setConfirm(null);
  };
  if (!editing) return <button className="link layertone-mine-edit" onClick={() => onEditing(true)}><Icon name="sliders" size={12} /> Edit my filaments…</button>;
  return (
    <div className="layertone-mine">
      <div className="layertone-grid-head">My filaments <button className="link" onClick={() => onEditing(false)}>Done</button></div>
      <ul>
        {list.map((f) => {
          const key = myFilamentKey(f);
          return (
            <li key={key}>
              <span className="swatch" style={{ background: f.color }} />
              <span className="layertone-title" title={f.name}>{f.name}</span>
              <span className="mono small dim">TD {f.td}</span>
              <button className="icon-btn" onClick={() => onEdit(f)} aria-label={`Edit ${f.name}`} title="Edit"><Icon name="pen" size={12} /></button>
              <button className={`icon-btn ${confirm === key ? 'confirm' : ''}`} onClick={() => (confirm === key ? void remove(key) : setConfirm(key))} onBlur={() => setConfirm((c) => (c === key ? null : c))}
                aria-label={confirm === key ? `Remove ${f.name}: click again to confirm` : `Remove ${f.name}`} title={confirm === key ? 'Click again to remove' : 'Remove'}>
                {confirm === key ? 'Remove?' : <Icon name="x" size={12} />}
              </button>
            </li>
          );
        })}
      </ul>
      {error && <div className="bad-note small" role="alert">{error}</div>}
    </div>
  );
}

function LookupNote({ r }: { r: FilamentLookup }) {
  const [label, trust] = CONFIDENCE[r.confidence] ?? CONFIDENCE.estimate;
  const src = (r.filament as LibraryFilament).source;
  // Only a valid web address is a link (a bad one like "https://" would throw here and blank the app).
  const site = siteName(src);
  return (
    <div className="layertone-lookup small" role="status">
      <span className={`src-kind ${trust}`}>{label}</span>
      <span>TD <span className="mono">{r.filament.td} mm</span>{r.filament.brand ? ` · ${r.filament.brand} ${r.filament.name}` : ''}</span>
      {site ? <a href={src} target="_blank" rel="noopener noreferrer">{site}</a> : src ? <span className="dim">{src}</span> : null}
      {r.note && <span className="dim">{r.note}</span>}
    </div>
  );
}
