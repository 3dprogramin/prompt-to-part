import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParamValues, PartMesh } from '../../shared/types';
import { FILL_WIDTH, LINEART_DEPTH_KEY, LINEART_EDITS_KEY, MAX_LINEART_STROKES, parseLineArtDepth, parseLineArtEdits, squareOutlines, type LineArtEdits, type LineArtInfo, type LineArtPaint, type LineArtStroke } from '../../shared/lineart';
import { colourCost, depthLabel } from './LineArtPanel';
import { DRAWINGS_KEY, parseDrawings } from '../../shared/svgFeatures';
import { SCALE_KEY, type PartFilament } from '../../shared/params';
import { addStroke, clearArea, frameAt, inkAt, leanStroke, niceLength, removeStroke, sameFilament, snapEnd, staleEdits, strokeFilaments, strokesOf, toDrawing, withoutDrawings, type InkMask } from '../lib/lineArtEdit';
import { useLayoutMode } from '../hooks/useLayoutMode';
import { useEscape } from './useEscape';
import { Icon } from './Icon';
import { FilamentPicker } from './FilamentPicker';

type Pt = [number, number];
type Tool = 'draw' | 'erase' | 'paint' | 'fill' | 'clear';
/** A step of this session, for Undo / Redo: a stroke added, edits cleared, or cleared where selected (the selection it cleared kept for Undo). */
type Op = { kind: 'add'; name: string; fp: string; stroke: LineArtStroke; shown: ShownStroke } | { kind: 'clear'; names: string[]; before: LineArtEdits; shown: ShownStroke[] }
  | { kind: 'here'; names: string[]; before: LineArtEdits; after: LineArtEdits; shown: ShownStroke[]; selection: ShownStroke[] };
/**
 * A stroke of this session on the screen (mm, the piece's XY), drawn over the piece: it is only
 * built when the editor closes with Done. `src` is the stroke as saved; `color` its filament's
 * (none: the piece's own). A 'clear' one is where edits were cleared (the piece as Jig made it shows there).
 * `shape` 'square': brushed with a square `width` wide.
 */
interface ShownStroke { mode: Tool; width: number; points: Pt[]; name?: string; src?: LineArtStroke; live?: boolean; color?: string; shape?: 'square' }

/** Brush widths (mm): draw, erase, paint, fill, and the selection to clear edits in. */
const WIDTH = { draw: { min: 0.6, max: 5 }, erase: { min: 1, max: 15 }, paint: { min: 0.5, max: 15 }, fill: { min: 0.5, max: 15 }, clear: { min: 1, max: 50 } };
/** Paint shows only on the piece, a fill only off it. */
const masked = (mode: Tool) => mode === 'paint' || mode === 'fill';
/** Strokes put together off screen (composed): those masked, and where edits were cleared. */
const composite = (mode: Tool) => masked(mode) || mode === 'clear';
/** Snap within this many mm of the ink (and at least SNAP_PX screen pixels). */
const SNAP_MM = 1.5;
const SNAP_PX = 10;
/** The piece's colour on the white page, and the bar, frame or pegs (raised above the lines) a little lighter. */
const INK = '#141414';
const RAISED = ['#3a3d42', '#6a6e75'];
const ERASE = 'rgba(229, 103, 95, 0.5)';
/** The area selected to clear edits in, see-through over the piece, and the brush's ring. */
const SELECT = ['#3d8bfd', 0.35] as const;
const SELECT_RING = '#1f6fe0';
/** The seams of a piece split into pieces. */
const SEAM = '#2f80d1';
/** Where Jig joined a loose end to a line, and the loose ends left (as in the 3D view). */
const JOIN = ['#ff4fd8', '#ffb020'];
const PAPER = '#fff';
/** The hit-test grid: this many mm per cell at least, and at most this many cells. */
const MASK_RES = 0.05;
const MASK_CELLS = 8_000_000;
/** The largest zoom, screen pixels per mm. */
const MAX_ZOOM = 400;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** A stroke (mm) in `color`, on a context set to mm. */
function strokeOn(ctx: CanvasRenderingContext2D, st: ShownStroke, color: string) {
  ctx.fillStyle = ctx.strokeStyle = color;
  if (st.shape === 'square') {
    // The outlines the piece is built with.
    ctx.beginPath();
    for (const c of squareOutlines([st.points], st.width / 2)) { c.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
    ctx.fill('nonzero');
    return;
  }
  if (st.points.length === 1 || st.points.every((p) => p[0] === st.points[0][0] && p[1] === st.points[0][1])) {
    ctx.beginPath(); ctx.arc(st.points[0][0], st.points[0][1], st.width / 2, 0, 2 * Math.PI); ctx.fill();
    return;
  }
  ctx.lineWidth = st.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

/**
 * The piece seen from above, ready to draw: its up-facing triangles as paths (all of them in INK,
 * then those raised above the lines lighter, by height, and the lines in other filaments in
 * theirs: `paints`, ranges of its triangles), a bitmap of it for quick pans and zooms, and its ink
 * on a grid for snapping.
 */
function pieceImage(part: PartMesh & { paints?: { color: string; from: number; to: number }[] }, thickness: number) {
  const P = part.positions, I = part.indices;
  const all = new Path2D();
  const raised = new Map<number, Path2D>();
  const colours = new Map<string, Path2D>();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1], cx = P[c], cy = P[c + 1];
    // Facing up (counter-clockwise seen from above): the walls and the back are left out.
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) <= 1e-9) continue;
    all.moveTo(ax, ay); all.lineTo(bx, by); all.lineTo(cx, cy); all.closePath();
    const paint = part.paints?.find((r) => t >= r.from && t < r.to);
    if (paint) {
      let p = colours.get(paint.color);
      if (!p) colours.set(paint.color, (p = new Path2D()));
      p.moveTo(ax, ay); p.lineTo(bx, by); p.lineTo(cx, cy); p.closePath();
    }
    const z = Math.max(P[a + 2], P[b + 2], P[c + 2]);
    if (!paint && z > thickness + 0.05) {
      const k = Math.round(z * 2) / 2;
      let p = raised.get(k);
      if (!p) raised.set(k, (p = new Path2D()));
      p.moveTo(ax, ay); p.lineTo(bx, by); p.lineTo(cx, cy); p.closePath();
    }
    x0 = Math.min(x0, ax, bx, cx); x1 = Math.max(x1, ax, bx, cx);
    y0 = Math.min(y0, ay, by, cy); y1 = Math.max(y1, ay, by, cy);
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  const zs = [...raised.keys()].sort((a, b) => a - b);
  const lo = zs[0] ?? 0, hi = zs[zs.length - 1] ?? 1;
  const mix = (z: number) => {
    const t = hi > lo ? (z - lo) / (hi - lo) : 0;
    const [r0, g0, b0] = [1, 3, 5].map((i) => parseInt(RAISED[0].slice(i, i + 2), 16));
    const [r1, g1, b1] = [1, 3, 5].map((i) => parseInt(RAISED[1].slice(i, i + 2), 16));
    return `rgb(${Math.round(r0 + (r1 - r0) * t)}, ${Math.round(g0 + (g1 - g0) * t)}, ${Math.round(b0 + (b1 - b0) * t)})`;
  };
  const layers = [{ path: all, color: INK }, ...zs.map((z) => ({ path: raised.get(z)!, color: mix(z) })), ...[...colours].map(([color, path]) => ({ path, color }))];
  const fill = (ctx: CanvasRenderingContext2D) => { for (const l of layers) { ctx.fillStyle = l.color; ctx.fill(l.path); } };

  // The bitmap, also the ink grid (a cell is ink where the piece covers most of it).
  const res = Math.max(MASK_RES, Math.sqrt(((x1 - x0) * (y1 - y0)) / MASK_CELLS));
  const w = Math.ceil((x1 - x0) / res) + 2, h = Math.ceil((y1 - y0) / res) + 2;
  const mx0 = x0 - res, my1 = y1 + res;
  const bitmap = document.createElement('canvas');
  bitmap.width = w; bitmap.height = h;
  const bctx = bitmap.getContext('2d', { willReadFrequently: true })!;
  bctx.setTransform(1 / res, 0, 0, -1 / res, -mx0 / res, my1 / res);
  fill(bctx);
  const px = bctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  const mask: InkMask = { data, w, h, x0: mx0, y1: my1, res };
  return { fill, bitmap, mask, box: { x0, y0, x1, y1 } };
}

