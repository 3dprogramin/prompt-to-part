import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Box3, EvalResult, ParamValues, PartMesh } from '../../shared/types';
import { defaultColors, drawingColors, type SvgDrawing } from '../../shared/svgFeatures';
import { ARTWORK_EDITS_KEY, MAX_ARTWORK_STROKES, parseArtworkEdits, type ArtworkEdits, type ArtworkStroke } from '../../shared/artworkEdits';
import { leanStroke, niceLength } from '../lib/lineArtEdit';
import { useLayoutMode } from '../hooks/useLayoutMode';
import { useEscape } from './useEscape';
import { Icon } from './Icon';
import { clamp, ERASE, MAX_ZOOM, round, strokeOn, type Pt } from './lineart/editorDraw';
import { colourNames, colourOps, drawPicture, mmPerUnit, pictureBox, shapePaths } from './artwork/artworkCanvas';

interface Props {
  /** The drawing as attached (without hand edits), named as in the design. */
  drawing: SvgDrawing;
  /** Its fingerprint, which the edits are saved with. */
  fp: string;
  /** The design's values: ARTWORK_EDITS_KEY (the edits). */
  values: ParamValues;
  result: EvalResult;
  /** The model's parts (their colours name the drawing's, their size gives the brush in mm). */
  parts: PartMesh[];
  /** A rebuild is running. */
  busy: boolean;
  /** Why the last rebuild failed, if it did. */
  error: string | null;
  onEdits: (update: (edits: ArtworkEdits) => ArtworkEdits) => void;
  onClose: () => void;
}

type Tool = 'paint' | 'erase';
/** Brush widths: in mm when the picture's printed size is known, else in % of its height. */
const MM = { min: 0.3, max: 15, start: 2 }, PCT = { min: 0.1, max: 10, start: 1 };

/**
 * The artwork brush: the drawing flat and straight on, in its own colours, to paint one of them
 * where the brush goes (it takes over from the colours there) or erase it (only it, down to the
 * plate). The strokes are a draft until Done (or Escape) saves them in the design at once
 * (ARTWORK_EDITS_KEY, in the drawing's own units) and the model rebuilds a single time; Cancel drops them.
 */
