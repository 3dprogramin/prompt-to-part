import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Box3, EvalResult, ParamValues, PartMesh } from '../../shared/types';
import { defaultColors, drawingColors, type SvgDrawing } from '../../shared/svgFeatures';
import { ARTWORK_EDITS_KEY, MAX_ARTWORK_STROKES, parseArtworkEdits, splitLongStroke, strokeContours, type ArtworkEdits, type ArtworkStroke } from '../../shared/artworkEdits';
import { leanStroke, niceLength } from '../lib/lineArtEdit';
import { useLayoutMode } from '../hooks/useLayoutMode';
import { describeChange, EDIT_HISTORY_KEY, historyFor, historyTime, parseEditHistory } from '../../shared/editHistory';
import { EditHistory } from './EditHistory';
import { useEscape } from './useEscape';
import { Icon } from './Icon';
import { clamp, ERASE, MAX_ZOOM, round, SELECT, SELECT_RING, strokeOn, type Pt } from './lineart/editorDraw';
import { BACKDROP, builtView, colourNames, colourOps, drawBuilt, drawPicture, mmPerUnit, nearestPart, pictureBox, registerDrawing, shapePaths } from './artwork/artworkCanvas';
import { parsePictureMarks, PICTURE_MARKS_KEY, type MarkStroke, type PictureMark } from '../../shared/pictureEdit/mark';
import type { PictureEditUi } from '../lib/pictureEdit';
import { EditPicturePanel } from './picture/EditPicturePanel';

interface Props {
  /** The drawing as attached (without hand edits), named as in the design. */
  drawing: SvgDrawing;
  /** Its fingerprint, which the edits are saved with. */
  fp: string;
  /** The design's values: ARTWORK_EDITS_KEY (the edits), EDIT_HISTORY_KEY (the restore points), PICTURE_MARKS_KEY (the area selected, as it opens). */
  values: ParamValues;
  result: EvalResult;
  /** The model's parts: seen from the top, they are the picture (their colours name the drawing's, their size places it and gives the brush in mm). */
  parts: PartMesh[];
  /** A rebuild is running. */
  busy: boolean;
  /** Why the last rebuild failed, if it did. */
  error: string | null;
  /** `label`: what the visit did, for the History. */
  onEdits: (update: (edits: ArtworkEdits) => ArtworkEdits, label?: string) => void;
  /** The area selected changed (null: none): saved with the design at once, so the chat can use it. */
  onMark: (mark: PictureMark | null) => void;
  /** Editing the picture with the image model, in the area selected or all of it. */
  edit: PictureEditUi;
  onClose: () => void;
}

type Tool = 'paint' | 'erase' | 'select';
/** Gone back to a restore point made at `at`, which gave `strokes`. */
type Restored = { at: number; strokes: ArtworkStroke[] };
/** A step of Undo and Redo: the strokes, and the restore point gone back to then. */
type Snap = { strokes: ArtworkStroke[]; restored: Restored | null };
/** Brush widths: in mm when the picture's printed size is known, else in % of its height. */
const MM = { min: 0.3, max: 15, start: 2 }, PCT = { min: 0.1, max: 10, start: 1 };
/** The selection brush's widths, the same ways. */
const SEL_MM = { min: 1, max: 60, start: 10 }, SEL_PCT = { min: 0.5, max: 40, start: 5 };
/** The model as built, drawn while the view moves: a bitmap of at most this many pixels. */
const QUICK_PX = 4_000_000;

/**
 * The artwork brush: the model as built seen from the top (what prints; the drawing flat in its own
 * colours when the model's layout can't be matched to it), to paint one of the drawing's colours
 * where the brush goes (it takes over from the colours there) or erase it (only it, down to the
 * plate). The strokes are a draft until Done (or Escape) saves them in the design at once
 * (ARTWORK_EDITS_KEY, in the drawing's own units) and the model rebuilds a single time; Cancel drops them.
 * Each visit saved is a restore point: History puts the strokes as they were before one in the draft.
 * Select (C) brushes an area (strokes add up, Escape deselects; saved with the design as it is made)
 * for the Edit panel, which changes it, or the whole picture, with the image model: while that works
 * and its result waits for Keep / Try again / Discard, the brush is locked and Escape keeps it open.
 */
