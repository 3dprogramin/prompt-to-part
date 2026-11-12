// The view of a picture editor (the artwork brush, a LayerTone photo's editor): picture units (1 =
// the picture's height, centred, y up) to screen, fitted to a box and moved with the wheel, the
// zoom buttons and keys, the middle or right button or Space + drag, and two fingers (pinch zooms);
// the stage's two canvases sized to it, painted once per frame; and one finger, the pen or the left
// button drawing a stroke, handed to the editor when it ends.
import { useCallback, useEffect, useRef, useState } from 'react';
import { clamp, type Pt } from '../lineart/editorDraw';
import type { Matrix } from './markCanvas';

/** A box of picture units. */
export interface ViewBox { x0: number; y0: number; x1: number; y1: number }

/** What the pointer is doing; the stroke being drawn (picture units); the pointer's place (screen px). */
export interface PointerAct { mode: 'idle' | 'draw' | 'pan' | 'pinch'; id: number; points: Pt[]; last: Pt; pinch?: { d: number; at: Pt; s: number } }

export interface PictureViewOptions {
  /** What Fit shows (read when fitting). */
  fitBox: ViewBox;
  /** The largest zoom, screen pixels per picture unit. */
  maxScale: number;
  /** Paints the picture on the base canvas, and what lies over it (strokes, the brush) on the top one. */
  paintBase: () => void;
  paintOver: () => void;
  /** Whether a stroke may start now (not while a picture edit locks the brush). */
  canDraw: () => boolean;
  /** A stroke began, and one ended (its points, picture units; never empty). */
  onDrawStart?: () => void;
  onDraw: (points: Pt[]) => void;
  /** The view moved (before it is painted again). */
  onMove?: () => void;
  /** A key the view does not use (Ctrl, Alt and Meta combinations included); Escape and keys typed in a text box never come here. */
  onKey?: (e: KeyboardEvent, key: string) => void;
}

/** The view of a picture editor; the editor renders the stage, its canvases and `pointer`'s handlers on the top one. */
export function usePictureView(o: PictureViewOptions) {
  const opts = useRef(o);
  opts.current = o;
  const stage = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  /** Screen pixels per picture unit, and the point at the stage's centre. */
  const view = useRef({ s: 1, cx: 0, cy: 0, fitted: false });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const act = useRef<PointerAct>({ mode: 'idle', id: -1, points: [], last: [0, 0] });
  const pointers = useRef(new Map<number, Pt>());
  const hover = useRef<{ at: Pt; show: boolean }>({ at: [0, 0], show: false });
  const space = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);

  // Focus moves into the editor (its keys) and back where it was when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => before?.focus();
  }, []);

  // ---- picture units to screen
  const toUnits = (x: number, y: number): Pt => {
    const v = view.current, { w, h } = size.current;
    return [v.cx + (x - w / 2) / v.s, v.cy - (y - h / 2) / v.s];
  };
  const matrix = (): Matrix => {
    const v = view.current, { w, h, dpr } = size.current;
    return [dpr * v.s, 0, 0, -dpr * v.s, dpr * (w / 2 - v.cx * v.s), dpr * (h / 2 + v.cy * v.s)];
  };
  const fitScale = () => {
    const { w, h } = size.current, b = opts.current.fitBox;
    if (!w || !h) return 1;
    const pad = Math.min(48, Math.min(w, h) * 0.08);
    return Math.min((w - 2 * pad) / (b.x1 - b.x0), (h - 2 * pad) / (b.y1 - b.y0));
  };

  // ---- painting, once per frame
  const raf = useRef({ base: 0, over: 0 });
  const repaintOver = useCallback(() => {
    cancelAnimationFrame(raf.current.over);
    raf.current.over = requestAnimationFrame(() => opts.current.paintOver());
  }, []);
  const repaint = useCallback(() => {
    cancelAnimationFrame(raf.current.base);
    raf.current.base = requestAnimationFrame(() => { opts.current.paintBase(); opts.current.paintOver(); });
  }, []);
  const viewChanged = useCallback(() => {
    opts.current.onMove?.();
    repaint();
    setZoom(view.current.s);
  }, [repaint]);
  const fit = useCallback(() => {
    if (!size.current.w || !size.current.h) return;
    const b = opts.current.fitBox;
    view.current = { s: fitScale(), cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, fitted: true };
    viewChanged();
  }, [viewChanged]);
  /** Zoom by `f` keeping the point under screen point `at` in place. */
  const zoomAt = useCallback((f: number, at?: Pt) => {
    const { w, h } = size.current;
    const p = at ?? [w / 2, h / 2];
    const m = toUnits(...p), v = view.current;
    const s = clamp(v.s * f, fitScale() / 4, opts.current.maxScale);
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
      if (!view.current.fitted) fit(); else repaint();
    });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(raf.current.base); cancelAnimationFrame(raf.current.over); };
  }, [fit, repaint]);

  // ---- pointer: one finger, the pen or the left button draws; two fingers, the middle or right button or Space + drag pan (and pinch zooms)
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = over.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
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
    if (e.button !== 0 || !opts.current.canDraw()) return;
    a.mode = 'draw'; a.points = [toUnits(...p)];
    opts.current.onDrawStart?.();
    repaintOver();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(e), a = act.current;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
    if (a.mode === 'pinch' && a.pinch) {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [p0, p1] = pts, { w, h } = size.current;
      const mid: Pt = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      const s = clamp(a.pinch.s * Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / a.pinch.d, fitScale() / 4, opts.current.maxScale);
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
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = act.current;
    pointers.current.delete(e.pointerId);
    if (a.mode === 'pinch') { if (!pointers.current.size) a.mode = 'idle'; return; }
    if (e.pointerId !== a.id) return;
    if (a.mode === 'draw') {
      const points = a.points;
      a.mode = 'idle'; a.points = [];
      // (A cancelled pointer drops the stroke.)
      if (e.type === 'pointerup' && points.length) opts.current.onDraw(points);
    } else if (a.mode === 'pan') { a.mode = 'idle'; setPanning(false); }
    if (e.pointerType === 'touch') hover.current.show = false;
    repaintOver();
  };
  const onPointerLeave = () => { if (act.current.mode !== 'draw') { hover.current.show = false; repaintOver(); } };

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

  // Keys: F fit, + - zoom, Space pans; the editor's own keys go to onKey. The editor is on top: the
  // app's own keys wait (Escape closes it).
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest('textarea, [contenteditable], input:not([type="range"])');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || typing(e.target)) return;
      e.stopPropagation();
      const key = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey || e.altKey) { opts.current.onKey?.(e, key); return; }
      if (e.key === ' ') { e.preventDefault(); if (!space.current) { space.current = true; setPanning(true); repaintOver(); } return; }
      if (key === 'f' || key === '0') fit();
      else if (key === '+' || key === '=') zoomAt(1.25);
      else if (key === '-' || key === '_') zoomAt(0.8);
      else opts.current.onKey?.(e, key);
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
  }, [fit, zoomAt, repaintOver]);

  return {
    stage, base, over, dialog, view, size, act, hover, space, zoom, panning,
    toUnits, matrix, fit, zoomAt, repaint, repaintOver,
    pointer: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onPointerLeave, onContextMenu: (e: React.MouseEvent) => e.preventDefault() },
  };
}
