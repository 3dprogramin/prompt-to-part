import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { hexToRgb, luma, type LayerToneFilament } from '../../shared/layertone';
import { DUPLICATE_FILAMENT, libraryFilament, MY_TD_RANGE, myFilamentKey, withMyFilament, type FilamentLookup, type LibraryFilament, type MyFilament } from '../../shared/filaments';
import { siteName } from '../../shared/sources';
import { lookupFilament } from '../lib/api';
import { changeMine, useMyFilamentsState } from '../lib/myFilaments';
import { Icon } from './Icon';
import { NumBox } from './NumBox';
import { usePopover } from './usePopover';
import { openSettings } from './settings/openSettings';
import { libraryBrands } from './settings/filamentsTab';
import { useFrozenWhenReady } from '../lib/frozen';
import { noMatch, pickerGroups, pickerLines, validLine } from './filamentPickerView';

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

interface Props {
  /** The filament being changed; none when adding one. */
  current?: LayerToneFilament;
  /** The control that opened the picker: pressing it again closes it, and the focus goes back to it. */
  trigger: RefObject<HTMLElement | null>;
  /** A library filament or a custom one: replace `current` with it, or add it. */
  onPick: (f: LayerToneFilament) => void;
  onClose: () => void;
  /** An "Automatic" choice above the search (the app picks the filament); `on` when it is the current choice. */
  automatic?: { on: boolean; title: string; onPick: () => void };
}

/**
 * The filament picker, a popover under (or over) its anchor, the nearest positioned ancestor: search,
 * the library's brands, then a brand's lines, a swatch grid with the common colours first, and a custom colour.
 */
