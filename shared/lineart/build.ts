// H.lineart: the drawing cleaned up at its final size, made into the piece with its style's bar,
// frame, hooks or stand, coloured and split as the user set.
import type { PartFilament } from '../params';
import { parseSplitSpec, seamAt, splitGrid, type SplitSpec } from '../split';
import { maxPiece, printer } from '../printer';
import { colourBottom, colourLayers, depthLayers, filamentTd, type LineArtPaint, type PaintMaterial } from './depth';
import { DEFAULT_LINE_ART_STYLE, isLineArtStyle, LINE_ART_STYLES, type LineArtDeps, type LineArtInfo, type LineArtOptions, lineArtPrint, type LineArtResult, type LineArtSplitInfo } from './info';
import { band, lineArtMask } from './mask';
import { squareOutlines, strokeOutlines } from './outlines';
import { type Coloured, colourLines, handEdits, type HandOp, LAYER_TIDY, MIN_BODY, MIN_PAINT, PAINT_CLEAN, PAINT_REACH, SLOT_OUT, SPIKE, TIDY_MITER } from './paint';
import { anchorWord, LABEL_DEPTH, layoutOffsets, SPLIT_MIN_PART, SPLIT_RESERVE, splitInfo, splitPieces, type SplitResult } from './pieces';
import { type LineArtGrid, MAX_PIXELS, type Pt, rasterize } from './raster';
import { DEFAULT_JOIN_ENDS, DEFAULT_SPLIT_JOIN, LINEART_LAYOUTS, MAX_JOIN_MARKS, MAX_LINEART_SIZE } from './settings';
import { filamentKey, FILL_WIDTH, type LineArtStroke } from './strokes';
import { traceMask } from './trace';

// ---------------------------------------------------------------------------
// The piece
// ---------------------------------------------------------------------------

/** Recent traced results: a live preview evaluates the same drawing on every slider move. */
const cache = new Map<string, { loops: Pt[][]; paths: Pt[][]; bridges: number; longestBridge: number; dropped: number; closed: number; openings: number; endsJoined: number; endsFree: number; joins: Pt[][]; loose: Pt[] }>();
const CACHE_SIZE = 6;

/** The chosen printer's bed, as "the Bambu Lab A1's 256 mm bed" in notes. */
const bedName = () => { const [w, d] = printer().bed; return `${printer().name}'s ${w === d ? w : `${w} × ${d}`} mm bed`; };
/** The largest piece H.lineart makes (split into pieces that fit the bed), mm. */
const MAX_SIZE = 3000;

