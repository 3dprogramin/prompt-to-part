import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DimTarget, EvalResult, NumberParam, ParamDef, ParamValue, ParamValues, ScriptErrorInfo, SolveResult, Vec3 } from '../../shared/types';
import { Icon } from './Icon';
import { load, store } from '../lib/storage';
import { TextPanel } from './TextPanel';
import { OneColourSwitch, PrintPanel } from './PrintPanel';
import { CostPanel } from './CostPanel';
import { SizesPanel } from './SizesPanel';
import type { SizesControls } from '../hooks/useSizes';
import { AXIS_NAMES, scaledAxes, type SizeAxis } from '../../shared/sizes';
import { ObjectPanel } from './ObjectPanel';
import { parsePartColors, PART_COLORS_KEY, type PartFilament } from '../../shared/params';
import { MeshColorsPanel } from './MeshColorsPanel';
import type { RepaintControls } from '../hooks/useRepaint';
import { MESHES_KEY, parseMeshes } from '../../shared/meshes';
import type { MeshColor } from '../../shared/meshColors';
import { SvgPanel } from './SvgPanel';
import { LayerTonePanel, findLayerTonePart } from './LayerTonePanel';
import { LithophanePanel, lithophanePart } from './LithophanePanel';
import { LineArtPanel, lineArtPart } from './LineArtPanel';
import type { LayerToneImage, LayerToneSetup } from '../../shared/layertone';
import type { LineArtEdits } from '../../shared/lineart';
import type { SvgFeature } from '../../shared/svgFeatures';
import type { useCost } from '../hooks/useCost';
import type { PrintProfile, PrintSettings } from '../../shared/print';
import { useReleaseSlider } from './useReleaseSlider';
import { usePopover } from './usePopover';
import { FontPicker } from './FontPicker';
import type { TextFeature } from '../../shared/textFeatures';
import type { FontEntry, PrinterInfo } from '../../shared/api';
import type { ExportFormat } from '../lib/export';
import { download } from '../lib/files';
import { tokenize } from '../lib/highlight';
import { printer, fitProblem, profileName, shortName, type PrinterSetup } from '../../shared/printer';
import { modelWarnings } from '../../shared/modelWarnings';
import { pageKey, SOURCE_KINDS, WEB_KINDS, type DimensionSource } from '../../shared/sources';

type Tab = 'object' | 'decorate' | 'print' | 'code';

interface Props {
  /** The open design: unapplied code edits are kept per design. */
  designId: string;
  designName: string;
  /** Claude's summary of the shown version. */
  summary?: string;
  /** Cost of printing it (useCost). */
  cost: ReturnType<typeof useCost>;
  /** Where the real-world dimensions of the shown version came from (Claude's report). */
  sources?: DimensionSource[];
  result: EvalResult | null;
  lastGood: EvalResult | null;
  error: ScriptErrorInfo | null;
  code: string;
  onValue: (key: string, v: ParamValue) => void;
  onResetValues: () => void;
  /** The design's values (the LayerTone setup and pictures). */
  values: ParamValues;
  onLayerTone: (s: LayerToneSetup | null) => void;
  /** Change the line-art hand edits (LINEART_EDITS_KEY). */
  onLineArtEdits: (update: (edits: LineArtEdits) => LineArtEdits) => void;
  /** Open the line-art editor (the Edit drawing brush). */
  onEditLineArt: () => void;
  /** Show line art's joins of loose ends in the 3D view. */
  onShowJoins?: (on: boolean) => void;
  /** A coloured mesh's colours and filaments changed (Object tab). */
  onMeshPalette: (name: string, palette: MeshColor[]) => void;
  /** A filament picked for a part in the Object tab (null: back to the script's colour). */
  onPartColor: (part: string, filament: PartFilament | null) => void;
  /** Repainting a coloured mesh's patches by hand (useRepaint); `onRepaintStart` turns it on for one. */
  repaint: RepaintControls;
  onRepaintStart: (name: string) => void;
  onLayerToneImage: (name: string, image: LayerToneImage) => void;
  onApplyCode: (code: string) => void;
  onExport: (format: ExportFormat, partName?: string) => void;
  /** "Export project…": everything about the design in one folder (or zip). */
  onExportProject: () => void;
  /** What the project export is making ("3MF"), while it runs. */
  exportStage: string | null;
  exporting: boolean;
  exportError: string | null;
  /** Installed Blender, and why .blend export can't use it (too old). */
  blender: { version: string; problem: string | null } | null;
  onValidate: () => void;
  validating: boolean;
  aiPrint: PrintProfile;
  userPrint: PrintProfile;
  /** The profile's own settings (from the user's Bambu Studio template). */
  printBase: Required<PrintSettings>;
  /** The chosen printer and the printers to pick from (null until loaded). */
  printerInfo: PrinterInfo | null;
  onPrinter: (s: PrinterSetup) => Promise<void>;
  onUserPrint: (p: PrintProfile) => void;
  bambu: string | null;
  /** Number of print-setting changes that would be written to a 3MF. */
  printChanges: number;
  threeMf: { print: boolean };
  onThreeMf: (o: { print: boolean }) => void;
  /** "Print in one colour" (parseOneColour), saved with the design. */
  oneColour: null | 'main' | string;
  onOneColour: (c: null | 'main' | string) => void;
  onExport3mf: () => void;
  hiddenParts: string[];
  onToggleHidden: (name: string) => void;
  /** Which parts each parameter changes (measured; undefined until known). */
  paramOwners?: Record<string, string[]>;
  /** Set which parts are hidden (Object tab: show all, show only one). */
  onHiddenParts: (names: string[]) => void;
  /** The part selected in the Object tab (highlighted in the view). */
  selectedPart: string | null;
  onSelectPart: (name: string | null) => void;
  onEditDimension: (target: DimTarget, goal: number) => Promise<SolveResult | null>;
  scale: number;
  onScale: (factor: number) => void;
  /** The sale sizes (useSizes). */
  sizes: SizesControls;
  textFeatures: TextFeature[];
  onTextFeatures: (f: TextFeature[]) => void;
  svgFeatures: SvgFeature[];
  onSvgFeatures: (f: SvgFeature[]) => void;
  fonts: FontEntry[];
  picking: string | null;
  onPick: (featureId: string | null) => void;
}