export function FilamentPicker({ current, trigger, onPick, onClose, automatic }: Props) {
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  usePopover(true, onClose, pop, trigger);
  const id = useId();
  const [query, setQuery] = useState('');
  const [brand, setBrand] = useState('');
  const [line, setLine] = useState('');
  const { list: myFilaments, status } = useMyFilamentsState();
  const selected: Option | undefined = useMemo(() => (current ? myFilaments.find((f) => myFilamentKey(f) === myFilamentKey(current)) ?? libraryFilament(current) : undefined), [current, myFilaments]);

  // The grid: the search results, or the user's own and the common colours and every line; with a
  // brand chosen, its lines (or the chosen one). The brands list the user's own first.
  // The brand row is ordered by the list as it was when it was first read (or failed to be), and stays so
  // while the picker is open: saving a filament must not move the buttons under the pointer.
  const orderBy = useFrozenWhenReady(myFilaments, status !== 'loading');
  const brands = useMemo(() => (orderBy ? libraryBrands(undefined, orderBy) : []), [orderBy]);
  const brandLines = useMemo(() => pickerLines(brand), [brand]);
  const groups = useMemo(() => pickerGroups({ query, brand, line }, myFilaments) as { key: string; label: string | undefined; filaments: Option[] }[], [query, brand, line, myFilaments]);
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
  }, [myFilaments.length > 0, !!custom]);
  useEffect(() => { pop.current?.scrollIntoView({ block: 'nearest' }); }, [up, !!custom, myFilaments.length > 0, brand !== '']);
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
  // Arrows move along a row of tabs (a brand row, a line row) and choose the one they land on.
  const onTabsKey = (keys: string[], value: string, choose: (k: string) => void) => (e: React.KeyboardEvent) => {
    const i = keys.indexOf(value);
    const to = e.key === 'ArrowRight' ? (i + 1) % keys.length : e.key === 'ArrowLeft' ? (i - 1 + keys.length) % keys.length : -1;
    if (to < 0) return;
    e.preventDefault();
    choose(keys[to]);
    (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };
  const chooseBrand = (b: string) => { setBrand(b); setLine(validLine(b, line)); setActive(null); };
  const chooseLine = (l: string) => { setLine(l); setActive(null); };
  // Tab and Shift+Tab go round the picker's controls.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !pop.current) return;
    const els = [...pop.current.querySelectorAll<HTMLElement>('input, button, [tabindex]')].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length);
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey ? i <= 0 : i === els.length - 1) { e.preventDefault(); els[e.shiftKey ? els.length - 1 : 0]?.focus(); }
  };

  return (
    <div ref={pop} className={`layertone-picker ${up ? 'up' : ''}`} role="dialog" aria-label={current ? `Change ${current.name}` : 'Add a filament'} onKeyDown={onKey}>
      {automatic && (
        <button className={`btn ghost layertone-auto${automatic.on ? ' on' : ''}`} aria-pressed={automatic.on} title={automatic.title} onClick={automatic.onPick}>
          {automatic.on && <Icon name="check" size={13} />} Automatic
        </button>
      )}
      <input ref={search} className="text-param" autoFocus value={query} placeholder='Search, e.g. "matte black", "esun red"' aria-label="Search the filaments" aria-controls={`${id}-grid`}
        onChange={(e) => { setQuery(e.target.value); setActive(null); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); focusOption(grid.current?.querySelector<HTMLElement>('[tabindex="0"]') ?? undefined); }
          if (e.key === 'Enter' && query.trim() && options[0]) { e.preventDefault(); pick(options[0].f); }
        }} />
      {orderBy && <div className="seg layertone-lines" role="tablist" aria-label="Filament brands" onKeyDown={onTabsKey(['', ...brands], brand, chooseBrand)}>
        {['', ...brands].map((b) => (
          <button key={b} role="tab" className={brand === b ? 'on' : ''} aria-selected={brand === b} tabIndex={brand === b ? 0 : -1} aria-controls={`${id}-grid`} title={b || 'Every filament'}
            onClick={() => chooseBrand(b)}>{b || 'All'}</button>
        ))}
      </div>}
      {brandLines.length > 0 && (
        <div className="seg layertone-lines layertone-line-row" role="tablist" aria-label={`${brand} lines`} onKeyDown={onTabsKey(['', ...brandLines.map((l) => l.key)], line, chooseLine)}>
          {[{ key: '', label: 'All lines', title: `Every ${brand} filament` }, ...brandLines.map((l) => ({ key: l.key, label: l.line || l.brand, title: l.key }))].map((t) => (
            <button key={t.key} role="tab" className={line === t.key ? 'on' : ''} aria-selected={line === t.key} tabIndex={line === t.key ? 0 : -1} aria-controls={`${id}-grid`} title={t.title}
              onClick={() => chooseLine(t.key)}>{t.label}</button>
          ))}
        </div>
      )}
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
        {!options.length && <NoMatch {...noMatch({ query, brand, line })} onEvery={() => chooseBrand('')} />}
      </div>
      {!query.trim() && !brand && (
        // Settings has room to browse, search and count rolls; the popover closes as it opens, and the
        // focus goes back to the control that opened the picker (where Settings returns it on close).
        <button className="link layertone-mine-edit" onClick={() => { trigger.current?.focus(); onClose(); openSettings('filaments'); }}>
          <Icon name="sliders" size={12} /> Edit my filaments in Settings
        </button>
      )}
      <div className="layertone-pick-detail small" aria-hidden>
        {shown
          ? <><span className="swatch" style={{ background: shown.color }} /><span className="layertone-title">{shown.name}</span><span className="dim">{shown.brand}</span><span className="mono">TD {shown.td}{shown.unverified ? '~' : ''}</span></>
          : <span className="dim">{current ? `${current.name} is not in the library` : 'Pick a colour'}</span>}
      </div>
      <div className="dim small"><span className="layertone-est">~</span> TD estimated, not measured</div>
      {!custom
        ? <button className="link layertone-custom-open" onClick={openCustom}><Icon name="pen" size={12} /> Custom colour…</button>
        : <CustomFilament value={custom} onChange={setCustom} adding={!current} onDone={pick} />}
    </div>
  );
}

