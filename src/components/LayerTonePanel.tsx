import { printer, shortName } from '../../shared/printer';
import { useMemo, useRef, useState } from 'react';
import type { EvalResult, ParamValues, PartMesh } from '../../shared/types';
import { SCALE_KEY } from '../../shared/params';
import { checkSwaps, firstFilamentBase, LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, layerCount, layerTop, maxLayerToneFilaments, rebaseSetup, parseLayerToneImages, parseLayerToneSetup, replaceFilament, simulateImage, stackFilament, type LayerToneFilament, type LayerToneImage, type LayerToneOptions, type LayerToneSetup, type LayerColor } from '../../shared/layertone';
import { estimatedTd } from '../../shared/filaments';
import { autoBackTextFilament, BACK_TEXT_KEY, backTextDefault, backTextDefaultSize, backTextStatus, BACK_TEXT_MAX_LENGTH, BACK_TEXT_MAX_SIZE, BACK_TEXT_MIN_SIZE, DEFAULT_BACK_TEXT_POSITION, parseBackText, planBackText, type BackTextPosition, type BackTextSetting } from '../../shared/backText';
import { backTextPrintLayers } from '../lib/bambu3mf';
import { layerToneImageToDataUrl, loadLayerToneImage, rgbaToDataUrl } from '../lib/layerToneImage';
import { FilamentPicker } from './FilamentPicker';
import { Icon } from './Icon';
import { NumBox } from './NumBox';
import { useEscape } from './useEscape';
import { useReleaseSlider } from './useReleaseSlider';

/** A LayerTone part: its stack, and (from the runtime) the picture and options it was built with. */
type LayerTonePartMesh = PartMesh & { layerColors: LayerColor[] };

/** The first part of the model that is a LayerTone print (H.layertone), if any. */
export function findLayerTonePart(result: EvalResult | null): LayerTonePartMesh | undefined {
  return result?.parts.find((p): p is LayerTonePartMesh => !!p.layerColors?.length);
}

interface Props {
  result: EvalResult;
  part: LayerTonePartMesh;
  /** The design's values: LAYERTONE_KEY (the setup) and LAYERTONE_IMAGES_KEY (the pictures). */
  values: ParamValues;
  /** The new setup; null = back to the script's filaments and automatic swaps. */
  onSetup: (s: LayerToneSetup | null) => void;
  /** Replace a stored picture. */
  onImage: (name: string, image: LayerToneImage) => void;
  /** The back text setting (BACK_TEXT_KEY); null = the defaults. */
  onBackText: (s: BackTextSetting | null) => void;
  /** The print's layer heights (Print tab): the 3MF prints the back text on these; default the part's own. */
  printLayers?: { layerHeight: number; firstLayerHeight: number };
  /** The 3MF the export makes: "Print in one colour" on, a Bambu Studio project (else a plain 3MF). The back text is only in a project with colours. */
  file: { oneColour: boolean; project: boolean };
}

/**
 * Print tab, LayerTone section: the picture and how it will print, the filament stack and where the
 * filaments change. Everything is saved under LAYERTONE_KEY, so the model rebuilds as it is edited.
 */