export function ArtworkEditor({ drawing, fp, values, result, parts, busy, error, onEdits, onMark, edit, onClose }: Props) {
  const layout = useLayoutMode();
  const name = drawing.name;
  // The strokes as the editor opened (none when they were made on an earlier picture), and as they are now.
  const [{ initial, stale }] = useState(() => {
    const saved = parseArtworkEdits(values[ARTWORK_EDITS_KEY])[name];
    return { initial: saved && saved.fp === fp ? saved.strokes : [], stale: !!saved && saved.fp !== fp };
  });
  const [strokes, setStrokes] = useState<ArtworkStroke[]>(initial);
  const [restored, setRestored] = useState<Restored | null>(null);
  const changed = strokes.length !== initial.length || strokes.some((s, i) => s !== initial[i]);
  // This picture's restore points, and its edits as saved now (also when made on an earlier picture).
  const history = useMemo(() => historyFor(parseEditHistory(values[EDIT_HISTORY_KEY]).artwork ?? [], name), [values[EDIT_HISTORY_KEY], name]);
  const savedNow = useMemo(() => { const e = parseArtworkEdits(values[ARTWORK_EDITS_KEY])[name]; return e ? { [name]: e } : {}; }, [values[ARTWORK_EDITS_KEY], name]);
  /** What this visit did, for the History. */
  const visitLabel = () => {
    const as = (list: ArtworkStroke[]) => (list.length ? { [name]: { fp, strokes: list } } : {});
    if (!restored) return describeChange(as(initial), as(strokes));
    const back = `Restored to before ${historyTime(restored.at)}`;
    return strokes.length === restored.strokes.length && strokes.every((s, i) => s === restored.strokes[i]) ? back : `${back}, then ${describeChange(as(restored.strokes), as(strokes)).toLowerCase()}`;
  };
  // A picture edit running or waiting for Keep / Try again / Discard locks the brush (its strokes and mark were sent).
  const locked = edit.busy || !!edit.result || edit.keeping;
  const finish = useRef(() => {});
  finish.current = () => {
    if (locked) return;
    if (changed) onEdits((e) => { const { [name]: _old, ...rest } = e; return strokes.length ? { ...rest, [name]: { fp, strokes } } : rest; }, visitLabel());
    onClose();
  };
  const cancel = () => { if (!changed || window.confirm('Close without the changes made now?')) onClose(); };
  useEscape(true, () => finish.current());
  // The area selected for a picture edit (drawing units), as saved with the design for this picture.
  const [selection, setSelection] = useState<MarkStroke[]>(() => {
    const saved = parsePictureMarks(values[PICTURE_MARKS_KEY])[name];
    return saved && saved.fp === fp ? saved.mark.strokes : [];
  });
  const select = (next: MarkStroke[]) => { setSelection(next); onMark(next.length ? { strokes: next } : null); };
  useEscape(selection.length > 0 && !locked, () => select([]));
  // (While locked, Escape does nothing: the result is dropped with Discard.)
  useEscape(locked, () => {});
  // Closing the editor stops the edit under way, or drops its result.
  const discard = useRef(edit.discard);
  discard.current = edit.discard;
  useEffect(() => () => discard.current(), []);

  const colours = useMemo(() => drawingColors(drawing), [drawing]);
  const names = useMemo(() => colourNames(colours, parts), [colours, parts]);
  const [colour, setColour] = useState(() => defaultColors(drawing)?.[0] ?? colours[0] ?? '');
  const label = (c: string) => names[c] || c || 'No colour';
  // Where the drawing lies on the model as built (measured with the paint it was built with); null
  // when the model's layout doesn't match it: then the picture shows as traced.
  const reg = useMemo(() => {
    const own = new Set(colours);
    const painted = initial.filter((st) => st.mode === 'paint' && own.has(st.color))
      .map((st) => ({ rule: 'NonZero' as const, contours: strokeContours(st), color: st.color, edit: 'paint' as const }));
    return registerDrawing(painted.length ? { ...drawing, shapes: [...drawing.shapes, ...painted] } : drawing, parts);
  }, [drawing, colours, initial, parts]);
  const built = useMemo(() => (reg ? builtView(parts) : null), [reg, parts]);
  const matched = useMemo(() => (reg && built ? { reg, built } : null), [reg, built]);
  // Each colour's part (-1: none) and the colour it shows in.
  const shade = useMemo(() => new Map(colours.map((c) => { const i = nearestPart(c, parts); return [c, { part: i, color: i < 0 ? c : parts[i].color }]; })), [colours, parts]);
  // Millimetres per drawing unit: from where the drawing lies on the model, else the parts in the
  // picture's raised colours against them (else the whole model).
  const k = useMemo(() => {
    if (reg && built) return reg.k;
    const raised = defaultColors(drawing) ?? colours;
    const own = parts.filter((p) => raised.some((c) => names[c] === p.name));
    const box = own.length ? own.reduce<Box3>((b, p) => ({ min: [0, 1, 2].map((i) => Math.min(b.min[i], p.bbox.min[i])) as Box3['min'], max: [0, 1, 2].map((i) => Math.max(b.max[i], p.bbox.max[i])) as Box3['max'] }), own[0].bbox) : result.bbox;
    return mmPerUnit(drawing, box);
  }, [drawing, colours, names, parts, result.bbox, reg, built]);
  const [tool, setTool] = useState<Tool>('paint');
  const selecting = tool === 'select';
  const unit = selecting ? (k ? SEL_MM : SEL_PCT) : k ? MM : PCT, per = k ?? 100;
  // The brush widths in drawing units: painting and erasing, and selecting.
  const [widths, setWidths] = useState(() => ({ brush: (k ? MM : PCT).start / per, select: (k ? SEL_MM : SEL_PCT).start / per }));
  const width = selecting ? widths.select : widths.brush;
  const setWidth = (f: number | ((w: number) => number)) => setWidths((w) => {
    const key = selecting ? 'select' : 'brush';
    return { ...w, [key]: typeof f === 'function' ? f(w[key]) : f };
  });
  const [shape, setShape] = useState<'round' | 'square'>('round');
  const square = shape === 'square';
  const [hist, setHist] = useState<{ undo: Snap[]; redo: Snap[] }>({ undo: [], redo: [] });
  const [note, setNote] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const touch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);

  const box = useMemo(() => pictureBox(drawing), [drawing]);
  const paths = useMemo(() => shapePaths(drawing), [drawing]);
  const layers = useMemo(() => colours.map((c) => ({ colour: c, ops: colourOps(drawing, strokes, c) })), [drawing, colours, strokes]);
  // The model was built with the strokes the editor opened with: the ones after those are drawn
  // over it; when some of those were taken away (undo, clear), that shows only once it is built.
  const kept = useMemo(() => { let i = 0; while (i < initial.length && i < strokes.length && strokes[i] === initial[i]) i++; return i; }, [initial, strokes]);
  const fresh = useMemo(() => strokes.slice(kept), [strokes, kept]);
  // What the view fits: the picture, and the model when it is shown (drawing units).
  const fitBox = useMemo(() => {
    const a = drawing.aspect / 2;
    if (!matched) return { x0: -a, y0: -0.5, x1: a, y1: 0.5 };
    const { reg: r, built: { box: b } } = matched;
    return { x0: Math.min(-a, (b.x0 - r.tx) / r.k), y0: Math.min(-0.5, (b.y0 - r.ty) / r.k), x1: Math.max(a, (b.x1 - r.tx) / r.k), y1: Math.max(0.5, (b.y1 - r.ty) / r.k) };
  }, [drawing, matched]);

  const stage = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const scratch = useRef<HTMLCanvasElement[]>([]);
  /** Screen pixels per drawing unit, and the point at the stage's centre. */
  const view = useRef({ s: 1, cx: 0, cy: 0, fitted: false });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  /** What the pointer is doing; the stroke being drawn (drawing units); the pointer's place (screen px). */
  const act = useRef<{ mode: 'idle' | 'draw' | 'pan' | 'pinch'; id: number; points: Pt[]; last: Pt; pinch?: { d: number; at: Pt; s: number } }>({ mode: 'idle', id: -1, points: [], last: [0, 0] });
  const pointers = useRef(new Map<number, Pt>());
  const hover = useRef<{ at: Pt; show: boolean }>({ at: [0, 0], show: false });
  const space = useRef(false);
  // The colour the picked one shows in.
  const ink = (matched ? shade.get(colour)?.color : colour) || '#000';
  // The latest of everything the pointer and key handlers and the painting use.
  const now = useRef({ tool, width, square, colour, ink, strokes, restored, hist, layers, matched, fresh, shade, fitBox, selection, locked });
  now.current = { tool, width, square, colour, ink, strokes, restored, hist, layers, matched, fresh, shade, fitBox, selection, locked };
  /** The selection put together off screen (where strokes cross it is no darker). */
  const selLayer = useRef<HTMLCanvasElement | null>(null);

  // Focus moves into the editor (its keys) and back where it was when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => before?.focus();
  }, []);

  // ---- the view: drawing units to screen
  const toUnits = (x: number, y: number): Pt => {
    const v = view.current, { w, h } = size.current;
    return [v.cx + (x - w / 2) / v.s, v.cy - (y - h / 2) / v.s];
  };
  const matrix = (): [number, number, number, number, number, number] => {
    const v = view.current, { w, h, dpr } = size.current;
    return [dpr * v.s, 0, 0, -dpr * v.s, dpr * (w / 2 - v.cx * v.s), dpr * (h / 2 + v.cy * v.s)];
  };
  const fitScale = () => {
    const { w, h } = size.current, b = now.current.fitBox;
    if (!w || !h) return 1;
    const pad = Math.min(48, Math.min(w, h) * 0.08);
    return Math.min((w - 2 * pad) / (b.x1 - b.x0), (h - 2 * pad) / (b.y1 - b.y0));
  };

  // ---- painting: the model as built with this session's strokes (or the picture with the strokes; redrawn when the view or the strokes
  // change, the model as a quick bitmap while the view moves), and the stroke being drawn and the brush over it
  const raf = useRef({ base: 0, over: 0 });
  /** The view is moving (the quick bitmap is up). */
  const moving = useRef(false);
  const crispTimer = useRef(0);
  /** The model with the strokes as a bitmap (drawing units: from x0, y1 down, r pixels per unit), kept while they stay the same. */
  const quick = useRef<{ key: unknown[]; canvas: HTMLCanvasElement; tmp: HTMLCanvasElement; x0: number; y1: number; r: number } | null>(null);
  const paintBase = useCallback(() => {
    const ctx = base.current?.getContext('2d');
    if (!ctx) return;
    const { matched: mt, fresh: st, shade: sh, fitBox: fb } = now.current;
    const partOf = (c: string) => sh.get(c)?.part ?? -1, colourOf = (c: string) => sh.get(c)?.color ?? c;
    if (!mt) drawPicture(ctx, now.current.layers, paths, box, matrix(), scratch.current);
    else if (!moving.current) drawBuilt(ctx, mt.built, mt.reg, st, partOf, colourOf, box, matrix(), (scratch.current[0] ??= document.createElement('canvas')));
    else {
      const key = [mt, st, sh, fb];
      let q = quick.current;
      if (!q || q.key.some((v, i) => v !== key[i])) {
        const W = fb.x1 - fb.x0, H = fb.y1 - fb.y0, r = Math.sqrt(QUICK_PX / (W * H));
        const canvas = q?.canvas ?? document.createElement('canvas'), tmp = q?.tmp ?? document.createElement('canvas');
        canvas.width = Math.ceil(W * r); canvas.height = Math.ceil(H * r);
        q = quick.current = { key, canvas, tmp, x0: fb.x0, y1: fb.y1, r };
        drawBuilt(canvas.getContext('2d')!, mt.built, mt.reg, st, partOf, colourOf, box, [r, 0, 0, -r, -fb.x0 * r, fb.y1 * r], tmp);
      }
      const m = matrix();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = BACKDROP;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.imageSmoothingEnabled = m[0] < q.r * 2;
      ctx.drawImage(q.canvas, m[0] * q.x0 + m[4], m[3] * q.y1 + m[5], (m[0] * q.canvas.width) / q.r, (m[0] * q.canvas.height) / q.r);
    }
    // The box paint stays inside, faintly.
    if (!box) return;
    ctx.setTransform(...matrix());
    ctx.beginPath(); ctx.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = '#0000004d'; ctx.lineWidth = size.current.dpr; ctx.setLineDash([5 * size.current.dpr, 4 * size.current.dpr]);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [paths, box]);
  const paintOver = useCallback(() => {
    const c = over.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const v = view.current, { dpr } = size.current, n = now.current, a = act.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(...matrix());
    const live = a.mode === 'draw' && a.points.length ? { width: n.width, points: a.points, ...(n.square ? { shape: 'square' as const } : {}) } : null;
    // The area selected (with the stroke adding to it), see-through: drawn whole off screen.
    const sel = [...n.selection, ...(live && n.tool === 'select' ? [live] : [])];
    if (sel.length) {
      const S = (selLayer.current ??= document.createElement('canvas'));
      if (S.width !== c.width || S.height !== c.height) { S.width = c.width; S.height = c.height; }
      const sctx = S.getContext('2d')!;
      sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.clearRect(0, 0, S.width, S.height);
      sctx.setTransform(...matrix());
      for (const st of sel) strokeOn(sctx, { mode: 'clear', ...st }, SELECT[0]);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = SELECT[1]; ctx.drawImage(S, 0, 0); ctx.globalAlpha = 1;
      ctx.setTransform(...matrix());
    }
    if (live && n.tool !== 'select') {
      // The stroke being drawn: paint in its colour (inside the box, as it will be), erasing in red.
      const st = { mode: n.tool, ...live };
      if (n.tool === 'erase') strokeOn(ctx, st, ERASE);
      else if (box) {
        ctx.save();
        ctx.beginPath(); ctx.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0); ctx.clip();
        strokeOn(ctx, st, n.ink);
        ctx.restore();
      }
    }
    // The brush, screen sized.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (hover.current.show && a.mode !== 'pan' && a.mode !== 'pinch' && !space.current && !n.locked) {
      const [x, y] = hover.current.at, r = Math.max(1.5, (n.width / 2) * v.s);
      const mark = n.tool === 'erase' ? '#c0392b' : n.tool === 'select' ? SELECT_RING : n.ink;
      const outline = (color: string, lw: number) => {
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
        if (n.square) ctx.rect(x - r, y - r, 2 * r, 2 * r); else ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.stroke();
      };
      // (Edged light and dark: a white or a black brush shows on any colour.)
      outline('#ffffffcc', 4.4); outline('#1d1d1f', 2.6); outline(mark, 1.2);
      ctx.fillStyle = mark;
      ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
  }, [box]);
  const repaintOver = useCallback(() => {
    cancelAnimationFrame(raf.current.over);
    raf.current.over = requestAnimationFrame(paintOver);
  }, [paintOver]);
  const repaint = useCallback(() => {
    cancelAnimationFrame(raf.current.base);
    raf.current.base = requestAnimationFrame(() => { paintBase(); paintOver(); });
  }, [paintBase, paintOver]);
  /** The view moved: the model as a quick bitmap at once, sharp once it rests (the picture is sharp at once). */
  const viewChanged = useCallback(() => {
    if (now.current.matched) {
      moving.current = true;
      clearTimeout(crispTimer.current);
      crispTimer.current = window.setTimeout(() => { moving.current = false; repaint(); }, 120);
    }
    repaint();
    setZoom(view.current.s);
  }, [repaint]);
  const fit = useCallback(() => {
    if (!size.current.w || !size.current.h) return;
    const b = now.current.fitBox;
    view.current = { s: fitScale(), cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, fitted: true };
    viewChanged();
  }, [viewChanged]);
  /** Zoom by `f` keeping the point under screen point `at` in place. */
  const zoomAt = useCallback((f: number, at?: Pt) => {
    const { w, h } = size.current;
    const p = at ?? [w / 2, h / 2];
    const m = toUnits(...p), v = view.current;
    const s = clamp(v.s * f, fitScale() / 4, MAX_ZOOM * per);
    view.current = { ...v, s, cx: m[0] - (p[0] - w / 2) / s, cy: m[1] + (p[1] - h / 2) / s };
    viewChanged();
  }, [viewChanged, per]);

  // The stage's size, at the screen's pixel density.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height, dpr };
      for (const c of [base.current, over.current]) if (c) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
      if (!view.current.fitted) fit(); else repaint();
    });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(raf.current.base); cancelAnimationFrame(raf.current.over); clearTimeout(crispTimer.current); };
  }, [fit, repaint]);
  useEffect(repaint, [layers, fresh, matched, repaint]);
  useEffect(repaintOver, [tool, width, square, colour, selection, locked, repaintOver]);

  // ---- strokes (Undo and Redo step through the lists of strokes)
  const change = (next: ArtworkStroke[], back = now.current.restored) => {
    const cur: Snap = { strokes: now.current.strokes, restored: now.current.restored };
    setHist((h) => ({ undo: [...h.undo, cur], redo: [] }));
    setStrokes(next);
    setRestored(back);
  };
  const go = (to: Snap) => { setStrokes(to.strokes); setRestored(to.restored); };
  const undo = () => {
    const { hist: h, strokes: cur, restored: r } = now.current;
    if (!h.undo.length) return;
    setHist({ undo: h.undo.slice(0, -1), redo: [...h.redo, { strokes: cur, restored: r }] });
    go(h.undo[h.undo.length - 1]);
  };
  const redo = () => {
    const { hist: h, strokes: cur, restored: r } = now.current;
    if (!h.redo.length) return;
    setHist({ undo: [...h.undo, { strokes: cur, restored: r }], redo: h.redo.slice(0, -1) });
    go(h.redo[h.redo.length - 1]);
  };
  /**
   * Back to a restore point: the strokes as they were before it (one step to undo). Those the
   * model was built with stay the same strokes, so only what differs shows over it.
   */
  const restoreTo = (to: ArtworkEdits, at: number) => {
    const list = parseArtworkEdits(to)[name]?.strokes ?? [];
    let p = 0;
    while (p < list.length && p < initial.length && JSON.stringify(list[p]) === JSON.stringify(initial[p])) p++;
    const next = [...initial.slice(0, p), ...list.slice(p)];
    change(next, { at, strokes: next });
    setNote(null);
  };
  const clearAll = () => { if (window.confirm(`Clear all ${strokes.length} hand edits of this picture?`)) change([]); };
  const commit = () => {
    const a = act.current, n = now.current;
    a.mode = 'idle';
    if (!a.points.length) return;
    // Made lean in mm (or as if the picture were 100 mm high), saved in drawing units.
    const pts = leanStroke(a.points.map(([x, y]): Pt => [x * per, y * per])).map(([x, y]): [number, number] => [round(x / per, 5), round(y / per, 5)]);
    if (n.tool === 'select') {
      // The stroke adds to the area selected (in pieces the mark can hold), saved with the design at once.
      if (n.selection.length >= MAX_ARTWORK_STROKES) { setNote(`At most ${MAX_ARTWORK_STROKES} selection strokes: deselect (Esc) and select again.`); return; }
      const st = { mode: 'paint' as const, color: '', width: round(clamp(n.width, 1e-5, 2), 5), points: pts, ...(n.square ? { shape: 'square' as const } : {}) };
      const added = splitLongStroke(st).map(({ width: w, points, shape }): MarkStroke => ({ width: w, points, ...(shape ? { shape } : {}) }));
      select([...n.selection, ...added].slice(0, MAX_ARTWORK_STROKES));
      setNote(null);
      return;
    }
    if (n.strokes.length >= MAX_ARTWORK_STROKES) { setNote(`At most ${MAX_ARTWORK_STROKES} strokes per picture: undo or clear some first.`); return; }
    const st: ArtworkStroke = { mode: n.tool === 'erase' ? 'erase' : 'paint', color: n.colour, width: round(clamp(n.width, 1e-5, 1), 5), points: pts, ...(n.square ? { shape: 'square' as const } : {}) };
    // (A very long stroke is saved as several: the build reads at most MAX_ARTWORK_POINTS per stroke.)
    change([...n.strokes, ...splitLongStroke(st)].slice(0, MAX_ARTWORK_STROKES));
    setNote(null);
  };

  // ---- pointer: one finger, the pen or the left button brushes; two fingers, the middle or right button or Space + drag pan (and pinch zooms)
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = over.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(e), a = act.current;
    if (e.button === 1 || e.button === 2) e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, p);
    hover.current = { at: p, show: e.pointerType !== 'touch' };
    if (pointers.current.size === 2 && e.pointerType === 'touch') {
      // A second finger: the stroke just begun was the start of a pinch.
      const [p0, p1] = [...pointers.current.values()];
      a.mode = 'pinch'; a.points = [];
      a.pinch = { d: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1, at: toUnits((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2), s: view.current.s };
      repaintOver();
      return;
    }
    if (pointers.current.size > 1 || a.mode !== 'idle') return;
    a.id = e.pointerId; a.last = p;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && space.current)) { a.mode = 'pan'; setPanning(true); return; }
    if (e.button !== 0 || now.current.locked) return;
    a.mode = 'draw'; a.points = [toUnits(...p)];
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
      const s = clamp(a.pinch.s * Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / a.pinch.d, fitScale() / 4, MAX_ZOOM * per);
      view.current = { ...view.current, s, cx: a.pinch.at[0] - (mid[0] - w / 2) / s, cy: a.pinch.at[1] + (mid[1] - h / 2) / s };
      viewChanged();
      return;
    }
    hover.current = { at: p, show: e.pointerType !== 'touch' || a.mode === 'draw' };
    if (a.mode === 'pan' && e.pointerId === a.id) {
      const v = view.current;
      view.current = { ...v, cx: v.cx - (p[0] - a.last[0]) / v.s, cy: v.cy + (p[1] - a.last[1]) / v.s };
      a.last = p;
      viewChanged();
      return;
    }
    if (a.mode === 'draw' && e.pointerId === a.id) {
      // Every point the pointer passed (coalesced events), for a faithful stroke.
      const evs = e.nativeEvent.getCoalescedEvents?.();
      for (const ev of evs?.length ? evs : [e.nativeEvent]) a.points.push(toUnits(...local(ev)));
    }
    repaintOver();
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = act.current;
    pointers.current.delete(e.pointerId);
    if (a.mode === 'pinch') { if (!pointers.current.size) a.mode = 'idle'; return; }
    if (e.pointerId !== a.id) return;
    if (a.mode === 'draw') { if (e.type === 'pointerup') commit(); else a.mode = 'idle'; a.points = []; }
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

  // Keys: P paint, E erase, C select, [ ] width, Q round / square brush, F fit, + - zoom, Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo,
  // Space pans. The editor is on top: the app's own keys wait (Escape closes it). While a picture
  // edit locks the brush, only the view moves.
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest('textarea, [contenteditable], input:not([type="range"])');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || typing(e.target)) return;
      e.stopPropagation();
      const key = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (key === 'z' || key === 'y')) { e.preventDefault(); if (locked) return; if (key === 'y' || e.shiftKey) redo(); else undo(); return; }
      if (ctrl || e.altKey) return;
      if (e.key === ' ') { e.preventDefault(); if (!space.current) { space.current = true; setPanning(true); repaintOver(); } return; }
      const step = (d: number) => setWidth((w) => clamp(round(w * per + d * (selecting ? 2 : 0.5), 1), unit.min, unit.max) / per);
      if (key === 'f' || key === '0') fit();
      else if (key === '+' || key === '=') zoomAt(1.25);
      else if (key === '-' || key === '_') zoomAt(0.8);
      else if (locked) return;
      else if (key === 'p') setTool('paint');
      else if (key === 'e') setTool('erase');
      else if (key === 'c') setTool('select');
      else if (key === 'q') setShape((s) => (s === 'square' ? 'round' : 'square'));
      else if (key === '[') step(-1);
      else if (key === ']') step(1);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // (Not a click on the focused button either.)
      if (e.key === ' ' && !typing(e.target)) { e.preventDefault(); space.current = false; if (act.current.mode !== 'pan') setPanning(false); repaintOver(); }
    };
    const onBlur = () => { space.current = false; setPanning(false); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true); window.removeEventListener('blur', onBlur); };
  });

  const phone = layout === 'phone';
  const shown = round(width * per, 1);
  const status = `${name}: ${strokes.length} hand edit${strokes.length === 1 ? '' : 's'}${changed ? ', built on Done' : ''}`;
  const doing = tool === 'paint' ? `paint ${label(colour)}` : tool === 'erase' ? `erase ${label(colour)}` : 'select where to edit';
  // The scale bar (when the printed size is known): a round length about 90 px long.
  const barMm = k ? niceLength((90 / zoom) * k) : 0;
  // The Edit panel: while selecting, with an area selected, or while an edit is under way.
  const editing = selecting || selection.length > 0 || locked;
  const mark = selection.length ? { strokes: selection } : null;
  return (
    <div className={`la-editor ${phone ? 'phone' : ''}`} role="dialog" aria-modal="true" aria-label="Paint the artwork" ref={dialog} tabIndex={-1}>
      <div className="la-ed-bar" role="toolbar" aria-label="Brush">
        <div className="la-ed-group" role="radiogroup" aria-label="Tool">
          <button className={`la-ed-tool ${tool === 'paint' ? 'on' : ''}`} role="radio" aria-checked={tool === 'paint'} disabled={locked} onClick={() => setTool('paint')}
            title="Paint (P): the colour picked takes over under the brush, from whatever colour was there">
            <Icon name="palette" size={15} /><span className="la-ed-label">Paint</span>
          </button>
          <button className={`la-ed-tool ${tool === 'erase' ? 'on erase' : ''}`} role="radio" aria-checked={tool === 'erase'} disabled={locked} onClick={() => setTool('erase')}
            title="Erase (E): only the colour picked goes under the brush, down to the plate; the other colours stay">
            <Icon name="eraser" size={15} /><span className="la-ed-label">Erase</span>
          </button>
          <button className={`la-ed-tool ${selecting ? 'on' : ''}`} role="radio" aria-checked={selecting} disabled={locked} onClick={() => setTool('select')}
            title="Select (C): brush over the area to change with the image model (strokes add up), then say the change; nothing selected: the whole picture">
            <Icon name="select" size={15} /><span className="la-ed-label">Select</span>
          </button>
        </div>
        <div className={`la-ed-filaments ${selecting ? 'off' : ''}`} role="radiogroup" aria-label="Colour to paint or erase">
          {colours.map((c) => (
            <button key={c} className={`la-ed-chip ${c === colour ? 'on' : ''}`} role="radio" aria-checked={c === colour} disabled={locked || selecting} onClick={() => setColour(c)} title={label(c)} aria-label={label(c)}>
              <span className="swatch" style={{ background: c || '#000' }} />
            </button>
          ))}
          <span className="la-ed-label la-ed-filament-name">{label(colour)}</span>
        </div>
        <label className="la-ed-width" title="Brush width ([ and ])">
          <span className="la-ed-label">Width</span>
          <input type="range" min={unit.min} max={unit.max} step={0.1} value={clamp(shown, unit.min, unit.max)} disabled={locked}
            aria-label={`${tool === 'paint' ? 'Paint brush' : tool === 'erase' ? 'Eraser' : 'Selection brush'} width, ${k ? 'mm' : '% of the picture height'}`}
            onChange={(e) => setWidth(Number(e.target.value) / per)} />
          <span className="mono la-ed-val">{shown.toFixed(1)} {k ? 'mm' : '%'}</span>
        </label>
        <div className="la-ed-group" role="radiogroup" aria-label="Brush shape">
          <button className={`la-ed-tool ${!square ? 'on' : ''}`} role="radio" aria-checked={!square} disabled={locked} onClick={() => setShape('round')} title="Round brush (Q)" aria-label="Round brush">
            <Icon name="round" size={15} />
          </button>
          <button className={`la-ed-tool ${square ? 'on' : ''}`} role="radio" aria-checked={square} disabled={locked} onClick={() => setShape('square')} title="Square brush (Q): a square as wide as the brush, upright" aria-label="Square brush">
            <Icon name="square" size={15} />
          </button>
        </div>
        <div className="la-ed-group">
          <button className="la-ed-tool" disabled={locked || !hist.undo.length} onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" size={15} /></button>
          <button className="la-ed-tool" disabled={locked || !hist.redo.length} onClick={redo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" size={15} /></button>
        </div>
        {!locked && (
          <EditHistory entries={history} current={savedNow} onPick={(to, e) => restoreTo(to, e.at)}
            unusable={(to) => (to[name] && to[name].fp !== fp ? 'Those edits were made on an earlier picture: they no longer fit this one' : null)} />
        )}
        {selection.length > 0 ? (
          <button className="la-ed-tool" disabled={locked} onClick={() => select([])} title="Deselect (Esc)">
            <Icon name="x" size={15} /><span className="la-ed-label">Deselect</span>
          </button>
        ) : (
          <button className="la-ed-tool" disabled={locked || !strokes.length} onClick={clearAll} title="Remove every hand edit of this picture">
            <Icon name="trash" size={15} /><span className="la-ed-label">Clear edits</span>
          </button>
        )}
        <span className="la-ed-status small" aria-live="polite" title={busy ? undefined : status}>
          {busy ? <><span className="spinner" /> updating…</> : status}
        </span>
        <button className="btn" onClick={cancel} title="Close without the changes made now">Cancel</button>
        <button className="btn primary" disabled={locked} onClick={() => finish.current()} title="Done (Esc): build the model with the edits">Done</button>
      </div>
      <div className={`la-ed-stage ${panning ? 'panning' : ''} ${editing ? 'with-edit' : ''}`} ref={stage}>
        <canvas ref={base} className="la-ed-canvas" aria-hidden />
        <canvas ref={over} className="la-ed-canvas la-ed-over" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={onLeave} onContextMenu={(e) => e.preventDefault()} aria-label={`The picture: drag to ${doing}`} />
        <div className="la-ed-notes">
          {restored && <div className="la-ed-note"><Icon name="history" size={13} /> Going back to before {historyTime(restored.at)}: Done saves it</div>}
          {!matched && <div className="la-ed-note">Showing the picture as traced: the model's layout didn't match it</div>}
          {matched && kept < initial.length && <div className="la-ed-note">Edits taken away come off the model when it is built (Done)</div>}
          {stale && <div className="la-ed-note warn"><Icon name="alert" size={13} /> Edits made on an earlier picture don't apply to this one</div>}
          {error && <div className="la-ed-note warn"><Icon name="alert" size={13} /> The model didn't build: {error}</div>}
          {note && <div className="la-ed-note">{note}</div>}
        </div>
        {k && (
          <div className="la-ed-scale" aria-label={`Scale: the bar is ${barMm} mm`}>
            <span className="la-ed-scale-bar" style={{ width: (barMm / k) * zoom }} />
            <span className="mono">{barMm} mm</span>
          </div>
        )}
        <div className="la-ed-zoom">
          <button onClick={() => zoomAt(1.25)} title="Zoom in (+)" aria-label="Zoom in"><Icon name="plus" size={15} /></button>
          <button onClick={() => zoomAt(0.8)} title="Zoom out (-)" aria-label="Zoom out"><Icon name="minus" size={15} /></button>
          <button onClick={fit} title="Fit (F)" aria-label="Fit the picture"><Icon name="fullscreen" size={15} /></button>
        </div>
        {!phone && (
          <div className="la-ed-hint small">
            {touch ? `One finger: ${doing} · two fingers move and zoom`
              : `Drag to ${doing}${selecting ? ' (strokes add up) · Esc: deselect' : ''} · Space, middle or right button: move · wheel: zoom · [ ]: width · Q: square`}
          </div>
        )}
        {editing && (
          <EditPicturePanel mark={mark} busy={edit.busy} startedAt={edit.startedAt} result={edit.result} error={edit.error} keeping={edit.keeping}
            onEdit={(change, photos) => edit.start({ mark, change, photos, draft: changed ? strokes : null })}
            onCancel={edit.cancel} onRetry={edit.retry} onDiscard={edit.discard}
            onKeep={() => { void edit.keep().then((kept) => { if (kept) onClose(); }); }} />
        )}
      </div>
    </div>
  );
}