function NoMatch({ text, everyBrand, onEvery }: { text: string; everyBrand: boolean; onEvery: () => void }) {
  return (
    <div className="layertone-grid-empty dim small">
      {text}
      {everyBrand && <> <button className="link" onClick={onEvery}>Search every brand</button></>}
    </div>
  );
}

/**
 * A colour and name of the user's own, with a TD to type or look up (library, then the web). In the
 * picker it is used in a design ("Add" or "Use", `onDone`); Settings' Filaments tab only saves it.
 */
export function CustomFilament({ value, onChange, adding, onDone, change = changeMine }: {
  value: LayerToneFilament & { original?: string }; onChange: (f: LayerToneFilament & { original?: string }) => void; adding: boolean;
  /** "Add" or "Use" it; without it the form has no such button. */
  onDone?: (f: LayerToneFilament) => void;
  /**
   * Makes "Save as mine" (or "Save changes") on the newest list of the user's filaments and saves it;
   * settles when that change was saved or refused. Default changeMine; the Filaments tab passes its queue.
   */
  change?: (f: (list: MyFilament[]) => { list: MyFilament[]; problem?: string }) => Promise<void>;
}) {
  const nameNote = useId();
  // A name and brand another saved filament has: said under the name, nothing saved.
  const [taken, setTaken] = useState(false);
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
    setTaken(false);
    try {
      // In place when editing a saved one (or saving one again), else at the end; never over another one.
      await change((list) => withMyFilament(list, f, value.original));
      onChange({ ...latest.current, original: key });
      setSaved({ ok: true });
    } catch (e) {
      const message = (e as Error).message;
      if (message === DUPLICATE_FILAMENT) { setTaken(true); setSaved(null); } else setSaved({ error: message });
    }
  };
  const edit = (f: LayerToneFilament & { original?: string }) => { setTaken(false); onChange(f); };
  return (
    <div className="layertone-custom-box">
      {value.original && <div className="dim small">Editing a saved filament: “Save changes” keeps it for every design.</div>}
      <div className="layertone-custom">
        <label className="layertone-swatch big" style={{ background: value.color }} title={value.color}>
          <input type="color" value={value.color} aria-label="Colour" onChange={(e) => onChange({ ...value, color: e.target.value })} />
        </label>
        <input className="text-param" autoFocus value={value.name} onChange={(e) => edit({ ...value, name: e.target.value })} placeholder="Name, e.g. PLA Matte Ivory White" aria-label="Filament name"
          aria-invalid={taken || undefined} aria-describedby={taken ? nameNote : undefined} />
        <input className="text-param" value={value.brand ?? ''} onChange={(e) => edit({ ...value, brand: e.target.value })} placeholder="Brand, e.g. Bambu Lab" aria-label="Brand" />
        <label className="layertone-td" title="Transmission distance: the thickness at which this filament hides what is under it">
          <span className="dim small">TD</span>
          <NumBox value={value.td} min={MY_TD_RANGE[0]} max={MY_TD_RANGE[1]} label="TD" onCommit={(td) => onChange({ ...latest.current, td })} />
        </label>
      </div>
      {taken && <div id={nameNote} className="bad-note small" role="alert">{DUPLICATE_FILAMENT}</div>}
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
        {onDone && <>
          <span className="spacer" />
          <button className="btn primary" disabled={!name} onClick={() => onDone({ ...latest.current, name, brand: latest.current.brand?.trim() || undefined })}>
            {adding ? <><Icon name="plus" size={14} /> Add</> : 'Use'}
          </button>
        </>}
      </div>
    </div>
  );
}

/** Name, brand, colour and TD only. */
export const stackFields = (f: LayerToneFilament): LayerToneFilament => ({ name: f.name, ...(f.brand ? { brand: f.brand } : {}), color: f.color, td: f.td });

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
