import { useId, useMemo, useRef, useState } from 'react';
import type { EvalResult, ParamValues, PartMesh } from '../../shared/types';
import { checkSwaps, HF_IMAGES_KEY, HF_KEY, layerTop, MAX_HF_FILAMENTS, parseHfImages, parseHueforgeSetup, simulateImage, type HfFilament, type HfImage, type HueforgeOptions, type HueforgeSetup, type LayerColor } from '../../shared/hueforge';
import { FILAMENT_LIBRARY, searchFilaments, type FilamentLookup, type LibraryFilament } from '../../shared/filaments';
import { request } from '../lib/api';
import { hfImageToDataUrl, loadHfImage, rgbaToDataUrl } from '../lib/hfImage';
import { Icon } from './Icon';
import { useEscape } from './useEscape';
import { useReleaseSlider } from './useReleaseSlider';

/** Filaments the A1's AMS lite holds; more need changing by hand during the print. */
const AMS_SLOTS = 4;

/** What the runtime may tell about a HueForge part beyond its layer colours (see hfPartInfo). */
type HfPart = PartMesh & { layerColors: LayerColor[]; hueforge?: { image?: string; options?: HueforgeOptions } };

/** The first part of the model that is a HueForge print (H.hueforge), if any. */
export function hueforgePart(result: EvalResult | null): HfPart | undefined {
  return result?.parts.find((p): p is HfPart => !!p.layerColors?.length);
}

interface Props {
  result: EvalResult;
  part: HfPart;
  /** The design's values: HF_KEY (the setup) and HF_IMAGES_KEY (the pictures). */
  values: ParamValues;
  /** The new setup; null = back to the script's filaments and automatic swaps. */
  onSetup: (s: HueforgeSetup | null) => void;
  /** Replace a stored picture. */
  onImage: (name: string, image: HfImage) => void;
}

/**
 * Print tab, HueForge section: the picture and how it will print, the filament stack and where the
 * filaments change. Everything is saved under HF_KEY, so the model rebuilds as it is edited.
 */