const PLA_DENSITY = 1.24; // g/cm³

export function SidePanel(p: Props) {
  const [tab, setTab] = useState<Tab>('object');
  // Code edits not applied yet, per design, kept while other tabs or designs are open.
  const [drafts, setDrafts] = useState<Record<string, CodeDraft>>({});
  const draft = drafts[p.designId];
  const setDraft = (d: CodeDraft | null) => setDrafts((all) => {
    const next = { ...all };
    if (d) next[p.designId] = d; else delete next[p.designId];
    return next;
  });
  const shown = p.result ?? p.lastGood;
  // Without a model the other tabs have nothing to show; say why when the script is the problem.
  const noModel = (what: string) => (p.error
    ? <div className="empty-note">The script has an error, so there is no model. <button className="link" onClick={() => setTab('code')}>See the Code tab</button>, or restore an earlier version from the version menu.</div>
    : <div className="empty-note">{what}</div>);
  const hiddenCount = shown ? shown.parts.filter((x) => p.hiddenParts.includes(x.name)).length : 0;
  const decorations = p.textFeatures.length + p.svgFeatures.length;
  const layerTonePart = findLayerTonePart(shown);
  const lithoPart = lithophanePart(shown);
  const lineArt = lineArtPart(shown);
  // Four tabs, each with two sections one under the other (a LayerTone print, a lithophane or line
  // art adds its own on top of the Print tab).
  const tabs: [Tab, React.ReactNode][] = [
    ['object', <><Icon name="cube" size={14} /> Object{hiddenCount ? <span className="count" aria-label={`${hiddenCount} parts hidden`}>{shown!.parts.length - hiddenCount}/{shown!.parts.length}</span> : null}</>],
    ['decorate', <><Icon name="shapes" size={14} /> Text &amp; SVG{decorations ? <span className="count" aria-label={`${decorations} texts and drawings`}>{decorations}</span> : null}</>],
    ['print', <><Icon name="printer" size={14} /> Print{p.printChanges ? <span className="count" aria-label={`${p.printChanges} changed settings`}>{p.printChanges}</span> : null}{p.cost.running ? <span className="spinner tab-spinner" aria-label="calculating the cost" /> : null}</>],
    ['code', <><Icon name="code" size={14} /> Code{p.error ? <span className="err-dot" aria-label="script error" /> : draft ? <span className="draft-dot" aria-label="unapplied edits" title="Unapplied code edits" /> : null}</>],
  ];
  // Collapsed sections, remembered across reloads.
  const [folded, setFolded] = useState<string[]>(() => load('sideFolded', []));
  useEffect(() => store('sideFolded', folded), [folded]);
  const section = (id: string, title: string, body: () => React.ReactNode, extra?: React.ReactNode) => {
    const open = !folded.includes(id);
    return (
      <section className={`side-section ${open ? '' : 'folded'}`} key={id}>
        <button className="side-section-head" aria-expanded={open} onClick={() => setFolded((f) => (open ? [...f, id] : f.filter((x) => x !== id)))}>
          <span className={`chev ${open ? 'open' : ''}`}><Icon name="chevron" size={11} /></span> {title}{extra}
        </button>
        {open && <div className="side-section-body">{body()}</div>}
      </section>
    );
  };
  const openSection = (t: Tab, id: string) => { setTab(t); setFolded((f) => f.filter((x) => x !== id)); };
  return (
    <div className="side-panel">
      <div className="tabs" role="tablist">
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>
      <div className="tab-body" role="tabpanel">
        {tab === 'object' && <>
          {section('parts', 'Parts', () => (shown
            ? <ObjectPanel result={shown} hiddenParts={p.hiddenParts} onHiddenParts={p.onHiddenParts} onExport={p.onExport} selected={p.selectedPart} onSelect={p.onSelectPart}
              partColors={parsePartColors(p.values[PART_COLORS_KEY])} onPartColor={p.onPartColor}
              textFeatures={p.textFeatures} onTextFeatures={p.onTextFeatures} svgFeatures={p.svgFeatures} onSvgFeatures={p.onSvgFeatures} onEdit={(t) => openSection('decorate', t)} />
            : noModel('The parts appear here once a model is generated.')))}
          {shown && Object.values(parseMeshes(p.values[MESHES_KEY])).some((m) => m.palette?.length) && section('colors', 'Filament colours', () => <MeshColorsPanel result={shown} meshes={parseMeshes(p.values[MESHES_KEY])} onPalette={p.onMeshPalette} repaint={p.repaint} onRepaintStart={p.onRepaintStart} />)}
          {section('params', 'Parameters', () => (shown
            ? <><OverallSize result={shown} onEdit={p.onEditDimension} scale={p.scale} onScale={p.onScale} size={sizeEdit(p.sizes)} /><SizesPanel sizes={p.sizes} result={shown} costSettings={p.cost.settings} bambu={!!p.bambu} /><ParamsTab result={shown} hiddenParts={p.hiddenParts} owners={p.paramOwners} onValue={p.onValue} onReset={p.onResetValues} fonts={p.fonts} /></>
            : noModel('Parameters appear here once a model is generated.')))}
        </>}
        {tab === 'decorate' && <>
          {section('text', 'Text', () => (shown
            ? <TextPanel result={shown} features={p.textFeatures} onChange={p.onTextFeatures} fonts={p.fonts} picking={p.picking} onPick={p.onPick} />
            : noModel('Generate a model first, then add text to it.')))}
          {section('svg', 'SVG', () => (shown
            ? <SvgPanel result={shown} features={p.svgFeatures} onChange={p.onSvgFeatures} picking={p.picking} onPick={p.onPick} />
            : noModel('SVG drawings can be added once a model is generated.')))}
        </>}
        {tab === 'print' && <>
          {shown && <OneColourSwitch parts={shown.parts.filter((x) => !p.hiddenParts.includes(x.name))} choice={p.oneColour} onChange={p.onOneColour} />}
          {shown && layerTonePart && section('layertone', 'LayerTone', () => <LayerTonePanel result={shown} part={layerTonePart} values={p.values} onSetup={p.onLayerTone} onImage={p.onLayerToneImage} />)}
          {shown && lithoPart && section('lithophane', 'Lithophane', () => <LithophanePanel part={lithoPart} values={p.values} onImage={p.onLayerToneImage} />)}
          {shown && lineArt && section('lineart', 'Line art', () => <LineArtPanel part={lineArt} result={shown} values={p.values} onEdits={p.onLineArtEdits} onEdit={p.onEditLineArt} onValue={p.onValue} onShowJoins={p.onShowJoins} />)}
          {section('print', 'Print settings', () => (shown
            ? <PrintPanel parts={shown.parts.map((x) => x.name)} ai={p.aiPrint} user={p.userPrint} base={p.printBase} onChange={p.onUserPrint} bambu={p.bambu} />
            : noModel('Print settings appear once a model is generated.')))}
          {section('cost', 'Cost', () => (shown
            ? <CostPanel designId={p.designId} designName={p.designName} summary={p.summary} settings={p.cost.settings} onSettings={p.cost.saveSettings}
              result={p.cost.result} upToDate={p.cost.upToDate} error={p.cost.error} running={p.cost.running} bambu={!!p.bambu} onCalculate={p.cost.calculate} />
            : noModel('Costs appear once a model is generated.')))}
        </>}
        {tab === 'code' && <>
          {section('info', 'Model', () => (shown ? <InfoTab result={shown} sources={p.sources} /> : noModel('No model yet.')))}
          {section('code', 'Code', () => <CodeTab code={p.code} error={p.error} onApply={(c) => { setDraft(null); p.onApplyCode(c); }} draft={draft} onDraft={setDraft} />)}
        </>}
      </div>
      <div className="export-bar">
        {shown?.bbox && (
          <div className="dims-summary mono">
            {(shown.bbox.max[0] - shown.bbox.min[0]).toFixed(2)} × {(shown.bbox.max[1] - shown.bbox.min[1]).toFixed(2)} × {(shown.bbox.max[2] - shown.bbox.min[2]).toFixed(2)} mm
          </div>
        )}
<div className="export-row">
          <button className="btn ghost validate-btn" disabled={!shown || p.validating || p.exporting} onClick={p.onValidate} title="Check the export mesh for printing problems (also runs automatically on export)">
            <Icon name="check" size={14} /> {p.validating ? 'Checking…' : 'Validate'}
          </button>
          <ExportButton disabled={!shown || p.exporting} exporting={p.exporting} onExport={(f) => p.onExport(f)} blender={p.blender}
            bambu={p.bambu} printChanges={p.printChanges} threeMf={p.threeMf} onThreeMf={p.onThreeMf} oneColour={!!p.oneColour} onOneColour={(on) => p.onOneColour(on ? 'main' : null)} onExport3mf={p.onExport3mf} onExportProject={p.onExportProject} painted={!!shown?.parts.some((x) => x.paint)}
          count={shown ? shown.parts.length - p.hiddenParts.filter((n) => shown.parts.some((x) => x.name === n)).length : 0} />
        </div>
        {p.exportStage && <div className="size-note" role="status">Exporting project… {p.exportStage}</div>}
        {p.exportError && <div className="size-note bad">{p.exportError}</div>}
      </div>
    </div>
  );
}

