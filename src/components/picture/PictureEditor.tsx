// The picture editor for a stored photo (a LayerTone picture under $images): the picture large,
// zoom and pan, Select (C) only, and the Edit panel that changes the area selected (or the whole
// picture) with the image model. Nothing here is painted: the only thing saved is the selection
// (with the design, as it is made), and a kept edit, which makes a new version.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParamValues } from '../../../shared/types';
import { layerToneLuma, type LayerToneImage } from '../../../shared/layertone';
import { MAX_ARTWORK_STROKES } from '../../../shared/artworkEdits';
import { parsePictureMarks, PICTURE_MARKS_KEY, type MarkStroke, type PictureMark } from '../../../shared/pictureEdit/mark';
import type { PictureEditUi } from '../../lib/pictureEdit';
import { useLayoutMode } from '../../hooks/useLayoutMode';
import { useEscape } from '../useEscape';
import { Icon } from '../Icon';
import { BACKDROP } from '../artwork/artworkCanvas';
import { clamp, MAX_ZOOM, round, SELECT_RING, type Pt } from '../lineart/editorDraw';
import { drawBrush, drawSelection, SEL_MM, SEL_PCT, selectionStrokes, type Matrix } from './markCanvas';
import { EditPicturePanel } from './EditPicturePanel';

interface Props {
  /** The picture as stored. */
  image: LayerToneImage;
  /** Its fingerprint, which the selection is saved with. */
  fp: string;
  /** The design's values: PICTURE_MARKS_KEY (the area selected, as it opens). */
  values: ParamValues;
  /** Millimetres per picture unit (its printed height), for the brush in mm; null: in % of the picture's height. */
  mmPerUnit: number | null;
  /** The area selected changed (null: none): saved with the design at once, so the chat can use it. */
  onMark: (mark: PictureMark | null) => void;
  /** Editing the picture with the image model, in the area selected or all of it. */
  edit: PictureEditUi;
  onClose: () => void;
}

/**
 * The stored picture large, in picture units (1 = its height, centred, y up): Select (C) brushes the
 * area to change (strokes add up, Escape deselects; saved with the design as it is made) for the
 * Edit panel. While an edit runs and its result waits for Keep / Try again / Discard, the brush is
 * locked and Escape keeps the editor open. Done (or Escape) closes it.
 */