/**
 * A stroke stamped into the ink grid: a drawn line or a fill adds ink (all under it is ink then),
 * erasing takes it away (paint changes none), clearing puts the ink of the piece as Jig made it
 * back (`own`, when it is known).
 */
function stamp(m: InkMask, st: ShownStroke, own?: InkMask | null) {
  if (st.mode === 'paint' || (st.mode === 'clear' && !own)) return;
  const r = st.width / 2 / m.res, v = st.mode === 'erase' ? 0 : 1;
  const set = (x: number, y: number) => { m.data[y * m.w + x] = st.mode === 'clear' ? (inkAt(own!, [m.x0 + (x + 0.5) * m.res, m.y1 - (y + 0.5) * m.res]) ? 1 : 0) : v; };
  if (st.shape === 'square') {
    // A square brush: the cells inside its outlines (mm, counter-clockwise).
    for (const c of squareOutlines([st.points], st.width / 2)) {
      const x0 = Math.max(0, Math.floor((Math.min(...c.map((p) => p[0])) - m.x0) / m.res)), x1 = Math.min(m.w - 1, Math.ceil((Math.max(...c.map((p) => p[0])) - m.x0) / m.res));
      const y0 = Math.max(0, Math.floor((m.y1 - Math.max(...c.map((p) => p[1]))) / m.res)), y1 = Math.min(m.h - 1, Math.ceil((m.y1 - Math.min(...c.map((p) => p[1]))) / m.res));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = m.x0 + (x + 0.5) * m.res, py = m.y1 - (y + 0.5) * m.res;
        if (c.every(([ax, ay], k) => { const [bx, by] = c[(k + 1) % c.length]; return (bx - ax) * (py - ay) - (by - ay) * (px - ax) >= 0; })) set(x, y);
      }
    }
    return;
  }
  const px = st.points.map(([x, y]): Pt => [(x - m.x0) / m.res, (m.y1 - y) / m.res]);
  const segs = px.length === 1 ? [[px[0], px[0]]] : px.slice(1).map((p, i) => [px[i], p]);
  for (const [[ax, ay], [bx, by]] of segs) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(m.w - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(m.h - 1, Math.ceil(Math.max(ay, by) + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= r * r) set(x, y);
    }
  }
}

interface Props {
  /** The line art on the wall (assembledLineArt), with its lines in other filaments. */
  part: PartMesh & { lineArt: LineArtInfo; paints?: { color: string; from: number; to: number }[]; colourInfo?: LineArtPaint[] };
  /** The design's values: LINEART_EDITS_KEY (the edits), DRAWINGS_KEY (the drawings' proportions), SCALE_KEY. */
  values: ParamValues;
  /** A rebuild is running. */
  busy: boolean;
  /** Why the last rebuild failed, if it did. */
  error: string | null;
  onEdits: (update: (edits: LineArtEdits) => LineArtEdits) => void;
  onClose: () => void;
  /** The piece built without any hand edits (as Jig made it), shown where edits are cleared. */
  original: () => Promise<(PartMesh & { lineArt: LineArtInfo; paints?: { color: string; from: number; to: number }[] }) | null | undefined>;
}

/**
 * The Edit drawing brush: the piece large and straight on, to draw lines on (they go through Jig's
 * clean-up like the drawing's own), paint the lines, frame, bar, text or pegs in another filament
 * (as deep as LINEART_DEPTH_KEY says; a line can be drawn in one too), fill where the piece has
 * nothing yet (inside an outline, in a filament too) or erase (also what Jig drew there). The strokes are a draft,
 * drawn over the piece, until Done (or Escape) saves them in the design at once (LINEART_EDITS_KEY,
 * in the drawing's own units) and the model rebuilds a single time; Cancel drops the draft.
 */