/** What the export button does: the format last picked in its menu, kept until the page reloads. */
type MainExport = 'stl' | '3mf' | 'blend' | 'project';
let lastExport: MainExport = 'stl';

function ExportButton({ disabled, exporting, onExport, blender, count, bambu, printChanges, threeMf, onThreeMf, oneColour, onOneColour, onExport3mf, onExportProject, painted }: {
  disabled: boolean; exporting: boolean; onExport: (f: ExportFormat) => void; blender: Props['blender']; count: number;
  /** A part has a coloured mesh's colours, which only the 3MF keeps. */
  painted: boolean;
  bambu: string | null; printChanges: number; threeMf: { print: boolean };
  onThreeMf: (o: { print: boolean }) => void;
  /** The design prints in one colour (the Print tab's switch; "Colours (AMS)" is its opposite). */
  oneColour: boolean; onOneColour: (on: boolean) => void; onExport3mf: () => void; onExportProject: () => void;
}) {
  const [open, setOpen] = useState<false | 'menu' | '3mf'>(false);
  const wrap = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  usePopover(!!open, () => setOpen(false), wrap, more);
  const [main, setMainState] = useState<MainExport>(lastExport);
  const setMain = (m: MainExport) => { lastExport = m; setMainState(m); };
  const pick = (f: ExportFormat) => { setOpen(false); setMain(f === 'blend' ? 'blend' : 'stl'); onExport(f); };
  const printOn = threeMf.print && !!bambu;
  // Blender gone since it was picked: STL.
  const now: MainExport = main === 'blend' && (!blender || blender.problem) ? 'stl' : main;
  const run = () => (now === '3mf' ? onExport3mf() : now === 'project' ? onExportProject() : onExport(now));
  const label = { stl: 'Export STL', '3mf': 'Export 3MF', blend: 'Export .blend', project: 'Export project' }[now];
  const title = now === 'stl' ? `${count > 1 ? `Export ${count} parts as one STL` : 'Export STL'}${painted ? ' (geometry only: the figure\'s colours are only in the 3MF)' : ''}`
    : now === '3mf' ? `Export 3MF for Bambu Studio (${oneColour ? 'one filament' : 'colours (AMS)'}${printOn ? ', with print settings' : ''}); the arrow changes the format`
    : now === 'blend' ? 'Export a Blender file; the arrow changes the format' : 'Export the project folder; the arrow changes the format';
  return (
    <div className="export-split" ref={wrap}>
      <button className="btn primary export-main" disabled={disabled} onClick={run} title={title}>
        <Icon name="download" /> {exporting ? 'Exporting…' : label}
      </button>
      <button ref={more} className="btn primary export-more" disabled={disabled} onClick={() => setOpen(open ? false : 'menu')} title="More formats" aria-label="More export formats" aria-haspopup="menu" aria-expanded={!!open}><Icon name="chevron" size={14} /></button>
      {open === 'menu' && (
        <div className="export-menu">
          <button onClick={() => pick('stl')}><b>STL</b><span>{painted ? 'Geometry only: the figure\'s colours are lost – use 3MF for them' : 'Single mesh, works everywhere'}</span></button>
          <button onClick={() => setOpen('3mf')}><b>3MF…</b><span>For Bambu Studio – choose colours (AMS) and print settings</span></button>
          <button onClick={() => pick('blend')} disabled={!blender || !!blender.problem}><b>Blender (.blend)</b><span>{!blender ? 'Blender not found on this computer' : blender.problem ?? `One object per part, materials, dimensions, params · Blender ${blender.version}`}</span></button>
          <button onClick={() => { setOpen(false); setMain('project'); onExportProject(); }}><b>Export project…</b><span>Model, STL, 3MF, .blend, pictures and a README in one folder (a zip in Firefox)</span></button>
        </div>
      )}
      {open === '3mf' && (
        <div className="export-menu threemf">
          <div className="tm-title">Export 3MF for Bambu Studio</div>
          <label className="check">
            <input type="checkbox" checked={!oneColour} onChange={(e) => onOneColour(!e.target.checked)} />
            <span><b>Colours (AMS)</b><small>One filament per part colour{painted ? '; a coloured figure comes painted with its filaments' : ''}. Off = everything in one filament (“Print in one colour” in the Print tab, saved with the design).</small></span>
          </label>
          <label className={`check ${bambu ? '' : 'off'}`}>
            <input type="checkbox" disabled={!bambu} checked={printOn} onChange={(e) => onThreeMf({ ...threeMf, print: e.target.checked })} />
            <span><b>Print settings</b><small>{!bambu ? 'Needs Bambu Studio installed on this computer.'
              : printChanges ? `${shortName()} · PLA · ${profileName().replace(' mm', '')} with ${printChanges} changed setting${printChanges > 1 ? 's' : ''} (see the Print tab).`
                : `${shortName()} · PLA · ${profileName().replace(' mm', '')} profile, no changes.`}</small></span>
          </label>
          <button className="btn primary wide" onClick={() => { setOpen(false); setMain('3mf'); onExport3mf(); }}><Icon name="download" size={14} /> Export 3MF</button>
        </div>
      )}
    </div>
  );
}

