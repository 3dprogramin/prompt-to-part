import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { hexToRgb, luma, type HfFilament } from '../../shared/hueforge';
import { COMMON_FILAMENTS, filamentLines, libraryFilament, pickerFilaments, type FilamentLookup, type LibraryFilament } from '../../shared/filaments';
import { lookupFilament } from '../lib/api';
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

const sameFilament = (a: { brand?: string; name: string }, b: { brand?: string; name: string }) => a.brand === b.brand && a.name === b.name;
const optionKey = (group: string, f: LibraryFilament) => `${group}:${f.brand} ${f.name}`;
const describe = (f: LibraryFilament) => `${f.name}, ${f.brand}, TD ${f.td} mm${f.unverified ? ' (estimated)' : ''}`;

interface Props {
  /** The filament being changed; none when adding one. */
  current?: HfFilament;
  /** The control that opened the picker: pressing it again closes it, and the focus goes back to it. */
  trigger: RefObject<HTMLElement | null>;
  /** A library filament or a custom one: replace `current` with it, or add it. */
  onPick: (f: HfFilament) => void;
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
  const selected = useMemo(() => (current ? libraryFilament(current) : undefined), [current]);

  // The grid: the search results, or the common colours and every line (or the chosen one).
  const groups = useMemo(() => {
    if (query.trim()) return [{ key: 'found', label: undefined, filaments: pickerFilaments(query, line || undefined) }];
    const lines = LINES.filter((l) => !line || l.key === line).map((l) => ({ key: l.key, label: l.key, filaments: l.filaments }));
    return line ? lines : [{ key: 'common', label: 'Common', filaments: COMMON_FILAMENTS }, ...lines];
  }, [query, line]);
  const options = groups.flatMap((g) => g.filaments.map((f) => ({ key: optionKey(g.key, f), f })));
  // The option the grid's one tab stop is on: the current filament, else the first.
  const [active, setActive] = useState<string | null>(null);
  const activeKey = options.find((o) => o.key === active)?.key ?? options.find((o) => selected && sameFilament(o.f, selected))?.key ?? options[0]?.key;
  const [hover, setHover] = useState<LibraryFilament | null>(null);
  const focused = options.find((o) => o.key === active)?.f;
  const shown = hover ?? focused ?? selected;

  const [custom, setCustom] = useState<HfFilament | null>(null);
  const openCustom = () => setCustom(current ? { ...current } : { name: query.trim(), brand: '', color: '#808080', td: 1 });

