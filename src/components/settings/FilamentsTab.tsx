// The Filaments tab of Settings: the user's filaments with a roll count each (left) and the built-in
// library to add from (right). Every change is saved at once. The decisions are in filamentsTab.ts.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cleanRolls, FILAMENT_LIBRARY, MAX_ROLLS, myFilamentKey, rollsOf, type LibraryFilament, type MyFilament } from '../../../shared/filaments';
import type { LayerToneFilament } from '../../../shared/layertone';
import { useMyFilaments } from '../../lib/myFilaments';
import { CustomFilament, stackFields } from '../FilamentPicker';
import { Icon } from '../Icon';
import { addFromLibrary, cardLabel, libraryBrands, libraryCount, libraryLines, libraryView, shelfSummary, shelfView, summaryText, withRolls, without, type ShelfSaver } from './filamentsTab';

interface Props {
  /** The saves, one for the dialog's lifetime. */
  saver: ShelfSaver;
  /** Where the "Saved" note or the error goes: the dialog's footer, which never scrolls. */
  footer: HTMLDivElement | null;
}

type Custom = LayerToneFilament & { original?: string };

const BRANDS = libraryBrands();

export function FilamentsTab({ saver, footer }: Props) {
  const id = useId();
  const stored = useMyFilaments();
  // The newest list sent and not answered yet: shown, and the next change is made on it.
  const [pending, setPending] = useState<MyFilament[] | null>(() => saver.pending());
  const list = pending ?? stored;
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const stop = saver.listen((e) => {
      setPending(saver.pending());
      clearTimeout(noteTimer.current);
      if (e.kind === 'start') setNote(null);
      else if (e.kind === 'saved') { setNote({ text: 'Saved' }); noteTimer.current = setTimeout(() => setNote(null), 2000); }
      else setNote({ text: e.error.message, error: true });
    });
    return () => { stop(); clearTimeout(noteTimer.current); };
  }, [saver]);
  const change = (next: MyFilament[]) => {
    if (next === list) return;
    setPending(next);
    saver.save(next).catch(() => { /* said in the note */ });
  };

  // ---- the shelf
  const [shelfQuery, setShelfQuery] = useState('');
  const shelf = useMemo(() => shelfView(list, shelfQuery), [list, shelfQuery]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [custom, setCustom] = useState<Custom | null>(null);
  const customButton = useRef<HTMLButtonElement>(null);
  const shelfSearch = useRef<HTMLInputElement>(null);
  const shelfList = useRef<HTMLDivElement>(null);
  // The row just added (shown and marked for a moment), and the row to focus after a removal.
  const [added, setAdded] = useState<string | null>(null);
  const addedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const focusAfter = useRef<string | null | undefined>(undefined);
  useEffect(() => () => clearTimeout(addedTimer.current), []);
  useEffect(() => {
    if (added) shelfList.current?.querySelector(`[data-key="${CSS.escape(added)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [added]);
  useEffect(() => {
    if (focusAfter.current === undefined) return;
    const key = focusAfter.current;
    focusAfter.current = undefined;
    const row = key ? shelfList.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"] input`) : null;
    (row ?? shelfSearch.current)?.focus();
  }, [shelf]);

  const remove = (key: string) => {
    const at = shelf.findIndex((f) => myFilamentKey(f) === key);
    const next = shelf[at + 1] ?? shelf[at - 1];
    focusAfter.current = next ? myFilamentKey(next) : null;
    setConfirm(null);
    if (custom?.original === key) setCustom(null);
    change(without(list, key));
  };
  const closeCustom = () => { setCustom(null); customButton.current?.focus(); };

  // ---- the library
  const [libQuery, setLibQuery] = useState('');
  const [brand, setBrand] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const lines = useMemo(() => libraryLines(brand), [brand]);
  const cards = useMemo(() => libraryView({ query: libQuery, brand, line }, list), [libQuery, brand, line, list]);
  const chooseBrand = (b: string | null) => {
    setBrand(b);
    if (line && !libraryLines(b).includes(line)) setLine(null);
  };
  const add = (f: LibraryFilament) => {
    const { list: next, problem } = addFromLibrary(list, f);
    if (problem) { clearTimeout(noteTimer.current); setNote({ text: problem, error: true }); return; }
    if (next === list) return;
    const key = myFilamentKey(f);
    if (shelfQuery && !shelfView(next, shelfQuery).some((m) => myFilamentKey(m) === key)) setShelfQuery('');
    clearTimeout(addedTimer.current);
    setAdded(key);
    addedTimer.current = setTimeout(() => setAdded(null), 2000);
    change(next);
  };

  return (
    <div className="fil-tab">
      <section className="fil-pane" aria-labelledby={`${id}-mine`}>
        <div className="fil-pane-head">
          <h4 id={`${id}-mine`}>My filaments</h4>
          <span className="dim small">{summaryText(shelfSummary(list))}</span>
        </div>
        <div className="fil-tools">
          <input ref={shelfSearch} type="search" className="text-input" value={shelfQuery} placeholder="Search my filaments" aria-label="Search my filaments" onChange={(e) => setShelfQuery(e.target.value)} />
          <button ref={customButton} type="button" className="btn small" aria-expanded={!!custom} onClick={() => setCustom({ name: '', brand: '', color: '#808080', td: 1 })}>
            <Icon name="plus" size={13} /> Custom filament
          </button>
        </div>
        <span className="sr-only" aria-live="polite">{shelfQuery.trim() && list.length ? `${shelf.length} of ${list.length} shown` : ''}</span>
        <div ref={shelfList} className="fil-scroll">
          {custom && (
            <div className="fil-custom" role="group" aria-label={custom.original ? `Edit ${custom.name}` : 'Custom filament'}>
              <div className="fil-custom-head">
                <span>{custom.original ? `Edit ${custom.name}` : 'Custom filament'}</span>
                <button type="button" className="link" onClick={closeCustom}>Done</button>
              </div>
              <CustomFilament value={custom} onChange={setCustom} adding={!custom.original} mine={list} save={(l) => saver.save(l)} />
            </div>
          )}
          {!list.length
            ? <p className="dim fil-empty">No filaments yet. Add one from the library, or a custom one.</p>
            : !shelf.length
              ? <p className="dim fil-empty">None of your filaments match.</p>
              : (
                <ul className="fil-rows" aria-label="My filaments">
                  {shelf.map((f) => {
                    const key = myFilamentKey(f);
                    return (
                      <li key={key} data-key={key} className={`fil-row${added === key ? ' added' : ''}`}>
                        <span className="swatch fil-swatch" style={{ background: f.color }} aria-hidden />
                        <span className="fil-name">
                          <span className="layertone-title" title={f.name}>{f.name}</span>
                          <span className="dim small">{f.brand ?? 'No brand'} · <span className="mono">TD {f.td}</span></span>
                        </span>
                        <RollsInput f={f} onCommit={(raw) => change(withRolls(list, key, raw))} />
                        <button type="button" className="icon-btn" onClick={() => setCustom({ ...stackFields(f), brand: f.brand ?? '', original: key })} aria-label={`Edit ${f.name}`} title="Edit"><Icon name="pen" size={12} /></button>
                        <button type="button" className={`icon-btn ${confirm === key ? 'confirm' : ''}`} onClick={() => (confirm === key ? remove(key) : setConfirm(key))} onBlur={() => setConfirm((c) => (c === key ? null : c))}
                          aria-label={confirm === key ? `Remove ${f.name}: click again to confirm` : `Remove ${f.name}`} title={confirm === key ? 'Click again to remove' : 'Remove'}>
                          {confirm === key ? 'Remove?' : <Icon name="x" size={12} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
        </div>
      </section>

      <section className="fil-pane" aria-labelledby={`${id}-lib`}>
        <div className="fil-pane-head">
          <h4 id={`${id}-lib`}>Library</h4>
          <span className="dim small" aria-live="polite">{libraryCount(cards.length, FILAMENT_LIBRARY.length)}</span>
        </div>
        <div className="fil-tools">
          <input type="search" className="text-input" value={libQuery} placeholder='Search by colour or name, e.g. "blue"' aria-label="Search the library" onChange={(e) => setLibQuery(e.target.value)} />
        </div>
        <div className="fil-pills" role="group" aria-label="Brand">
          {[null, ...BRANDS].map((b) => (
            <button key={b ?? ''} type="button" className={`filter-chip${brand === b ? ' on' : ''}`} aria-pressed={brand === b} onClick={() => chooseBrand(b)}>{b ?? 'All'}</button>
          ))}
        </div>
        <div className="fil-pills" role="group" aria-label="Line">
          {[null, ...lines].map((l) => (
            <button key={l ?? ''} type="button" className={`filter-chip${line === l ? ' on' : ''}`} aria-pressed={line === l} onClick={() => setLine(l)}>{l ?? 'All lines'}</button>
          ))}
        </div>
        <div className="fil-scroll">
          {cards.length
            ? (
              <ul className="fil-cards" aria-label="Library filaments">
                {cards.map((c) => (
                  <li key={c.key}>
                    <button type="button" className={`fil-card${c.owned ? ' owned' : ''}`} aria-disabled={c.owned || undefined} aria-label={cardLabel(c)}
                      title={c.owned ? 'In My filaments' : 'Add to My filaments'} onClick={() => { if (!c.owned) add(c.filament); }}>
                      <span className="fil-card-colour" style={{ background: c.filament.color }} />
                      <span className="fil-card-name">{c.filament.name}</span>
                      <span className="fil-card-meta">{c.filament.brand} · TD {c.filament.td}</span>
                      {(c.filament.unverified || c.owned) && (
                        <span className="fil-card-tags">
                          {c.filament.unverified && <span className="fil-tag">estimated</span>}
                          {c.owned && <span className="fil-tag owned"><Icon name="check" size={11} /> owned</span>}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )
            : <p className="dim fil-empty">Nothing matches. Try another colour or brand.</p>}
        </div>
      </section>

      {footer && createPortal(
        <p className={`small fil-note ${note?.error ? 'warn-note' : 'dim'}`} role={note?.error ? 'alert' : 'status'}>{note?.text ?? ''}</p>,
        footer,
      )}
    </div>
  );
}

/** A filament's roll count: typed freely, made a valid whole number and saved on blur or Enter. */
function RollsInput({ f, onCommit }: { f: MyFilament; onCommit: (raw: string) => void }) {
  const value = rollsOf(f);
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => { setText(String(cleanRolls(text))); onCommit(text); };
  return (
    <span className="fil-rolls">
      <input type="number" className="text-input" min={0} max={MAX_ROLLS} step={1} inputMode="numeric" value={text} aria-label={`Rolls of ${f.name}`}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
      <span className="dim small" aria-hidden>{value === 1 ? 'roll' : 'rolls'}</span>
    </span>
  );
}
