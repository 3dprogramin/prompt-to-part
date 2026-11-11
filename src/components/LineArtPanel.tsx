import { useEffect, useMemo, useRef, useState } from 'react';
import type { EvalResult, ParamValue, ParamValues, PartMesh } from '../../shared/types';
import { DEFAULT_SPLIT_JOIN, formatLineArtSize, LINE_ART_STYLE_INFO, LINEART_JOIN_KEY, parseLineArtJoin, LINEART_EDITS_KEY, LINEART_SIZE_KEY, LINEART_SPLIT_KEY, MAX_LINEART_SIZE, parseLineArtEdits, parseLineArtSize, parseLineArtSplit, type LineArtEdits, type LineArtInfo, type LineArtSplitInfo } from '../../shared/lineart';
import { formatSplitSpec, parseSplitSpec, type SplitSpec } from '../../shared/split';
import { NumBox } from './NumBox';
import { DEFAULT_JOIN_ENDS, LINEART_ENDS_KEY, parseLineArtEnds } from '../../shared/lineart';
import { colourBands, colourSwaps, LINEART_DEPTH_KEY, MAX_COLOUR_LAYERS, parseLineArtDepth, type ColourDepth, type LineArtPaint } from '../../shared/lineart';
import { colourFamilies } from '../../shared/filaments';
import { staleEdits, withoutColours, withoutDrawings } from '../lib/lineArtEdit';
import { amsSlots } from '../lib/bambu3mf';
import { DRAWINGS_KEY, parseDrawings, type SvgDrawing } from '../../shared/svgFeatures';
import { maxPiece, printer, shortName } from '../../shared/printer';
import { Icon } from './Icon';
import { SCALE_KEY } from '../../shared/params';
import { load, store } from '../lib/storage';

/** A line-art part (H.lineart): its style, drawings and what was fixed. */
type LineArtPart = PartMesh & { lineArt: LineArtInfo };

/** The first part of the model that is line art (not one of its colours), if any. */
export function lineArtPart(result: EvalResult | null): LineArtPart | undefined {
  const all = result?.parts.filter((p): p is LineArtPart => !!p.lineArt) ?? [];
  return all.find((p) => !p.lineArt.paintedIn) ?? all[0];
}

/**
 * The line art as one part on the wall, for the editor: a piece split into pieces has them put back
 * where they go (each moved back by its layout offset) and merged, with the lines coloured in other
 * filaments (`paints`: their colour and triangles, from / to in `indices`); otherwise the part itself.
 */
export function assembledLineArt(result: EvalResult | null): (LineArtPart & { paints?: { color: string; from: number; to: number }[]; colourInfo?: LineArtPaint[] }) | undefined {
  const first = lineArtPart(result);
  if (!first || !result || (!first.lineArt.split && !first.lineArt.colours?.length)) return first;
  const pieces = result.parts.filter((p): p is LineArtPart => (first.lineArt.split ? !!p.lineArt?.piece : !!p.lineArt));
  const n = pieces.reduce((a, p) => a + p.positions.length, 0), m = pieces.reduce((a, p) => a + p.indices.length, 0);
  const positions = new Float32Array(n), indices = new Uint32Array(m);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const paints: { color: string; from: number; to: number }[] = [];
  let pv = 0, pi = 0;
  for (const p of pieces) {
    if (p.lineArt.paintedIn) paints.push({ color: p.color, from: pi, to: pi + p.indices.length });
    const [dx, dy] = p.lineArt.piece?.offset ?? [0, 0];
    for (let k = 0; k < p.positions.length; k += 3) {
      const x = p.positions[k] - dx, y = p.positions[k + 1] - dy, z = p.positions[k + 2];
      positions[pv + k] = x; positions[pv + k + 1] = y; positions[pv + k + 2] = z;
      min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
    }
    for (let k = 0; k < p.indices.length; k++) indices[pi + k] = p.indices[k] + pv / 3;
    pv += p.positions.length; pi += p.indices.length;
  }
  // Every piece should be one piece: the most any is in (with its colours). Their joins of loose ends together.
  const whole = pieces.filter((p) => !p.lineArt.paintedIn).map((p) => p.lineArt.components ?? p.components);
  const lineArt = { ...first.lineArt, joins: pieces.flatMap((p) => (p.lineArt.paintedIn ? [] : p.lineArt.joins ?? [])), loose: pieces.flatMap((p) => (p.lineArt.paintedIn ? [] : p.lineArt.loose ?? [])) };
  const colourInfo = pieces.flatMap((p) => (!p.lineArt.paintedIn && p.lineArt.paint ? [p.lineArt.paint] : []));
  return { ...first, lineArt, positions, indices, bbox: { min, max }, components: Math.max(1, ...whole), ...(paints.length ? { paints } : {}), ...(colourInfo.length ? { colourInfo } : {}) };
}

