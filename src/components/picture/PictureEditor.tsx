// The picture editor for a stored photo (a LayerTone picture under $images): the picture large,
// zoom and pan, Select only, and the Edit panel that changes the area selected (or the whole
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
import { drawBrush, drawSelection, SEL_MM, SEL_PCT, selectionStrokes } from './markCanvas';
import { usePictureView } from './usePictureView';
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
 * The stored picture large, in picture units (1 = its height, centred, y up): Select brushes the
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
  const selLayer = useRef<HTMLCanvasElement | null>(null);
  const now = useRef({ width, square, selection, locked });
  now.current = { width, square, selection, locked };

  // ---- the view: picture units to screen. Keys: [ ] width, Q round / square brush (the view's own:
  // F, + -, Space); while a picture edit locks the brush, only the view moves.
  const { stage, base, over, dialog, view, size, act, hover, space, panning, matrix, fit, zoomAt, repaint, repaintOver, pointer } = usePictureView({
    fitBox: { x0: -aspect / 2, y0: -0.5, x1: aspect / 2, y1: 0.5 }, maxScale: MAX_ZOOM * per,
    paintBase: () => paintBase(), paintOver: () => paintOver(),
    canDraw: () => !now.current.locked,
    onDrawStart: () => setNote(null),
    onDraw: (points) => commit(points),
    onKey: (e, key) => {
      if (e.ctrlKey || e.metaKey || e.altKey || locked) return;
      const step = (d: number) => setWidth((w) => clamp(round(w * per + d * 2, 1), unit.min, unit.max) / per);
      if (key === 'q') setSquare((sq) => !sq);
      else if (key === '[') step(-1);
      else if (key === ']') step(1);
    },
  });

  // ---- painting: the picture, and over it the selection (with the stroke being drawn) and the brush
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
  useEffect(repaint, [paintBase, repaint]);
  useEffect(repaintOver, [width, square, selection, locked, repaintOver]);

  /** The stroke drawn adds to the area selected (in pieces the mark can hold), saved with the design at once. */
  const commit = (points: Pt[]) => {
    const n = now.current;
    if (n.selection.length >= MAX_ARTWORK_STROKES) { setNote(`At most ${MAX_ARTWORK_STROKES} selection strokes: deselect (Esc) and select again.`); return; }
    select([...n.selection, ...selectionStrokes(points, n.width, n.square, per)].slice(0, MAX_ARTWORK_STROKES));
    setNote(null);
  };

  const phone = layout === 'phone';
  const shown = round(width * per, 1);
  const mark = selection.length ? { strokes: selection } : null;
  return (
    <div className={`la-editor ${phone ? 'phone' : ''}`} role="dialog" aria-modal="true" aria-label="Edit the picture" ref={dialog} tabIndex={-1}>
      <div className="la-ed-bar" role="toolbar" aria-label="Brush">
        <div className="la-ed-group" role="radiogroup" aria-label="Tool">
          <button className="la-ed-tool on" role="radio" aria-checked disabled={locked}
            title="Select: brush over the area to change with the image model (strokes add up), then say the change; nothing selected: the whole picture">
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
        <canvas ref={over} className="la-ed-canvas la-ed-over" {...pointer} aria-label="The picture: drag to select where to edit" />
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