/** The size shown in the 3D view, as Overall size edits it: only its own main dimension. */
interface SizeEdit { label: string; axis: SizeAxis; mm: number; dims: Vec3 | null; onSet: (mm: number) => void }
function sizeEdit(z: SizesControls): SizeEdit | undefined {
  const s = z.viewed;
  return s ? { label: s.label, axis: s.axis, mm: s.mm, dims: z.resolvedOf(s)?.size ?? null, onSet: (mm) => void z.setMm(s.id, mm) } : undefined;
}

function OverallSize({ result, onEdit, scale, onScale, size }: { result: EvalResult; onEdit: Props['onEditDimension']; scale: number; onScale: (f: number) => void; size?: SizeEdit }) {
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => setNote(null), [size?.label]);
  const b = result.bbox;
  if (!b) return null;
  const axes = [['W', 'X'], ['D', 'Y'], ['H', 'Z']] as const;
  // A sale size shown in the view: its W, D or H sets that size's main dimension (in proportion);
  // the others and the design stay as they are.
  if (size) {
    const d = size.dims;
    const setSize = (axis: SizeAxis, goal: number) => {
      if (!d) return;
      if (axis === size.axis) size.onSet(goal);
      else if (scaledAxes(d).includes(axis)) size.onSet((size.mm * goal) / d[axis]);
      else return setNote({ ok: false, text: `The ${['width', 'depth', 'height'][axis]} is the same in every size: stop showing ${size.label} to change it for all of them.` });
      setNote({ ok: true, text: `Size ${size.label} only: ${AXIS_NAMES[size.axis]} ${axis === size.axis ? goal.toFixed(1) : ((size.mm * goal) / d[axis]).toFixed(1)} mm` });
    };
    return (
      <section className="param-group overall size-mode">
        <h4>Overall size · {size.label} <span className="h4-hint">changes only size {size.label}</span></h4>
        <div className="size-grid">
          {axes.map(([name, ax], i) => (
            <label key={ax} className={`size-cell axis-${ax.toLowerCase()}`}>
              <span>{name} <small>{ax}</small></span>
              {d ? <CommitInput value={d[i]} decimals={2} onCommit={(v) => setSize(i as SizeAxis, v)} /> : <div className="num-box"><span className="spinner" /></div>}
            </label>
          ))}
          <div className="size-cell"><span>Sale size</span><b className="size-chip">{size.label}</b></div>
        </div>
        {note && <div className={`size-note ${note.ok ? '' : 'bad'}`}>{note.text}</div>}
      </section>
    );
  }
  const edit = async (axis: 0 | 1 | 2, goal: number) => {
    setNote({ ok: true, text: `Finding the right size for ${'XYZ'[axis]}…` });
    const r = await onEdit({ kind: 'bbox', axis }, goal);
    if (!r) return;
    const label = r.key ? result.params[r.key]?.label ?? r.key : '';
    setNote(r.ok ? { ok: true, text: r.key ? `${'XYZ'[axis]} set via “${label}”` : 'Already that size' } : { ok: false, text: r.message ?? 'Not reachable' });
  };
  return (
    <section className="param-group overall">
      <h4>Overall size <span className="h4-hint">type a size, or double-click a dimension in the view</span></h4>
      <div className="size-grid">
        {axes.map(([name, ax], i) => (
          <label key={ax} className={`size-cell axis-${ax.toLowerCase()}`}>
            <span>{name} <small>{ax}</small></span>
            <CommitInput value={b.max[i] - b.min[i]} decimals={2} onCommit={(v) => edit(i as 0 | 1 | 2, v)} />
          </label>
        ))}
        <label className="size-cell">
          <span>Scale</span>
          <CommitInput value={scale * 100} decimals={1} suffix="%" onCommit={(v) => v > 0 && onScale(v / 100)} />
        </label>
      </div>
      {note && <div className={`size-note ${note.ok ? '' : 'bad'}`}>{note.text}</div>}
    </section>
  );
}

