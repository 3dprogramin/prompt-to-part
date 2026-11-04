// The Edit drawing brush's toolbar: the tools, the filament to draw, paint and fill with, the
// brush's width and shape, snap, undo and redo, clearing edits, the status and Cancel / Done.
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { PartMesh } from '../../../shared/types';
import type { ColourDepth, LineArtEdits, LineArtInfo } from '../../../shared/lineart';
import type { PartFilament } from '../../../shared/params';
import { sameFilament } from '../../lib/lineArtEdit';
import { depthLabel } from '../LineArtPanel';
import { Icon } from '../Icon';
import { FilamentPicker } from '../FilamentPicker';
import { WIDTH, type Op, type ShownStroke, type Tool } from './editorDraw';

interface Props {
  tool: Tool; setTool: Dispatch<SetStateAction<Tool>>;
  filament: PartFilament | null; setFilament: Dispatch<SetStateAction<PartFilament | null>>;
  /** The brush puts down a filament (not Erase or Select). */
  coloured: boolean;
  part: Pick<PartMesh, 'color'>;
  palette: PartFilament[];
  pickButton: RefObject<HTMLButtonElement | null>;
  picking: boolean; setPicking: Dispatch<SetStateAction<boolean>>;
  width: number; setWidths: Dispatch<SetStateAction<Record<Tool, number>>>;
  square: boolean; setShape: Dispatch<SetStateAction<'round' | 'square'>>;
  snap: boolean; setSnap: Dispatch<SetStateAction<boolean>>;
  hist: { undo: Op[]; redo: Op[] }; undo: () => void; redo: () => void;
  selection: ShownStroke[]; setSelection: Dispatch<SetStateAction<ShownStroke[]>>;
  clearHere: () => void; clear: (names: string[]) => void;
  applied: number;
  la: Pick<LineArtInfo, 'frames'>;
  edits: LineArtEdits;
  busy: boolean;
  changed: boolean;
  swaps: { depth: ColourDepth; text: string } | null;
  cancel: () => void;
  finish: RefObject<() => void>;
}

