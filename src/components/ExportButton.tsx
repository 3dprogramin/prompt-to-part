// The side panel's Export button: the main button runs the format last picked (3MF until then),
// the arrow opens the list of formats.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { usePopover } from './usePopover';
import type { ExportFormat, ThreeMfChoice } from '../lib/export';
import type { GlbOptions } from '../lib/glb';
import { bambuProjectSupported, profileName, shortName } from '../../shared/printer';

/** Blender on this computer, if found (its version, or why it can't be used). */
type Blender = { version: string; problem: string | null } | null;

/** What the export button does: the format last picked in its menu, kept until the page reloads. */
type MainExport = 'stl' | '3mf' | 'blend' | 'glb' | 'project';
let lastExport: MainExport = '3mf';

/** How many filament colours the parts print with (their colours, a LayerTone part's stack and a painted part's). */
export function colourCount(parts: { color: string; layerColors?: { color: string }[]; paint?: { filaments: { color: string }[] } }[]): number {
  return new Set(parts.flatMap((p) => [p.color, ...(p.layerColors ?? []).map((l) => l.color), ...(p.paint?.filaments ?? []).map((f) => f.color)]).map((c) => c.toLowerCase())).size;
}

export function ExportButton({ disabled, exporting, onExport, blender, count, colours, bambu, printChanges, threeMf, onThreeMf, oneColour, onOneColour, onExport3mf, onExportProject, painted, flat }: {
  disabled: boolean; exporting: boolean; onExport: (f: ExportFormat, glb?: GlbOptions) => void; blender: Blender; count: number;
  /** The model is a flat piece (wall art, a sign): its GLB stands upright unless unticked. */
  flat: boolean;
  /** A part has a coloured mesh's colours, which only the 3MF keeps. */
  painted: boolean;
  /** The filament colours the shown parts use (colourCount): one plate per colour only for more than one. */
  colours: number;
  bambu: string | null; printChanges: number; threeMf: ThreeMfChoice;
  onThreeMf: (o: ThreeMfChoice) => void;
  /** The design prints in one colour (the Print tab's switch; "Colours (AMS)" is its opposite). */
  oneColour: boolean; onOneColour: (on: boolean) => void; onExport3mf: () => void; onExportProject: () => void;
}) {
  const [open, setOpen] = useState<false | 'menu' | '3mf' | 'glb'>(false);
  // GLB: upright follows the model (flat or not) until the user changes it for this model.
  const [upright, setUpright] = useState(flat);
  useEffect(() => setUpright(flat), [flat]);
  const wrap = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  usePopover(!!open, () => setOpen(false), wrap, more);
  const [main, setMainState] = useState<MainExport>(lastExport);
  const setMain = (m: MainExport) => { lastExport = m; setMainState(m); };
  const pick = (f: ExportFormat) => { setOpen(false); setMain(f === 'blend' ? 'blend' : 'stl'); onExport(f); };
  const project = !!bambu && bambuProjectSupported();
  const printOn = threeMf.print && project;
  const byColour = project && colours > 1 && !oneColour && threeMf.platePerColour;
  // Blender gone since it was picked: STL.
  const now: MainExport = main === 'blend' && (!blender || blender.problem) ? 'stl' : main;
  const run = () => (now === '3mf' ? onExport3mf() : now === 'project' ? onExportProject() : now === 'glb' ? onExport('glb', { upright }) : onExport(now));
  const label = { stl: 'Export STL', '3mf': 'Export 3MF', blend: 'Export .blend', glb: 'Export GLB', project: 'Export project' }[now];
  const title = now === 'stl' ? `${count > 1 ? `Export ${count} parts as one STL` : 'Export STL'}${painted ? ' (geometry only: the figure\'s colours are only in the 3MF)' : ''}`
    : now === '3mf' ? `Export 3MF for Bambu Studio (${oneColour ? 'one filament' : byColour ? 'one plate per colour' : 'colours (AMS)'}${printOn ? ', with print settings' : ''}); the arrow changes the format`
    : now === 'blend' ? 'Export a Blender file; the arrow changes the format'
    : now === 'glb' ? `Export a GLB for a shop's 3D view (${upright ? 'upright, as on a wall' : 'lying, as printed'}); the arrow changes the format` : 'Export the project folder; the arrow changes the format';
  return (
    <div className="export-split" ref={wrap}>
      <button className="btn primary export-main" disabled={disabled} onClick={run} title={title}>
        <Icon name="download" /> {exporting ? 'Exporting…' : label}
      </button>
      <button ref={more} className="btn primary export-more" disabled={disabled} onClick={() => setOpen(open ? false : 'menu')} title="More formats" aria-label="More export formats" aria-haspopup="menu" aria-expanded={!!open}><Icon name="chevron" size={14} /></button>
      {open === 'menu' && (
        <ExportMenu blender={blender} painted={painted} pick={pick} open3mf={() => setOpen('3mf')} openGlb={() => setOpen('glb')}
          project={() => { setOpen(false); setMain('project'); onExportProject(); }} />
      )}
      {open === '3mf' && (
        <ThreeMfMenu colours={colours} oneColour={oneColour} onOneColour={onOneColour} painted={painted} bambu={bambu} printChanges={printChanges}
          threeMf={threeMf} onThreeMf={onThreeMf} onExport={() => { setOpen(false); setMain('3mf'); onExport3mf(); }} />
      )}
      {open === 'glb' && (
        <div className="export-menu threemf">
          <div className="tm-title">Export GLB for a shop's 3D view</div>
          <label className="check">
            <input type="checkbox" checked={upright} onChange={(e) => setUpright(e.target.checked)} />
            <span><b>Upright, as it hangs on the wall</b><small>{flat ? 'For wall art, signs and plaques. Untick for a flat piece that lies down (a coaster, a tray).' : 'Off = standing as it prints. On = its top face turned to the front, for a piece that hangs.'}</small></span>
          </label>
          <small className="glb-note">Shopify: Products → the product → Media → add the .glb. Colours and real size are in the file.</small>
          <button className="btn primary wide" onClick={() => { setOpen(false); setMain('glb'); onExport('glb', { upright }); }}><Icon name="download" size={14} /> Export GLB</button>
        </div>
      )}
    </div>
  );
}