function CommitInput({ value, decimals, onCommit, suffix }: { value: number; decimals: number; onCommit: (v: number) => void; suffix?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const v = Number(draft.replace(',', '.'));
    setDraft(null);
    if (Number.isFinite(v) && Math.abs(v - value) > 1e-6) onCommit(v);
  };
  return (
    <div className="num-box">
      <input className="mono" value={draft ?? value.toFixed(decimals)} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.preventDefault(); setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
      <span className="unit">{suffix ?? 'mm'}</span>
    </div>
  );
}

function ParamsTab({ result, hiddenParts, owners, onValue, onReset, fonts }: { result: EvalResult; hiddenParts: string[]; owners?: Record<string, string[]>; onValue: Props['onValue']; onReset: () => void; fonts: FontEntry[] }) {
  // A parameter is greyed out while every part it changes is hidden: the parts measured to change
  // with it plus those the script names; before the measurement, a group named after a part. With
  // every part hidden, all of them are.
  const names = result.parts.map((x) => x.name);
  const allHidden = names.length > 0 && names.every((n) => hiddenParts.includes(n));
  const ownersOf = (k: string, d: ParamDef) => {
    const known = [...new Set([...(d.parts ?? []), ...(owners?.[k] ?? [])])].filter((n) => names.includes(n));
    if (known.length || owners) return known;
    const byGroup = d.group && names.find((n) => n.toLowerCase() === d.group!.toLowerCase());
    return byGroup ? [byGroup] : [];
  };
  const hiddenOwners = (k: string, d: ParamDef) => {
    if (allHidden) return names;
    const o = ownersOf(k, d);
    return o.length && o.every((n) => hiddenParts.includes(n)) ? o : null;
  };
  const entries = Object.entries(result.params);
  if (!entries.length) return <div className="empty-note">This model has no parameters.</div>;
  const groups = new Map<string, [string, ParamDef][]>();
  for (const e of entries) {
    const g = e[1].group ?? 'General';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(e);
  }
  const modified = entries.some(([k, d]) => result.values[k] !== d.value);
  return (
    <div className="params">
      {result.meta.name && (
        <div className="model-title">
          <div>{result.meta.name}</div>
          {result.meta.description && <div className="dim small">{result.meta.description}</div>}
        </div>
      )}
      {[...groups].map(([g, items]) => (
        <section key={g} className="param-group">
          <h4>{g}</h4>
          {(() => {
            // Said once per group: which hidden parts its greyed-out parameters belong to.
            const off = [...new Set(items.flatMap(([k, d]) => hiddenOwners(k, d) ?? []))];
            return off.length ? <div className="hint-line param-hidden-note">{off.join(', ')} {off.length > 1 ? 'are' : 'is'} hidden: show {off.length > 1 ? 'them' : 'it'} in Parts to change {items.every(([k, d]) => hiddenOwners(k, d)) ? 'these' : 'the greyed-out ones'}.</div> : null;
          })()}
          {items.map(([k, d]) => {
            const off = hiddenOwners(k, d);
            return (
              <fieldset key={k} className="param-fieldset" disabled={!!off} title={off ? `${off.join(', ')} ${off.length > 1 ? 'are' : 'is'} hidden` : undefined}>
                <ParamRow k={k} def={d} value={result.values[k]} onValue={onValue} fonts={fonts} />
              </fieldset>
            );
          })}
        </section>
      ))}
      <button className="btn ghost wide" disabled={!modified} onClick={onReset}><Icon name="restore" size={14} /> Reset to AI defaults</button>
    </div>
  );
}