export function PictureEditor({ image, fp, values, mmPerUnit, onMark, edit, onClose }: Props) {
  const layout = useLayoutMode();
  const name = image.name, aspect = image.width / image.height;
  // A picture edit running or waiting for Keep / Try again / Discard locks the brush.
  const locked = edit.busy || !!edit.result || edit.keeping;
  const [selection, setSelection] = useState<MarkStroke[]>(() => {
    const saved = parsePictureMarks(values[PICTURE_MARKS_KEY])[name];
    return saved && saved.fp === fp ? saved.mark.strokes : [];
  });
  const select = (next: MarkStroke[]) => { setSelection(next); onMark(next.length ? { strokes: next } : null); };
  const close = () => { if (!locked) onClose(); };
  const cancel = () => {
    // (An edit waiting for Keep goes too: ask first.)
    if (edit.result && !window.confirm('Drop the edited picture?')) return;
    onClose();
  };
  useEscape(true, close);
  useEscape(selection.length > 0 && !locked, () => select([]));
  // (While locked, Escape does nothing: the result is dropped with Discard.)
  useEscape(locked, () => {});
  // Closing the editor stops the edit under way, or drops its result.
  const discard = useRef(edit.discard);
  discard.current = edit.discard;
  useEffect(() => () => discard.current(), []);

  const per = mmPerUnit ?? 100, unit = mmPerUnit ? SEL_MM : SEL_PCT;
  const [width, setWidth] = useState(() => unit.start / per);
  const [square, setSquare] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const touch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  // The picture as a bitmap, grey.
  const picture = useMemo(() => {
    const luma = layerToneLuma(image), rgba = new Uint8ClampedArray(image.width * image.height * 4);
    for (let p = 0; p < luma.length; p++) { rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = luma[p]; rgba[p * 4 + 3] = 255; }
    const c = document.createElement('canvas');
    c.width = image.width; c.height = image.height;
    c.getContext('2d')!.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
    return c;
  }, [image]);

  const stage = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const selLayer = useRef<HTMLCanvasElement | null>(null);
  /** Screen pixels per picture unit, and the point at the stage's centre. */
  const view = useRef({ s: 1, cx: 0, cy: 0, fitted: false });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  /** What the pointer is doing; the stroke being drawn (picture units); the pointer's place (screen px). */
  const act = useRef<{ mode: 'idle' | 'draw' | 'pan' | 'pinch'; id: number; points: Pt[]; last: Pt; pinch?: { d: number; at: Pt; s: number } }>({ mode: 'idle', id: -1, points: [], last: [0, 0] });
  const pointers = useRef(new Map<number, Pt>());
  const hover = useRef<{ at: Pt; show: boolean }>({ at: [0, 0], show: false });
  const space = useRef(false);
  const now = useRef({ width, square, selection, locked });
  now.current = { width, square, selection, locked };

  // Focus moves into the editor (its keys) and back where it was when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => before?.focus();
  }, []);

  // ---- the view: picture units to screen
  const toUnits = (x: number, y: number): Pt => {
    const v = view.current, { w, h } = size.current;
    return [v.cx + (x - w / 2) / v.s, v.cy - (y - h / 2) / v.s];
  };
  const matrix = (): Matrix => {
    const v = view.current, { w, h, dpr } = size.current;
    return [dpr * v.s, 0, 0, -dpr * v.s, dpr * (w / 2 - v.cx * v.s), dpr * (h / 2 + v.cy * v.s)];
  };
  const fitScale = () => {
    const { w, h } = size.current;
    if (!w || !h) return 1;
    const pad = Math.min(48, Math.min(w, h) * 0.08);
    return Math.min((w - 2 * pad) / aspect, h - 2 * pad);
  };

  // ---- painting: the picture, and over it the selection (with the stroke being drawn) and the brush
  const raf = useRef({ base: 0, over: 0 });
  const paintBase = useCallback(() => {
    const ctx = base.current?.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const m = matrix();
    ctx.setTransform(...m);
    // Picture pixels to picture units: its top-left corner at (-aspect / 2, 0.5), rows going down.
    ctx.transform(1 / image.height, 0, 0, -1 / image.height, -aspect / 2, 0.5);
    // Sharp pixels once each is larger than a few screen pixels.
    ctx.imageSmoothingEnabled = m[0] / image.height < 3;
    ctx.drawImage(picture, 0, 0);
  }, [picture, image.height, aspect]);
  const paintOver = useCallback(() => {
    const c = over.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const v = view.current, { dpr } = size.current, n = now.current, a = act.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const live = a.mode === 'draw' && a.points.length ? [{ width: n.width, points: a.points, ...(n.square ? { shape: 'square' as const } : {}) }] : [];
    const sel = [...n.selection, ...live];
    if (sel.length) drawSelection(ctx, (selLayer.current ??= document.createElement('canvas')), matrix(), sel);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (hover.current.show && a.mode !== 'pan' && a.mode !== 'pinch' && !space.current && !n.locked) {
      drawBrush(ctx, hover.current.at, Math.max(1.5, (n.width / 2) * v.s), n.square, SELECT_RING);
    }
  }, []);
  const repaintOver = useCallback(() => {
    cancelAnimationFrame(raf.current.over);
    raf.current.over = requestAnimationFrame(paintOver);
  }, [paintOver]);
  const repaint = useCallback(() => {
    cancelAnimationFrame(raf.current.base);
    raf.current.base = requestAnimationFrame(() => { paintBase(); paintOver(); });
  }, [paintBase, paintOver]);
  const fit = useCallback(() => {
    if (!size.current.w || !size.current.h) return;
    view.current = { s: fitScale(), cx: 0, cy: 0, fitted: true };
    repaint();
  }, [repaint]);
  /** Zoom by `f` keeping the point under screen point `at` in place. */
  const zoomAt = useCallback((f: number, at?: Pt) => {
    const { w, h } = size.current;
    const p = at ?? [w / 2, h / 2];
    const m = toUnits(...p), v = view.current;
    const s = clamp(v.s * f, fitScale() / 4, MAX_ZOOM * per);
    view.current = { ...v, s, cx: m[0] - (p[0] - w / 2) / s, cy: m[1] + (p[1] - h / 2) / s };
    repaint();
  }, [repaint, per]);

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
  useEffect(repaint, [picture, repaint]);
  useEffect(repaintOver, [width, square, selection, locked, repaintOver]);

  /** The stroke drawn adds to the area selected (in pieces the mark can hold), saved with the design at once. */
  const commit = () => {
    const a = act.current, n = now.current;
    a.mode = 'idle';
    if (!a.points.length) return;
    if (n.selection.length >= MAX_ARTWORK_STROKES) { setNote(`At most ${MAX_ARTWORK_STROKES} selection strokes: deselect (Esc) and select again.`); return; }
    select([...n.selection, ...selectionStrokes(a.points, n.width, n.square, per)].slice(0, MAX_ARTWORK_STROKES));
    setNote(null);
  };

  // ---- pointer: one finger, the pen or the left button selects; two fingers, the middle or right button or Space + drag pan (and pinch zooms)
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
      repaint();
      return;
    }
    hover.current = { at: p, show: e.pointerType !== 'touch' || a.mode === 'draw' };
    if (a.mode === 'pan' && e.pointerId === a.id) {
      const v = view.current;
      view.current = { ...v, cx: v.cx - (p[0] - a.last[0]) / v.s, cy: v.cy + (p[1] - a.last[1]) / v.s };
      a.last = p;
      repaint();
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

  // Keys: C select, [ ] width, Q round / square brush, F fit, + - zoom, Space pans. The editor is on
  // top: the app's own keys wait (Escape closes it). While a picture edit locks the brush, only the view moves.
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest('textarea, [contenteditable], input:not([type="range"])');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || typing(e.target)) return;
      e.stopPropagation();
      const key = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ') { e.preventDefault(); if (!space.current) { space.current = true; setPanning(true); repaintOver(); } return; }
      const step = (d: number) => setWidth((w) => clamp(round(w * per + d * 2, 1), unit.min, unit.max) / per);
      if (key === 'f' || key === '0') fit();
      else if (key === '+' || key === '=') zoomAt(1.25);
      else if (key === '-' || key === '_') zoomAt(0.8);
      else if (locked) return;
      else if (key === 'q') setSquare((s) => !s);
      else if (key === '[') step(-1);
      else if (key === ']') step(1);
    };
    const onKeyUp = (e: KeyboardEvent) => {
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
  const mark = selection.length ? { strokes: selection } : null;
  return (
    <div className={`la-editor ${phone ? 'phone' : ''}`} role="dialog" aria-modal="true" aria-label="Edit the picture" ref={dialog} tabIndex={-1}>
      <div className="la-ed-bar" role="toolbar" aria-label="Brush">
        <div className="la-ed-group" role="radiogroup" aria-label="Tool">
          <button className="la-ed-tool on" role="radio" aria-checked disabled={locked}
            title="Select (C): brush over the area to change with the image model (strokes add up), then say the change; nothing selected: the whole picture">
            <Icon name="select" size={15} /><span className="la-ed-label">Select</span>
          </button>
        </div>
        <label className="la-ed-width" title="Brush width ([ and ])">
          <span className="la-ed-label">Width</span>
          <input type="range" min={unit.min} max={unit.max} step={0.1} value={clamp(shown, unit.min, unit.max)} disabled={locked}
            aria-label={`Selection brush width, ${mmPerUnit ? 'mm' : '% of the picture height'}`}
            onChange={(e) => setWidth(Number(e.target.value) / per)} />
          <span className="mono la-ed-val">{shown.toFixed(1)} {mmPerUnit ? 'mm' : '%'}</span>
        </label>
        <div className="la-ed-group" role="radiogroup" aria-label="Brush shape">
          <button className={`la-ed-tool ${!square ? 'on' : ''}`} role="radio" aria-checked={!square} disabled={locked} onClick={() => setSquare(false)} title="Round brush (Q)" aria-label="Round brush">
            <Icon name="round" size={15} />
          </button>
          <button className={`la-ed-tool ${square ? 'on' : ''}`} role="radio" aria-checked={square} disabled={locked} onClick={() => setSquare(true)} title="Square brush (Q): a square as wide as the brush, upright" aria-label="Square brush">
            <Icon name="square" size={15} />
          </button>
        </div>
        {selection.length > 0 && (
          <button className="la-ed-tool" disabled={locked} onClick={() => select([])} title="Deselect (Esc)">
            <Icon name="x" size={15} /><span className="la-ed-label">Deselect</span>
          </button>
        )}
        <span className="la-ed-status small" aria-live="polite">{name}: {image.width} x {image.height} pixels</span>
        <button className="btn" onClick={cancel} title="Close the picture">Cancel</button>
        <button className="btn primary" disabled={locked} onClick={close} title="Done (Esc)">Done</button>
      </div>
      <div className={`la-ed-stage with-edit ${panning ? 'panning' : ''}`} ref={stage}>
        <canvas ref={base} className="la-ed-canvas" aria-hidden />
        <canvas ref={over} className="la-ed-canvas la-ed-over" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={onLeave} onContextMenu={(e) => e.preventDefault()} aria-label="The picture: drag to select where to edit" />
        {note && <div className="la-ed-notes"><div className="la-ed-note">{note}</div></div>}
        <div className="la-ed-zoom">
          <button onClick={() => zoomAt(1.25)} title="Zoom in (+)" aria-label="Zoom in"><Icon name="plus" size={15} /></button>
          <button onClick={() => zoomAt(0.8)} title="Zoom out (-)" aria-label="Zoom out"><Icon name="minus" size={15} /></button>
          <button onClick={fit} title="Fit (F)" aria-label="Fit the picture"><Icon name="fullscreen" size={15} /></button>
        </div>
        {!phone && (
          <div className="la-ed-hint small">
            {touch ? 'One finger: select where to edit · two fingers move and zoom'
              : 'Drag to select where to edit (strokes add up) · Esc: deselect · Space, middle or right button: move · wheel: zoom · [ ]: width · Q: square'}
          </div>
        )}
        <EditPicturePanel mark={mark} busy={edit.busy} startedAt={edit.startedAt} result={edit.result} error={edit.error} keeping={edit.keeping}
          onEdit={(change, photos) => edit.start({ mark, change, photos, draft: null })}
          onCancel={edit.cancel} onRetry={edit.retry} onDiscard={edit.discard}
          onKeep={() => { void edit.keep().then((kept) => { if (kept) onClose(); }); }} />
      </div>
    </div>
  );
}
