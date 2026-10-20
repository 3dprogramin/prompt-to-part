import { useEffect, useMemo, useRef, useState } from 'react';
import type { EvalResult, ParamValue, ParamValues, PartMesh } from '../../shared/types';
import { LINE_ART_STYLE_INFO, LINEART_EDITS_KEY, LINEART_SPLIT_KEY, parseLineArtEdits, parseLineArtSplit, type LineArtEdits, type LineArtInfo, type LineArtSplitInfo } from '../../shared/lineart';
import { formatSplitSpec, MAX_PIECE, parseSplitSpec, type SplitSpec } from '../../shared/split';
import { NumBox } from './NumBox';
import { staleEdits, withoutDrawings } from '../lib/lineArtEdit';
import { DRAWINGS_KEY, parseDrawings, type SvgDrawing } from '../../shared/svgFeatures';
import { PRINTER } from '../../shared/printer';
import { Icon } from './Icon';

/** A line-art part (H.lineart): its style, drawings and what Jig fixed. */
type LineArtPart = PartMesh & { lineArt: LineArtInfo };

/** The first part of the model that is line art, if any. */
export function lineArtPart(result: EvalResult | null): LineArtPart | undefined {
  return result?.parts.find((p): p is LineArtPart => !!p.lineArt);
}

/**
 * The line art as one part on the wall: a piece split into pieces has them put back where they go
 * (each moved back by its layout offset) and merged, for the editor; otherwise the part itself.
 */
export function assembledLineArt(result: EvalResult | null): LineArtPart | undefined {
  const first = lineArtPart(result);
  if (!first?.lineArt.split || !result) return first;
  const pieces = result.parts.filter((p): p is LineArtPart => !!p.lineArt?.piece);
  const n = pieces.reduce((a, p) => a + p.positions.length, 0), m = pieces.reduce((a, p) => a + p.indices.length, 0);
  const positions = new Float32Array(n), indices = new Uint32Array(m);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let pv = 0, pi = 0;
  for (const p of pieces) {
    const [dx, dy] = p.lineArt.piece!.offset;
    for (let k = 0; k < p.positions.length; k += 3) {
      const x = p.positions[k] - dx, y = p.positions[k + 1] - dy, z = p.positions[k + 2];
      positions[pv + k] = x; positions[pv + k + 1] = y; positions[pv + k + 2] = z;
      min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
    }
    for (let k = 0; k < p.indices.length; k++) indices[pi + k] = p.indices[k] + pv / 3;
    pv += p.positions.length; pi += p.indices.length;
  }
  // Every piece should be one piece: the most any is in.
  return { ...first, positions, indices, bbox: { min, max }, components: Math.max(...pieces.map((p) => p.components)) };
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
  onEdits: (update: (edits: LineArtEdits) => LineArtEdits) => void;
  /** Open the editor (the Edit drawing brush). */
  onEdit: () => void;
  /** Set a parameter or design value (the size, the split). */
  onValue: (key: string, v: ParamValue) => void;
}