function ParamRow({ k, def, value: resultValue, onValue, fonts }: { k: string; def: ParamDef; value: ParamValue; onValue: Props['onValue']; fonts: FontEntry[] }) {
  // Show the user's choice immediately; the evaluated result catches up when the rebuild finishes.
  const [pending, setPending] = useState<ParamValue | undefined>(undefined);
  useEffect(() => setPending(undefined), [resultValue]);
  const value = pending ?? resultValue;
  const set = (key: string, v: ParamValue) => { setPending(v); onValue(key, v); };
  const changed = value !== def.value;
  const id = useId();
  const label = def.label ?? k;
  // The reset dot sits beside the label, not inside it: a click on the label must not reset.
  const reset = changed && <button className="mod-dot" title={`Reset to ${String(def.value)}`} aria-label={`Reset ${label} to ${String(def.value)}`} onClick={() => set(k, def.value)} />;
  // A <label> clicks the control it points at, so it only points at real inputs; choice buttons
  // and the font picker are named by their group instead (a click on the name changes nothing).
  const labelId = `${id}-label`;
  const forInput = def.type === 'number' || def.type === 'integer' || (def.type === 'text' && !def.font) || (def.type === 'select' && def.options.length > 4);
  const head = (
    <div className="param-head">
      {forInput
        ? <label htmlFor={id} id={labelId} title={def.description}>{label}</label>
        : <span className="param-label" id={labelId} title={def.description}>{label}</span>}
      {reset}
      {def.description && <span className="hint" title={def.description} aria-hidden>?</span>}
    </div>
  );
  if (def.type === 'boolean') {
    return (
      <div className="param bool">
        <label className="switch">
          <input type="checkbox" checked={!!value} onChange={(e) => set(k, e.target.checked)} />
          <span className="track" />
          <span className="switch-label" title={def.description}>{label}</span>
        </label>
        {reset}
      </div>
    );
  }
  if (def.type === 'text') {
    return (
      <div className="param">
        {head}
        {def.font
          ? <div role="group" aria-labelledby={labelId}><FontPicker id={id} fonts={fonts} value={String(value)} onChange={(v) => set(k, v)} /></div>
          : <TextValue id={id} value={String(value)} onCommit={(v) => set(k, v)} />}
      </div>
    );
  }
  if (def.type === 'select') {
    return (
      <div className="param">
        {head}
        <div className="seg" role="group" aria-labelledby={labelId}>
          {def.options.length <= 4
            ? def.options.map((o) => <button key={o.value} className={value === o.value ? 'on' : ''} aria-pressed={value === o.value} onClick={() => set(k, o.value)}>{o.label}</button>)
            : <select id={id} value={String(value)} onChange={(e) => set(k, e.target.value)}>{def.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}
        </div>
      </div>
    );
  }
  return (
    <div className="param">
      {head}
      <NumberControl id={id} label={label} def={def} value={Number(value)} onChange={(v) => set(k, v)} />
    </div>
  );
}

function TextValue({ id, value, onCommit }: { id: string; value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // Live update while typing (debounced) – text geometry is cheap enough.
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onCommit(draft), 250);
    return () => clearTimeout(t);
    // Only typing starts the timer; a new value from outside resets the draft above.
  }, [draft]);
  return <input id={id} className="text-param" value={draft} onChange={(e) => setDraft(e.target.value)} />;
}