export function buildLineArt(d: LineArtDeps, source: string | string[], opts: LineArtOptions = {}): LineArtResult {
  // The size the user typed wins: a width alone frees the height (it follows the drawing), a
  // height alone sets the largest width, so the height decides.
  const scriptOpts = opts;
  if (d.size) opts = { ...opts, width: d.size.width ?? MAX_LINEART_SIZE, height: d.size.height };
  // Both sides typed: a frame's box or a medallion's oval is exactly that size, the art fitted inside.
  const exact = d.size?.width && d.size.height ? { w: d.size.width, h: d.size.height } : null;
  const { M, C } = d;
  const names = Array.isArray(source) ? source : [source];
  if (!names.length || names.length > 8 || !names.every((n) => typeof n === 'string')) throw new Error('H.lineart: give a drawing name or a list of 1–8 names');
  const style = opts.style ?? DEFAULT_LINE_ART_STYLE;
  if (!isLineArtStyle(style)) throw new Error(`H.lineart: style must be one of ${LINE_ART_STYLES.map((s) => `'${s}'`).join(', ')}`);
  const num = <K extends keyof LineArtOptions>(k: K, def: number, min: number, max: number): number => {
    const v = opts[k] ?? def;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`H.lineart: ${k} must be a number from ${min} to ${max}`);
    return v;
  };
  const bar = style === 'keyholder' || style === 'sign' || style === 'stand';
  const width = num('width', 200, 20, MAX_SIZE);
  const thickness = num('thickness', 2, 0.6, 20);
  const lineWidth = num('lineWidth', 1, 0.4, 10);
  const lines = opts.lines === 'even' ? 'even' : 'keep';
  const fill = num('fill', 3 * lineWidth, lineWidth, 200);
  const minIsland = num('minIsland', 4 * lineWidth * lineWidth, 0, 10000);
  const gap = num('gap', 0, -500, 500);
  const joinEnds = d.ends ?? num('joinEnds', DEFAULT_JOIN_ENDS, 0, 50);
  const barHeight = num('barHeight', style === 'sign' ? 16 : 12, 3, 200);
  const barThickness = num('barThickness', style === 'keyholder' ? 4 : style === 'stand' ? thickness : thickness + 1, 0.6, 30);
  const overhang = num('overhang', 6, 0, 200);
  const frameWidth = num('frameWidth', 4, 0.8, 100);
  const frameThickness = num('frameThickness', thickness + 1, 0.6, 30);
  const padding = num('padding', 0, 0, 200);
  const color = typeof opts.color === 'string' ? opts.color : '#1d1d1f';
  const segs = d.quality === 'draft' ? 48 : d.quality === 'normal' ? 96 : 160;

  // The drawings side by side at the same height (1 unit), bottoms on y = 0.
  const units = names.map((n) => {
    const cs = d.section(n, opts.colors);
    const b = cs.bounds();
    const h = b.max[1] - b.min[1];
    if (!(h > 0)) throw new Error(`H.lineart: drawing "${n}" is empty`);
    return { name: n, cs: cs.translate([-b.min[0], -b.min[1]]).scale(1 / h), w: (b.max[0] - b.min[0]) / h, bx: b.min[0], by: b.min[1], h, edits: d.edits(n) };
  });
  // Where each drawing lands in the piece (drawing units → mm), followed through the layout.
  const frames: LineArtInfo['frames'] = [];
  // A stroke's width follows the piece's size: as wide on the drawing as it was drawn, at its `k`
  // (the mm per drawing unit then), or, saved without one, at the script's own size (`grown`: how
  // much bigger the typed whole piece size makes the drawing).
  let grown = 1;
  const wide = (st: LineArtStroke, k: number) => (st.width != null ? st.width * (st.k ? k / st.k : grown) : st.mode === 'draw' ? lineWidth : st.mode === 'fill' ? FILL_WIDTH : 3);
  const brush = (st: LineArtStroke, toUnit: (p: Pt) => Pt, mmPerUnit: number, k: number, w = wide(st, k)) => {
    const r = w / 2 / mmPerUnit, path = st.points.map(toUnit);
    return new C(st.shape === 'square' ? squareOutlines([path], r) : strokeOutlines([path], r, segs / 4), 'NonZero');
  };
  const sumW = units.reduce((a, u) => a + u.w, 0);
  // The art `s` mm high: its width, and the art placed with its box's bottom-left at the origin.
  const artWidth = (s: number) => s * sumW + gap * (names.length - 1);
  const placeArt = (s: number) => {
    let x = 0, art: any = null;
    frames.length = 0;
    for (const u of units) {
      // Hand edits first, in the drawing's unit height (so Jig's clean-up treats them like the rest).
      let cs = u.cs;
      const toUnit = ([px_, py_]: Pt): Pt => [(px_ - u.bx) / u.h, (py_ - u.by) / u.h];
      for (const st of u.edits) {
        if (st.mode === 'draw') cs = cs.add(brush(st, toUnit, s, s / u.h)); else if (st.mode === 'erase') cs = cs.subtract(brush(st, toUnit, s, s / u.h));
        // A clear: the drawing as it was, under its brush.
        else if (st.mode === 'restore') { const b = brush(st, toUnit, s, s / u.h); cs = cs.subtract(b).add(u.cs.intersect(b)); }
      }
      const p = cs.scale(s).translate([x, 0]);
      art = art ? art.add(p) : p;
      frames.push({ name: u.name, k: s / u.h, tx: x - (u.bx * s) / u.h, ty: -(u.by * s) / u.h, fp: d.fingerprint(u.name), k0: s / u.h / grown });
      x += u.w * s + gap;
    }
    return art;
  };
  const moveFrames = (dx: number, dy: number, scale = 1) => { for (const f of frames) { f.k *= scale; f.tx = (f.tx + dx) * scale; f.ty = (f.ty + dy) * scale; } };
  const heightFor = (artW: number) => (artW - gap * (names.length - 1)) / sumW;

  // How far the art reaches into a bar or frame it touches.
  const overlap = Math.min(lineWidth, bar ? barHeight / 3 : frameWidth / 2);
  const ov = padding > 0 ? 0 : overlap;
  // The art's height for a width and height limit.
  const fit = (w: number, h: number | undefined) => {
    let v = style === 'outline' ? heightFor(w) : bar ? heightFor(w - 2 * overhang) : style === 'framed' ? heightFor(w - 2 * (frameWidth + padding - ov)) : heightFor(w - 2 * frameWidth); // medallion: refined below
    // A height limit shrinks the art.
    if (h != null) {
      const room = style === 'outline' ? h : bar ? h - barHeight + overlap : style === 'framed' ? h - 2 * (frameWidth + padding - ov) : h - 2 * frameWidth;
      if (!(room > 0)) throw new Error('H.lineart: height leaves no room for the drawing');
      v = Math.min(v, room);
    }
    return v;
  };
  let s = fit(width, opts.height != null ? num('height', 0, 5, MAX_SIZE) : undefined);
  if (!(s > 0)) throw new Error('H.lineart: the drawing has no room – make width larger or gap, overhang or frameWidth smaller');
  if (d.size) {
    try {
      const s0 = fit(typeof scriptOpts.width === 'number' ? scriptOpts.width : 200, typeof scriptOpts.height === 'number' ? scriptOpts.height : undefined);
      if (s0 > 0) grown = s / s0;
    } catch { /* the script's own size leaves no room: its strokes as they are */ }
  }

  let art = placeArt(s);
  const aw = artWidth(s);
  let anchor: any = null, anchorThickness = 0;
  let pieceW = aw, pieceH = s;
  if (style === 'outline') { art = art.translate([-aw / 2, 0]); moveFrames(-aw / 2, 0); }
  else if (bar) {
    art = art.translate([-aw / 2, -overlap]);
    moveFrames(-aw / 2, -overlap);
    anchor = C.square([width, barHeight]).translate([-width / 2, -barHeight]);
    anchorThickness = barThickness;
    pieceW = width; pieceH = s - overlap + barHeight;
  } else if (style === 'framed') {
    art = art.translate([-aw / 2, -s / 2]);
    moveFrames(-aw / 2, -s / 2);
    const hx = exact ? exact.w / 2 - frameWidth : aw / 2 + padding - ov, hy = exact ? exact.h / 2 - frameWidth : s / 2 + padding - ov;
    anchor = C.square([2 * (hx + frameWidth), 2 * (hy + frameWidth)], true).subtract(C.square([2 * hx, 2 * hy], true));
    anchorThickness = frameThickness;
    pieceW = 2 * (hx + frameWidth); pieceH = 2 * (hy + frameWidth);
  } else {
    // Medallion: the art as large as fits inside the ring (touching it, unless padding).
    const oval = opts.shape === 'oval';
    let a = width / 2, b = oval ? (width / 2) * (s / aw) : width / 2;
    if (exact) { a = exact.w / 2; b = exact.h / 2; }
    else if (opts.height != null && 2 * b > opts.height) { const k = opts.height / (2 * b); a *= k; b *= k; }
    const ia = a - frameWidth, ib = b - frameWidth;
    if (!(ia > 0 && ib > 0)) throw new Error('H.lineart: frameWidth leaves no room inside the medallion');
    const fa = ia + ov - padding, fb = ib + ov - padding;
    art = art.translate([-aw / 2, -s / 2]);
    moveFrames(-aw / 2, -s / 2);
    let k = 0;
    for (const c of art.toPolygons()) for (const [x, y] of c) k = Math.max(k, Math.hypot(x / fa, y / fb));
    if (!(k > 0)) throw new Error('H.lineart: the drawing is empty');
    // Placed again at its final size rather than scaled, so hand-drawn lines keep their widths.
    s /= k;
    const aw2 = artWidth(s);
    art = placeArt(s).translate([-aw2 / 2, -s / 2]);
    moveFrames(-aw2 / 2, -s / 2);
    const ring = (rx: number, ry: number) => C.circle(1, segs).scale([rx, ry]);
    anchor = ring(a, b).subtract(ring(ia, ib));
    anchorThickness = frameThickness;
    pieceW = 2 * a; pieceH = 2 * b;
  }

  // Loose bits too small to print on their own are dropped (those touching the bar or frame aren't loose).
  let vectorDropped = 0;
  const pieces = art.decompose();
  if (pieces.length > 1) {
    const kept = pieces.filter((p: any) => p.area() >= minIsland || (anchor && !p.intersect(anchor).isEmpty()));
    vectorDropped = pieces.length - kept.length;
    if (vectorDropped) art = C.compose(kept);
  }


  // The split the user chose in the Print tab wins over the script's own.
  const optSplit = parseSplitSpec(opts.split);
  if (opts.split != null && optSplit === undefined) throw new Error("H.lineart: split must be 'auto', 'off', a number of pieces (2–100) or [columns, rows]");
  const layout = opts.layout ?? d.layout ?? 'print';
  if (!(LINEART_LAYOUTS as readonly string[]).includes(layout)) throw new Error(`H.lineart: layout must be one of ${LINEART_LAYOUTS.map((l) => `'${l}'`).join(', ')}`);
  const ab = (anchor ? art.add(anchor) : art).bounds();
  const splitSpec = d.split ?? optSplit ?? 'off';
  const grid = splitSpec === 'off' ? null : splitGrid(ab.max[0] - ab.min[0], ab.max[1] - ab.min[1], splitSpec, maxPiece(), SPLIT_RESERVE);

  // Key holder: pegs out of the bar's front, printed standing up: a flared foot, the stem, and a
  // cap that keeps the keys on (its underside a 45° cone, no support).
  let hooks = 0, peg: any = null, pegFoot = 0, pegLen = 0;
  const pegAt: Pt[] = [];
  if (style === 'keyholder') {
    hooks = Math.round(num('hooks', Math.max(2, Math.round(width / 70)), 1, 20));
    const len = num('hookLength', 15, 6, 60), dia = num('hookDiameter', 6, 3, 20);
    const r = dia / 2, foot = 1, cap = 1.5, flare = 1.5;
    peg = M.cylinder(foot, r + foot, r, segs / 2)
      .add(M.cylinder(len - cap - flare, r, r, segs / 2))
      .add(M.cylinder(flare, r, r + flare, segs / 2).translate([0, 0, len - cap - flare]))
      .add(M.cylinder(cap, r + flare, r + flare, segs / 2).translate([0, 0, len - cap]));
    pegFoot = r + flare; pegLen = len;
    const span = width - 2 * overhang;
    for (let i = 0; i < hooks; i++) pegAt.push([-span / 2 + (span * (i + 0.5)) / hooks, -barHeight / 2]);
  }
  // Name sign: the text raised on the bar, as large as fits.
  let signText: any = null, textDepth = 0;
  if (style === 'sign' && opts.text?.trim()) {
    textDepth = num('textDepth', 1, 0.2, 10);
    let t = d.text(opts.text.trim(), { size: num('textHeight', barHeight * 0.6, 2, 200), font: opts.font, halign: 'center', valign: 'center' });
    const tb = t.bounds(), room = width - 2 * Math.max(overhang, barHeight * 0.3), tw = tb.max[0] - tb.min[0];
    if (tw > room) t = t.scale(room / tw);
    const cb = t.bounds();
    signText = t.translate([-(cb.min[0] + cb.max[0]) / 2, -barHeight / 2 - (cb.min[1] + cb.max[1]) / 2]);
  }
  // The pegs (those `on` says are on this piece) and the text on the bar (what is on `region`; null: none).
  const decorate = (shape: any, on: (p: Pt) => boolean = () => true, region?: any) => {
    for (const p of pegAt) if (on(p)) shape = shape.add(peg.translate([p[0], p[1], barThickness]));
    const t = !signText || region === null ? null : region ? signText.intersect(region) : signText;
    if (t && !t.isEmpty()) shape = shape.add(t.extrude(textDepth).translate([0, 0, barThickness]));
    return shape;
  };

  // What changes the piece's shape through Jig's clean-up (paint and the lines' filaments don't: a
  // new colour isn't traced again; nor do fills, added after it).
  const shapeEdits = units.map((u) => u.edits.filter((st) => st.mode !== 'paint' && st.mode !== 'fill').map(({ filament: _f, ...st }) => st));
  // Erasing and filling by hand, in stroke order, after the clean-up (mm): a clear later takes back
  // what each did under it.
  const handOps: HandOp[] = units.flatMap((u, i) => {
    const f = frames[i], toMm = ([x, y]: Pt): Pt => [x * f.k + f.tx, y * f.k + f.ty], ops: HandOp[] = [];
    for (const st of u.edits) {
      if (st.mode === 'erase' || st.mode === 'fill') ops.push({ st, cs: brush(st, toMm, 1, f.k) });
      else if (st.mode === 'restore') { const b = brush(st, toMm, 1, f.k); for (const op of ops) op.cs = op.cs.subtract(b); }
    }
    return ops.filter((op) => !op.cs.isEmpty());
  });
  // The hand edits (a clear isn't one: it takes them back).
  const editCount = units.reduce((n, u) => n + u.edits.filter((st) => st.mode !== 'restore').length, 0);
  // Colours: each filament's area on the piece (mm), the later stroke winning where two cross; a
  // stroke in the piece's own filament (none, or its colour) takes it back, as a clear does. A drawn line colours
  // all of itself, also where Jig made it thicker; a fill what it added (`filled`, once the piece is
  // made), so the lines it filled up to keep their own colour (`fill`: the area's filled part).
  const baseColour = color.toLowerCase();
  const areas: { filament: PartFilament; area: any; fill?: any }[] = [];
  const colourAreas = (filled: Map<LineArtStroke, any>) => units.forEach((u, i) => {
    const f = frames[i], toMm = ([x, y]: Pt): Pt => [x * f.k + f.tx, y * f.k + f.ty];
    for (const st of u.edits) {
      if (st.mode === 'erase') continue;
      const fil = st.filament && st.filament.color !== baseColour ? st.filament : null;
      if (!fil && !areas.length) continue;
      const b = st.mode === 'fill' ? filled.get(st) : brush(st, toMm, 1, f.k, st.mode === 'draw' ? Math.max(wide(st, f.k), lineWidth) : undefined);
      if (!b || b.isEmpty()) continue;
      for (const a of areas) if (!fil || filamentKey(a.filament) !== filamentKey(fil)) { a.area = a.area.subtract(b); if (a.fill) a.fill = a.fill.subtract(b); }
      if (!fil) continue;
      let mine = areas.find((a) => filamentKey(a.filament) === filamentKey(fil));
      if (mine) mine.area = mine.area.add(b); else areas.push((mine = { filament: fil, area: b }));
      if (st.mode === 'fill') mine.fill = mine.fill ? mine.fill.add(b) : b;
    }
  });
  // Each colour's part name: the piece's, with the filament's name (its colour too when two share one).
  const colourName = (fil: PartFilament) => {
    const name = fil.name || fil.color;
    return areas.some((a) => (a.filament.name || a.filament.color) === name && a.filament.color !== fil.color) ? `${name} ${fil.color}` : name;
  };
  // The filaments the piece came out coloured in (a colour on nothing is none).
  const used: PartFilament[] = [];
  // How deep each colour goes: through, or its top layers (as many as hide what is under it by its
  // TD, or the user's number), cut to the print's layers.
  const depth = d.depth ?? 'through';
  const printLayers = d.layers ?? { layerHeight: lineArtPrint().layerHeight, firstLayerHeight: lineArtPrint().firstLayerHeight };
  const needs = new Map<string, { td: number; known: boolean; need: number }>();
  const needOf = (fil: PartFilament) => {
    let n = needs.get(filamentKey(fil));
    if (!n) { const t = filamentTd(fil); needs.set(filamentKey(fil), (n = { ...t, need: colourLayers(t.td, printLayers.layerHeight) })); }
    return n;
  };
  const union = (ss: any[]) => ss.reduce((u: any, x) => (u ? u.add(x) : x), null);
  /**
   * A piece (`lc` its lines, `anc` its bar or frame, the pegs `on` it and its part of the text, as
   * decorate) in its own filament and its colours, a part per filament named after the piece. A
   * colour is what shows from the front under the brush: the lines, the bar or frame (not under a
   * peg or the text), the sign's raised text (its own height only) or a peg, which the filament over
   * most of its top colours whole (seen all along, and above the bar it prints alone).
   */
  const paintPiece = (piece: string, lc: any, anc: any, on: (p: Pt) => boolean = () => true, region?: any) => {
    let full = lc.isEmpty() && anc ? null : lc.extrude(thickness);
    if (anc) full = full ? full.add(anc.extrude(anchorThickness)) : anc.extrude(anchorThickness);
    full = decorate(full, on, region);
    const none = { shape: full, colours: [] as Coloured[], paint: undefined as LineArtPaint | undefined };
    if (!areas.length) return none;
    const pegs = pegAt.filter(on);
    const text = !signText || region === null ? null : region ? signText.intersect(region) : signText;
    const disc = (p: Pt) => C.circle(pegFoot, segs / 2).translate(p);
    let shows = anc && !anc.isEmpty() ? anc : null;
    if (shows) { for (const p of pegs) shows = shows.subtract(disc(p)); if (text && !text.isEmpty()) shows = shows.subtract(text); }
    const z: Record<PaintMaterial, [number, number]> = { lines: [0, thickness], frame: [0, anchorThickness], text: [anchorThickness, anchorThickness + textDepth], pegs: [anchorThickness, anchorThickness + pegLen] };
    const cols: { filament: PartFilament; solids: any[]; on: PaintMaterial[] }[] = [];
    const coloured: Record<PaintMaterial, number> = { lines: 0, frame: 0, text: 0, pegs: 0 };
    const put = (filament: PartFilament, kind: PaintMaterial, solid: any, area: number) => {
      let c = cols.find((x) => filamentKey(x.filament) === filamentKey(filament));
      if (!c) cols.push((c = { filament, solids: [], on: [] }));
      c.solids.push(solid);
      if (!c.on.includes(kind)) c.on.push(kind);
      coloured[kind] += area;
    };
    // The lines and the bar or frame are split in the flat into the piece's own filament and the
    // colours, without hair-thin slivers, and each part is made from its own outline: cut out of one
    // another in 3D, a hair's difference between the outlines leaves a skin of one on the other's walls.
    const base: any[] = [];
    const clean = (cs: any) => (cs.isEmpty() ? cs : cs.offset(-PAINT_CLEAN, 'Round').offset(PAINT_CLEAN, 'Round').intersect(cs));
    // Slits closed (a crack along a fill or a line, made solid, flips faces).
    const tidy = (cs: any) => (cs.isEmpty() ? cs : cs.offset(PAINT_CLEAN, 'Miter', TIDY_MITER).offset(-PAINT_CLEAN, 'Miter', TIDY_MITER));
    const part = (kind: PaintMaterial, whole: any, list: { cs: any; filament: PartFilament }[]) => {
      if (!whole || whole.isEmpty()) return;
      const top = z[kind][1];
      if (!list.length) return void base.push(whole.extrude(top));
      whole = tidy(whole);
      const own = clean(whole.subtract(union(list.map((c) => c.cs))));
      const rest = whole.subtract(own);
      const kept: { filament: PartFilament; cs: any }[] = [];
      let taken: any = null;
      for (const c of list) {
        let cs = rest.intersect(c.cs.offset(PAINT_REACH, 'Miter'));
        if (taken) cs = cs.subtract(taken);
        taken = taken ? taken.add(cs) : cs;
        // Bits narrower than MIN_PAINT (where it reached past its brush) would print as junk: the piece's filament.
        const bits = cs.decompose(), narrow = bits.filter((x: any) => { const r = x.bounds(); return Math.max(r.max[0] - r.min[0], r.max[1] - r.min[1]) < MIN_PAINT; });
        if (narrow.length) cs = C.compose(bits.filter((x: any) => !narrow.includes(x)));
        cs = clean(cs);
        if (!cs.isEmpty()) kept.push({ filament: c.filament, cs });
      }
      // A filament in one outline: its areas side by side, made apart, left slits and faces in it.
      for (let i = kept.length - 1; i > 0; i--) {
        const j = kept.findIndex((k) => filamentKey(k.filament) === filamentKey(kept[i].filament));
        if (j < i) { kept[j].cs = kept[j].cs.add(kept[i].cs); kept.splice(i, 1); }
      }
      // And without slits (where a brush edge ran along a hair of the piece's own filament): its
      // top made over one flips faces, which show as a dark band.
      kept.forEach((k, i) => {
        k.cs = tidy(k.cs).intersect(whole);
        for (const o of kept.slice(0, i)) k.cs = k.cs.subtract(o.cs);
      });
      // The piece's filament: all the rest, in one outline (made of pieces, it showed their seams),
      // less its hairs against a colour, which go to the colour they lie against most: every bit of
      // the flat is in one part, with no crack or sliver between them.
      let mine = kept.length ? whole.subtract(union(kept.map((k) => k.cs))) : whole;
      const hair = kept.length ? mine.subtract(clean(mine)) : null;
      if (hair && !hair.isEmpty()) {
        // (Only the hairs by a colour, of all those along the piece's edges.)
        const by = kept.map((k) => k.cs.offset(2 * PAINT_CLEAN, 'Miter'));
        const near = hair.intersect(union(by));
        if (!near.isEmpty()) {
          const touch = near.offset(PAINT_CLEAN, 'Miter'), bits = hair.intersect(touch).decompose();
          const moves: any[][] = kept.map(() => []);
          for (const bit of bits) {
            let best = -1, most = 0;
            by.forEach((g, i) => { const t = bit.intersect(g).area(); if (t > most) { most = t; best = i; } });
            if (best >= 0) moves[best].push(bit);
          }
          moves.forEach((m, i) => { if (m.length) kept[i].cs = kept[i].cs.add(C.compose(m)); });
          mine = whole.subtract(union(kept.map((k) => k.cs)));
        }
      }
      // The piece's filament is the whole of it made solid, less a slot for each colour from where it
      // starts, which reaches a hair past the piece's edge (and over its top): no wall of the slot is
      // on one of the piece's, which would leave a skin, and no blocks of it are joined side by side,
      // which left slits.
      // (Without spikes of no width where a colour ends on its edge: made solid, they stood as fins on
      // the colour's walls, drawn as stripes in the view. The slots take what this leaves.)
      if (kept.length) mine = mine.offset(-SPIKE, 'Miter').offset(SPIKE, 'Miter');
      const bottoms = kept.map((k) => colourBottom(depthLayers(depth, needOf(k.filament).need), z[kind][0], top, printLayers));
      kept.forEach((k, i) => put(k.filament, kind, k.cs.simplify(LAYER_TIDY).extrude(top - bottoms[i]).translate([0, 0, bottoms[i]]), k.cs.area()));
      const slots = kept.map((k, i) => k.cs.offset(SLOT_OUT, 'Miter').subtract(mine).extrude(top - bottoms[i] + SLOT_OUT).translate([0, 0, bottoms[i]]));
      base.push(slots.length ? whole.extrude(top).subtract(union(slots)) : whole.extrude(top));
    };
    part('lines', anc && !lc.isEmpty() ? lc.subtract(anc) : lc, colourLines(lc, anc, areas));
    if (anc && !anc.isEmpty()) part('frame', anc, shows ? colourLines(shows, null, areas) : []);
    // The sign's text and the pegs stand on the bar: cut out of the piece as they are.
    const cutOut: any[] = [];
    if (text && !text.isEmpty()) for (const c of colourLines(text, null, areas)) {
      const b = colourBottom(depthLayers(depth, needOf(c.filament).need), z.text[0], z.text[1], printLayers);
      const solid = c.cs.extrude(z.text[1] - b).translate([0, 0, b]);
      put(c.filament, 'text', solid, c.cs.area());
      cutOut.push(solid);
    }
    for (const p of pegs) {
      const top = disc(p);
      let best: PartFilament | null = null, most = top.area() / 4;
      for (const a of areas) { const t = top.intersect(a.area).area(); if (t > most) { most = t; best = a.filament; } }
      if (best) { const solid = peg.translate([p[0], p[1], anchorThickness]); put(best, 'pegs', solid, 1); cutOut.push(solid); }
    }
    if (!cols.length) return none;
    const solids = cols.map((c) => union(c.solids));
    for (const c of cols) if (!used.some((f) => filamentKey(f) === filamentKey(c.filament))) used.push(c.filament);
    const there: [PaintMaterial, number][] = [['lines', lc.area()], ['frame', anc ? anc.area() : 0], ['text', text ? text.area() : 0], ['pegs', pegs.length]];
    const paint: LineArtPaint = {
      depth, layers: printLayers,
      materials: there.filter(([, a]) => a > 0).map(([kind, a]) => ({ kind, z: z[kind], own: a - coloured[kind] > 1e-3 })),
      colours: cols.map((c) => ({ filament: c.filament, ...needOf(c.filament), on: c.on })),
    };
    // The piece's own filament: its parts put together, with the pegs and the text, less those coloured.
    let rest = decorate(union(base), on, region);
    if (cutOut.length) rest = rest.subtract(union(cutOut));
    const bodies = rest.decompose();
    const own = bodies.some((b: any) => b.volume() < MIN_BODY) ? M.compose(bodies.filter((b: any) => b.volume() >= MIN_BODY)) : rest;
    return { shape: own, colours: cols.map((c, i): Coloured => ({ name: `${piece} (${colourName(c.filament)})`, shape: solids[i], filament: c.filament })), paint };
  };

  let parts: (LineArtResult['parts'][number] & { colours?: Coloured[] })[];
  let info: LineArtInfo;
  let sp: SplitResult | null = null;
  // Where loose ends were joined and left (the piece unsplit), and what the user erased by hand.
  let marks: { joins: Pt[][]; loose: Pt[] } = { joins: [], loose: [] }, erased: any = null;
  if (!grid || grid.cols * grid.rows < 2) {
    // The drawing made printable, on a pixel grid over the whole piece.
    let px = lineWidth / (d.quality === 'draft' ? 3 : d.quality === 'high' ? 6 : 5);
    const area = (ab.max[0] - ab.min[0] + 8 * px) * (ab.max[1] - ab.min[1] + 8 * px);
    px = Math.max(px, Math.sqrt(area / MAX_PIXELS[d.quality]));
    const key = JSON.stringify([names.map((n) => d.fingerprint(n)), opts.colors ?? null, style, s, aw, gap, lineWidth, lines, fill, minIsland, pieceW, pieceH, barHeight, overhang, frameWidth, padding, opts.shape ?? '', px, joinEnds, shapeEdits, grown]);
    let res = cache.get(key);
    if (!res) {
      const g: LineArtGrid = { px, x0: ab.min[0] - 4 * px, y1: ab.max[1] + 4 * px, w: Math.ceil((ab.max[0] - ab.min[0]) / px) + 8, h: Math.ceil((ab.max[1] - ab.min[1]) / px) + 8 };
      const m = lineArtMask(rasterize(art.toPolygons(), g), anchor ? rasterize(anchor.toPolygons(), g) : null, g, { lineWidth, fill, minIsland, lines, keepSpecks: lines === 'keep', joinEnds });
      const mm = ([x, y]: Pt): Pt => [g.x0 + (x + 0.5) * px, g.y1 - (y + 0.5) * px];
      res = { loops: lines === 'keep' ? [] : traceMask(m.mask, g, px * 0.35), paths: lines === 'keep' ? m.paths.map((p) => p.map(mm)) : [], bridges: m.bridges, longestBridge: m.longestBridge, dropped: m.dropped, closed: m.closed, openings: m.openings, endsJoined: m.endsJoined, endsFree: m.endsFree, joins: m.joins.map((j) => j.map(mm)), loose: m.loose.map(mm) };
      cache.set(key, res);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    }
    // Lines kept as drawn: the drawing itself, exactly, with what Jig drew (thickened lines, bridges) added as exact shapes.
    let lineCs = lines === 'keep' ? (res.paths.length ? art.add(new C(strokeOutlines(res.paths, lineWidth / 2, segs / 4), 'NonZero')) : art) : new C(res.loops, 'EvenOdd');
    // Erasing by hand has the last word: also over what Jig drew there (a join, a bridge); filling
    // by hand adds to the piece as it is then.
    for (const op of handOps) if (op.st.mode === 'erase') erased = erased ? erased.add(op.cs) : op.cs;
    const hand = handEdits(C, lineCs, anchor, handOps);
    lineCs = hand.lineCs;
    colourAreas(hand.filled);
    marks = res;
    // What is in other filaments is parts of their own; the rest is the piece's.
    const { shape, colours, paint } = paintPiece('Line art', lineCs, anchor);
    info = { style, sources: names, size: [pieceW, pieceH], thickness, lineWidth, lines, bridges: res.bridges, longestBridge: res.longestBridge, dropped: res.dropped + vectorDropped, closed: res.closed, openings: res.openings, endsJoined: res.endsJoined, endsFree: res.endsFree, hooks, frames, edits: editCount, ...(hand.loose ? { fillsLoose: hand.loose } : {}) };
    if (colours.length) { info.components = (anchor ? lineCs.add(anchor) : lineCs).decompose().length; info.paint = paint; }
    parts = [{ name: 'Line art', shape, color, lineArt: info, colours }];
  } else {
    // Split into pieces: Jig's clean-up runs on each piece on its own, so each holds together by
    // itself; erasing and filling by hand are applied to each piece.
    for (const op of handOps) if (op.st.mode === 'erase') erased = erased ? erased.add(op.cs) : op.cs;
    const key = JSON.stringify([names.map((n) => d.fingerprint(n)), opts.colors ?? null, style, s, aw, gap, lineWidth, lines, fill, minIsland, pieceW, pieceH, barHeight, overhang, frameWidth, padding, opts.shape ?? '', joinEnds, shapeEdits, grown, d.quality, grid, hooks, opts.text ?? '', opts.clearance ?? null, d.join ?? opts.splitJoin ?? null, maxPiece()]);
    sp = splitPieces({
      d, key, art, anchor, hand: handOps, ab, cols: grid.cols, rows: grid.rows, lineWidth, fill, minIsland, lines, joinEnds, segs,
      clearance: num('clearance', 0.15, 0, 1), maxBridge: d.join ?? (opts.splitJoin != null ? num('splitJoin', DEFAULT_SPLIT_JOIN, 5, 300) : DEFAULT_SPLIT_JOIN), minPart: SPLIT_MIN_PART * lineWidth, pegAt, pegZone: pegFoot + 1, barHeight, signText,
    });
    const totals = sp.pieces.reduce((t, p) => ({ bridges: t.bridges + p.info.bridges, longestBridge: Math.max(t.longestBridge, p.info.longestBridge), dropped: t.dropped + p.info.dropped, endsJoined: t.endsJoined + p.info.endsJoined, endsFree: t.endsFree + p.info.endsFree, closed: t.closed + p.closed, openings: t.openings + p.openings }), { bridges: 0, longestBridge: 0, dropped: vectorDropped, endsJoined: 0, endsFree: 0, closed: 0, openings: 0 });
    info = { style, sources: names, size: [pieceW, pieceH], thickness, lineWidth, lines, ...totals, hooks, frames, edits: editCount, ...(sp.fillsLoose ? { fillsLoose: sp.fillsLoose } : {}) };
    // What each fill added, over the pieces, for its colour.
    colourAreas(sp.filled);
    const labels = opts.labels !== false;
    const res = sp;
    parts = res.pieces.map((p, i) => {
      // Each piece keeps the colours on it.
      const painted = paintPiece(p.info.label, p.lineCs, p.anchor, (q) => res.pieceAt(q) === i, p.region);
      let { shape, colours } = painted;
      // Its name engraved on the back, mirrored so it reads from the back.
      const at = labels ? res.label(i) : null;
      if (at) {
        let t = d.text(p.info.label, { size: at.size, halign: 'center', valign: 'center' });
        const tb = t.bounds();
        t = t.translate([-(tb.min[0] + tb.max[0]) / 2, -(tb.min[1] + tb.max[1]) / 2]).mirror([1, 0]);
        if (at.rot) t = t.rotate(90);
        const cut = t.translate([at.x, at.y]).extrude(LABEL_DEPTH + 1).translate([0, 0, -1]);
        shape = shape.subtract(cut);
        colours = colours.map((c) => ({ ...c, shape: c.shape.subtract(cut) }));
      }
      p.info.labelSize = at ? at.size : 0;
      const whole = colours.length ? (p.anchor ? p.lineCs.add(p.anchor) : p.lineCs).decompose().length : 0;
      return { name: p.info.label, shape, color, lineArt: whole ? { ...info, components: whole, paint: painted.paint } : info, plate: i + 1, colours };
    });
  }
  info.joinEnds = joinEnds;

  // Desk stand: a base with a slot the bar pushes into, printed beside the piece (split, cut where the bar is).
  let slotNote = '';
  if (style === 'stand') {
    const depth = num('standDepth', 30, 10, 200), height = num('standHeight', 12, 4, 100);
    const slotDepth = Math.min(height - 2, barHeight - 2), slotW = barThickness + 0.3, len = width + 16;
    const base = M.cube([len, depth, height]).translate([-len / 2, 0, 0])
      .subtract(M.cube([width + 0.6, slotW, slotDepth + 1]).translate([-(width + 0.6) / 2, (depth - slotW) / 2, height - slotDepth]))
      .translate([0, -barHeight - 10 - depth, 0]);
    const cuts = sp ? sp.seams.filter((m) => m.dir === 'v').map((m) => seamAt(m.points, -barHeight / 2, 1)).sort((a, b) => a - b) : [];
    const edges = [-len / 2 - 1, ...cuts, len / 2 + 1];
    for (let k = 0; k + 1 < edges.length; k++) {
      const slab = edges.length > 2 ? base.intersect(M.cube([edges[k + 1] - edges[k], 1000, 1000]).translate([edges[k], -500, -1])) : base;
      parts.push({ name: edges.length > 2 ? `Stand base ${k + 1}` : 'Stand base', shape: slab, color, ...(sp ? { plate: parts.length + 1 } : {}) });
    }
    slotNote = ` Print the base as well and push the bar into its slot (${slotW.toFixed(1)} mm wide, ${slotDepth.toFixed(0)} mm deep).`;
  }
  // Everything centred on the plate (the origin), as the 3MF export places it.
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const p of parts) for (const sh of [p.shape, ...(p.colours ?? []).map((c) => c.shape)] as any[]) {
    if (sh.isEmpty()) continue;
    const b = sh.boundingBox();
    lo = [Math.min(lo[0], b.min[0]), Math.min(lo[1], b.min[1])]; hi = [Math.max(hi[0], b.max[0]), Math.max(hi[1], b.max[1])];
  }
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
  // A part and its colours move together.
  const move = (p: (typeof parts)[number], dx: number, dy: number) => {
    p.shape = (p.shape as any).translate([dx, dy, 0]);
    p.colours = p.colours?.map((c) => ({ ...c, shape: c.shape.translate([dx, dy, 0]) }));
  };
  if (Math.abs(cx) > 1e-6 || Math.abs(cy) > 1e-6) {
    for (const p of parts) move(p, -cx, -cy);
    moveFrames(-cx, -cy);
  }
  if (used.length) info.colours = used;
  const filaments = used.length ? ` in ${used.length + 1} filaments (its own and ${used.map((f) => f.name || f.color).join(', ')}: ${depth === 'through' ? 'the colours go through its whole thickness, so the AMS changes filament on every layer' : 'the colours are only its top layers, so the AMS changes filament on those layers only'}, with a prime tower beside it)` : ' in one colour (black PLA)';
  // The joins and loose ends where they are, moved like the piece; a join erased by hand leaves its end loose, and an erased end goes.
  const erasedAt = (a: Pt, b: Pt) => !!erased && !erased.intersect(new C([band(a, b, 0.05)], 'NonZero')).isEmpty();
  const placeMarks = (m: { joins: Pt[][]; loose: Pt[] }): Pick<LineArtInfo, 'joins' | 'loose'> => {
    const mv = ([x, y]: Pt): [number, number] => [x - cx, y - cy];
    const live = m.joins.filter((j) => !erasedAt(j[0], j[0]));
    const joins = live.filter((j) => !erasedAt(j[0], j[1]));
    const loose = [...live.filter((j) => !joins.includes(j)).map((j) => j[0]), ...m.loose.filter((p) => !erasedAt(p, p))];
    return { joins: joins.slice(0, MAX_JOIN_MARKS).map((j) => j.map(mv)), loose: loose.slice(0, MAX_JOIN_MARKS).map(mv) };
  };
  if (!sp) Object.assign(info, placeMarks(marks));
  let note: string, assembly: LineArtResult['assembly'];
  if (!sp) {
    const bed = printer().bed;
    const big = pieceW > bed[0] || pieceH > bed[1] ? ` It is ${pieceW.toFixed(0)} × ${pieceH.toFixed(0)} mm, bigger than the ${bedName()}: make it smaller${grid ? '' : ', or split it into pieces'}.` : '';
    note = `Print it flat, back on the bed,${filaments}: 0.2 mm layers, 100 % infill, no brim. ${style === 'keyholder' ? `The ${hooks} pegs print standing up. ` : ''}${style === 'stand' ? '' : 'Hang it with double-sided tape or Command strips.'}${slotNote}${big}`;
  } else {
    const split = splitInfo(sp, splitSpec as SplitSpec, grid!, -cx, -cy, anchor, layout as LineArtSplitInfo['layout']);
    info.split = split;
    // The layout: on the wall with hairline gaps (assembled), pulled apart (exploded), or each piece in a grid to print.
    const n = sp.pieces.length;
    const offsets = layoutOffsets(parts, n, split, layout, Math.max(pieceW, pieceH));
    parts.forEach((p, i) => {
      const [dx, dy] = offsets[i];
      if (dx || dy) move(p, dx, dy);
      if (i < n) p.lineArt = { ...info, ...(i ? { split: undefined } : {}), ...(p.lineArt?.components ? { components: p.lineArt.components, paint: p.lineArt.paint } : {}), ...placeMarks(sp!.pieces[i]), piece: { label: p.name, offset: [dx, dy] } };
    });
    const bed = printer().bed;
    const big = split.pieces.filter((p) => p.size[0] > bed[0] || p.size[1] > bed[1]);
    const order = split.pieces.map((p) => p.label);
    assembly = order.slice(1).map((l) => ({ label: `Stick ${l} on the wall against the pieces already up`, parts: [l, ...(parts.find((p) => p.name === l)?.colours ?? []).map((c) => c.name)], from: [0, 0, Math.max(30, 0.15 * Math.max(pieceW, pieceH))] }));
    const lab = split.pieces.filter((p) => p.labelSize > 0).length;
    note = `Split into ${n} pieces (${grid!.cols} × ${grid!.rows}: ${order.join(', ')}), each on its own plate. Print each flat, back on the bed,${filaments}: 0.2 mm layers, 100 % infill, no brim. ${style === 'keyholder' ? `The ${hooks} pegs print standing up. ` : ''}`
      + `${split.joints.length ? `The ${split.joints.length} dovetail${split.joints.length > 1 ? 's' : ''} on the ${anchorWord(style)} lock the pieces together; ` : ''}lines that cross a seam just meet end to end, so each piece is taped up on its own. `
      + `${lab ? `Each piece's name (row letter from the top, column number from the left) is engraved on its back${lab < n ? ` (${n - lab} had no room for it)` : ''}. ` : ''}`
      + `Put it up from the top left: A1 first, then along the row and down. Mark a level line, tape each piece up and push it against the one before.${slotNote}`
      + `${big.length ? ` ${big.map((p) => `${p.label} is ${p.size[0].toFixed(0)} × ${p.size[1].toFixed(0)} mm`).join(', ')}: bigger than the ${bedName()} - use more pieces.` : ''}`;
  }
  // Each part followed by its colours (on its plate, with the line-art info and the filament).
  const out: LineArtResult['parts'] = parts.flatMap(({ colours, ...p }) => [p, ...(colours ?? []).map((c) => ({
    name: c.name, shape: c.shape, color: c.filament.color,
    lineArt: { ...(p.lineArt ?? info), split: undefined, components: undefined, joins: undefined, loose: undefined, paint: undefined, paintedIn: c.filament },
    ...(p.plate ? { plate: p.plate } : {}),
  }))]);
  return { parts: out, print: lineArtPrint(), lineArt: info, note, ...(assembly ? { assembly } : {}) };
}

/** A part of the lines in another filament, while the piece is put together. */