/** Pieces to choose from, and the most columns or rows of a grid. */
const PIECE_COUNTS = [2, 3, 4, 6, 8, 9, 10, 12, 15, 16, 20, 24, 30, 36];
const MAX_GRID = 10;
/** About how big a piece Auto makes, to guess a count before the model is split (mm). */
const AUTO_ROOM = MAX_PIECE - 24;

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
  const guess: [number, number] = sp ? [sp.cols, sp.rows] : [w > MAX_PIECE ? Math.ceil(w / AUTO_ROOM) : 1, h > MAX_PIECE ? Math.ceil(h / AUTO_ROOM) : 1];
  const grid: [number, number] = Array.isArray(choice) ? choice : guess;
  const count = typeof choice === 'number' ? choice : Math.max(2, guess[0] * guess[1]);
  // The size: the script's width and height parameters when it has them.
  const num = (k: string) => (result.params[k]?.type === 'number' || result.params[k]?.type === 'integer' ? Number(result.values[k]) : null);
  const pw = num('width'), ph = num('height');
  const bed = PRINTER.bed[0];
  const over = (p: { size: [number, number] }) => p.size[0] > PRINTER.bed[0] || p.size[1] > PRINTER.bed[1];
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
          {pw != null ? <NumBox value={pw} min={20} max={3000} label="Width of the whole piece" onCommit={(v) => onValue('width', v)} /> : <span className="mono">{w.toFixed(0)} mm</span>}
          <span className="dim">×</span>
          {ph != null ? <NumBox value={ph} min={5} max={3000} label="Most height of the whole piece" onCommit={(v) => onValue('height', v)} /> : <span className="mono" title="Follows the drawing's proportions">{h.toFixed(0)} mm</span>}
        </span>
      </div>
      {!sp && mode === 'off' && (w > bed || h > PRINTER.bed[1]) && (
        <div className="lineart-edit-row small warn"><span><Icon name="alert" size={12} /> Bigger than the {bed} mm bed: Auto splits it into pieces that fit</span></div>
      )}
      {!sp && mode !== 'off' && <div className="dim small">It fits the bed in one piece.</div>}
      {sp && (
        <>
          <SplitPicture result={result} split={sp} />
          <ul className="lineart-pieces small">
            {sp.pieces.map((p) => (
              <li key={p.label} className={over(p) ? 'warn' : ''}>
                <b className="mono">{p.label}</b>
                <span className="mono">{p.size[0].toFixed(0)} × {p.size[1].toFixed(0)} mm</span>
                <span className="dim">{[p.joints ? `${p.joints} dovetail${p.joints > 1 ? 's' : ''}` : '', p.labelSize ? 'name on the back' : 'no room for its name'].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
          {tooBig.length > 0 && <div className="lineart-edit-row small warn"><span><Icon name="alert" size={12} /> {tooBig.map((p) => p.label).join(', ')} {tooBig.length > 1 ? 'are' : 'is'} bigger than the {bed} mm bed: use more pieces</span></div>}
          <ul className="litho-advice small">
            <li>The seams cut {crossings ? <><span className="mono">{crossings}</span> line{crossings > 1 ? 's' : ''}</> : 'no lines'}; lines just meet end to end on the wall{sp.joints.length ? <>, and <span className="mono">{sp.joints.length}</span> dovetail{sp.joints.length > 1 ? 's' : ''} lock the {la.style === 'framed' || la.style === 'medallion' ? 'frame' : 'bar'}</> : ''}.</li>
            {sp.noJoint.map((j, i) => <li key={i} className="warn">No dovetail at one crossing: {j.why}.</li>)}
            {apart && <li>{apart.label} and its like are bits of a square too far apart to join: each goes up on its own.</li>}
            <li>Each piece prints on its own plate. {unnamed.length ? `Names are engraved on the backs where there is room (not on ${unnamed.map((p) => p.label).join(', ')}).` : 'Each name is engraved on its back.'}</li>
            <li>Put it up from the top left (A1), along each row: mark a level line, tape each piece up and push it against the last.</li>
          </ul>
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
    for (const m of split.seams) {
      ctx.beginPath();
      m.points.forEach(([x, y], i) => { if (i) ctx.lineTo(X(x), Y(y)); else ctx.moveTo(X(x), Y(y)); });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of split.pieces) {
      const cx = X((p.box[0] + p.box[2]) / 2), cy = Y((p.box[1] + p.box[3]) / 2), tw = ctx.measureText(p.label).width + 8;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'; ctx.strokeStyle = SEAM; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(cx - tw / 2, cy - 8, tw, 16, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#1d1d1f'; ctx.fillText(p.label, cx, cy + 0.5);
    }
  }, [result, split, width]);
  return <canvas ref={ref} className="lineart-split-picture" role="img" aria-label={`The ${split.pieces.length} pieces on the wall: ${split.pieces.map((p) => p.label).join(', ')}`} />;
}

/**
 * Print tab, Line art section: the drawing(s) the piece was made from, what Jig fixed (bridges,
 * dropped specks) and how to print and hang it. Sizes are the script's sliders (Parameters).
 */
export function LineArtPanel({ part, result, values, onEdits, onEdit, onValue }: Props) {
  const drawings = useMemo(() => parseDrawings(values[DRAWINGS_KEY]), [values[DRAWINGS_KEY]]);
  const edits = useMemo(() => parseLineArtEdits(values[LINEART_EDITS_KEY]), [values[LINEART_EDITS_KEY]]);
  const la = part.lineArt;
  const stale = staleEdits(edits, la.frames);
  const erased = la.frames.some((f) => edits[f.name]?.fp === f.fp && edits[f.name].strokes.some((st) => st.mode === 'erase'));
  const [w, h] = la.size;
  const bed = PRINTER.name.replace(/^Bambu Lab /, '');
  // Split, each piece must fit the bed (the pieces list says which don't).
  const tooBig = !la.split && (w > PRINTER.bed[0] || h > PRINTER.bed[1]);
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
        <button className="btn wide" onClick={onEdit} disabled={!la.frames.length} title={la.frames.length ? 'Draw or erase on the piece by hand (B draw, E erase)' : 'Rebuild the model to edit it'}>
          <Icon name="brush" size={14} /> Edit drawing
        </button>
        {la.edits > 0 && (
          <div className="lineart-edit-row small">
            <span><span className="mono">{la.edits}</span> hand edit{la.edits === 1 ? '' : 's'}</span>
            <button className="link" onClick={() => onEdits((e) => withoutDrawings(e, la.frames.filter((f) => e[f.name]?.fp === f.fp).map((f) => f.name)))}>Clear edits</button>
          </div>
        )}
        {stale.strokes > 0 && (
          <div className="lineart-edit-row small warn">
            <span><Icon name="alert" size={12} /> {stale.strokes} edit{stale.strokes === 1 ? ' was' : 's were'} made on an earlier drawing</span>
            <button className="link" onClick={() => onEdits((e) => withoutDrawings(e, stale.names))}>Clear</button>
          </div>
        )}
        {part.components > 1 && (
          <div className="lineart-edit-row small warn">
            <span><Icon name="alert" size={12} /> The piece is in {part.components} pieces{erased ? ' – an erase cut it apart' : ''}</span>
          </div>
        )}
      </div>
      <dl className="lineart-facts small">
        <dt>Style</dt><dd>{LINE_ART_STYLE_INFO[la.style].label}</dd>
        <dt>Size</dt>
        <dd className={tooBig ? 'warn' : ''}>
          <span className="mono">{w.toFixed(0)} × {h.toFixed(0)} mm</span>
          {tooBig && <span className="lineart-why"><Icon name="alert" size={12} /> bigger than the {bed}'s bed ({PRINTER.bed[0]} mm): split it into pieces below</span>}
          {la.split && <span className="dim"> in {la.split.pieces.length} pieces</span>}
        </dd>
        <dt>Thickness</dt><dd className="mono">{mm(la.thickness)}</dd>
        <dt>Lines</dt><dd><span className="mono">{mm(la.lineWidth)}</span>, {la.lines === 'even' ? 'even' : 'kept (thin ones thickened)'}</dd>
        <dt>Bridges</dt>
        <dd className={loose ? 'warn' : ''}>
          {la.bridges ? <><span className="mono">{la.bridges}</span> added, longest <span className="mono">{mm(la.longestBridge)}</span></> : 'none needed'}
          {loose && <span className="lineart-why"><Icon name="alert" size={12} /> ask Jig for a more connected drawing</span>}
        </dd>
        <dt>Specks</dt><dd>{la.dropped ? <><span className="mono">{la.dropped}</span> dropped (too small to print)</> : 'none dropped'}</dd>
        <dt>Loose lines</dt>
        <dd className={la.endsFree ? 'warn' : ''}>
          {la.endsJoined ? <><span className="mono">{la.endsJoined}</span> joined to a nearby line</> : la.endsFree ? null : 'none dangling'}
          {la.endsFree > 0 && <span className="lineart-why"><Icon name="alert" size={12} /> {la.endsFree} still held at one point only: they can lift off the wall – ask Jig to redraw with every line ending on another</span>}
        </dd>
        <dt>Detail</dt>
        <dd className={blotchy ? 'warn' : ''}>
          {la.closed ? <><span className="mono">{la.closed}</span> of <span className="mono">{la.openings}</span> gaps between lines closed up</> : 'every gap between lines kept'}
          {blotchy && <span className="lineart-why"><Icon name="alert" size={12} /> too fine for this size: ask Jig for a bolder, simpler drawing, or make it larger</span>}
        </dd>
        {la.hooks > 0 && <><dt>Pegs</dt><dd className="mono">{la.hooks}</dd></>}
      </dl>
      <SplitSection la={la} result={result} values={values} onValue={onValue} />
      <ul className="litho-advice small">
        <li><b>Print flat</b>, back down, in one colour (black PLA); no brim.</li>
        <li>{la.style === 'stand' ? "Push the piece into the base's slot." : 'Hang with double-sided tape or Command strips.'}</li>
      </ul>
    </div>
  );
}