export function HueforgePanel({ result, part, values, onSetup, onImage }: Props) {
  const setup = useMemo(() => parseHueforgeSetup(values[HF_KEY]), [values[HF_KEY]]);
  const images = useMemo(() => parseHfImages(values[HF_IMAGES_KEY]), [values[HF_IMAGES_KEY]]);
  const grid = layerGrid(part, result);
  const layers = part.layerColors;
  // The stack as the model was built with it: the user's, or the script's (from the part).
  const filaments: HfFilament[] = setup.filaments ?? layers.map((l) => ({ name: l.name ?? l.color, brand: l.brand, color: l.color, td: l.td }));
  // The part's layers match the list (they lag behind it while the model rebuilds).
  const built = layers.length === filaments.length;
  // Swaps that don't fit the filaments are ignored by the engine (automatic), so here too.
  const manualSwaps = checkSwaps(setup.swaps, filaments.length);
  const manual = !!manualSwaps;
  const swaps = manualSwaps ?? built ? layers.slice(1).map((l) => l.layer) : evenSwaps(filaments.length, grid.total);

  const save = (next: HueforgeSetup) => onSetup(next.filaments || next.swaps ? next : null);
  const change = (list: HfFilament[], nextSwaps = manual ? swaps : undefined) =>
    save({ filaments: list, ...(nextSwaps ? { swaps: sanitizeSwaps(nextSwaps, grid.total) } : {}) });
  const move = (i: number, to: number) => {
    const list = [...filaments];
    [list[i], list[to]] = [list[to], list[i]];
    change(list);
  };
  const remove = (i: number) => change(filaments.filter((_, j) => j !== i), manual ? swaps.filter((_, j) => j !== Math.max(0, i - 1)) : undefined);
  const edit = (i: number, patch: Partial<HfFilament>) => change(filaments.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = (f: HfFilament) => {
    // On top, starting halfway between the last change and the top of the print.
    const last = swaps.at(-1) ?? 0;
    change([...filaments, { name: f.name, brand: f.brand, color: f.color, td: f.td }], manual ? [...swaps, Math.round((last + grid.total) / 2)] : undefined);
    setAdding(false);
  };
  const setManual = (on: boolean) => save({ ...(setup.filaments ? { filaments: setup.filaments } : {}), ...(on ? { filaments, swaps: sanitizeSwaps(swaps, grid.total) } : {}) });
  const setSwap = (i: number, layer: number) => {
    const lo = (swaps[i - 1] ?? 0) + 1, hi = (swaps[i + 1] ?? grid.total) - 1;
    save({ filaments, swaps: swaps.map((s, j) => (j === i ? Math.min(hi, Math.max(lo, Math.round(layer))) : s)) });
  };

  const [adding, setAdding] = useState(false);
  const changes = Math.max(0, filaments.length - 1);
  return (
    <div className="hf-panel">
      <Pictures part={part} grid={grid} images={images} onImage={onImage} />

      <div className="hf-stats small" role="status">
        <span className="mono">{grid.total} layers</span> · <span className="mono">{grid.top.toFixed(2)} mm</span> · {changes} filament change{changes === 1 ? '' : 's'}
      </div>
      {filaments.length > AMS_SLOTS && (
        <div className="hf-warn small" role="alert">
          <Icon name="alert" size={13} /> {filaments.length} filaments: the AMS lite holds {AMS_SLOTS}, so the print stops for you to load the others by hand.
        </div>
      )}

      <div className="hf-head">
        <h4>Filaments <span className="h4-hint">top of the print first</span></h4>
        {values[HF_KEY] != null && <button className="link" onClick={() => onSetup(null)} title="Back to the filaments and swaps the script chose">Reset</button>}
      </div>
      <div className="hf-swap-mode">
        <span className="dim small">Swaps</span>
        <div className="seg" role="group" aria-label="Filament swaps">
          <button className={manual ? '' : 'on'} aria-pressed={!manual} onClick={() => setManual(false)} title="Jig picks the layers where the filaments change, from the picture's brightness and the filaments' TD">Automatic</button>
          <button className={manual ? 'on' : ''} aria-pressed={manual} onClick={() => setManual(true)} title="Set the layer where each filament starts">Manual</button>
        </div>
      </div>
      <ol className="hf-stack">
        {filaments.map((f, i) => ({ f, i })).reverse().map(({ f, i }) => (
          <li key={i} className="hf-filament">
            <div className="hf-row">
              <label className="hf-swatch" style={{ background: f.color }} title={`Colour ${f.color}`}>
                <input type="color" value={f.color} aria-label={`Colour of ${f.name}`} onChange={(e) => edit(i, { color: e.target.value })} />
              </label>
              <div className="hf-title" title={f.name}>{f.name}</div>
              <button className="icon-btn hf-move up" disabled={i === filaments.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move ${f.name} up (printed later)`} title="Move up (printed later)"><Icon name="chevron" size={13} /></button>
              <button className="icon-btn hf-move down" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${f.name} down (printed earlier)`} title="Move down (printed earlier)"><Icon name="chevron" size={13} /></button>
              <button className="icon-btn" disabled={filaments.length < 2} onClick={() => remove(i)} aria-label={`Remove ${f.name}`} title="Remove"><Icon name="x" size={13} /></button>
            </div>
            <div className="hf-row2">
              <span className="dim small">
                {f.brand || 'Unknown brand'}
                {i === 0 ? ' · base' : manual ? '' : <> · from <span className="mono">{zOf(swaps[i - 1], grid).toFixed(2)} mm</span>{built ? '' : ' …'}</>}
              </span>
              <label className="hf-td" title="Transmission distance: the thickness at which this filament hides what is under it">
                <span className="dim small">TD</span>
                <NumBox value={f.td} min={0.05} max={50} label={`TD of ${f.name}`} onCommit={(td) => edit(i, { td })} />
              </label>
            </div>
            {i > 0 && manual && <SwapSlider name={f.name} layer={swaps[i - 1]} min={(swaps[i - 2] ?? 0) + 1} max={(swaps[i] ?? grid.total) - 1} grid={grid} onCommit={(l) => setSwap(i - 1, l)} />}
          </li>
        ))}
      </ol>
      {adding
        ? <AddFilament onAdd={add} onCancel={() => setAdding(false)} />
        : <button className="btn ghost wide" disabled={filaments.length >= MAX_HF_FILAMENTS} onClick={() => setAdding(true)} title={filaments.length >= MAX_HF_FILAMENTS ? `At most ${MAX_HF_FILAMENTS} filaments` : undefined}><Icon name="plus" size={14} /> Add filament</button>}
    </div>
  );
}

// ---------------------------------------------------------------- layers

interface Grid { first: number; lh: number; total: number; top: number }

/** Layer heights and count: from the part's options, else read off its layer colours and print settings. */
function layerGrid(part: HfPart, result: EvalResult): Grid {
  const o = part.hueforge?.options;
  const ls = part.layerColors.filter((l) => l.layer >= 1);
  let lh = o?.layerHeight;
  if (lh == null && ls.length >= 2 && ls.at(-1)!.layer > ls[0].layer) lh = (ls.at(-1)!.z - ls[0].z) / (ls.at(-1)!.layer - ls[0].layer);
  lh ??= result.print.layerHeight ?? 0.08;
  const first = o?.firstLayerHeight ?? (ls.length ? ls[0].z - (ls[0].layer - 1) * lh : 0.16);
  const top = part.bbox.max[2];
  return { first, lh, top, total: Math.max(2, 1 + Math.round((top - first) / lh)) };
}

/** Where layer `layer` (0 = the first) starts, mm above the bed. */
const zOf = (layer: number, g: Grid) => layerTop(layer, { firstLayerHeight: g.first, layerHeight: g.lh });

const evenSwaps = (n: number, total: number) => Array.from({ length: Math.max(0, n - 1) }, (_, i) => Math.round(((i + 1) * total) / n));

/** Whole layers, ascending, each filament at least one layer, within the print. */
function sanitizeSwaps(swaps: number[], total: number): number[] {
  const out: number[] = [];
  swaps.forEach((s, i) => out.push(Math.min(total - (swaps.length - i), Math.max((out[i - 1] ?? 0) + 1, Math.round(s)))));
  return out;
}

function SwapSlider({ name, layer, min, max, grid, onCommit }: { name: string; layer: number; min: number; max: number; grid: Grid; onCommit: (layer: number) => void }) {
  const slider = useReleaseSlider(Math.min(max, Math.max(min, layer)), onCommit);
  return (
    <div className="hf-slider">
      <input type="range" min={min} max={Math.max(min, max)} step={1} aria-label={`Layer where ${name} starts`} aria-valuetext={`${zOf(slider.shown, grid).toFixed(2)} mm, layer ${slider.shown + 1}`} {...slider.inputProps} />
      <span className="mono small">{zOf(slider.shown, grid).toFixed(2)} mm</span>
    </div>
  );
}

function NumBox({ value, min, max, label, onCommit }: { value: number; min: number; max: number; label: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const v = Number(draft.replace(',', '.'));
    setDraft(null);
    if (Number.isFinite(v) && v !== value) onCommit(Math.min(max, Math.max(min, v)));
  };
  return (
    <div className="num-box">
      <input className="mono" aria-label={`${label} (mm)`} value={draft ?? String(+value.toFixed(2))} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.preventDefault(); setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
      <span className="unit">mm</span>
    </div>
  );
}

// ---------------------------------------------------------------- pictures

function Pictures({ part, grid, images, onImage }: { part: HfPart; grid: Grid; images: Record<string, HfImage>; onImage: Props['onImage'] }) {
  const name = part.hueforge?.image && images[part.hueforge.image] ? part.hueforge.image : Object.keys(images)[0];
  const image = name ? images[name] : undefined;
  const source = useMemo(() => (image ? hfImageToDataUrl(image) : null), [image]);
  const options: HueforgeOptions = part.hueforge?.options ?? { width: part.bbox.max[0] - part.bbox.min[0], maxHeight: grid.top, layerHeight: grid.lh, firstLayerHeight: grid.first };
  const optionsKey = JSON.stringify(options);
  // The engine may not be able to simulate (yet): the picture is shown without the preview.
  const simulated = useMemo(() => {
    if (!image) return null;
    try {
      const s = simulateImage(image, part.layerColors, options);
      return rgbaToDataUrl(s.width, s.height, s.rgba);
    } catch {
      return null;
    }
  }, [image, part.layerColors, optionsKey]);
  const [big, setBig] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const open = () => { opener.current = document.activeElement as HTMLElement | null; setBig(true); };
  const close = () => { setBig(false); opener.current?.focus(); };
  useEscape(big, close);
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const replace = async (f: File | undefined) => {
    if (!f || !name) return;
    setError(null);
    try {
      onImage(name, await loadHfImage(f, name));
    } catch (e) {
      setError(`${f.name} could not be read as a picture${(e as Error).message ? `: ${(e as Error).message}` : '.'}`);
    }
  };

  if (!image || !source) return <div className="hf-nopic dim small">No picture is stored with this design: attach a photo in the chat with HueForge chosen in the palette menu.</div>;
  const pics = (
    <>
      <span className="hf-fig"><img src={source} alt={`The picture (${image.width} × ${image.height}, brightness)`} /><span className="hf-cap">Picture</span></span>
      <span className="hf-fig">
        {simulated ? <img src={simulated} alt="How the print will look" /> : <span className="hf-nosim small">Preview not available</span>}
        <span className="hf-cap">Simulated print</span>
      </span>
    </>
  );
  return (
    <div className="hf-pictures">
      <button className="hf-pics" onClick={open} aria-label="Enlarge the picture and the simulated print" title="Enlarge">{pics}</button>
      <div className="hf-pic-actions">
        <span className="dim small" title={name}>{image.width} × {image.height} px</span>
        <button className="link" onClick={() => file.current?.click()}>Change picture…</button>
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { void replace(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {error && <div className="bad-note small" role="alert">{error}</div>}
      {big && (
        <div className="lightbox hf-lightbox" role="dialog" aria-modal="true" aria-label="Picture and simulated print" onClick={close}
          onKeyDown={(e) => { if (e.key === 'Tab') e.preventDefault(); }}>
          <div className="hf-big">{pics}</div>
          <button className="lightbox-close" autoFocus onClick={close} aria-label="Close (Esc)"><Icon name="x" size={16} /></button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- adding filaments

const CONFIDENCE: Record<FilamentLookup['confidence'], [string, 'high' | 'medium' | 'low']> = {
  listed: ['Published TD', 'high'],
  similar: ['From a similar filament', 'medium'],
  estimate: ['Estimate', 'low'],
};

function AddFilament({ onAdd, onCancel }: { onAdd: (f: HfFilament) => void; onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const found = useMemo(() => (query.trim() ? searchFilaments(query, 8) : []), [query]);
  const [custom, setCustom] = useState<HfFilament | null>(null);
  const [lookup, setLookup] = useState<{ busy: boolean; result?: FilamentLookup; error?: string } | null>(null);
  const id = useId();
  useEscape(true, onCancel);
  const look = async () => {
    if (!custom) return;
    setLookup({ busy: true });
    try {
      const r = await lookupFilament(custom.brand ?? '', custom.name);
      setLookup({ busy: false, result: r });
      setCustom((c) => c && { ...c, td: r.filament.td, color: r.filament.color });
    } catch (e) {
      setLookup({ busy: false, error: (e as Error).message });
    }
  };
  return (
    <div className="hf-add">
      {!custom && <>
        <input className="text-param" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder='Search, e.g. "bambu black", "esun pla+ red"' aria-label="Search the filament library" aria-describedby={`${id}-note`} />
        {found.length > 0 && (
          <ul className="hf-results" aria-label="Library filaments">
            {found.map((f, i) => (
              <li key={i}>
                <button onClick={() => onAdd(f)}>
                  <span className="swatch" style={{ background: f.color }} />
                  <span className="hf-name"><span className="hf-title">{f.name}</span><span className="dim small">{f.brand}</span></span>
                  <span className="mono small">TD {f.td}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="dim small" id={`${id}-note`}>
          {!FILAMENT_LIBRARY.length ? 'The filament library is empty: add a custom filament.' : query.trim() && !found.length ? 'No filament in the library matches.' : ''}
        </div>
        <div className="hf-add-actions">
          <button className="btn ghost" onClick={() => setCustom({ name: query.trim(), brand: '', color: '#808080', td: 1 })}>Custom filament…</button>
          <span className="spacer" />
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
        </div>
      </>}
      {custom && <>
        <div className="hf-custom">
          <label className="hf-swatch big" style={{ background: custom.color }} title={custom.color}>
            <input type="color" value={custom.color} aria-label="Colour" onChange={(e) => setCustom({ ...custom, color: e.target.value })} />
          </label>
          <input className="text-param" autoFocus value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="Name, e.g. PLA Matte Ivory White" aria-label="Filament name" />
          <input className="text-param" value={custom.brand ?? ''} onChange={(e) => setCustom({ ...custom, brand: e.target.value })} placeholder="Brand, e.g. Bambu Lab" aria-label="Brand" />
          <label className="hf-td">
            <span className="dim small">TD</span>
            <NumBox value={custom.td} min={0.05} max={50} label="TD" onCommit={(td) => setCustom({ ...custom, td })} />
          </label>
          <button className="btn ghost" disabled={!custom.name.trim() || lookup?.busy} onClick={() => void look()} title="Find this filament's TD and colour (library and the web)">
            {lookup?.busy ? <><span className="spinner" /> Looking up…</> : 'Look up TD'}
          </button>
        </div>
        {lookup?.result && <LookupNote r={lookup.result} />}
        {lookup?.error && <div className="bad-note small" role="alert">{lookup.error}</div>}
        <div className="hf-add-actions">
          <button className="btn primary" disabled={!custom.name.trim()} onClick={() => onAdd({ ...custom, name: custom.name.trim(), brand: custom.brand?.trim() || undefined })}><Icon name="plus" size={14} /> Add</button>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => { setCustom(null); setLookup(null); }}>Back</button>
        </div>
      </>}
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

/** TODO(integration): temporary; use lookupFilament from src/lib/api.ts once the filaments branch is merged. */
async function lookupFilament(brand: string, name: string): Promise<FilamentLookup> {
  return (await request('/api/filaments/lookup', { method: 'POST', body: JSON.stringify({ brand, name }) })).json() as Promise<FilamentLookup>;
}