export function ArtworkEditor({ drawing, fp, values, result, parts, busy, error, onEdits, onClose }: Props) {
  const layout = useLayoutMode();
  const name = drawing.name;
  // The strokes as the editor opened (none when they were made on an earlier picture), and as they are now.
  const [{ initial, stale }] = useState(() => {
    const saved = parseArtworkEdits(values[ARTWORK_EDITS_KEY])[name];
    return { initial: saved && saved.fp === fp ? saved.strokes : [], stale: !!saved && saved.fp !== fp };
  });
  const [strokes, setStrokes] = useState<ArtworkStroke[]>(initial);
  const changed = strokes.length !== initial.length || strokes.some((s, i) => s !== initial[i]);
  const finish = useRef(() => {});
  finish.current = () => {
    if (changed) onEdits((e) => { const { [name]: _old, ...rest } = e; return strokes.length ? { ...rest, [name]: { fp, strokes } } : rest; });
    onClose();
  };
  const cancel = () => { if (!changed || window.confirm('Close without the changes made now?')) onClose(); };
  useEscape(true, () => finish.current());

  const colours = useMemo(() => drawingColors(drawing), [drawing]);
  const names = useMemo(() => colourNames(colours, parts), [colours, parts]);
  const [colour, setColour] = useState(() => defaultColors(drawing)?.[0] ?? colours[0] ?? '');
  const label = (c: string) => names[c] || c || 'No colour';
  // Millimetres per drawing unit: the parts in the picture's raised colours against them (else the whole model).
  const k = useMemo(() => {
    const raised = defaultColors(drawing) ?? colours;
    const own = parts.filter((p) => raised.some((c) => names[c] === p.name));
    const box = own.length ? own.reduce<Box3>((b, p) => ({ min: [0, 1, 2].map((i) => Math.min(b.min[i], p.bbox.min[i])) as Box3['min'], max: [0, 1, 2].map((i) => Math.max(b.max[i], p.bbox.max[i])) as Box3['max'] }), own[0].bbox) : result.bbox;
    return mmPerUnit(drawing, box);
  }, [drawing, colours, names, parts, result.bbox]);
  const unit = k ? MM : PCT, per = k ?? 100;
  const [tool, setTool] = useState<Tool>('paint');
  // The brush width in drawing units.
  const [width, setWidth] = useState(() => unit.start / per);
  const [shape, setShape] = useState<'round' | 'square'>('round');
  const square = shape === 'square';
  const [hist, setHist] = useState<{ undo: ArtworkStroke[][]; redo: ArtworkStroke[][] }>({ undo: [], redo: [] });
  const [note, setNote] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const touch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);

  const box = useMemo(() => pictureBox(drawing), [drawing]);
  const paths = useMemo(() => shapePaths(drawing), [drawing]);
  const layers = useMemo(() => colours.map((c) => ({ colour: c, ops: colourOps(drawing, strokes, c) })), [drawing, colours, strokes]);

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
  // The latest of everything the pointer and key handlers use.
  const now = useRef({ tool, width, square, colour, strokes, hist, layers });
  now.current = { tool, width, square, colour, strokes, hist, layers };

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
    const { w, h } = size.current;
    if (!w || !h) return 1;
    const pad = Math.min(48, Math.min(w, h) * 0.08);
    return Math.min((w - 2 * pad) / drawing.aspect, h - 2 * pad);
  };

  // ---- painting: the picture with the strokes (redrawn when the view or the strokes change), and the stroke being drawn and the brush over it
  const raf = useRef({ base: 0, over: 0 });
  const paintBase = useCallback(() => {
    const ctx = base.current?.getContext('2d');
    if (!ctx) return;
    drawPicture(ctx, now.current.layers, paths, box, matrix(), scratch.current);
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
    if (a.mode === 'draw' && a.points.length) {
      // The stroke being drawn: paint in its colour (inside the box, as it will be), erasing in red.
      const st = { mode: n.tool, width: n.width, points: a.points, ...(n.square ? { shape: 'square' as const } : {}) };
      if (n.tool === 'erase') strokeOn(ctx, st, ERASE);
      else if (box) {
        ctx.save();
        ctx.beginPath(); ctx.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0); ctx.clip();
        strokeOn(ctx, st, n.colour || '#000');
        ctx.restore();
      }
    }
    // The brush, screen sized.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (hover.current.show && a.mode !== 'pan' && a.mode !== 'pinch' && !space.current) {
      const [x, y] = hover.current.at, r = Math.max(1.5, (n.width / 2) * v.s);
      const mark = n.tool === 'erase' ? '#c0392b' : n.colour || '#1d1d1f';
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
  const viewChanged = useCallback(() => { repaint(); setZoom(view.current.s); }, [repaint]);
  const fit = useCallback(() => {
    if (!size.current.w || !size.current.h) return;
    view.current = { s: fitScale(), cx: 0, cy: 0, fitted: true };
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
    return () => { ro.disconnect(); cancelAnimationFrame(raf.current.base); cancelAnimationFrame(raf.current.over); };
  }, [fit, repaint]);
  useEffect(repaint, [layers, repaint]);
  useEffect(repaintOver, [tool, width, square, colour, repaintOver]);

  // ---- strokes (Undo and Redo step through the lists of strokes)
  const change = (next: ArtworkStroke[]) => {
    const cur = now.current.strokes;
    setHist((h) => ({ undo: [...h.undo, cur], redo: [] }));
    setStrokes(next);
  };
  const undo = () => {
    const { hist: h, strokes: cur } = now.current;
    if (!h.undo.length) return;
    setHist({ undo: h.undo.slice(0, -1), redo: [...h.redo, cur] });
    setStrokes(h.undo[h.undo.length - 1]);
  };
  const redo = () => {
    const { hist: h, strokes: cur } = now.current;
    if (!h.redo.length) return;
    setHist({ undo: [...h.undo, cur], redo: h.redo.slice(0, -1) });
    setStrokes(h.redo[h.redo.length - 1]);
  };
  const clearAll = () => { if (window.confirm(`Clear all ${strokes.length} hand edits of this picture?`)) change([]); };
  const commit = () => {
    const a = act.current, n = now.current;
    a.mode = 'idle';
    if (!a.points.length) return;
    if (n.strokes.length >= MAX_ARTWORK_STROKES) { setNote(`At most ${MAX_ARTWORK_STROKES} strokes per picture: undo or clear some first.`); return; }
    // Made lean in mm (or as if the picture were 100 mm high), saved in drawing units.
    const pts = leanStroke(a.points.map(([x, y]): Pt => [x * per, y * per])).map(([x, y]): [number, number] => [round(x / per, 5), round(y / per, 5)]);
    const st: ArtworkStroke = { mode: n.tool, color: n.colour, width: round(clamp(n.width, 1e-5, 1), 5), points: pts, ...(n.square ? { shape: 'square' as const } : {}) };
    change([...n.strokes, st]);
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
    if (e.button !== 0) return;
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

  // Keys: P paint, E erase, [ ] width, Q round / square brush, F fit, + - zoom, Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo,
  // Space pans. The editor is on top: the app's own keys wait (Escape closes it).
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest('textarea, [contenteditable], input:not([type="range"])');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || typing(e.target)) return;
      e.stopPropagation();
      const key = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (key === 'z' || key === 'y')) { e.preventDefault(); if (key === 'y' || e.shiftKey) redo(); else undo(); return; }
      if (ctrl || e.altKey) return;
      if (e.key === ' ') { e.preventDefault(); if (!space.current) { space.current = true; setPanning(true); repaintOver(); } return; }
      const step = (d: number) => setWidth((w) => clamp(round(w * per + d * 0.5, 1), unit.min, unit.max) / per);
      if (key === 'p') setTool('paint');
      else if (key === 'e') setTool('erase');
      else if (key === 'q') setShape((s) => (s === 'square' ? 'round' : 'square'));
      else if (key === 'f' || key === '0') fit();
      else if (key === '+' || key === '=') zoomAt(1.25);
      else if (key === '-' || key === '_') zoomAt(0.8);
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
  const doing = tool === 'paint' ? `paint ${label(colour)}` : `erase ${label(colour)}`;
  // The scale bar (when the printed size is known): a round length about 90 px long.
  const barMm = k ? niceLength((90 / zoom) * k) : 0;
  return (
    <div className={`la-editor ${phone ? 'phone' : ''}`} role="dialog" aria-modal="true" aria-label="Paint the artwork" ref={dialog} tabIndex={-1}>
      <div className="la-ed-bar" role="toolbar" aria-label="Brush">
        <div className="la-ed-group" role="radiogroup" aria-label="Tool">
          <button className={`la-ed-tool ${tool === 'paint' ? 'on' : ''}`} role="radio" aria-checked={tool === 'paint'} onClick={() => setTool('paint')}
            title="Paint (P): the colour picked takes over under the brush, from whatever colour was there">
            <Icon name="palette" size={15} /><span className="la-ed-label">Paint</span>
          </button>
          <button className={`la-ed-tool ${tool === 'erase' ? 'on erase' : ''}`} role="radio" aria-checked={tool === 'erase'} onClick={() => setTool('erase')}
            title="Erase (E): only the colour picked goes under the brush, down to the plate; the other colours stay">
            <Icon name="eraser" size={15} /><span className="la-ed-label">Erase</span>
          </button>
        </div>
        <div className="la-ed-filaments" role="radiogroup" aria-label="Colour to paint or erase">
          {colours.map((c) => (
            <button key={c} className={`la-ed-chip ${c === colour ? 'on' : ''}`} role="radio" aria-checked={c === colour} onClick={() => setColour(c)} title={label(c)} aria-label={label(c)}>
              <span className="swatch" style={{ background: c || '#000' }} />
            </button>
          ))}
          <span className="la-ed-label la-ed-filament-name">{label(colour)}</span>
        </div>
        <label className="la-ed-width" title="Brush width ([ and ])">
          <span className="la-ed-label">Width</span>
          <input type="range" min={unit.min} max={unit.max} step={0.1} value={clamp(shown, unit.min, unit.max)} aria-label={`${tool === 'paint' ? 'Paint brush' : 'Eraser'} width, ${k ? 'mm' : '% of the picture height'}`}
            onChange={(e) => setWidth(Number(e.target.value) / per)} />
          <span className="mono la-ed-val">{shown.toFixed(1)} {k ? 'mm' : '%'}</span>
        </label>
        <div className="la-ed-group" role="radiogroup" aria-label="Brush shape">
          <button className={`la-ed-tool ${!square ? 'on' : ''}`} role="radio" aria-checked={!square} onClick={() => setShape('round')} title="Round brush (Q)" aria-label="Round brush">
            <Icon name="round" size={15} />
          </button>
          <button className={`la-ed-tool ${square ? 'on' : ''}`} role="radio" aria-checked={square} onClick={() => setShape('square')} title="Square brush (Q): a square as wide as the brush, upright" aria-label="Square brush">
            <Icon name="square" size={15} />
          </button>
        </div>
        <div className="la-ed-group">
          <button className="la-ed-tool" disabled={!hist.undo.length} onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" size={15} /></button>
          <button className="la-ed-tool" disabled={!hist.redo.length} onClick={redo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" size={15} /></button>
        </div>
        <button className="la-ed-tool" disabled={!strokes.length} onClick={clearAll} title="Remove every hand edit of this picture">
          <Icon name="trash" size={15} /><span className="la-ed-label">Clear edits</span>
        </button>
        <span className="la-ed-status small" aria-live="polite" title={busy ? undefined : status}>
          {busy ? <><span className="spinner" /> updating…</> : status}
        </span>
        <button className="btn" onClick={cancel} title="Close without the changes made now">Cancel</button>
        <button className="btn primary" onClick={() => finish.current()} title="Done (Esc): build the model with the edits">Done</button>
      </div>
      <div className={`la-ed-stage ${panning ? 'panning' : ''}`} ref={stage}>
        <canvas ref={base} className="la-ed-canvas" aria-hidden />
        <canvas ref={over} className="la-ed-canvas la-ed-over" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={onLeave} onContextMenu={(e) => e.preventDefault()} aria-label={`The picture: drag to ${doing}`} />
        <div className="la-ed-notes">
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
              : `Drag to ${doing} · Space, middle or right button: move · wheel: zoom · [ ]: width · Q: square`}
          </div>
        )}
      </div>
    </div>
  );
}