  // Under the anchor, or over it when there is more room there; then scrolled into view.
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    const el = pop.current, anchor = el?.offsetParent;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const s = (el.closest('.tab-body') ?? document.documentElement).getBoundingClientRect();
    const below = s.bottom - a.bottom, above = a.top - s.top;
    setUp(el.offsetHeight > below && above > below);
  }, []);
  useEffect(() => { pop.current?.scrollIntoView({ block: 'nearest' }); }, [up, !!custom]);
  // The current filament in view in the grid.
  useEffect(() => { grid.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, []);

  const pick = (f: HfFilament) => onPick({ name: f.name, brand: f.brand, color: f.color, td: f.td });
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
    <div ref={pop} className={`hf-picker ${up ? 'up' : ''}`} role="dialog" aria-label={current ? `Change ${current.name}` : 'Add a filament'} onKeyDown={onKey}>
      <input ref={search} className="text-param" autoFocus value={query} placeholder='Search, e.g. "matte black", "esun red"' aria-label="Search the filaments" aria-controls={`${id}-grid`}
        onChange={(e) => { setQuery(e.target.value); setActive(null); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); focusOption(grid.current?.querySelector<HTMLElement>('[tabindex="0"]') ?? undefined); }
          if (e.key === 'Enter' && query.trim() && options[0]) { e.preventDefault(); pick(options[0].f); }
        }} />
      <div className="seg hf-lines" role="tablist" aria-label="Filament lines" onKeyDown={onTabsKey}>
        {[{ key: '', label: 'All', title: 'Every filament' }, ...LINES.map((l) => ({ key: l.key, label: short(l), title: l.key }))].map((t) => (
          <button key={t.key} role="tab" className={line === t.key ? 'on' : ''} aria-selected={line === t.key} tabIndex={line === t.key ? 0 : -1} aria-controls={`${id}-grid`} title={t.title}
            onClick={() => { setLine(t.key); setActive(null); }}>{t.label}</button>
        ))}
      </div>
      <div ref={grid} id={`${id}-grid`} className="hf-grid" role="listbox" aria-label={query.trim() ? `Filaments matching "${query.trim()}"` : 'Filaments'} onKeyDown={onGridKey} onMouseLeave={() => setHover(null)}>
        {groups.map((g) => (
          <div key={g.key} role="group" aria-labelledby={g.label ? `${id}-${g.key}` : undefined}>
            {g.label && <div className="hf-grid-head" id={`${id}-${g.key}`}>{g.label}</div>}
            <div className="hf-swatches">
              {g.filaments.map((f) => {
                const key = optionKey(g.key, f);
                const on = !!selected && sameFilament(f, selected);
                return (
                  <div key={key} data-key={key} role="option" aria-selected={on} aria-label={describe(f)} title={describe(f)} tabIndex={key === activeKey ? 0 : -1}
                    className="hf-option" style={{ background: f.color }}
                    onClick={() => pick(f)} onMouseEnter={() => setHover(f)} onFocus={() => setActive(key)}>
                    {on && <span className={luma(hexToRgb(f.color)) > 0.55 ? 'ink-dark' : 'ink-light'}><Icon name="check" size={13} /></span>}
                    {f.unverified && <span className="hf-est-mark" aria-hidden>~</span>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {!options.length && <div className="hf-grid-empty dim small">No filament in the library matches: use a custom colour.</div>}
      </div>
      <div className="hf-pick-detail small" aria-hidden>
        {shown
          ? <><span className="swatch" style={{ background: shown.color }} /><span className="hf-title">{shown.name}</span><span className="dim">{shown.brand}</span><span className="mono">TD {shown.td}{shown.unverified ? '~' : ''}</span></>
          : <span className="dim">{current ? `${current.name} is not in the library` : 'Pick a colour'}</span>}
      </div>
      <div className="dim small"><span className="hf-est">~</span> TD estimated, not measured</div>
      {!custom
        ? <button className="link hf-custom-open" onClick={openCustom}><Icon name="pen" size={12} /> Custom colour…</button>
        : <CustomFilament value={custom} onChange={setCustom} adding={!current} onDone={pick} />}
    </div>
  );
}

/** A colour and name of the user's own, with a TD to type or look up (library, then the web). */
function CustomFilament({ value, onChange, adding, onDone }: { value: HfFilament; onChange: (f: HfFilament) => void; adding: boolean; onDone: (f: HfFilament) => void }) {
  const [lookup, setLookup] = useState<{ busy: boolean; result?: FilamentLookup; error?: string } | null>(null);
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
  return (
    <div className="hf-custom-box">
      <div className="hf-custom">
        <label className="hf-swatch big" style={{ background: value.color }} title={value.color}>
          <input type="color" value={value.color} aria-label="Colour" onChange={(e) => onChange({ ...value, color: e.target.value })} />
        </label>
        <input className="text-param" autoFocus value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Name, e.g. PLA Matte Ivory White" aria-label="Filament name" />
        <input className="text-param" value={value.brand ?? ''} onChange={(e) => onChange({ ...value, brand: e.target.value })} placeholder="Brand, e.g. Bambu Lab" aria-label="Brand" />
        <label className="hf-td" title="Transmission distance: the thickness at which this filament hides what is under it">
          <span className="dim small">TD</span>
          <NumBox value={value.td} min={0.05} max={50} label="TD" onCommit={(td) => onChange({ ...latest.current, td })} />
        </label>
      </div>
      {lookup?.result && <LookupNote r={lookup.result} />}
      {lookup?.error && <div className="bad-note small" role="alert">{lookup.error}</div>}
      <div className="hf-add-actions">
        <button className="btn ghost" disabled={!name || lookup?.busy} onClick={() => void look()} title="Find this filament's TD and colour (library and the web)">
          {lookup?.busy ? <><span className="spinner" /> Looking up…</> : 'Look up TD'}
        </button>
        <span className="spacer" />
        <button className="btn primary" disabled={!name} onClick={() => onDone({ ...latest.current, name, brand: latest.current.brand?.trim() || undefined })}>
          {adding ? <><Icon name="plus" size={14} /> Add</> : 'Use'}
        </button>
      </div>
    </div>
  );
}

function LookupNote({ r }: { r: FilamentLookup }) {
  const [label, trust] = CONFIDENCE[r.confidence] ?? CONFIDENCE.estimate;
  const src = (r.filament as LibraryFilament).source;
  const link = src && /^https?:\/\//.test(src) ? src : undefined;
  return (
    <div className="hf-lookup small" role="status">
      <span className={`src-kind ${trust}`}>{label}</span>
      <span>TD <span className="mono">{r.filament.td} mm</span>{r.filament.brand ? ` · ${r.filament.brand} ${r.filament.name}` : ''}</span>
      {link ? <a href={link} target="_blank" rel="noopener noreferrer">{new URL(link).hostname.replace(/^www\./, '')}</a> : src ? <span className="dim">{src}</span> : null}
      {r.note && <span className="dim">{r.note}</span>}
    </div>
  );
}
