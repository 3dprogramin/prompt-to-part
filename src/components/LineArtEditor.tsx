import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParamValues, PartMesh } from '../../shared/types';
import { LINEART_EDITS_KEY, MAX_LINEART_STROKES, parseLineArtEdits, type LineArtEdits, type LineArtInfo, type LineArtStroke } from '../../shared/lineart';
import { DRAWINGS_KEY, parseDrawings } from '../../shared/svgFeatures';
import { SCALE_KEY } from '../../shared/params';
import { addStroke, frameAt, leanStroke, niceLength, removeStroke, snapEnd, staleEdits, strokesOf, toDrawing, withoutDrawings, type InkMask } from '../lib/lineArtEdit';
import { useLayoutMode } from '../hooks/useLayoutMode';
import { useEscape } from './useEscape';
import { Icon } from './Icon';

type Pt = [number, number];
type Tool = 'draw' | 'erase';
/** A step of this session, for Undo / Redo: a stroke added, or edits cleared. */
type Op = { kind: 'add'; name: string; fp: string; stroke: LineArtStroke; shown: ShownStroke } | { kind: 'clear'; names: string[]; before: LineArtEdits; shown: ShownStroke[] };
/** A stroke of this session on the screen (mm, the piece's XY), drawn over the piece: it is only built when the editor closes with Done. `src` is the stroke as saved. */
interface ShownStroke { mode: Tool; width: number; points: Pt[]; name?: string; src?: LineArtStroke; live?: boolean }

/** Brush widths (mm): draw, erase. */
const WIDTH = { draw: { min: 0.6, max: 5 }, erase: { min: 1, max: 15 } };
/** Snap within this many mm of the ink (and at least SNAP_PX screen pixels). */
const SNAP_MM = 1.5;
const SNAP_PX = 10;
/** The piece's colour on the white page, and the bar, frame or pegs (raised above the lines) a little lighter. */
const INK = '#141414';
const RAISED = ['#3a3d42', '#6a6e75'];
const ERASE = 'rgba(229, 103, 95, 0.5)';
/** The seams of a piece split into pieces. */
const SEAM = '#2f80d1';
const PAPER = '#fff';
/** The hit-test grid: this many mm per cell at least, and at most this many cells. */
const MASK_RES = 0.05;
const MASK_CELLS = 8_000_000;
/** The largest zoom, screen pixels per mm. */
const MAX_ZOOM = 400;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * The piece seen from above, ready to draw: its up-facing triangles as paths (all of them in INK,
 * then those raised above the lines lighter, by height), a bitmap of it for quick pans and zooms,
 * and its ink on a grid for snapping.
 */