export function LineArtEditor({ part, values, busy, error, onEdits, onClose, original }: Props) {
  const layout = useLayoutMode();
  const la = part.lineArt;
  // A piece split into pieces: its seams, shown (read-only) over it.
  const seams = useRef(la.split?.seams ?? []);
  seams.current = la.split?.seams ?? [];
  const joins = useRef(la);
  joins.current = la;
  const saved = useMemo(() => parseLineArtEdits(values[LINEART_EDITS_KEY]), [values[LINEART_EDITS_KEY]]);
  // The edits as they will be saved: the saved ones as the editor opened, and this session's changes.
  const [edits, setEdits] = useState<LineArtEdits>(saved);
  const changed = useMemo(() => JSON.stringify(edits) !== JSON.stringify(saved), [edits, saved]);
  const finish = useRef(() => {});
  finish.current = () => { if (changed) onEdits(() => edits); onClose(); };
  const cancel = () => { if (!changed || window.confirm('Close without the changes made now?')) onClose(); };
  useEscape(true, () => finish.current());
  // The area selected to clear edits in (mm, the piece's XY): Escape drops it first.
  const [selection, setSelection] = useState<ShownStroke[]>([]);
  useEscape(selection.length > 0, () => setSelection([]));
  const drawings = useMemo(() => parseDrawings(values[DRAWINGS_KEY]), [values[DRAWINGS_KEY]]);
  const scale = Number(values[SCALE_KEY] ?? 1) || 1;
  const image = useMemo(() => pieceImage(part, la.thickness), [part, la.thickness]);

  const [tool, setTool] = useState<Tool>('draw');
  const [widths, setWidths] = useState(() => ({ draw: round(clamp(la.lineWidth, WIDTH.draw.min, WIDTH.draw.max), 1), erase: 3, paint: 3, fill: FILL_WIDTH, clear: 10 }));
  // The brush's shape, for every brush but Draw (a line is drawn round: Jig draws it again at the line width).
  const [shape, setShape] = useState<'round' | 'square'>('round');
  const square = shape === 'square' && tool !== 'draw';
  // The filament lines are drawn and painted in (null: the piece's own), and the picker for another.
  const [filament, setFilament] = useState<PartFilament | null>(null);
  const [picking, setPicking] = useState(false);
  const pickButton = useRef<HTMLButtonElement>(null);
  const [snap, setSnap] = useState(true);
  const [hist, setHist] = useState<{ undo: Op[]; redo: Op[] }>({ undo: [], redo: [] });
  const [note, setNote] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  // This session's strokes, drawn over the piece (it is built only when the editor closes).
  const [shown, setShown] = useState<ShownStroke[]>([]);
  // The piece as Jig made it, for where edits are cleared: this one when it has no hand edits, else
  // built (once) as soon as there is something to clear.
  const [built, setBuilt] = useState<ReturnType<typeof pieceImage> | 'building' | 'failed'>(null);
  const clearing = selection.length > 0 || shown.some((st) => st.mode === 'clear');
  useEffect(() => {
    if (la.edits === 0 || !clearing || built) return;
    setBuilt('building');
    original().then((p) => setBuilt((p && pieceImage(p, p.lineArt.thickness)) || 'failed'), () => setBuilt('failed'));
  }, [la.edits, clearing, built, original]);
  const own = la.edits === 0 ? image : built && typeof built === 'object' ? built : null;
  // The ink to snap to: the piece, with this session's lines drawn in and its erasing taken out.
  const ink = useMemo(() => {
    if (!image) return null;
    if (!shown.length) return image.mask;
    const m = { ...image.mask, data: image.mask.data.slice() };
    for (const st of shown) stamp(m, st, own?.mask);
    return m;
  }, [image, shown, own]);
  const width = widths[tool];
  const stale = staleEdits(edits, la.frames);
  // (A clear isn't a hand edit: it takes them back.)
  const applied = la.frames.reduce((n, f) => n + strokesOf(edits, f.name, f.fp).filter((st) => st.mode !== 'restore').length, 0);
  const erased = la.frames.some((f) => strokesOf(edits, f.name, f.fp).some((st) => st.mode === 'erase'));
  // The filaments a click away: those the piece is in and those of the strokes so far.
  const palette = useMemo(() => {
    const out = [...(la.colours ?? [])];
    for (const f of strokeFilaments(la.frames.flatMap((fr) => strokesOf(edits, fr.name, fr.fp)))) if (!out.some((g) => sameFilament(g, f))) out.push(f);
    if (filament && !out.some((g) => sameFilament(g, filament))) out.push(filament);
    return out;
  }, [la.colours, la.frames, edits, filament]);
  const coloured = tool !== 'erase' && tool !== 'clear';
  // What the colours as built cost in filament changes (an estimate; the Print tab compares the depths).
  const swaps = useMemo(() => {
    if (!part.colourInfo?.length) return null;
    const depth = parseLineArtDepth(values[LINEART_DEPTH_KEY]) ?? 'through', c = colourCost(part.colourInfo, depth);
    return c.changes ? { depth, text: `${c.changes} filament change${c.changes === 1 ? '' : 's'}, about +${Math.max(1, Math.round(c.minutes))} min, +${+c.grams.toFixed(1)} g` } : null;
  }, [part.colourInfo, values[LINEART_DEPTH_KEY]]);
  const touch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);

  const stage = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  /** Screen pixels per mm, and the mm point at the stage's centre. */
  const view = useRef({ s: 1, cx: 0, cy: 0, fitted: false });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  /** What the pointer is doing; the stroke being drawn (mm); the pointer's place (screen px). */
  const act = useRef<{ mode: 'idle' | 'draw' | 'pan' | 'pinch'; id: number; points: Pt[]; startSnap: Pt | null; endSnap: Pt | null; last: Pt; pinch?: { d: number; at: Pt; s: number } }>({ mode: 'idle', id: -1, points: [], startSnap: null, endSnap: null, last: [0, 0] });
  const pointers = useRef(new Map<number, Pt>());
  const hover = useRef<{ at: Pt; snap: Pt | null; show: boolean }>({ at: [0, 0], snap: null, show: false });
  const keys = useRef({ space: false, shift: false });
  // The latest of everything the pointer and key handlers use.
  const now = useRef({ tool, width, square, snap, image, ink, la, edits, scale, shown, hist, filament, selection, own });
  now.current = { tool, width, square, snap, image, ink, la, edits, scale, shown, hist, filament, selection, own };

  // Focus moves into the editor (its keys) and back where it was when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => before?.focus();
  }, []);

  // ---- the view: mm ↔ screen
  const toMm = (x: number, y: number): Pt => {
    const v = view.current, { w, h } = size.current;
    return [v.cx + (x - w / 2) / v.s, v.cy - (y - h / 2) / v.s];
  };
  const toScreen = ([x, y]: Pt): Pt => {
    const v = view.current, { w, h } = size.current;
    return [w / 2 + (x - v.cx) * v.s, h / 2 - (y - v.cy) * v.s];
  };
  const fitScale = () => {
    const im = now.current.image, { w, h } = size.current;
    if (!im || !w || !h) return 1;
    const pad = Math.min(48, Math.min(w, h) * 0.08);
    return Math.min((w - 2 * pad) / (im.box.x1 - im.box.x0), (h - 2 * pad) / (im.box.y1 - im.box.y0));
  };

  // ---- painting: the piece (a quick bitmap while the view moves, then sharp), and the strokes over it
  const crispTimer = useRef(0);
  const raf = useRef({ base: 0, over: 0 });
  /** The view is moving (the quick bitmap is up). */
  const moving = useRef(false);
  // This session's strokes once they have paint, put together off screen (paint shows only on the
  // lines under it), kept while they and the view stay the same.
  const layer = useRef<{ out: HTMLCanvasElement; ink: HTMLCanvasElement; tmp: HTMLCanvasElement; key: unknown[] } | null>(null);
  // The selection, put together off screen.
  const selLayer = useRef<HTMLCanvasElement | null>(null);
  const composed = (strokes: ShownStroke[], width: number, height: number) => {
    const v = view.current, im = now.current.image, own = now.current.own, { w, h, dpr } = size.current;
    const key = [strokes, im, own, v.s, v.cx, v.cy, width, height, moving.current];
    let L = layer.current;
    if (L && L.key.every((k, i) => k === key[i])) return L.out;
    if (!L || L.out.width !== width || L.out.height !== height) {
      const make = () => Object.assign(document.createElement('canvas'), { width, height });
      L = layer.current = { out: make(), ink: make(), tmp: make(), key };
    }
    L.key = key;
    const [out, ink, tmp] = [L.out, L.ink, L.tmp].map((c) => c.getContext('2d')!);
    const mm = (ctx: CanvasRenderingContext2D) => ctx.setTransform(dpr * v.s, 0, 0, -dpr * v.s, dpr * (w / 2 - v.cx * v.s), dpr * (h / 2 + v.cy * v.s));
    const px = (ctx: CanvasRenderingContext2D) => ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const ctx of [out, ink, tmp]) { px(ctx); ctx.clearRect(0, 0, width, height); }
    // The lines as they are: the piece (its bitmap while the view moves), with this session's lines and fills drawn and erasing taken out.
    if (im && moving.current) {
      const m = im.mask, [sx, sy] = toScreen([m.x0, m.y1]);
      ink.setTransform(dpr, 0, 0, dpr, 0, 0);
      ink.drawImage(im.bitmap, sx, sy, m.w * m.res * v.s, m.h * m.res * v.s);
    } else if (im) { mm(ink); im.fill(ink); }
    mm(ink); mm(out);
    for (const st of strokes) {
      if (st.mode === 'draw') { strokeOn(out, st, st.color ?? INK); strokeOn(ink, st, INK); }
      else if (st.mode === 'clear') {
        // Cleared: the piece as Jig made it there, over the strokes before (once it is known).
        if (!own) continue;
        // Its ink, then the paper with it in (as one, so its soft edge shows no seam).
        const brushed = (under: string, op: GlobalCompositeOperation) => {
          px(tmp); tmp.clearRect(0, 0, width, height); mm(tmp);
          strokeOn(tmp, st, under);
          tmp.globalCompositeOperation = op; own.fill(tmp); tmp.globalCompositeOperation = 'source-over';
        };
        brushed(INK, 'source-in');
        ink.globalCompositeOperation = 'destination-out'; strokeOn(ink, st, INK); ink.globalCompositeOperation = 'source-over';
        px(ink); ink.drawImage(L.tmp, 0, 0); mm(ink);
        brushed(PAPER, 'source-atop');
        px(out); out.drawImage(L.tmp, 0, 0); mm(out);
      }
      else if (st.mode === 'erase') {
        strokeOn(out, st, PAPER);
        ink.globalCompositeOperation = 'destination-out'; strokeOn(ink, st, INK); ink.globalCompositeOperation = 'source-over';
      } else {
        // Paint on the ink only, a fill off it only (then it is ink too, for what comes after it).
        px(tmp); tmp.clearRect(0, 0, width, height); mm(tmp);
        strokeOn(tmp, st, st.color ?? INK);
        px(tmp); tmp.globalCompositeOperation = st.mode === 'fill' ? 'destination-out' : 'destination-in'; tmp.drawImage(L.ink, 0, 0); tmp.globalCompositeOperation = 'source-over';
        px(out); out.drawImage(L.tmp, 0, 0); mm(out);
        // (A pixel narrower: a fill after it covers its soft edge, so two fills show no seam.)
        if (st.mode === 'fill') strokeOn(ink, { ...st, width: Math.max(0, st.width - 2 / (dpr * v.s)) }, INK);
      }
    }
    return L.out;
  };
  const paintBase = useCallback((crisp: boolean) => {
    const c = base.current, im = now.current.image;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const v = view.current, { w, h, dpr } = size.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    if (!im) return;
    if (crisp) {
      ctx.setTransform(dpr * v.s, 0, 0, -dpr * v.s, dpr * (w / 2 - v.cx * v.s), dpr * (h / 2 + v.cy * v.s));
      im.fill(ctx);
    } else {
      const m = im.mask, [sx, sy] = toScreen([m.x0, m.y1]);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = v.s * m.res < 2;
      ctx.drawImage(im.bitmap, sx, sy, m.w * m.res * v.s, m.h * m.res * v.s);
    }
  }, []);
  const paintOver = useCallback(() => {
    const c = over.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const v = view.current, { w, h, dpr } = size.current, n = now.current, a = act.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr * v.s, 0, 0, -dpr * v.s, dpr * (w / 2 - v.cx * v.s), dpr * (h / 2 + v.cy * v.s));
    // Erased: the paper shows (red while it is being drawn).
    const stroke = (st: ShownStroke) => strokeOn(ctx, st, st.mode === 'draw' ? st.color ?? INK : st.live ? ERASE : PAPER);
    const live: ShownStroke | null = a.mode === 'draw' && a.points.length ? { mode: n.tool, width: n.width, points: livePoints(), live: true, color: n.tool === 'erase' || n.tool === 'clear' ? undefined : n.filament?.color, ...(n.square ? { shape: 'square' as const } : {}) } : null;
    // Paint only shows on the piece (its lines, frame, bar, text and pegs), a fill only off it: the
    // strokes over the ink layer, which is kept while they and the view stay the same.
    if ((live && masked(live.mode)) || n.shown.some((st) => composite(st.mode))) {
      const img = composed(n.shown, c.width, c.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(img, 0, 0);
      ctx.setTransform(dpr * v.s, 0, 0, -dpr * v.s, dpr * (w / 2 - v.cx * v.s), dpr * (h / 2 + v.cy * v.s));
    } else for (const st of n.shown) stroke(st);
    if (live && masked(live.mode) && layer.current) {
      // The stroke being painted: see-through, on the ink only (filled: off it only).
      const L = layer.current, t = L.tmp.getContext('2d')!;
      t.setTransform(1, 0, 0, 1, 0, 0); t.clearRect(0, 0, L.tmp.width, L.tmp.height);
      t.setTransform(dpr * v.s, 0, 0, -dpr * v.s, dpr * (w / 2 - v.cx * v.s), dpr * (h / 2 + v.cy * v.s));
      strokeOn(t, live, live.color ?? INK);
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.globalCompositeOperation = live.mode === 'fill' ? 'destination-out' : 'destination-in'; t.drawImage(L.ink, 0, 0); t.globalCompositeOperation = 'source-over';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.6; ctx.drawImage(L.tmp, 0, 0); ctx.globalAlpha = 1;
      ctx.setTransform(dpr * v.s, 0, 0, -dpr * v.s, dpr * (w / 2 - v.cx * v.s), dpr * (h / 2 + v.cy * v.s));
    } else if (live && live.mode !== 'clear') stroke(live);
    // The area selected to clear edits in (with the stroke adding to it), see-through: drawn whole
    // off screen, so where strokes cross it is no darker. Where edits were cleared shows so too
    // until the piece as Jig made it is known.
    const sel = [...n.selection, ...(live?.mode === 'clear' ? [live] : []), ...(n.own ? [] : n.shown.filter((st) => st.mode === 'clear'))];
    if (sel.length) {
      const S = (selLayer.current ??= document.createElement('canvas'));
      if (S.width !== c.width || S.height !== c.height) { S.width = c.width; S.height = c.height; }
      const sctx = S.getContext('2d')!;
      sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.clearRect(0, 0, S.width, S.height);
      sctx.setTransform(dpr * v.s, 0, 0, -dpr * v.s, dpr * (w / 2 - v.cx * v.s), dpr * (h / 2 + v.cy * v.s));
      for (const st of sel) strokeOn(sctx, st, SELECT[0]);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = SELECT[1]; ctx.drawImage(S, 0, 0); ctx.globalAlpha = 1;
    }
    // Screen-sized marks: the seams of a piece split into pieces (where it is cut), where a line will snap to, and the brush.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const seamLook: [string, number, number[]][] = [['#ffffffd0', 3.5, []], [SEAM, 1.5, [7, 5]]];
    for (const [color, lw, dash] of seamLook) {
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash(dash);
      // (Only where two pieces really meet: not through strips of frame joined into one piece.)
      for (const sm of seams.current) for (const cut of sm.cuts ?? [sm.points]) {
        ctx.beginPath();
        cut.forEach((p, i) => { const [x, y] = toScreen(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle = JOIN[0]; ctx.lineWidth = 2.5;
    for (const [a, b] of joins.current.joins ?? []) {
      const [ax, ay] = toScreen(a), [bx, by] = toScreen(b);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.beginPath(); ctx.arc(ax, ay, 3.5, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.fillStyle = JOIN[1];
    for (const p of joins.current.loose ?? []) { const [x, y] = toScreen(p); ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 2 * Math.PI); ctx.fill(); }
    const ring = (p: Pt, r: number, color: string, lw: number) => { const [x, y] = toScreen(p); ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke(); };
    const snaps = a.mode === 'draw' ? [a.startSnap, a.endSnap] : [hover.current.show ? hover.current.snap : null];
    for (const p of snaps) if (p) { ring(p, 6, '#fff', 4); ring(p, 6, '#e0a43c', 2); }
    if (hover.current.show && a.mode !== 'pan' && a.mode !== 'pinch' && !keys.current.space) {
      const p = toMm(...hover.current.at), r = Math.max(1.5, (n.width / 2) * v.s);
      const mark = n.tool === 'erase' ? '#c0392b' : n.tool === 'clear' ? SELECT_RING : n.filament?.color ?? '#1d1d1f';
      const [x, y] = hover.current.at;
      // (A square brush: a square as wide.)
      const box = (color: string, lw: number) => { ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.strokeRect(x - r, y - r, 2 * r, 2 * r); };
      if (n.square) { box('#ffffffcc', 3); box(mark, 1.2); } else { ring(p, r, '#ffffffcc', 3); ring(p, r, mark, 1.2); }
      ctx.fillStyle = mark;
      ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
  }, []);
  const repaintOver = useCallback(() => {
    cancelAnimationFrame(raf.current.over);
    raf.current.over = requestAnimationFrame(paintOver);
  }, [paintOver]);
  /** The view moved: the bitmap at once, the sharp piece once it rests. */
  const viewChanged = useCallback(() => {
    cancelAnimationFrame(raf.current.base);
    moving.current = true;
    raf.current.base = requestAnimationFrame(() => { paintBase(false); paintOver(); });
    clearTimeout(crispTimer.current);
    crispTimer.current = window.setTimeout(() => { moving.current = false; paintBase(true); paintOver(); }, 120);
    setZoom(view.current.s);
  }, [paintBase, paintOver]);
  const fit = useCallback(() => {
    const im = now.current.image;
    if (!im || !size.current.w || !size.current.h) return;
    view.current = { ...view.current, s: fitScale(), cx: (im.box.x0 + im.box.x1) / 2, cy: (im.box.y0 + im.box.y1) / 2, fitted: true };
    viewChanged();
  }, [viewChanged]);
  /** Zoom by `k` keeping the mm point under screen point `at` in place. */
  const zoomAt = useCallback((k: number, at?: Pt) => {
    const { w, h } = size.current;
    const p = at ?? [w / 2, h / 2];
    const m = toMm(...p), v = view.current;
    const s = clamp(v.s * k, fitScale() / 4, MAX_ZOOM);
    view.current = { ...v, s, cx: m[0] - (p[0] - w / 2) / s, cy: m[1] + (p[1] - h / 2) / s };
    viewChanged();
  }, [viewChanged]);

  // The stage's size, at the screen's pixel density.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height, dpr };
      for (const c of [base.current, over.current]) if (c) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
      if (!view.current.fitted) fit();
      else { paintBase(true); paintOver(); }
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(crispTimer.current); cancelAnimationFrame(raf.current.base); cancelAnimationFrame(raf.current.over); };
  }, [fit, paintBase, paintOver]);
  // A rebuilt piece: drawn sharp where the view is (fitted the first time there is one).
  useEffect(() => {
    if (!view.current.fitted) fit();
    else paintBase(true);
    repaintOver();
  }, [image, fit, paintBase, repaintOver]);
  useEffect(repaintOver, [shown, tool, width, square, filament, selection, own, repaintOver]);

  // ---- strokes
  const snapRadius = () => Math.max(SNAP_MM, SNAP_PX / view.current.s);
  /** Where a line starting or ending at p would snap to, if it would. */
  const snapAt = (p: Pt, prev?: Pt): Pt | null => {
    const n = now.current;
    if (n.tool !== 'draw' || !n.snap || !n.ink) return null;
    return snapEnd(n.ink, p, prev, n.width, snapRadius());
  };
  /** The stroke being drawn as it will be saved: straight with Shift, its ends snapped. */
  function livePoints(): Pt[] {
    const a = act.current;
    let pts = keys.current.shift && a.points.length > 1 ? [a.points[0], a.points[a.points.length - 1]] : a.points;
    if (a.startSnap) pts = [a.startSnap, ...pts.slice(1)];
    if (a.endSnap && pts.length > 1) pts = [...pts.slice(0, -1), a.endSnap];
    return pts;
  }
  const updateEndSnap = () => {
    const a = act.current;
    const pts = keys.current.shift && a.points.length > 1 ? [a.points[0], a.points[a.points.length - 1]] : a.points;
    a.endSnap = pts.length > 1 ? snapAt(pts[pts.length - 1], pts[pts.length - 2]) : null;
  };
  const commit = () => {
    const a = act.current, n = now.current;
    const raw = keys.current.shift && a.points.length > 1 ? [a.points[0], a.points[a.points.length - 1]] : a.points;
    a.mode = 'idle';
    if (!raw.length) return;
    let pts = leanStroke(raw);
    // Snapped ends, worked out again on the lean stroke (its last segment can point another way).
    if (n.tool === 'draw' && n.snap && n.ink && pts.length > 1) {
      const s0 = snapEnd(n.ink, pts[0], pts[1], n.width, snapRadius());
      const s1 = snapEnd(n.ink, pts[pts.length - 1], pts[pts.length - 2], n.width, snapRadius());
      if (s0) pts = [s0, ...pts.slice(1)];
      if (s1) pts = [...pts.slice(0, -1), s1];
    }
    // Selecting where to clear edits: the stroke adds to the selection (nothing is saved yet).
    const sq = n.square ? { shape: 'square' as const } : {};
    if (n.tool === 'clear') { setSelection((s) => [...s, { mode: 'clear', width: n.width, points: pts, ...sq }]); setNote(null); return; }
    const f = frameAt(n.la.frames, pts[0], (name) => drawings[name]?.aspect ?? 1);
    if (!f) return;
    if (strokesOf(n.edits, f.name, f.fp).length >= MAX_LINEART_STROKES) {
      setNote(`At most ${MAX_LINEART_STROKES} strokes per drawing: undo or clear some first.`);
      repaintOver();
      return;
    }
    const fil = n.tool !== 'erase' && n.filament ? n.filament : undefined;
    const stroke: LineArtStroke = {
      mode: n.tool,
      // In the drawing's units (it stays put when the piece is resized), the width as Jig builds it (before the scale).
      width: round(n.width / n.scale, 3),
      points: pts.map((p) => toDrawing(f, p).map((v) => round(v, 6)) as Pt),
      ...(fil ? { filament: fil } : {}),
      ...sq,
    };
    const view: ShownStroke = { mode: n.tool, width: n.width, points: pts, name: f.name, src: stroke, ...(fil ? { color: fil.color } : {}), ...sq };
    setEdits((e) => addStroke(e, f.name, f.fp, stroke));
    setHist((h) => ({ undo: [...h.undo, { kind: 'add', name: f.name, fp: f.fp, stroke, shown: view }], redo: [] }));
    setShown((s) => [...s, view]);
    setNote(null);
  };
  const apply = (op: Op, undo: boolean) => {
    if (op.kind === 'here') {
      const from = undo ? op.before : op.after;
      setEdits((e) => {
        const out = { ...e };
        for (const k of op.names) if (from[k]) out[k] = from[k]; else delete out[k];
        return out;
      });
      setShown((s) => (undo ? s.filter((x) => !op.shown.includes(x)) : [...s, ...op.shown]));
      setSelection(undo ? op.selection : []);
    } else if (op.kind === 'add') {
      setEdits((e) => (undo ? removeStroke(e, op.name, op.stroke) : addStroke(e, op.name, op.fp, op.stroke)));
      setShown((s) => (undo ? s.filter((x) => x !== op.shown) : [...s, op.shown]));
    } else {
      setEdits((e) => (undo ? { ...e, ...op.before } : withoutDrawings(e, op.names)));
      setShown((s) => (undo ? [...s, ...op.shown] : s.filter((x) => !op.names.includes(x.name ?? ''))));
    }
  };
  const undo = () => {
    const op = now.current.hist.undo.at(-1);
    if (!op) return;
    apply(op, true);
    setHist((h) => ({ undo: h.undo.slice(0, -1), redo: [...h.redo, op] }));
  };
  const redo = () => {
    const op = now.current.hist.redo.at(-1);
    if (!op) return;
    apply(op, false);
    setHist((h) => ({ undo: [...h.undo, op], redo: h.redo.slice(0, -1) }));
  };
  const clear = (names: string[]) => {
    const e = now.current.edits;
    names = names.filter((k) => e[k]);
    if (!names.length) return;
    const op: Op = { kind: 'clear', names, before: Object.fromEntries(names.map((k) => [k, e[k]])), shown: now.current.shown.filter((x) => names.includes(x.name ?? '')) };
    apply(op, false);
    setHist((h) => ({ undo: [...h.undo, op], redo: [] }));
  };

  /**
   * Clear edits here: on each drawing, its hand edits under the selection taken back (a restore
   * stroke per selection stroke, after them), so there the piece is as Jig made it again.
   */
  const clearHere = () => {
    const n = now.current;
    if (!n.selection.length) return;
    const names: string[] = [], before: LineArtEdits = {}, after: LineArtEdits = {};
    for (const f of n.la.frames) {
      const strokes = strokesOf(n.edits, f.name, f.fp);
      if (!strokes.length) continue;
      const area = n.selection.map((st): LineArtStroke => ({ mode: 'restore', width: round(st.width / n.scale, 3), points: st.points.map((p) => toDrawing(f, p).map((v) => round(v, 6)) as Pt), ...(st.shape ? { shape: st.shape } : {}) }));
      // How far each brush reaches, in the drawing's units (a drawn line: its colour, at least the piece's line width).
      const reach = (st: LineArtStroke) => {
        const w = (st.width ?? (st.mode === 'draw' ? n.la.lineWidth / n.scale : st.mode === 'fill' ? FILL_WIDTH : 3)) * n.scale;
        return (st.mode === 'draw' ? Math.max(w, n.la.lineWidth) : w) / 2 / f.k;
      };
      const kept = clearArea(strokes, area, reach);
      if (JSON.stringify(kept) === JSON.stringify(strokes)) continue;
      if (kept.length > MAX_LINEART_STROKES) { setNote(`At most ${MAX_LINEART_STROKES} strokes per drawing: undo or clear some first.`); return; }
      names.push(f.name);
      before[f.name] = n.edits[f.name];
      if (kept.length) after[f.name] = { fp: f.fp, strokes: kept };
    }
    if (!names.length) { setNote('No hand edits there to clear.'); return; }
    const op: Op = { kind: 'here', names, before, after, shown: n.selection.map((st) => ({ ...st })), selection: n.selection };
    apply(op, false);
    setHist((h) => ({ undo: [...h.undo, op], redo: [] }));
    setNote(null);
  };

  // ---- pointer: one finger, the pen or the left button draws; two fingers, the middle or right button or Space + drag pan (and pinch zooms)
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = over.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(e), a = act.current;
    if (e.button === 1 || e.button === 2) e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, p);
    hover.current = { at: p, snap: null, show: e.pointerType !== 'touch' };
    if (pointers.current.size === 2 && e.pointerType === 'touch') {
      // A second finger: the stroke just begun was the start of a pinch.
      const [p0, p1] = [...pointers.current.values()];
      a.mode = 'pinch'; a.points = []; a.startSnap = a.endSnap = null;
      a.pinch = { d: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1, at: toMm((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2), s: view.current.s };
      repaintOver();
      return;
    }
    if (pointers.current.size > 1 || a.mode !== 'idle') return;
    a.id = e.pointerId; a.last = p;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && keys.current.space)) { a.mode = 'pan'; setPanning(true); return; }
    if (e.button !== 0) return;
    const m = toMm(...p);
    a.mode = 'draw'; a.points = [m]; a.startSnap = snapAt(m); a.endSnap = null;
    setNote(null);
    repaintOver();
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(e), a = act.current;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
    if (a.mode === 'pinch' && a.pinch) {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [p0, p1] = pts, { w, h } = size.current;
      const mid: Pt = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      const s = clamp(a.pinch.s * Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / a.pinch.d, fitScale() / 4, MAX_ZOOM);
      view.current = { ...view.current, s, cx: a.pinch.at[0] - (mid[0] - w / 2) / s, cy: a.pinch.at[1] + (mid[1] - h / 2) / s };
      viewChanged();
      return;
    }
    hover.current.at = p;
    hover.current.show = e.pointerType !== 'touch' || a.mode === 'draw';
    if (a.mode === 'pan' && e.pointerId === a.id) {
      const v = view.current;
      view.current = { ...v, cx: v.cx - (p[0] - a.last[0]) / v.s, cy: v.cy + (p[1] - a.last[1]) / v.s };
      a.last = p;
      viewChanged();
      return;
    }
    if (a.mode === 'draw' && e.pointerId === a.id) {
      // Every point the pointer passed (coalesced events), for a faithful line.
      const evs = e.nativeEvent.getCoalescedEvents?.();
      for (const ev of evs?.length ? evs : [e.nativeEvent]) a.points.push(toMm(...local(ev)));
      updateEndSnap();
    } else if (a.mode === 'idle') hover.current.snap = snapAt(toMm(...p));
    repaintOver();
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = act.current;
    pointers.current.delete(e.pointerId);
    if (a.mode === 'pinch') { if (!pointers.current.size) a.mode = 'idle'; return; }
    if (e.pointerId !== a.id) return;
    if (a.mode === 'draw') { if (e.type === 'pointerup') commit(); else a.mode = 'idle'; a.points = []; a.startSnap = a.endSnap = null; }
    else if (a.mode === 'pan') { a.mode = 'idle'; setPanning(false); }
    if (e.pointerType === 'touch') hover.current.show = false;
    repaintOver();
  };
  const onLeave = () => { if (act.current.mode !== 'draw') { hover.current.show = false; repaintOver(); } };

  // The wheel zooms (not passive: the page mustn't scroll).
  useEffect(() => {
    const c = over.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), local(e));
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Keys: B draw, P paint, G fill, E erase, C select where to clear edits, S snap, [ ] width, Q round / square brush, F fit, + − zoom, Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo,
  // Space pans, Shift draws straight. The editor is on top: the app's own keys wait (Escape closes it).
  // (Not in the filament picker, which has keys of its own.)
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest('textarea, [contenteditable], input:not([type="range"]), .layertone-picker');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || typing(e.target)) return;
      e.stopPropagation();
      const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'Shift') { keys.current.shift = true; updateEndSnap(); repaintOver(); return; }
      if (ctrl && (k === 'z' || k === 'y')) { e.preventDefault(); if (k === 'y' || e.shiftKey) redo(); else undo(); return; }
      if (ctrl || e.altKey) return;
      if (e.key === ' ') { e.preventDefault(); if (!keys.current.space) { keys.current.space = true; setPanning(true); repaintOver(); } return; }
      const step = (d: number) => setWidths((w) => {
        const t = now.current.tool, lim = WIDTH[t];
        return { ...w, [t]: round(clamp(w[t] + d * (t === 'draw' ? 0.1 : t === 'clear' ? 2 : 0.5), lim.min, lim.max), 1) };
      });
      if (k === 'b') setTool('draw');
      else if (k === 'p') setTool('paint');
      else if (k === 'g') setTool('fill');
      else if (k === 'e') setTool('erase');
      else if (k === 'c') setTool('clear');
      else if (k === 's') setSnap((s) => !s);
      else if (k === 'q') setShape((s) => (s === 'square' ? 'round' : 'square'));
      else if (k === 'f' || k === '0') fit();
      else if (k === '+' || k === '=') zoomAt(1.25);
      else if (k === '-' || k === '_') zoomAt(0.8);
      else if (k === '[') step(-1);
      else if (k === ']') step(1);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') { keys.current.shift = false; updateEndSnap(); repaintOver(); }
      // (Not a click on the focused button either.)
      if (e.key === ' ' && !typing(e.target)) { e.preventDefault(); keys.current.space = false; if (act.current.mode !== 'pan') setPanning(false); repaintOver(); }
    };
    const onBlur = () => { keys.current = { space: false, shift: false }; setPanning(false); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true); window.removeEventListener('blur', onBlur); };
  });

  // ---- the scale bar: a round length about 90 px long
  const barMm = niceLength(90 / zoom);
  const phone = layout === 'phone';
  const lim = WIDTH[tool];
  // The filament the brush puts down, when it isn't the piece's own (a line is drawn in it too).
  const using = coloured && filament ? ` in ${filament.name ?? filament.color}` : '';
  const status = changed ? 'Not built yet: Done builds it' : `${applied} hand edit${applied === 1 ? '' : 's'}`;
  const showSwaps = !!swaps && (tool === 'paint' || tool === 'fill' || palette.length > 0);
  // Clearing edits the piece was built with only shows once it is rebuilt.
  const clearedBuilt = la.edits > 0 && applied === 0;
  return (
    <div className={`la-editor ${phone ? 'phone' : ''}`} role="dialog" aria-modal="true" aria-label="Edit the drawing" ref={dialog} tabIndex={-1}>
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
          <button className={`la-ed-tool ${tool === 'erase' ? 'on erase' : ''}`} role="radio" aria-checked={tool === 'erase'} onClick={() => setTool('erase')} title="Erase (E): also what Jig drew there">
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
            <button className="la-ed-tool" disabled={!selection.length} onClick={clearHere} title="Take back the hand edits in the area selected: there the piece is as Jig made it (lines drawn go, erased ones come back, paint and fills go)">
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
            <span className="la-ed-swaps" title={`Colours ${depthLabel(swaps.depth).toLowerCase()}, as built: an estimate for the A1 (the Print tab's Colours set how deep they go and compare; the Cost tab's slice is exact)`}>· {swaps.text}</span>
          )}
        </span>
        <button className="btn" onClick={cancel} title="Close without the changes made now">Cancel</button>
        <button className="btn primary" onClick={() => finish.current()} title="Done (Esc): build the piece with the edits">Done</button>
      </div>
      <div className={`la-ed-stage ${panning ? 'panning' : ''}`} ref={stage}>
        <canvas ref={base} className="la-ed-canvas" aria-hidden />
        <canvas ref={over} className="la-ed-canvas la-ed-over" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={onLeave} onContextMenu={(e) => e.preventDefault()} aria-label="The piece: drag to draw, paint, fill, erase or select" />
        <div className="la-ed-notes">
          {stale.strokes > 0 && (
            <div className="la-ed-note warn"><Icon name="alert" size={13} /> {stale.strokes} edit{stale.strokes === 1 ? ' was' : 's were'} made on an earlier drawing <button className="link" onClick={() => clear(stale.names)}>Clear</button></div>
          )}
          {clearedBuilt && <div className="la-ed-note">The cleared edits go when you click Done.</div>}
          {part.components > 1 && !busy && !changed && (
            <div className="la-ed-note warn"><Icon name="alert" size={13} /> The piece is in {part.components} pieces{erased ? ' – an erase cut it apart' : ''}</div>
          )}
          {error && <div className="la-ed-note warn"><Icon name="alert" size={13} /> The model didn't build: {error}</div>}
          {note && <div className="la-ed-note">{note}</div>}
          {clearing && built === 'building' && <div className="la-ed-note"><span className="spinner" /> Working out the piece as Jig made it, to show where edits are cleared…</div>}
          {clearing && built === 'failed' && la.edits > 0 && <div className="la-ed-note">Where edits are cleared shows once built (Done).</div>}
        </div>
        <div className="la-ed-scale" aria-label={`Scale: the bar is ${barMm} mm`}>
          <span className="la-ed-scale-bar" style={{ width: barMm * zoom }} />
          <span className="mono">{barMm} mm</span>
        </div>
        <div className="la-ed-zoom">
          <button onClick={() => zoomAt(1.25)} title="Zoom in (+)" aria-label="Zoom in"><Icon name="plus" size={15} /></button>
          <button onClick={() => zoomAt(0.8)} title="Zoom out (−)" aria-label="Zoom out"><Icon name="minus" size={15} /></button>
          <button onClick={fit} title="Fit (F)" aria-label="Fit the piece"><Icon name="fullscreen" size={15} /></button>
        </div>
        {!phone && (
          <div className="la-ed-hint small">
            {touch ? `One finger ${tool === 'draw' ? 'draws' : tool === 'paint' ? 'paints' : tool === 'fill' ? 'fills' : tool === 'clear' ? 'selects where to clear edits' : 'erases'}${using} · two fingers move and zoom`
              : `${tool === 'clear' ? 'Drag to select where to clear edits (strokes add up) · Esc: deselect' : `Drag to ${tool}${using}`} · Shift: straight line · Space, middle or right button: move · wheel: zoom · [ ]: width · Q: square`}
          </div>
        )}
      </div>
    </div>
  );
}