export function LayerTonePanel({ result, part, values, onSetup, onImage, onBackText, printLayers, file }: Props) {
  const setup = useMemo(() => parseLayerToneSetup(values[LAYERTONE_KEY]), [values[LAYERTONE_KEY]]);
  // The whole design's scale: the part's heights are scaled, the setup's are the script's.
  const scale = Number(values[SCALE_KEY] ?? 1) || 1;
  const images = useMemo(() => parseLayerToneImages(values[LAYERTONE_IMAGES_KEY]), [values[LAYERTONE_IMAGES_KEY]]);
  const grid = layerGrid(part, result);
  const layers = part.layerColors;
  // The stack as the model was built with it: the user's, or the script's (from the part).
  const filaments: LayerToneFilament[] = setup.filaments ?? layers.map((l) => ({ name: l.name ?? l.color, brand: l.brand, color: l.color, td: l.td }));
  // The part's layers match the list (they lag behind it while the model rebuilds).
  const built = layers.length === filaments.length;
  // Swaps that don't fit the filaments are ignored by the engine (automatic), so here too.
  const manualSwaps = checkSwaps(setup.swaps, filaments.length);
  const manual = !!manualSwaps;
  const swaps = manualSwaps ?? built ? layers.slice(1).map((l) => l.layer) : evenSwaps(filaments.length, grid.total);

  // The First filament slider's thickness goes with every save.
  const base = setup.baseHeight != null ? { baseHeight: setup.baseHeight } : {};
  const save = (next: LayerToneSetup) => onSetup(next.filaments || next.swaps || next.baseHeight != null ? next : null);
  const change = (list: LayerToneFilament[], nextSwaps = manual ? swaps : undefined) =>
    save({ filaments: list, ...(nextSwaps ? { swaps: sanitizeSwaps(nextSwaps, grid.total) } : {}), ...base });
  const move = (i: number, to: number) => {
    const list = [...filaments];
    [list[i], list[to]] = [list[to], list[i]];
    change(list);
  };
  const remove = (i: number) => change(filaments.filter((_, j) => j !== i), manual ? swaps.filter((_, j) => j !== Math.max(0, i - 1)) : undefined);
  const edit = (i: number, patch: Partial<LayerToneFilament>) => change(filaments.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = (f: LayerToneFilament) => {
    // On top, starting halfway between the last change and the top of the print.
    const last = swaps.at(-1) ?? 0;
    change([...filaments, stackFilament(f)], manual ? [...swaps, Math.round((last + grid.total) / 2)] : undefined);
  };
  const setManual = (on: boolean) => save({ ...(setup.filaments ? { filaments: setup.filaments } : {}), ...(on ? { filaments, swaps: sanitizeSwaps(swaps, grid.total) } : {}), ...base });
  const setSwap = (i: number, layer: number) => {
    const lo = (swaps[i - 1] ?? 0) + 1, hi = (swaps[i + 1] ?? grid.total) - 1;
    save({ filaments, swaps: swaps.map((s, j) => (j === i ? Math.min(hi, Math.max(lo, Math.round(layer))) : s)), ...base });
  };

  // The filament picker: open on a stack row (its index) or to add one; `trigger` is the control that opened it.
  const [picking, setPicking] = useState<number | 'add' | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const openPicker = (at: number | 'add', button: HTMLButtonElement) => { trigger.current = button; setPicking(picking === at ? null : at); };
  const picked = (f: LayerToneFilament) => {
    if (picking === 'add') add(f);
    else if (picking != null) change(replaceFilament(filaments, picking, f));
    setPicking(null);
    trigger.current?.focus();
  };
  // The preview takes new colours and TDs at once: a full-size relief takes seconds to rebuild, and
  // until then only the swatches would change. Where the layers start still comes from the rebuild.
  const filamentsKey = JSON.stringify(filaments);
  const previewLayers = useMemo(() => (built ? layers.map((l, i) => ({ ...l, color: filaments[i].color, td: filaments[i].td })) : layers), [layers, filamentsKey]);
  const changes = Math.max(0, filaments.length - 1);
  return (
    <div className="layertone-panel">
      <Pictures part={part} layers={previewLayers} grid={grid} images={images} onImage={onImage} />

      <div className="layertone-stats small" role="status">
        <span className="mono">{grid.total} layers</span> · <span className="mono">{grid.top.toFixed(2)} mm</span> · {changes} filament change{changes === 1 ? '' : 's'}
      </div>
      {part.layerTone && (
        <BaseSlider name={filaments[0]?.name ?? 'first filament'} base={firstFilamentBase(setup, part.layerTone, scale)} scale={scale}
          onCommit={(mm) => onSetup(rebaseSetup(setup, mm, firstFilamentBase(setup, part.layerTone!, scale)))} />
      )}
      {filaments.length > printer().filaments && (
        <div className="layertone-warn small" role="alert">
          <Icon name="alert" size={13} /> {filaments.length} filaments: the {shortName()} loads {printer().filaments} at once, so the print stops for you to load the others by hand.
        </div>
      )}

      <div className="layertone-head">
        <h4>Filaments <span className="h4-hint">top of the print first</span></h4>
        {values[LAYERTONE_KEY] != null && <button className="link" onClick={() => onSetup(null)} title="Back to the script's filaments, swaps and first filament thickness">Reset</button>}
      </div>
      <div className="layertone-swap-mode">
        <span className="dim small">Swaps</span>
        <div className="seg" role="group" aria-label="Filament swaps">
          <button className={manual ? '' : 'on'} aria-pressed={!manual} onClick={() => setManual(false)} title="Picks the layers where the filaments change, from the picture's brightness and the filaments' TD">Automatic</button>
          <button className={manual ? 'on' : ''} aria-pressed={manual} onClick={() => setManual(true)} title="Set the layer where each filament starts">Manual</button>
        </div>
      </div>
      <ol className="layertone-stack">
        {filaments.map((f, i) => ({ f, i })).reverse().map(({ f, i }) => (
          <li key={i} className="layertone-filament">
            <div className="layertone-row">
              <button className="layertone-pick" onClick={(e) => openPicker(i, e.currentTarget)} aria-haspopup="dialog" aria-expanded={picking === i} aria-label={`${f.name}: change the filament`} title="Change the filament">
                <span className="layertone-swatch" style={{ background: f.color }} />
                <span className="layertone-title">{f.name}</span>
              </button>
              <button className="icon-btn layertone-move up" disabled={i === filaments.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move ${f.name} up (printed later)`} title="Move up (printed later)"><Icon name="chevron" size={13} /></button>
              <button className="icon-btn layertone-move down" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${f.name} down (printed earlier)`} title="Move down (printed earlier)"><Icon name="chevron" size={13} /></button>
              <button className="icon-btn" disabled={filaments.length < 2} onClick={() => remove(i)} aria-label={`Remove ${f.name}`} title="Remove"><Icon name="x" size={13} /></button>
            </div>
            <div className="layertone-row2">
              <span className="dim small">
                {f.brand || 'Unknown brand'}
                {i === 0 ? ' · base' : manual ? '' : <> · from <span className="mono">{zOf(swaps[i - 1], grid).toFixed(2)} mm</span>{built ? '' : ' …'}</>}
              </span>
              <label className="layertone-td" title="Transmission distance: the thickness at which this filament hides what is under it">
                <span className="dim small">TD</span>
                {estimatedTd(f) && <span className="layertone-est" title="Estimated TD: no measured value is published for this filament; a test print corrects it">~</span>}
                <NumBox value={f.td} min={0.05} max={50} label={`TD of ${f.name}${estimatedTd(f) ? ' (estimated)' : ''}`} onCommit={(td) => edit(i, { td })} />
              </label>
            </div>
            {picking === i && <FilamentPicker current={f} trigger={trigger} onPick={picked} onClose={() => setPicking(null)} />}
            {i > 0 && manual && <SwapSlider name={f.name} layer={swaps[i - 1]} min={(swaps[i - 2] ?? 0) + 1} max={(swaps[i] ?? grid.total) - 1} grid={grid} onCommit={(l) => setSwap(i - 1, l)} />}
          </li>
        ))}
      </ol>
      <div className="layertone-add-wrap">
        <button className="btn ghost wide" disabled={filaments.length >= maxLayerToneFilaments()} onClick={(e) => openPicker('add', e.currentTarget)} aria-haspopup="dialog" aria-expanded={picking === 'add'}
          title={filaments.length >= maxLayerToneFilaments() ? `At most ${maxLayerToneFilaments()} filaments` : undefined}><Icon name="plus" size={14} /> Add filament</button>
        {picking === 'add' && filaments.length < maxLayerToneFilaments() && <FilamentPicker trigger={trigger} onPick={picked} onClose={() => setPicking(null)} />}
      </div>

      <BackText raw={values[BACK_TEXT_KEY]} layers={previewLayers} grid={grid} part={part} printLayers={printLayers} file={file} onChange={onBackText} />
    </div>
  );
}

// ---------------------------------------------------------------- back text

/** Only what differs from the defaults; null when nothing does (the key is removed). */
function backTextDiff(s: BackTextSetting): BackTextSetting | null {
  const text = s.text?.trim();
  const position = s.position ?? DEFAULT_BACK_TEXT_POSITION;
  const out: BackTextSetting = {
    ...(s.off ? { off: true as const } : {}),
    ...(text && text !== backTextDefault() ? { text } : {}),
    ...(s.filament ? { filament: s.filament } : {}),
    ...(s.size != null && s.size !== backTextDefaultSize(position) ? { size: s.size } : {}),
    ...(position !== DEFAULT_BACK_TEXT_POSITION ? { position } : {}),
  };
  return Object.keys(out).length ? out : null;
}

/**
 * The back text: a mirrored line (PTP_BACK_TEXT by default) in the first layers, in its own filament.
 * Read-only, and off, when the server has no PTP_BACK_TEXT.
 */
function BackText({ raw, layers, grid, part, printLayers, file, onChange }: { raw: unknown; layers: LayerColor[]; grid: Grid; part: LayerTonePartMesh; printLayers?: Props['printLayers']; file: Props['file']; onChange: (s: BackTextSetting | null) => void }) {
  const setting = useMemo(() => parseBackText(raw), [raw]);
  const def = backTextDefault();
  const disabled = !def;
  const o = part.layerTone?.options;
  const own = { layerHeight: o?.layerHeight ?? grid.lh, firstLayerHeight: o?.firstLayerHeight ?? grid.first };
  const plan = planBackText(setting, layers, own);
  // What the 3MF prints: on the print's layers, a scaled part's first change can come sooner (filamentPlan).
  const printed = plan.on ? backTextPrintLayers(plan.layers, layers, part.bbox.max[2] - part.bbox.min[2], printLayers ?? own) : 0;
  const on = !disabled && !setting.off;
  const save = (patch: Partial<BackTextSetting>) => onChange(backTextDiff({ ...setting, ...patch }));

  // The text is saved on Enter or leaving the box (each change rebuilds the model); Esc puts it back.
  const saved = setting.text ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const commitText = () => { if (draft != null) { save({ text: draft }); setDraft(null); } };

  const filament = setting.filament ?? autoBackTextFilament(layers);
  const [picking, setPicking] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const done = () => { setPicking(false); trigger.current?.focus(); };

  const position: BackTextPosition = setting.position ?? DEFAULT_BACK_TEXT_POSITION;
  // Another place starts at that place's own size (small in the corner, wide in the centre).
  const place = (p: BackTextPosition) => { if (p !== position) save({ position: p, size: undefined }); };
  const size = useReleaseSlider(setting.size ?? backTextDefaultSize(position), (v) => save({ size: v }));
  const notes = plan.on ? plan.notes : [];
  const status = on ? backTextStatus(plan, printed, part.bbox, file) : null;
  return (
    <div className="layertone-backtext">
      <div className="layertone-head">
        <h4>{disabled ? 'Back text: off' : 'Back text'}</h4>
        <label className="switch" title={disabled ? undefined : on ? 'Turn the back text off for this design' : 'Print the back text'}>
          <input type="checkbox" checked={on} disabled={disabled} aria-label="Print the back text" onChange={(e) => save({ off: e.target.checked ? undefined : true })} />
          <span className="track" />
        </label>
      </div>
      <div className="layertone-backtext-row">
        <input className="text-param" value={draft ?? saved} placeholder={def} maxLength={BACK_TEXT_MAX_LENGTH} disabled={!on} aria-label="Back text"
          onChange={(e) => setDraft(e.target.value)} onBlur={commitText}
          onKeyDown={(e) => { if (e.key === 'Enter') commitText(); if (e.key === 'Escape' && draft != null) { e.stopPropagation(); setDraft(null); } }} />
        <button ref={trigger} className="layertone-pick" disabled={!on} onClick={() => setPicking(!picking)} aria-haspopup="dialog" aria-expanded={picking}
          aria-label={`Text filament: ${setting.filament ? filament.name : `automatic (${filament.name})`}`} title={setting.filament ? `${filament.name}: change the filament` : `Automatic: ${filament.name}, the filament that stands out most against the first one`}>
          <span className="layertone-swatch" style={{ background: filament.color }} />
          <span className="small">{setting.filament ? 'Filament' : 'Auto'}</span>
        </button>
        {picking && on && (
          <FilamentPicker current={setting.filament} trigger={trigger} onClose={() => setPicking(false)} onPick={(f) => { save({ filament: f }); done(); }}
            automatic={{ on: !setting.filament, title: "The stack's filament that stands out most against the first one", onPick: () => { save({ filament: undefined }); done(); } }} />
        )}
      </div>
      <div className="seg" role="group" aria-label="Back text position">
        <button className={position === 'corner' ? 'on' : ''} aria-pressed={position === 'corner'} disabled={!on} onClick={() => place('corner')} title="Small, in the bottom-right corner when the print is turned over, like a maker's mark">Corner</button>
        <button className={position === 'centre' ? 'on' : ''} aria-pressed={position === 'centre'} disabled={!on} onClick={() => place('centre')} title="Large, in the middle of the back">Centre</button>
      </div>
      <div className="layertone-slider layertone-base-slider">
        <span className="dim small">Size</span>
        <input type="range" min={BACK_TEXT_MIN_SIZE} max={BACK_TEXT_MAX_SIZE} step={1} disabled={!on} aria-label="Back text size, % of the print's width" aria-valuetext={`${size.shown} %`} {...size.inputProps} />
        <span className="mono small">{size.shown} %</span>
      </div>
      {disabled
        ? <div className="dim small">Set PTP_BACK_TEXT to print your website on the back of every LayerTone print.</div>
        : status === 'printed' && <div className="dim small">Mirrored on the back{position === 'corner' ? ', bottom-right when turned over' : ''}, in the first {printed === 1 ? '1 layer' : `${printed} layers`}.</div>}
      {status === 'tooThin' && <div className="layertone-warn small" role="status"><Icon name="alert" size={13} /> The first filament is one layer: no back text. Raise the First filament slider.</div>}
      {status === 'noGlyph' && <div className="layertone-warn small" role="status"><Icon name="alert" size={13} /> Nothing in this text can be drawn (only spaces or invisible characters): no back text.</div>}
      {status === 'oneColour' && <div className="layertone-warn small" role="status"><Icon name="alert" size={13} /> Print in one colour is on: no back text. It needs its own filament.</div>}
      {status === 'noProject' && <div className="layertone-warn small" role="status"><Icon name="alert" size={13} /> No back text in a plain 3MF: it needs a Bambu Studio project (Bambu Studio installed, a one-nozzle printer).</div>}
      {status === 'noRoom' && <div className="layertone-warn small" role="status"><Icon name="alert" size={13} /> No room for the back text in the corner of a print this small. Try the centre.</div>}
      {notes.includes('sameColour') && <div className="layertone-warn small" role="status"><Icon name="alert" size={13} /> The text is in the first filament's colour, so it won't show.</div>}
      {notes.includes('showsThrough') && <div className="layertone-warn small" role="status"><Icon name="alert" size={13} /> The text may show faintly from the front. Raise the First filament slider or use a darker first filament.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- layers

interface Grid { first: number; lh: number; total: number; top: number }

/** Layer heights and count: from the part's options, else read off its layer colours and print settings. */
function layerGrid(part: LayerTonePartMesh, result: EvalResult): Grid {
  const o = part.layerTone?.options;
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
    <div className="layertone-slider">
      <input type="range" min={min} max={Math.max(min, max)} step={1} aria-label={`Layer where ${name} starts`} aria-valuetext={`${zOf(slider.shown, grid).toFixed(2)} mm, layer ${slider.shown + 1}`} {...slider.inputProps} />
      <span className="mono small">{zOf(slider.shown, grid).toFixed(2)} mm</span>
    </div>
  );
}

/** The thickest first filament the slider offers, mm. */
const MAX_BASE = 4;

/** The First filament slider: how thick the solid first filament is; everything above moves with it. */
function BaseSlider({ name, base, scale, onCommit }: {
  name: string;
  /** In the script's mm (firstFilamentBase), as the setup stores it. */
  base: { baseHeight: number; layerHeight: number; firstLayerHeight: number };
  /** The design's overall scale: shown heights are the printed ones. */
  scale: number;
  onCommit: (mm: number) => void;
}) {
  const max = layerCount(MAX_BASE, base);
  const slider = useReleaseSlider(Math.min(max, layerCount(base.baseHeight, base)), (n) => onCommit(Number(layerTop(n, base).toFixed(4))));
  const shown = (layerTop(slider.shown, base) * scale).toFixed(2);
  return (
    <div className="layertone-base">
      <div className="layertone-base-head">
        <span className="small">First filament</span>
        <span className="h4-hint" title="A thicker first filament makes the print stiffer; everything above it moves up, so it looks the same">solid {name} under the picture</span>
      </div>
      <div className="layertone-slider layertone-base-slider">
        <input type="range" min={1} max={max} step={1} aria-label="First filament thickness" aria-valuetext={`${shown} mm`} {...slider.inputProps} />
        <span className="mono small">{shown} mm</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pictures

function Pictures({ part, layers, grid, images, onImage }: { part: LayerTonePartMesh; layers: LayerColor[]; grid: Grid; images: Record<string, LayerToneImage>; onImage: Props['onImage'] }) {
  const name = part.layerTone?.image && images[part.layerTone.image] ? part.layerTone.image : Object.keys(images)[0];
  const image = name ? images[name] : undefined;
  const options: LayerToneOptions = part.layerTone?.options ?? { width: part.bbox.max[0] - part.bbox.min[0], maxHeight: grid.top, layerHeight: grid.lh, firstLayerHeight: grid.first };
  const optionsKey = JSON.stringify(options);
  // The engine may not be able to simulate (yet): the picture is shown without the preview.
  const simulated = useMemo(() => {
    if (!image) return null;
    try {
      const s = simulateImage(image, layers, options);
      return rgbaToDataUrl(s.width, s.height, s.rgba);
    } catch {
      return null;
    }
  }, [image, layers, optionsKey]);
  return <PicturePair name={name} image={image} preview={simulated} previewLabel="Simulated print" previewAlt="How the print will look" onImage={onImage}
    empty="No picture is stored with this design: attach a photo in the chat with LayerTone chosen in the palette menu." />;
}

/**
 * A stored picture next to a preview made from it (click to enlarge both), with a button to
 * replace the picture. Shared by the LayerTone and Lithophane sections.
 */
export function PicturePair({ name, image, preview, previewLabel, previewAlt, empty, onImage }: {
  name: string | undefined; image: LayerToneImage | undefined; preview: string | null; previewLabel: string; previewAlt: string;
  /** Shown when there is no picture. */
  empty: string;
  onImage: (name: string, image: LayerToneImage) => void;
}) {
  const source = useMemo(() => (image ? layerToneImageToDataUrl(image) : null), [image]);
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
      onImage(name, await loadLayerToneImage(f, name));
    } catch (e) {
      setError(`${f.name} could not be read as a picture${(e as Error).message ? `: ${(e as Error).message}` : '.'}`);
    }
  };

  if (!image || !source) return <div className="layertone-nopic dim small">{empty}</div>;
  const pics = (
    <>
      <span className="layertone-fig"><img src={source} alt={`The picture (${image.width} × ${image.height}, brightness)`} /><span className="layertone-cap">Picture</span></span>
      <span className="layertone-fig">
        {preview ? <img src={preview} alt={previewAlt} /> : <span className="layertone-nosim small">Preview not available</span>}
        <span className="layertone-cap">{previewLabel}</span>
      </span>
    </>
  );
  return (
    <div className="layertone-pictures">
      <button className="layertone-pics" onClick={open} aria-label={`Enlarge the picture and the ${previewLabel.toLowerCase()}`} title="Enlarge">{pics}</button>
      <div className="layertone-pic-actions">
        <span className="dim small" title={name}>{image.width} × {image.height} px</span>
        <button className="link" onClick={() => file.current?.click()}>Change picture…</button>
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { void replace(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {error && <div className="bad-note small" role="alert">{error}</div>}
      {big && (
        <div className="lightbox layertone-lightbox" role="dialog" aria-modal="true" aria-label={`Picture and ${previewLabel.toLowerCase()}`} onClick={close}
          onKeyDown={(e) => { if (e.key === 'Tab') e.preventDefault(); }}>
          <div className="layertone-big">{pics}</div>
          <button className="lightbox-close" autoFocus onClick={close} aria-label="Close (Esc)"><Icon name="x" size={16} /></button>
        </div>
      )}
    </div>
  );
}