/** What the colours cost in filament changes at a depth, over the pieces (each prints on its own): an estimate (colourSwaps). */
export function colourCost(paints: LineArtPaint[], depth: ColourDepth) {
  return paints.map((p) => colourSwaps(p, depth)).reduce((t, c) => ({ layers: t.layers + c.layers, changes: t.changes + c.changes, minutes: t.minutes + c.minutes, grams: t.grams + c.grams }), { layers: 0, changes: 0, minutes: 0, grams: 0 });
}
const aboutTime = (min: number) => { const m = Math.max(1, Math.round(min)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };
/** "11 filament changes on 9 layers, about 18 min and 3.9 g more" */
export function formatColourCost(c: ReturnType<typeof colourCost>): string {
  if (!c.changes) return 'no filament changes';
  return `${c.changes} filament change${c.changes === 1 ? '' : 's'} on ${c.layers} layer${c.layers === 1 ? '' : 's'}, about ${aboutTime(c.minutes)} and ${c.grams < 9.95 ? +c.grams.toFixed(1) : Math.round(c.grams)} g more`;
}
export const depthLabel = (d: ColourDepth) => (d === 'through' ? 'Through the piece' : d === 'auto' ? 'Top layers (auto)' : `Top ${d} layer${d === 1 ? '' : 's'}`);

/**
 * How deep the colours go (LINEART_DEPTH_KEY): their top layers (as few as hide the piece's own
 * filament by each one's TD, or a number for all) or through the piece; how many layers each gets
 * and how much of the filament under it that hides, and what the filament changes cost against
 * the other choice (estimates; the Cost tab slices it).
 */
function ColourDepthRow({ paints, base, values, onValue }: { paints: LineArtPaint[]; base: string; values: ParamValues; onValue: Props['onValue'] }) {
  const depth = parseLineArtDepth(values[LINEART_DEPTH_KEY]) ?? 'through';
  const mode = depth === 'through' ? 'through' : depth === 'auto' ? 'auto' : 'layers';
  const under = colourFamilies(base)[0];
  // Each colour once (the first piece it is on), with the layers it gets on what it is on (not a peg: those are whole).
  const seen = new Set<string>();
  const colours = paints.flatMap((p) => p.colours.flatMap((c) => {
    const key = `${c.filament.color}|${c.filament.name ?? ''}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const on = p.materials.filter((m) => c.on.includes(m.kind)), bands = colourBands(p, c, depth);
    const k = on.findIndex((m) => m.kind !== 'pegs');
    const t = k < 0 ? 0 : bands[k][1] - bands[k][0];
    return [{ ...c, t, layers: Math.round(t / p.layers.layerHeight), pegsOnly: k < 0 }];
  }));
  const autoMost = Math.max(...paints.flatMap((p) => p.colours.map((c) => colourBands(p, c, 'auto')).flat().map(([a, b]) => Math.round((b - a) / p.layers.layerHeight))));
  const other: ColourDepth = depth === 'through' ? 'auto' : 'through';
  const now = colourCost(paints, depth), alt = colourCost(paints, other);
  const pct = (t: number, td: number) => Math.round(100 * (1 - Math.exp((-3 * t) / td)));
  return (
    <div className="lineart-depth">
      <div className="lineart-edit-row">
        <select value={mode} aria-label="How deep the colours go" title="Top layers: the colours are only the face that shows, so the AMS changes filament on those layers only"
          onChange={(e) => onValue(LINEART_DEPTH_KEY, e.target.value === 'layers' ? String(typeof depth === 'number' ? depth : Math.min(MAX_COLOUR_LAYERS, Math.max(1, autoMost))) : e.target.value)}>
          <option value="auto">Top layers (auto)</option>
          <option value="layers">Top layers:</option>
          <option value="through">Through the piece</option>
        </select>
        {typeof depth === 'number' && <NumBox value={depth} min={1} max={MAX_COLOUR_LAYERS} label="Top layers the colours are" onCommit={(v) => onValue(LINEART_DEPTH_KEY, String(Math.min(MAX_COLOUR_LAYERS, Math.max(1, Math.round(v)))))} />}
      </div>
      {depth !== 'through' && colours.map((c) => (
        <span key={`${c.filament.color}${c.filament.name ?? ''}`} className="lineart-why">
          {c.pegsOnly ? `${c.filament.name ?? c.filament.color}: the pegs, whole` : `${c.filament.name ?? c.filament.color}: top ${c.layers} layer${c.layers === 1 ? '' : 's'}${c.t >= c.td - 1e-6
            ? `, enough to cover the ${under}`
            : `, covering about ${pct(c.t, c.td)}\u00a0% of the ${under} (fully hiding it takes ${+c.td.toFixed(1)} mm${c.known ? '' : ', a guess for this colour'}${depth === 'auto' ? ', more than the piece allows' : ''})`}`}
        </span>
      ))}
      <span className="lineart-why">{depthLabel(depth)}: {formatColourCost(now)}.</span>
      <span className="lineart-why">{depthLabel(other)}: {formatColourCost(alt)}.</span>
      <span className="lineart-why note">Estimates{printer().model === 'Bambu Lab A1' ? ' for the A1' : ' (measured on an A1)'}; the Cost tab's slice is exact.</span>
    </div>
  );
}

/** Closed-up gaps beyond this share of them, and the drawing is too fine for its size. */
const BLOTCHY_SHARE = 0.1;
/** More bridges than this, or a longer one (mm), and the drawing is worth asking again for. */
const MANY_BRIDGES = 10;
const LONG_BRIDGE = 15;

/** A drawing as it was attached or drawn, on paper: its shapes in their own colours. */
function DrawingPreview({ drawing }: { drawing: SvgDrawing }) {
  const shapes = useMemo(() => drawing.shapes.map((s) => ({
    d: s.contours.map((c) => `M${c.map(([x, y]) => `${x.toFixed(4)} ${(-y).toFixed(4)}`).join('L')}Z`).join(''),
    rule: s.rule === 'EvenOdd' ? 'evenodd' as const : 'nonzero' as const,
    color: s.color || '#1a1a1a',
  })), [drawing]);
  const pad = 0.04;
  return (
    <svg className="lineart-drawing" viewBox={`${-drawing.aspect / 2 - pad} ${-0.5 - pad} ${drawing.aspect + 2 * pad} ${1 + 2 * pad}`} role="img" aria-label={`The drawing ${drawing.name}`}>
      {shapes.map((s, i) => <path key={i} d={s.d} fill={s.color} fillRule={s.rule} />)}
    </svg>
  );
}

interface Props {
  part: LineArtPart;
  /** The whole model (a split piece's other pieces, the script's width and height parameters). */
  result: EvalResult;
  /** The design's values: DRAWINGS_KEY (the attached and drawn drawings), LINEART_EDITS_KEY (hand edits) and LINEART_SPLIT_KEY (the split). */
  values: ParamValues;
  /** `label`: what the change did, for the editor's History. */
  onEdits: (update: (edits: LineArtEdits) => LineArtEdits, label?: string) => void;
  /** Set a parameter or design value (the size, the split). */
  onValue: (key: string, v: ParamValue) => void;
  /** Show where loose ends were joined and left in the 3D view (while this section is open). */
  onShowJoins?: (on: boolean) => void;
}

/** Pieces to choose from, and the most columns or rows of a grid. */
const PIECE_COUNTS = [2, 3, 4, 6, 8, 9, 10, 12, 15, 16, 20, 24, 30, 36];
const MAX_GRID = 10;
/** About how big a piece Auto makes, to guess a count before the model is split (mm). */

/**
 * Split into pieces: Off / Auto / a number of pieces / a grid, the size of the whole piece (the
 * script's width and height parameters), the pieces with their sizes and a picture of how they go
 * on the wall. The choice is a design value (LINEART_SPLIT_KEY) that wins over the script's own.
 */
function SplitSection({ la, result, values, onValue }: { la: LineArtInfo; result: EvalResult; values: ParamValues; onValue: Props['onValue'] }) {
  const sp = la.split;
  const choice: SplitSpec | 'off' = parseLineArtSplit(values[LINEART_SPLIT_KEY]) ?? (sp ? parseSplitSpec(sp.spec) ?? 'off' : 'off');
  const mode = choice === 'off' ? 'off' : choice === 'auto' ? 'auto' : Array.isArray(choice) ? 'grid' : 'pieces';
  const set = (c: SplitSpec | 'off') => onValue(LINEART_SPLIT_KEY, formatSplitSpec(c));
  const [w, h] = la.size;
  const guess: [number, number] = sp ? [sp.cols, sp.rows] : [w > maxPiece() ? Math.ceil(w / (maxPiece() - 24)) : 1, h > maxPiece() ? Math.ceil(h / (maxPiece() - 24)) : 1];
  const grid: [number, number] = Array.isArray(choice) ? choice : guess;
  const count = typeof choice === 'number' ? choice : Math.max(2, guess[0] * guess[1]);
  // The size typed here (before the design's overall scale, which applies to it too).
  const scale = Number(values[SCALE_KEY] ?? 1) || 1;
  const userSize = !!parseLineArtSize(values[LINEART_SIZE_KEY]);
  // The list of pieces: folded unless opened (remembered).
  const [listOpen, setListOpen] = useState<boolean>(() => load('lineArtPiecesOpen', false));
  useEffect(() => store('lineArtPiecesOpen', listOpen), [listOpen]);
  const [notesOpen, setNotesOpen] = useState<boolean>(() => load('lineArtNotesOpen', false));
  useEffect(() => store('lineArtNotesOpen', notesOpen), [notesOpen]);
  // Pieces beyond the grid's cells: bits too far from the rest of their cell (A2b…), and the join that decides it.
  const loose = sp ? sp.pieces.filter((p) => /[a-z]$/.test(p.label)) : [];
  // Cells that make no piece of their own: empty, or a strip of frame joined to the one beside it.
  const used = sp ? sp.pieces.length - loose.length : 0, spare = sp ? sp.cols * sp.rows - used : 0;
  const spareNote = `${spare} empty or joined to the one beside`;
  const userJoin = parseLineArtJoin(values[LINEART_JOIN_KEY]) != null;
  const join = parseLineArtJoin(values[LINEART_JOIN_KEY]) ?? DEFAULT_SPLIT_JOIN;
  // The size boxes: locked (the default, remembered), one side follows the other at the drawing's
  // proportions. A typed size shows at once and stays until the rebuild brings the piece's own.
  const [lock, setLock] = useState<boolean>(() => load('lineArtSizeLock', true));
  useEffect(() => store('lineArtSizeLock', lock), [lock]);
  const [typed, setTyped] = useState<[number, number] | null>(null);
  useEffect(() => setTyped(null), [w, h]);
  const [sw, sh] = typed ?? [w, h];
  const ratio = w / h || 1;
  const setSize = (nw: number, nh: number) => {
    nw = Math.min(MAX_LINEART_SIZE, nw); nh = Math.min(MAX_LINEART_SIZE, nh);
    setTyped([nw, nh]);
    onValue(LINEART_SIZE_KEY, formatLineArtSize(lock ? { width: nw / scale } : { width: nw / scale, height: nh / scale }));
  };
  const bed = printer().bed[0];
  const over = (p: { size: [number, number] }) => p.size[0] > printer().bed[0] || p.size[1] > printer().bed[1];
  const tooBig = sp ? sp.pieces.filter(over) : [];
  const crossings = sp ? sp.seams.reduce((n, m) => n + m.crossings, 0) : 0;
  const unnamed = sp ? sp.pieces.filter((p) => !p.labelSize) : [];
  const apart = sp?.pieces.find((p) => /[a-z]$/.test(p.label));
  const radio = (on: boolean) => ({ role: 'radio', className: on ? 'on' : '', 'aria-checked': on });
  return (
    <div className="lineart-split">
      <div className="lineart-split-row">
        <span className="dim small">Split into pieces</span>
        <div className="seg" role="radiogroup" aria-label="Split into pieces">
          <button {...radio(mode === 'off')} onClick={() => set('off')} title="One piece">Off</button>
          <button {...radio(mode === 'auto')} onClick={() => set('auto')} title={`The fewest pieces that each fit the ${bed} mm bed`}>Auto</button>
          <button {...radio(mode === 'pieces')} onClick={() => set(count)} title="A number of pieces">Pieces</button>
          <button {...radio(mode === 'grid')} onClick={() => set(grid[0] * grid[1] > 1 ? grid : [2, 1])} title="Columns × rows">Grid</button>
        </div>
      </div>
      {/* How many pieces it makes, at a glance. */}
      {sp && (
        <div className="lineart-split-summary">
          <span className="lineart-count">{sp.pieces.length} pieces</span>
          <span className="dim small">
            {loose.length
              ? <>{used} cells{spare > 0 && ` (${spareNote})`} + {loose.length} loose bit{loose.length > 1 ? 's' : ''} ({loose.map((p) => p.label).join(', ')}): too far from the rest of their cell to join</>
              : <>{sp.cols} × {sp.rows} grid{spare > 0 && `, ${spareNote}`}</>}
            {' · '}the biggest {Math.max(...sp.pieces.map((p) => p.size[0])).toFixed(0)} × {Math.max(...sp.pieces.map((p) => p.size[1])).toFixed(0)} mm
          </span>
        </div>
      )}
      {sp && (
        <label className="lineart-split-row small" title="The longest join added inside a piece to hold a bit of the drawing to the rest. Longer joins mean fewer loose pieces but visible struts on the wall.">
          <span className="dim">Longest join</span>
          <span className="lineart-split-grid">
            <NumBox value={join} min={5} max={300} label="Longest join, mm" onCommit={(v) => onValue(LINEART_JOIN_KEY, String(v))} />
            {userJoin && <button className="icon-btn" title={`Back to ${DEFAULT_SPLIT_JOIN} mm`} aria-label={`Back to ${DEFAULT_SPLIT_JOIN} mm`} onClick={() => onValue(LINEART_JOIN_KEY, '')}><Icon name="restore" size={12} /></button>}
          </span>
        </label>
      )}
      {mode === 'pieces' && (
        <label className="lineart-split-row small">
          <span className="dim">Pieces</span>
          <select value={count} onChange={(e) => set(Number(e.target.value))} aria-label="Number of pieces">
            {[...new Set([...PIECE_COUNTS, count])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
      {mode === 'grid' && (
        <div className="lineart-split-row small">
          <span className="dim">Columns × rows</span>
          <span className="lineart-split-grid">
            <select value={grid[0]} onChange={(e) => set([Number(e.target.value), grid[1]])} aria-label="Columns">
              {Array.from({ length: MAX_GRID }, (_, i) => <option key={i} value={i + 1} disabled={i === 0 && grid[1] === 1}>{i + 1}</option>)}
            </select>
            <span className="dim">×</span>
            <select value={grid[1]} onChange={(e) => set([grid[0], Number(e.target.value)])} aria-label="Rows">
              {Array.from({ length: MAX_GRID }, (_, i) => <option key={i} value={i + 1} disabled={i === 0 && grid[0] === 1}>{i + 1}</option>)}
            </select>
          </span>
        </div>
      )}
      <div className="lineart-split-row small">
        <span className="dim">Whole piece</span>
        <span className="lineart-split-grid">
          {/* The size typed here wins over the script's sliders (their limits too). Locked, the other side
              keeps the drawing's proportions (shown at once, before the rebuild); unlocked, both are set. */}
          <NumBox value={+sw.toFixed(1)} min={20} max={MAX_LINEART_SIZE} label={lock ? 'Width of the whole piece (the height follows)' : 'Width of the whole piece'} onCommit={(v) => setSize(v, lock ? v / ratio : sh)} />
          <button className={`icon-btn lineart-lock ${lock ? 'on' : ''}`} aria-pressed={lock} onClick={() => setLock(!lock)}
            title={lock ? 'Proportions locked: changing one side changes the other. Click to set width and height separately' : 'Width and height set separately (the drawing is fitted inside, never stretched). Click to keep the proportions'}
            aria-label={lock ? 'Unlock the proportions' : 'Lock the proportions'}><Icon name={lock ? 'link' : 'unlink'} size={13} /></button>
          <NumBox value={+sh.toFixed(1)} min={20} max={MAX_LINEART_SIZE} label={lock ? 'Height of the whole piece (the width follows)' : 'Height of the whole piece'} onCommit={(v) => setSize(lock ? v * ratio : sw, v)} />
          {userSize && <button className="icon-btn" title="Back to the suggested size" aria-label="Back to the suggested size" onClick={() => onValue(LINEART_SIZE_KEY, '')}><Icon name="restore" size={12} /></button>}
        </span>
      </div>
      {!sp && mode === 'off' && (w > bed || h > printer().bed[1]) && (
        <div className="lineart-edit-row small warn"><span><Icon name="alert" size={12} /> Bigger than the {bed} mm bed: Auto splits it into pieces that fit</span></div>
      )}
      {!sp && mode !== 'off' && <div className="dim small">It fits the bed in one piece.</div>}
      {sp && (
        <>
          <SplitPicture result={result} split={sp} />
          {/* The list of pieces folds away (a split can make dozens); folded, a piece too big still shows. */}
          <details className="lineart-pieces-fold" open={listOpen} onToggle={(e) => setListOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary className="small">
              Pieces ({sp.pieces.length}){!listOpen && tooBig.length > 0 && <span className="warn"> · {tooBig.length} bigger than the bed</span>}
            </summary>
            <ul className="lineart-pieces small">
              {sp.pieces.map((p) => (
                <li key={p.label} className={over(p) ? 'warn' : ''}>
                  <b className="mono">{p.label}</b>
                  <span className="mono">{p.size[0].toFixed(0)} × {p.size[1].toFixed(0)} mm</span>
                  <span className="dim">{[p.joints ? `${p.joints} dovetail${p.joints > 1 ? 's' : ''}` : '', p.labelSize ? 'named' : 'unnamed (no room)'].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          </details>
          {tooBig.length > 0 && <div className="lineart-edit-row small warn"><span><Icon name="alert" size={12} /> {tooBig.map((p) => p.label).join(', ')} {tooBig.length > 1 ? 'are' : 'is'} bigger than the {bed} mm bed: use more pieces</span></div>}
          {/* Notes on putting it up, folded by default (remembered); repeated ones merged. */}
          <details className="lineart-pieces-fold" open={notesOpen} onToggle={(e) => setNotesOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="small">Notes{!notesOpen && sp.noJoint.length > 0 && <span className="warn"> · no dovetail at {sp.noJoint.length} crossing{sp.noJoint.length > 1 ? 's' : ''}</span>}</summary>
          <ul className="litho-advice small">
            <li>The seams cut {crossings ? <><span className="mono">{crossings}</span> line{crossings > 1 ? 's' : ''}</> : 'no lines'}; lines just meet end to end on the wall{sp.joints.length ? <>, and <span className="mono">{sp.joints.length}</span> dovetail{sp.joints.length > 1 ? 's' : ''} lock the {la.style === 'framed' || la.style === 'medallion' ? 'frame' : 'bar'}</> : ''}.</li>
            {[...sp.noJoint.reduce((m, j) => m.set(j.why, (m.get(j.why) ?? 0) + 1), new Map<string, number>())].map(([why, n]) => (
              <li key={why} className="warn">No dovetail at {n > 1 ? `${n} crossings` : 'one crossing'}: {why}.</li>
            ))}
            {apart && <li>{apart.label} and its like are bits of a square too far apart to join: each goes up on its own.</li>}
            <li>Each piece prints on its own plate. {unnamed.length ? `Names are engraved on the backs where there is room (not on ${unnamed.map((p) => p.label).join(', ')}).` : 'Each name is engraved on its back.'}</li>
            <li>Put it up from the top left (A1), along each row: mark a level line, tape each piece up and push it against the last.</li>
          </ul>
          </details>
        </>
      )}
    </div>
  );
}

/** Piece colours in the layout picture, alternating like a chequerboard. */
const PIECE_INK = ['#1d1d1f', '#59606b'];
const SEAM = '#2f80d1';

/** The pieces as they go on the wall, seen from the front: alternating tints, the seams dashed, each piece's name. */
function SplitPicture({ result, split }: { result: EvalResult; split: LineArtSplitInfo }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setWidth(c.clientWidth));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current, ctx = c?.getContext('2d');
    if (!c || !ctx || !width) return;
    const boxes = split.pieces.map((p) => p.box);
    const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1])), x1 = Math.max(...boxes.map((b) => b[2])), y1 = Math.max(...boxes.map((b) => b[3]));
    const pad = 6, s = (width - 2 * pad) / Math.max(1e-6, x1 - x0), height = Math.round((y1 - y0) * s + 2 * pad), dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr); c.height = Math.round(height * dpr); c.style.height = `${height}px`;
    const X = (x: number) => pad + (x - x0) * s, Y = (y: number) => pad + (y1 - y) * s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(0, 0, width, height);
    // Each piece put back in its place: its faces looking up.
    for (const p of result.parts) {
      const pc = p.lineArt?.piece;
      if (!pc) continue;
      const info = split.pieces.find((q) => q.label === pc.label);
      const [dx, dy] = pc.offset, P = p.positions, I = p.indices, path = new Path2D();
      for (let t = 0; t + 2 < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, d = I[t + 2] * 3;
        if ((P[b] - P[a]) * (P[d + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[d] - P[a]) <= 1e-9) continue;
        path.moveTo(X(P[a] - dx), Y(P[a + 1] - dy)); path.lineTo(X(P[b] - dx), Y(P[b + 1] - dy)); path.lineTo(X(P[d] - dx), Y(P[d + 1] - dy)); path.closePath();
      }
      ctx.fillStyle = PIECE_INK[info ? (info.col + info.row) % 2 : 0];
      ctx.fill(path);
    }
    ctx.lineWidth = 1.2; ctx.strokeStyle = SEAM; ctx.setLineDash([4, 3]);
    // (Only where two pieces really meet.)
    for (const m of split.seams) for (const cut of m.cuts ?? [m.points]) {
      ctx.beginPath();
      cut.forEach(([x, y], i) => { if (i) ctx.lineTo(X(x), Y(y)); else ctx.moveTo(X(x), Y(y)); });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of split.pieces) {
      // (Inside the picture: a narrow strip of frame at its edge too.)
      const tw = ctx.measureText(p.label).width + 8;
      const cx = Math.min(width - tw / 2 - 1, Math.max(tw / 2 + 1, X((p.box[0] + p.box[2]) / 2))), cy = Math.min(height - 9, Math.max(9, Y((p.box[1] + p.box[3]) / 2)));
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'; ctx.strokeStyle = SEAM; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(cx - tw / 2, cy - 8, tw, 16, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#1d1d1f'; ctx.fillText(p.label, cx, cy + 0.5);
    }
  }, [result, split, width]);
  return <canvas ref={ref} className="lineart-split-picture" role="img" aria-label={`The ${split.pieces.length} pieces on the wall: ${split.pieces.map((p) => p.label).join(', ')}`} />;
}

/**
 * Join loose ends: on, a line held at one point only is joined to the nearest line within the
 * reach (so it can't lift off the wall); off, the drawing stays as traced. A design value
 * (LINEART_ENDS_KEY) that wins over the script's joinEnds.
 */
function LooseEnds({ la, values, onValue, onShowJoins }: { la: LineArtInfo; values: ParamValues; onValue: Props['onValue']; onShowJoins: Props['onShowJoins'] }) {
  const user = parseLineArtEnds(values[LINEART_ENDS_KEY]);
  // The reach set here shows at once; else the one the build used (the script's joinEnds).
  const reach = user ?? la.joinEnds ?? DEFAULT_JOIN_ENDS;
  const on = reach > 0;
  // Where they are, in the 3D view while this section is open: on unless turned off (remembered).
  const [show, setShow] = useState<boolean>(() => load('lineArtShowJoins', true));
  useEffect(() => store('lineArtShowJoins', show), [show]);
  useEffect(() => { onShowJoins?.(show); return () => onShowJoins?.(false); }, [show, onShowJoins]);
  return (
    <div className="lineart-ends">
      <div className="lineart-split-row small">
        <label className="switch">
          <input type="checkbox" checked={on} onChange={(e) => onValue(LINEART_ENDS_KEY, e.target.checked ? String(DEFAULT_JOIN_ENDS) : '0')} />
          <span className="track" />
          <span className="switch-label">Join loose ends</span>
        </label>
        <span className="lineart-split-grid">
          {on && <NumBox value={reach} min={1} max={50} label="How far a loose end reaches to join a line" onCommit={(v) => onValue(LINEART_ENDS_KEY, String(Math.max(1, Math.round(v * 2) / 2)))} />}
          {user != null && <button className="icon-btn" title="Back to the suggested reach" aria-label="Back to the suggested reach" onClick={() => onValue(LINEART_ENDS_KEY, '')}><Icon name="restore" size={12} /></button>}
        </span>
      </div>
      <span className="dim small">A line that hangs by one end is joined to the nearest line within this distance, so nothing lifts off the wall. Off: the drawing exactly as traced; loose ends may need a dot of glue.</span>
      {(la.endsJoined > 0 || la.endsFree > 0) && (
        <label className="switch small" title="An added join that is not in the drawing can be erased with Edit drawing (the brush at the bottom right of the 3D view)">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          <span className="track" />
          <span className="switch-label">Show in the 3D view: <span className="lineart-key join" /> joined{la.endsFree > 0 && <>, <span className="lineart-key loose" /> loose</>}</span>
        </label>
      )}
    </div>
  );
}

/**
 * Print tab, Line art section: the drawing(s) the piece was made from, what was fixed (bridges,
 * dropped specks) and how to print and hang it. Sizes are the script's sliders (Parameters).
 */
export function LineArtPanel({ part, result, values, onEdits, onValue, onShowJoins }: Props) {
  const drawings = useMemo(() => parseDrawings(values[DRAWINGS_KEY]), [values[DRAWINGS_KEY]]);
  const edits = useMemo(() => parseLineArtEdits(values[LINEART_EDITS_KEY]), [values[LINEART_EDITS_KEY]]);
  const la = part.lineArt;
  const stale = staleEdits(edits, la.frames);
  const erased = la.frames.some((f) => edits[f.name]?.fp === f.fp && edits[f.name].strokes.some((st) => st.mode === 'erase'));
  // With colours, the piece is it and its coloured parts together.
  const components = la.components ?? part.components;
  const colours = la.colours ?? [];
  // Each coloured piece's colours and how deep they go (split: each piece's own).
  const paints = result.parts.flatMap((p) => (p.lineArt?.paint && !p.lineArt.paintedIn ? [p.lineArt.paint] : []));
  const [w, h] = la.size;
  const bed = printer().name.replace(/^Bambu Lab /, '');
  // Split, each piece must fit the bed (the pieces list says which don't).
  const tooBig = !la.split && (w > printer().bed[0] || h > printer().bed[1]);
  const loose = la.bridges > MANY_BRIDGES || la.longestBridge > LONG_BRIDGE;
  // Lines closer together than the print keeps apart merge into blotches.
  const blotchy = la.closed > Math.max(3, la.openings * BLOTCHY_SHARE);
  const mm = (v: number) => `${v.toFixed(1)} mm`;
  return (
    <div className="lineart-panel">
      {la.sources.length > 0 && (
        <div className="lineart-sources">
          {la.sources.map((name) => (
            <figure key={name} className="lineart-fig">
              {drawings[name] ? <DrawingPreview drawing={drawings[name]} /> : <div className="lineart-nodrawing small">Not stored with this design</div>}
              <figcaption className="lineart-cap" title={name}>{name}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="lineart-edit">
        {la.edits > 0 && (
          <div className="lineart-edit-row small">
            <span><span className="mono">{la.edits}</span> hand edit{la.edits === 1 ? '' : 's'}</span>
            <button className="link" onClick={() => onEdits((e) => withoutDrawings(e, la.frames.filter((f) => e[f.name]?.fp === f.fp).map((f) => f.name)), 'Cleared edits')}>Clear edits</button>
          </div>
        )}
        {stale.strokes > 0 && (
          <div className="lineart-edit-row small warn">
            <span><Icon name="alert" size={12} /> {stale.strokes} edit{stale.strokes === 1 ? ' was' : 's were'} made on an earlier drawing</span>
            <button className="link" onClick={() => onEdits((e) => withoutDrawings(e, stale.names), 'Cleared edits made on an earlier drawing')}>Clear</button>
          </div>
        )}
        {components > 1 && (
          <div className="lineart-edit-row small warn">
            <span><Icon name="alert" size={12} /> The piece is in {components} pieces{erased ? ': an erase cut it apart' : ''}</span>
          </div>
        )}
      </div>
      <dl className="lineart-facts small">
        <dt>Style</dt><dd>{LINE_ART_STYLE_INFO[la.style].label}</dd>
        <dt>Size</dt>
        <dd className={tooBig ? 'warn' : ''}>
          <span className="mono">{w.toFixed(0)} × {h.toFixed(0)} mm</span>
          {tooBig && <span className="lineart-why"><Icon name="alert" size={12} /> bigger than the {bed}'s bed ({printer().bed[0]} mm): split it into pieces below</span>}
          {la.split && <> in <b>{la.split.pieces.length} pieces</b></>}
        </dd>
        <dt>Thickness</dt><dd className="mono">{mm(la.thickness)}</dd>
        <dt>Lines</dt><dd><span className="mono">{mm(la.lineWidth)}</span>, {la.lines === 'even' ? 'even' : 'kept (thin ones thickened)'}</dd>
        <dt>Bridges</dt>
        <dd className={loose ? 'warn' : ''}>
          {la.bridges ? <><span className="mono">{la.bridges}</span> added, longest <span className="mono">{mm(la.longestBridge)}</span></> : 'none needed'}
          {loose && <span className="lineart-why"><Icon name="alert" size={12} /> ask for a more connected drawing</span>}
        </dd>
        <dt>Specks</dt><dd>{la.dropped ? <><span className="mono">{la.dropped}</span> dropped (too small to print)</> : 'none dropped'}</dd>
        {(la.fillsLoose ?? 0) > 0 && (
          <><dt>Fills</dt><dd className="warn"><span className="mono">{la.fillsLoose}</span> left out<span className="lineart-why"><Icon name="alert" size={12} /> filled where it touched nothing of the piece, so it would fall off: fill up to a line (Edit drawing)</span></dd></>
        )}
        <dt>Loose lines</dt>
        <dd className={la.endsFree && la.joinEnds !== 0 ? 'warn' : ''}>
          {la.endsJoined ? <><span className="mono">{la.endsJoined}</span> joined to a nearby line</> : la.endsFree ? null : 'none dangling'}
          {la.endsFree > 0 && la.joinEnds === 0 && <span className="lineart-why">{la.endsFree} held at one point only, left as drawn (Join loose ends is off): a dot of glue holds them</span>}
          {la.endsFree > 0 && la.joinEnds !== 0 && <span className="lineart-why"><Icon name="alert" size={12} /> {la.endsFree} still held at one point only: they can lift off the wall; ask for a redraw with every line ending on another</span>}
        </dd>
        <dt>Detail</dt>
        <dd className={blotchy ? 'warn' : ''}>
          {la.closed ? <><span className="mono">{la.closed}</span> of <span className="mono">{la.openings}</span> gaps between lines closed up</> : 'every gap between lines kept'}
          {blotchy && <span className="lineart-why"><Icon name="alert" size={12} /> too fine for this size: ask for a bolder, simpler drawing, or make it larger</span>}
        </dd>
        {la.hooks > 0 && <><dt>Pegs</dt><dd className="mono">{la.hooks}</dd></>}
        {colours.length > 0 && (
          <>
            <dt>Colours</dt>
            <dd className={colours.length + 1 > amsSlots() ? 'warn' : ''}>
              <span className="lineart-colours">
                {colours.map((f) => <span key={`${f.color}${f.name ?? ''}`} className="lineart-colour" title={f.brand ? `${f.brand} ${f.name ?? f.color}` : f.name ?? f.color}><span className="swatch" style={{ background: f.color }} />{f.name ?? f.color}</span>)}
              </span>
              <button className="link" onClick={() => onEdits((e) => withoutColours(e, la.frames.filter((f) => e[f.name]?.fp === f.fp).map((f) => f.name)), 'Removed colours')} title="Every line back in the piece's own filament">Remove colours</button>
              {colours.length + 1 > amsSlots() && <span className="lineart-why"><Icon name="alert" size={12} /> {colours.length + 1} filaments with the piece's own: the {shortName()} loads {amsSlots()} at once, the rest are swapped by hand</span>}
              {paints.length > 0 && <ColourDepthRow paints={paints} base={part.color} values={values} onValue={onValue} />}
            </dd>
          </>
        )}
      </dl>
      <LooseEnds la={la} values={values} onValue={onValue} onShowJoins={onShowJoins} />
      <SplitSection la={la} result={result} values={values} onValue={onValue} />
      <ul className="litho-advice small">
        <li><b>Print flat</b>, back down, {colours.length ? `in ${colours.length + 1} filaments: ${(parseLineArtDepth(values[LINEART_DEPTH_KEY]) ?? 'through') === 'through' ? 'the colours go all the way through, so the AMS changes filament on every layer' : 'the colours are only the top layers, so the AMS changes filament on those layers only'} (the Cost tab counts the swaps and the prime tower)` : 'in one colour (black PLA)'}; no brim.</li>
        <li>{la.style === 'stand' ? "Push the piece into the base's slot." : 'Hang with double-sided tape or Command strips.'}</li>
      </ul>
    </div>
  );
}