function decimals(step: number) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

function NumberControl({ id, label, def, value, onChange }: { id: string; label: string; def: NumberParam; value: number; onChange: (v: number) => void }) {
  const step = def.step ?? (def.type === 'integer' ? 1 : 0.1);
  const dec = def.type === 'integer' ? 0 : Math.min(4, Math.max(decimals(step), 1));
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const v = Number(draft.replace(',', '.'));
    if (Number.isFinite(v)) onChange(def.type === 'integer' ? Math.round(v) : v);
    setDraft(null);
  };
  const out = value < def.min || value > def.max;
  const slider = useReleaseSlider(Math.min(def.max, Math.max(def.min, value)), onChange);
  const shown = slider.dragging ? slider.shown : value;
  return (
    <div className="num-control">
      <input type="range" id={id} aria-label={label} min={def.min} max={def.max} step={step} {...slider.inputProps} />
      <div className={`num-box ${out ? 'out' : ''}`} title={out ? `Outside the suggested range ${def.min}–${def.max}` : `${def.min} – ${def.max}`}>
        <input
          aria-label={`${label}${def.unit ? ` (${def.unit})` : ''}`}
          className="mono"
          value={draft ?? shown.toFixed(dec)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { e.preventDefault(); setDraft(null); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const mult = e.shiftKey ? 10 : 1;
              const nv = +(value + (e.key === 'ArrowUp' ? 1 : -1) * step * mult).toFixed(6);
              onChange(nv); setDraft(null);
            }
          }}
        />
        {def.unit && <span className="unit">{def.unit}</span>}
      </div>
    </div>
  );
}