function pieceImage(part: PartMesh, thickness: number) {
  const P = part.positions, I = part.indices;
  const all = new Path2D();
  const raised = new Map<number, Path2D>();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1], cx = P[c], cy = P[c + 1];
    // Facing up (counter-clockwise seen from above): the walls and the back are left out.
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) <= 1e-9) continue;
    all.moveTo(ax, ay); all.lineTo(bx, by); all.lineTo(cx, cy); all.closePath();
    const z = Math.max(P[a + 2], P[b + 2], P[c + 2]);
    if (z > thickness + 0.05) {
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
  const layers = [{ path: all, color: INK }, ...zs.map((z) => ({ path: raised.get(z)!, color: mix(z) }))];
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

/** A stroke stamped into the ink grid: a drawn line adds ink, erasing takes it away. */
function stamp(m: InkMask, st: ShownStroke) {
  const r = st.width / 2 / m.res, v = st.mode === 'draw' ? 1 : 0;
  const px = st.points.map(([x, y]): Pt => [(x - m.x0) / m.res, (m.y1 - y) / m.res]);
  const segs = px.length === 1 ? [[px[0], px[0]]] : px.slice(1).map((p, i) => [px[i], p]);
  for (const [[ax, ay], [bx, by]] of segs) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(m.w - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(m.h - 1, Math.ceil(Math.max(ay, by) + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= r * r) m.data[y * m.w + x] = v;
    }
  }
}

interface Props {
  part: PartMesh & { lineArt: LineArtInfo };
  /** The design's values: LINEART_EDITS_KEY (the edits), DRAWINGS_KEY (the drawings' proportions), SCALE_KEY. */
  values: ParamValues;
  /** A rebuild is running. */
  busy: boolean;
  /** Why the last rebuild failed, if it did. */
  error: string | null;
  onEdits: (update: (edits: LineArtEdits) => LineArtEdits) => void;
  onClose: () => void;
}

/**
 * The Edit drawing brush: the piece large and straight on, to draw lines on (they go through Jig's
 * clean-up like the drawing's own) or erase (also what Jig drew there). The strokes are a draft,
 * drawn over the piece, until Done (or Escape) saves them in the design at once (LINEART_EDITS_KEY,
 * in the drawing's own units) and the model rebuilds a single time; Cancel drops the draft.
 */
export function LineArtEditor({ part, values, busy, error, onEdits, onClose }: Props) {
  const layout = useLayoutMode();
  const la = part.lineArt;
  // A piece split into pieces: its seams, shown (read-only) over it.
  const seams = useRef(la.split?.seams ?? []);
  seams.current = la.split?.seams ?? [];
  const saved = useMemo(() => parseLineArtEdits(values[LINEART_EDITS_KEY]), [values[LINEART_EDITS_KEY]]);
  // The edits as they will be saved: the saved ones as the editor opened, and this session's changes.
  const [edits, setEdits] = useState<LineArtEdits>(saved);
  const changed = useMemo(() => JSON.stringify(edits) !== JSON.stringify(saved), [edits, saved]);
  const finish = useRef(() => {});
  finish.current = () => { if (changed) onEdits(() => edits); onClose(); };
  const cancel = () => { if (!changed || window.confirm('Close without the changes made now?')) onClose(); };
  useEscape(true, () => finish.current());
  const drawings = useMemo(() => parseDrawings(values[DRAWINGS_KEY]), [values[DRAWINGS_KEY]]);
  const scale = Number(values[SCALE_KEY] ?? 1) || 1;
  const image = useMemo(() => pieceImage(part, la.thickness), [part, la.thickness]);

  const [tool, setTool] = useState<Tool>('draw');
  const [widths, setWidths] = useState(() => ({ draw: round(clamp(la.lineWidth, WIDTH.draw.min, WIDTH.draw.max), 1), erase: 3 }));
  const [snap, setSnap] = useState(true);
  const [hist, setHist] = useState<{ undo: Op[]; redo: Op[] }>({ undo: [], redo: [] });
  const [note, setNote] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  // This session's strokes, drawn over the piece (it is built only when the editor closes).
  const [shown, setShown] = useState<ShownStroke[]>([]);
  // The ink to snap to: the piece, with this session's lines drawn in and its erasing taken out.
  const ink = useMemo(() => {
    if (!image) return null;
    if (!shown.length) return image.mask;
    const m = { ...image.mask, data: image.mask.data.slice() };
    for (const st of shown) stamp(m, st);
    return m;
  }, [image, shown]);
  const width = widths[tool];
  const stale = staleEdits(edits, la.frames);
  const applied = la.frames.reduce((n, f) => n + strokesOf(edits, f.name, f.fp).length, 0);
  const erased = la.frames.some((f) => strokesOf(edits, f.name, f.fp).some((st) => st.mode === 'erase'));
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
  const now = useRef({ tool, width, snap, image, ink, la, edits, scale, shown, hist });
  now.current = { tool, width, snap, image, ink, la, edits, scale, shown, hist };

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
    const stroke = (st: ShownStroke) => {
      // Erased: the paper shows (red while it is being drawn).
      ctx.fillStyle = ctx.strokeStyle = st.mode === 'draw' ? INK : st.live ? ERASE : PAPER;
      if (st.points.length === 1 || st.points.every((p) => p[0] === st.points[0][0] && p[1] === st.points[0][1])) {
        ctx.beginPath(); ctx.arc(st.points[0][0], st.points[0][1], st.width / 2, 0, 2 * Math.PI); ctx.fill();
        return;
      }
      ctx.lineWidth = st.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    };
    for (const st of n.shown) stroke(st);
    if (a.mode === 'draw' && a.points.length) stroke({ mode: n.tool, width: n.width, points: livePoints(), live: true });
    // Screen-sized marks: the seams of a piece split into pieces (where it is cut), where a line will snap to, and the brush.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const seamLook: [string, number, number[]][] = [['#ffffffd0', 3.5, []], [SEAM, 1.5, [7, 5]]];
    for (const [color, lw, dash] of seamLook) {
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash(dash);
      for (const sm of seams.current) {
        ctx.beginPath();
        sm.points.forEach((p, i) => { const [x, y] = toScreen(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    const ring = (p: Pt, r: number, color: string, lw: number) => { const [x, y] = toScreen(p); ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke(); };
    const snaps = a.mode === 'draw' ? [a.startSnap, a.endSnap] : [hover.current.show ? hover.current.snap : null];
    for (const p of snaps) if (p) { ring(p, 6, '#fff', 4); ring(p, 6, '#e0a43c', 2); }
    if (hover.current.show && a.mode !== 'pan' && a.mode !== 'pinch' && !keys.current.space) {
      const p = toMm(...hover.current.at), r = Math.max(1.5, (n.width / 2) * v.s);
      ring(p, r, '#ffffffcc', 3); ring(p, r, n.tool === 'erase' ? '#c0392b' : '#1d1d1f', 1.2);
      const [x, y] = hover.current.at;
      ctx.fillStyle = n.tool === 'erase' ? '#c0392b' : '#1d1d1f';
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
    raf.current.base = requestAnimationFrame(() => { paintBase(false); paintOver(); });
    clearTimeout(crispTimer.current);
    crispTimer.current = window.setTimeout(() => paintBase(true), 120);
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
  useEffect(repaintOver, [shown, tool, width, repaintOver]);

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
    const f = frameAt(n.la.frames, pts[0], (name) => drawings[name]?.aspect ?? 1);
    if (!f) return;
    if (strokesOf(n.edits, f.name, f.fp).length >= MAX_LINEART_STROKES) {
      setNote(`At most ${MAX_LINEART_STROKES} strokes per drawing: undo or clear some first.`);
      repaintOver();
      return;
    }
    const stroke: LineArtStroke = {
      mode: n.tool,
      // In the drawing's units (it stays put when the piece is resized), the width as Jig builds it (before the scale).
      width: round(n.width / n.scale, 3),
      points: pts.map((p) => toDrawing(f, p).map((v) => round(v, 6)) as Pt),
    };
    const view: ShownStroke = { mode: n.tool, width: n.width, points: pts, name: f.name, src: stroke };
    setEdits((e) => addStroke(e, f.name, f.fp, stroke));
    setHist((h) => ({ undo: [...h.undo, { kind: 'add', name: f.name, fp: f.fp, stroke, shown: view }], redo: [] }));
    setShown((s) => [...s, view]);
    setNote(null);
  };
  const apply = (op: Op, undo: boolean) => {
    if (op.kind === 'add') {
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

  // ---- pointer: one finger, the pen or the left button draws; two fingers, the middle button or Space + drag pan (and pinch zooms)
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = over.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(e), a = act.current;
    if (e.button === 1) e.preventDefault();
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
    if (e.button === 1 || (e.button === 0 && keys.current.space)) { a.mode = 'pan'; setPanning(true); return; }
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

  // Keys: B draw, E erase, S snap, [ ] width, F fit, + − zoom, Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo,
  // Space pans, Shift draws straight. The editor is on top: the app's own keys wait (Escape closes it).
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest('textarea, [contenteditable], input:not([type="range"])');
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
        return { ...w, [t]: round(clamp(w[t] + d * (t === 'draw' ? 0.1 : 0.5), lim.min, lim.max), 1) };
      });
      if (k === 'b') setTool('draw');
      else if (k === 'e') setTool('erase');
      else if (k === 's') setSnap((s) => !s);
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
  // Clearing edits the piece was built with only shows once it is rebuilt.
  const clearedBuilt = la.edits > 0 && applied === 0;
  return (
    <div className={`la-editor ${phone ? 'phone' : ''}`} role="dialog" aria-modal="true" aria-label="Edit the drawing" ref={dialog} tabIndex={-1}>
      <div className="la-ed-bar" role="toolbar" aria-label="Brush">
        <div className="la-ed-group" role="radiogroup" aria-label="Tool">
          <button className={`la-ed-tool ${tool === 'draw' ? 'on' : ''}`} role="radio" aria-checked={tool === 'draw'} onClick={() => setTool('draw')} title="Draw a line (B)">
            <Icon name="brush" size={15} /><span className="la-ed-label">Draw</span>
          </button>
          <button className={`la-ed-tool ${tool === 'erase' ? 'on erase' : ''}`} role="radio" aria-checked={tool === 'erase'} onClick={() => setTool('erase')} title="Erase (E): also what Jig drew there">
            <Icon name="eraser" size={15} /><span className="la-ed-label">Erase</span>
          </button>
        </div>
        <label className="la-ed-width" title="Brush width ([ and ])">
          <span className="la-ed-label">Width</span>
          <input type="range" min={lim.min} max={lim.max} step={0.1} value={width} aria-label={`${tool === 'draw' ? 'Line' : 'Eraser'} width, mm`}
            onChange={(e) => setWidths((w) => ({ ...w, [tool]: Number(e.target.value) }))} />
          <span className="mono la-ed-val">{width.toFixed(1)} mm</span>
        </label>
        <button className={`la-ed-tool ${snap ? 'on' : ''}`} aria-pressed={snap} disabled={tool !== 'draw'} onClick={() => setSnap((s) => !s)}
          title="Snap (S): a line starting or ending near the drawing joins it exactly">
          <Icon name="magnet" size={15} /><span className="la-ed-label">Snap</span>
        </button>
        <div className="la-ed-group">
          <button className="la-ed-tool" disabled={!hist.undo.length} onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" size={15} /></button>
          <button className="la-ed-tool" disabled={!hist.redo.length} onClick={redo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" size={15} /></button>
        </div>
        <button className="la-ed-tool" disabled={!applied} onClick={() => clear(la.frames.filter((f) => edits[f.name]?.fp === f.fp).map((f) => f.name))} title="Remove every hand edit of this piece">
          <Icon name="trash" size={15} /><span className="la-ed-label">Clear edits</span>
        </button>
        <span className="spacer" />
        <span className="la-ed-status small" aria-live="polite">
          {busy ? <><span className="spinner" /> updating…</> : changed ? 'Not built yet: Done builds it' : `${applied} hand edit${applied === 1 ? '' : 's'}`}
        </span>
        <button className="btn" onClick={cancel} title="Close without the changes made now">Cancel</button>
        <button className="btn primary" onClick={() => finish.current()} title="Done (Esc): build the piece with the edits">Done</button>
      </div>
      <div className={`la-ed-stage ${panning ? 'panning' : ''}`} ref={stage}>
        <canvas ref={base} className="la-ed-canvas" aria-hidden />
        <canvas ref={over} className="la-ed-canvas la-ed-over" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={onLeave} onContextMenu={(e) => e.preventDefault()} aria-label="The piece: drag to draw or erase" />
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
            {touch ? 'One finger draws · two fingers move and zoom' : 'Drag to draw · Shift: straight line · Space or middle button: move · wheel: zoom · [ ]: width'}
          </div>
        )}
      </div>
    </div>
  );
}