/** The bar over the Edit drawing brush's piece (LineArtEditor). */
export function EditorToolbar({ tool, setTool, filament, setFilament, coloured, part, palette, pickButton, picking, setPicking, width, setWidths, square, setShape,
  snap, setSnap, hist, undo, redo, selection, setSelection, clearHere, clear, applied, la, edits, busy, changed, swaps, cancel, finish }: Props) {
  const lim = WIDTH[tool];
  const status = changed ? 'Not built yet: Done builds it' : `${applied} hand edit${applied === 1 ? '' : 's'}`;
  const showSwaps = !!swaps && (tool === 'paint' || tool === 'fill' || palette.length > 0);
  return (
    <div className="la-ed-bar" role="toolbar" aria-label="Brush">
      <div className="la-ed-group" role="radiogroup" aria-label="Tool">
        {/* (In the filament chosen too: its swatch on the button says so.) */}
        <button className={`la-ed-tool ${tool === 'draw' ? 'on' : ''}`} role="radio" aria-checked={tool === 'draw'} onClick={() => setTool('draw')} title={`Draw a line (B), in ${filament ? filament.name ?? filament.color : "the piece's own filament"}`}>
          <Icon name="brush" size={15} /><span className="la-ed-label">Draw</span>
          {filament && <span className="swatch la-ed-tool-swatch" style={{ background: filament.color }} />}
        </button>
        <button className={`la-ed-tool ${tool === 'paint' ? 'on' : ''}`} role="radio" aria-checked={tool === 'paint'} onClick={() => setTool('paint')} title="Paint (P): colour what is under the brush (lines, frame, bar, text, pegs) in the filament chosen, as deep as the Print tab's Colours say (adds no line)">
          <Icon name="palette" size={15} /><span className="la-ed-label">Paint</span>
        </button>
        <button className={`la-ed-tool ${tool === 'fill' ? 'on' : ''}`} role="radio" aria-checked={tool === 'fill'} onClick={() => setTool('fill')} title="Fill (G): add material in the filament chosen, only where the piece has none (inside an outline), never over its lines">
          <Icon name="bucket" size={15} /><span className="la-ed-label">Fill</span>
        </button>
        <button className={`la-ed-tool ${tool === 'erase' ? 'on erase' : ''}`} role="radio" aria-checked={tool === 'erase'} onClick={() => setTool('erase')} title="Erase (E): the piece's own lines too">
          <Icon name="eraser" size={15} /><span className="la-ed-label">Erase</span>
        </button>
        <button className={`la-ed-tool ${tool === 'clear' ? 'on' : ''}`} role="radio" aria-checked={tool === 'clear'} onClick={() => setTool('clear')} title="Select (C): brush over where to clear the hand edits (strokes add up), then Clear edits here">
          <Icon name="select" size={15} /><span className="la-ed-label">Select</span>
        </button>
      </div>
      {/* The filament lines are drawn and painted in: the piece's own, those used, or another from the picker. */}
      <div className={`la-ed-filaments ${coloured ? '' : 'off'}`} role="radiogroup" aria-label="Filament to draw, paint and fill with">
        <button className={`la-ed-chip ${!filament ? 'on' : ''}`} role="radio" aria-checked={!filament} disabled={!coloured} onClick={() => setFilament(null)}
          title="The piece's own filament: paint with it to take a colour off" aria-label="The piece's own filament">
          <span className="swatch" style={{ background: part.color }} />
        </button>
        {palette.map((f) => {
          const on = !!filament && sameFilament(f, filament);
          return (
            <button key={`${f.color}${f.name ?? ''}`} className={`la-ed-chip ${on ? 'on' : ''}`} role="radio" aria-checked={on} disabled={!coloured} onClick={() => setFilament(f)}
              title={f.brand ? `${f.brand} ${f.name ?? f.color}` : f.name ?? f.color} aria-label={f.name ?? f.color}>
              <span className="swatch" style={{ background: f.color }} />
            </button>
          );
        })}
        <button ref={pickButton} className="la-ed-chip" disabled={!coloured} aria-expanded={picking} onClick={() => setPicking((o) => !o)} title="Another filament (yours, Bambu Lab's and more)" aria-label="Pick another filament">
          <Icon name="plus" size={13} />
        </button>
        <span className="la-ed-label la-ed-filament-name">{filament ? filament.name ?? filament.color : "Piece's own"}</span>
        {picking && (
          <FilamentPicker trigger={pickButton} current={filament ? { name: filament.name ?? filament.color, brand: filament.brand, color: filament.color, td: 1 } : undefined}
            onPick={(f) => { setFilament({ color: f.color.toLowerCase(), ...(f.name ? { name: f.name } : {}), ...(f.brand ? { brand: f.brand } : {}), ...(f.td ? { td: f.td } : {}) }); setPicking(false); }} onClose={() => setPicking(false)} />
        )}
      </div>
      <label className="la-ed-width" title="Brush width ([ and ])">
        <span className="la-ed-label">Width</span>
        <input type="range" min={lim.min} max={lim.max} step={0.1} value={width} aria-label={`${tool === 'draw' ? 'Line' : tool === 'paint' ? 'Paint brush' : tool === 'fill' ? 'Fill brush' : tool === 'clear' ? 'Selection brush' : 'Eraser'} width, mm`}
          onChange={(e) => setWidths((w) => ({ ...w, [tool]: Number(e.target.value) }))} />
        <span className="mono la-ed-val">{width.toFixed(1)} mm</span>
      </label>
      {/* The brush round or square (upright, as wide as the brush); Draw's lines are round. */}
      <div className="la-ed-group" role="radiogroup" aria-label="Brush shape">
        <button className={`la-ed-tool ${!square ? 'on' : ''}`} role="radio" aria-checked={!square} disabled={tool === 'draw'} onClick={() => setShape('round')} title="Round brush (Q)" aria-label="Round brush">
          <Icon name="round" size={15} />
        </button>
        <button className={`la-ed-tool ${square ? 'on' : ''}`} role="radio" aria-checked={square} disabled={tool === 'draw'} onClick={() => setShape('square')}
          title={tool === 'draw' ? 'Square brush (Q): for paint, fill, erase and select (a line is drawn round)' : 'Square brush (Q): a square as wide as the brush, upright'} aria-label="Square brush">
          <Icon name="square" size={15} />
        </button>
      </div>
      <button className={`la-ed-tool ${snap ? 'on' : ''}`} aria-pressed={snap} disabled={tool !== 'draw'} onClick={() => setSnap((s) => !s)}
        title="Snap (S): a line starting or ending near the drawing joins it exactly">
        <Icon name="magnet" size={15} /><span className="la-ed-label">Snap</span>
      </button>
      <div className="la-ed-group">
        <button className="la-ed-tool" disabled={!hist.undo.length} onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" size={15} /></button>
        <button className="la-ed-tool" disabled={!hist.redo.length} onClick={redo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" size={15} /></button>
      </div>
      {/* While selecting, edits are cleared only where selected. */}
      {tool === 'clear' || selection.length > 0 ? (
        <div className="la-ed-group">
          <button className="la-ed-tool" disabled={!selection.length} onClick={clearHere} title="Take back the hand edits in the area selected: there the piece is as it was made (lines drawn go, erased ones come back, paint and fills go)">
            <Icon name="restore" size={15} /><span className="la-ed-label">Clear edits here</span>
          </button>
          {selection.length > 0 && (
            <button className="la-ed-tool" onClick={() => setSelection([])} title="Deselect (Esc)" aria-label="Deselect"><Icon name="x" size={15} /></button>
          )}
        </div>
      ) : (
        <button className="la-ed-tool" disabled={!applied} onClick={() => clear(la.frames.filter((f) => edits[f.name]?.fp === f.fp).map((f) => f.name))} title="Remove every hand edit of this piece">
          <Icon name="trash" size={15} /><span className="la-ed-label">Clear edits</span>
        </button>
      )}
      {/* (It takes the room left, cut short rather than pushing Done onto a row of its own.) */}
      <span className="la-ed-status small" aria-live="polite" title={busy ? undefined : `${status}${showSwaps ? ` · ${swaps.text}` : ''}`}>
        {busy ? <><span className="spinner" /> updating…</> : status}
        {showSwaps && (
          <span className="la-ed-swaps" title={`Colours ${depthLabel(swaps.depth).toLowerCase()}, as built: an estimate (measured on an A1; the Print tab's Colours set how deep they go and compare; the Cost tab's slice is exact)`}>· {swaps.text}</span>
        )}
      </span>
      <button className="btn" onClick={cancel} title="Close without the changes made now">Cancel</button>
      <button className="btn primary" onClick={() => finish.current()} title="Done (Esc): build the piece with the edits">Done</button>
    </div>
  );
}