function InfoTab({ result, sources }: { result: EvalResult; sources?: DimensionSource[] }) {
  const vol = result.parts.reduce((s, p) => s + p.volume, 0) / 1000;
  const area = result.parts.reduce((s, p) => s + p.surfaceArea, 0) / 100;
  const tris = result.parts.reduce((s, p) => s + p.triCount, 0);
  const b = result.bbox;
  const warnings = modelWarnings(result);
  const fit = fitProblem(b);
  return (
    <div className="info">
      {b && (
        <table className="kv">
          <tbody>
            <tr><th>Width (X)</th><td className="mono">{(b.max[0] - b.min[0]).toFixed(2)} mm</td></tr>
            <tr><th>Depth (Y)</th><td className="mono">{(b.max[1] - b.min[1]).toFixed(2)} mm</td></tr>
            <tr><th>Height (Z)</th><td className="mono">{(b.max[2] - b.min[2]).toFixed(2)} mm</td></tr>
            <tr><th>Volume</th><td className="mono">{vol.toFixed(2)} cm³</td></tr>
            <tr><th>Mass, solid PLA</th><td className="mono">{(vol * PLA_DENSITY).toFixed(1)} g</td></tr>
            <tr><th>Surface area</th><td className="mono">{area.toFixed(1)} cm²</td></tr>
            <tr><th>Fits {printer().name}</th><td className={fit ? 'bad-text' : 'good-text'}>{fit ? 'No' : 'Yes'}</td></tr>
            <tr><th>Triangles</th><td className="mono">{tris.toLocaleString()}</td></tr>
          </tbody>
        </table>
      )}
      {sources && sources.length > 0 && <Sources list={sources} />}
      <h4>Parts</h4>
      <ul className="part-list">
        {result.parts.map((p) => {
          return (
            <li key={p.name}>
              <span className="swatch" style={{ background: p.color }} />
              <div className="part-meta">
                <div>{p.name}</div>
                <div className="mono dim small">{(p.bbox.max[0] - p.bbox.min[0]).toFixed(1)} × {(p.bbox.max[1] - p.bbox.min[1]).toFixed(1)} × {(p.bbox.max[2] - p.bbox.min[2]).toFixed(1)} mm · {(p.volume / 1000).toFixed(2)} cm³</div>
              </div>
            </li>
          );
        })}
      </ul>
      {result.dimensions.length > 0 && (
        <>
          <h4>Callouts</h4>
          <table className="kv">
            <tbody>
              {result.dimensions.map((d, i) => (
                <tr key={i}><th>{d.label ?? `Dimension ${i + 1}`}</th><td className="mono">{Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]).toFixed(2)} mm</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {warnings.length > 0 && (
        <>
          <h4>Warnings</h4>
          <ul className="warnings">{warnings.map((w, i) => <li key={i}><Icon name="alert" size={13} /> {w}</li>)}</ul>
        </>
      )}
      {result.logs.length > 0 && (
        <>
          <h4>Console</h4>
          <pre className="console">{result.logs.join('\n')}</pre>
        </>
      )}
    </div>
  );
}

/** Where Claude got the real-world dimensions, most trustworthy first, with links to the pages. */
function Sources({ list }: { list: DimensionSource[] }) {
  const order = Object.keys(SOURCE_KINDS);
  const sorted = [...list].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <>
      <h4>Dimension sources</h4>
      <ul className="sources">
        {sorted.map((s, i) => {
          const kind = SOURCE_KINDS[s.kind];
          const link = pageKey(s.url) ? s.url : undefined;
          return (
            <li key={i}>
              <span className={`src-kind ${kind.trust}`} title={kind.hint}>{kind.label}</span>
              <div className="src-meta">
                <div>{s.dimension}: <span className="mono">{s.value}</span></div>
                {link && (
                  <div className="small">
                    <a href={link} target="_blank" rel="noopener noreferrer">{new URL(link).hostname.replace(/^www\./, '')}</a>
                    {WEB_KINDS.includes(s.kind) && !s.opened && <span className="dim" title="Jig cited this page without opening it (e.g. from a search result)"> · not opened by Jig</span>}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Code typed in the editor but not applied: `base` is the script it started from. */
interface CodeDraft { base: string; text: string }

function CodeTab({ code, error, onApply, draft, onDraft }: {
  code: string; error: ScriptErrorInfo | null; onApply: (c: string) => void; draft: CodeDraft | undefined; onDraft: (d: CodeDraft | null) => void;
}) {
  const text = draft?.text ?? code;
  const dirty = text !== code;
  // The script changed (Claude's new version, a restore) while unapplied edits were open.
  const outdated = !!draft && draft.base !== code;
  // Tab indents; Escape first lets the next Tab move the focus on, as in other code editors.
  const escaped = useRef(false);
  const hintId = useId();
  // The coloured copy of the script sits behind the textarea, whose own text is transparent.
  const colours = useRef<HTMLPreElement>(null);
  const tokens = useMemo(() => tokenize(text), [text]);
  return (
    <div className="code-tab">
      {error && <div className="code-error" role="alert"><Icon name="alert" size={14} /> {error.line ? `Line ${error.line}: ` : ''}{error.message}</div>}
      {outdated && (
        <div className="code-note">
          The script has changed since you started editing.{' '}
          <button className="link" onClick={() => onDraft(null)}>Load the new script</button> or keep editing yours.
        </div>
      )}
      <div className="code-wrap">
      <pre className="code-colours mono" ref={colours} aria-hidden="true">
        {tokens.map((t, i) => (t.kind === 'plain' ? t.text : <span key={i} className={`tk-${t.kind}`}>{t.text}</span>))}
        {'\n'}
      </pre>
      <textarea className="code-editor mono" spellCheck={false} value={text} aria-label="Model script (model.js)" aria-describedby={hintId}
        onScroll={(e) => { if (colours.current) { colours.current.scrollTop = e.currentTarget.scrollTop; colours.current.scrollLeft = e.currentTarget.scrollLeft; } }}
        onChange={(e) => onDraft(e.target.value === code ? null : { base: draft?.base ?? code, text: e.target.value })}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (dirty) onApply(text); }
          if (e.key === 'Escape') { e.preventDefault(); escaped.current = true; return; }
          if (e.key === 'Tab' && !e.shiftKey && !escaped.current) {
            e.preventDefault();
            const t = e.currentTarget, s = t.selectionStart;
            onDraft({ base: draft?.base ?? code, text: text.slice(0, s) + '  ' + text.slice(t.selectionEnd) });
            requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2; });
          }
          escaped.current = false;
        }}
        placeholder="The model script appears here." />
      </div>
      <div className="code-hint dim small" id={hintId}>Tab indents · Esc, then Tab, leaves the editor · Ctrl+S applies</div>
      <div className="code-actions">
        <button className="btn ghost" disabled={!dirty} onClick={() => onDraft(null)}>Revert</button>
        <button className="btn primary" disabled={!dirty} onClick={() => onApply(text)}>Apply (Ctrl+S)</button>
        <span className="spacer" />
        <button className="btn ghost" disabled={!code} onClick={() => download(new Blob([code], { type: 'text/javascript' }), 'model.js')} aria-label="Download model.js">
          <Icon name="download" size={14} /> .js
        </button>
      </div>
    </div>
  );
}