/**
 * Export ▸ 3MF…: colours (AMS) or one filament, one plate per colour (a Bambu project of more than
 * one colour, not in one filament), print settings, and the Export 3MF button.
 */
export function ThreeMfMenu({ colours, oneColour, onOneColour, painted, bambu, printChanges, threeMf, onThreeMf, onExport }: {
  colours: number; oneColour: boolean; onOneColour: (on: boolean) => void; painted: boolean; bambu: string | null; printChanges: number;
  threeMf: ThreeMfChoice; onThreeMf: (o: ThreeMfChoice) => void; onExport: () => void;
}) {
  const project = !!bambu && bambuProjectSupported();
  const printOn = threeMf.print && project;
  const byColour = project && colours > 1 && !oneColour && threeMf.platePerColour;
  return (
    <div className="export-menu threemf">
      <div className="tm-title">Export 3MF for Bambu Studio</div>
      <label className="check">
        <input type="checkbox" checked={!oneColour} onChange={(e) => onOneColour(!e.target.checked)} />
        <span><b>Colours (AMS)</b><small>One filament per part colour{painted ? '; a coloured figure comes painted with its filaments' : ''}. Off = everything in one filament (“Print in one colour” in the Print tab, saved with the design).</small></span>
      </label>
      {project && colours > 1 && (
        <label className={`check ${oneColour ? 'off' : ''}`}>
          <input type="checkbox" disabled={oneColour} checked={byColour} onChange={(e) => onThreeMf({ ...threeMf, platePerColour: e.target.checked })} />
          <span><b>One plate per colour</b><small>{oneColour ? 'Needs Colours (AMS): everything prints in one filament now.'
            : 'No AMS: each plate prints one filament, its parts packed onto as few plates as fit. Parts of several colours that touch get a plate of their own.'}</small></span>
        </label>
      )}
      <label className={`check ${project ? '' : 'off'}`}>
        <input type="checkbox" disabled={!project} checked={printOn} onChange={(e) => onThreeMf({ ...threeMf, print: e.target.checked })} />
        <span><b>Print settings</b><small>{!bambu ? 'Needs Bambu Studio installed on this computer.'
          : !project ? `Not yet for the ${shortName()} (two nozzles): a plain 3MF.`
          : printChanges ? `${shortName()} · PLA · ${profileName().replace(' mm', '')} with ${printChanges} changed setting${printChanges > 1 ? 's' : ''} (see the Print tab).`
            : `${shortName()} · PLA · ${profileName().replace(' mm', '')} profile, no changes.`}</small></span>
      </label>
      <button className="btn primary wide" onClick={onExport}><Icon name="download" size={14} /> Export 3MF</button>
    </div>
  );
}

/**
 * The list of formats: 3MF first (the usual one), then STL, GLB and Blender, and Export project
 * (everything in one folder) below a divider. 3MF and Export project are set apart.
 */
export function ExportMenu({ blender, painted, pick, open3mf, openGlb, project }: {
  blender: Blender; painted: boolean;
  pick: (f: ExportFormat) => void; open3mf: () => void; openGlb: () => void; project: () => void;
}) {
  return (
    <div className="export-menu">
      <button className="export-featured" onClick={open3mf}>
        <span className="export-name"><b>3MF…</b><em className="export-tag">Best for printing</em></span>
        <span>For Bambu Studio: colours (AMS) and print settings</span>
      </button>
      <button onClick={() => pick('stl')}><b>STL</b><span>{painted ? 'Geometry only: the figure\'s colours are lost. Use 3MF for them' : 'Single mesh, works everywhere'}</span></button>
      <button onClick={openGlb}><b>GLB… (shop 3D view)</b><span>For Shopify's 360° view and “view in your room”: colours, real size</span></button>
      <button onClick={() => pick('blend')} disabled={!blender || !!blender.problem}><b>Blender (.blend)</b><span>{!blender ? 'Blender not found on this computer' : blender.problem ?? `One object per part, materials, dimensions, params · Blender ${blender.version}`}</span></button>
      <div className="export-divider" role="separator" />
      <button className="export-featured" onClick={project}>
        <span className="export-name"><Icon name="folder" size={13} /><b>Export project…</b><em className="export-tag">Everything</em></span>
        <span>Model, STL, 3MF, .blend, pictures and a README in one folder (a zip in Firefox)</span>
      </button>
    </div>
  );
}
