// Line art: wall cut-outs of a drawing (a car and a motorbike on a key holder, a figure in a frame),
// printed flat in one colour as one connected piece. H.lineart takes a drawing (an attached SVG, a
// traced picture or one the image model drew), redraws its lines at an even width at the final
// size, joins loose bits to the rest with short bridges, drops specks too small to print, and adds
// the style's bar, frame, hooks or stand.
import type { Brim } from './print';
import { defaultColors, type SvgDrawing } from './svgFeatures';
import { boxFitter, dovetail, formatSplitSpec, keepTogether, MAX_PIECE, parseSplitSpec, pieceLabel, routeSeam, seamAt, seamGeometry, splitGrid, type Seam, type SplitGrid, type SplitSpec } from './split';

export const LINE_ART_STYLES = ['outline', 'keyholder', 'framed', 'medallion', 'sign', 'stand'] as const;
export type LineArtStyle = (typeof LINE_ART_STYLES)[number];
export const DEFAULT_LINE_ART_STYLE: LineArtStyle = 'outline';

/** The styles as the user sees them (the Line art ▾ menu). */
export const LINE_ART_STYLE_INFO: Record<LineArtStyle, { label: string; desc: string }> = {
  outline: { label: 'Outline', desc: 'Just the drawing, cut out in one piece' },
  keyholder: { label: 'Key holder', desc: 'Standing on a bar with pegs for keys' },
  framed: { label: 'Framed', desc: 'Inside a rectangular frame' },
  medallion: { label: 'Medallion', desc: 'Inside a round or oval frame' },
  sign: { label: 'Name sign', desc: 'Standing on a bar with a name or label' },
  stand: { label: 'Desk stand', desc: 'Stands in a slotted base on a desk or shelf' },
};

export function isLineArtStyle(v: unknown): v is LineArtStyle {
  return typeof v === 'string' && (LINE_ART_STYLES as readonly string[]).includes(v);
}

/** Options of H.lineart(source, opts); lengths in mm. */
export interface LineArtOptions {
  style?: LineArtStyle;
  /** Width of the whole piece (frame or bar included), default 200. */
  width?: number;
  /** Optional most height of the whole piece: the drawing shrinks to fit both. */
  height?: number;
  /** Thickness of the drawing, default 2. */
  thickness?: number;
  /** The drawing's line width (with lines 'keep', the thinnest a line may be), default 1. */
  lineWidth?: number;
  /** 'keep' (default): the drawing's own line weights, only lines thinner than lineWidth thickened; 'even': every line redrawn at lineWidth. */
  lines?: 'even' | 'keep';
  /** lines 'even': areas of the drawing wider than this stay solid fills (tyres, hair, shadows), default 3 × lineWidth. */
  fill?: number;
  /** Loose bits smaller than this (mm²) are dropped rather than bridged, default 4 × lineWidth². */
  minIsland?: number;
  /** Loose lines and branches (held at one point only, so they would lift off the wall) are joined to the nearest line within this distance, mm; default 8, 0 = off. */
  joinEnds?: number;
  /** Space between several drawings side by side (negative overlaps them), default 0. */
  gap?: number;
  /** Fill colours of the drawing that are its lines (default: all but white-ish ones). */
  colors?: string[];
  /** Part colour, default near-black. */
  color?: string;

  /** Bar styles (keyholder, sign, stand): the bar's height in the picture plane (default 12 / 16 / 10). */
  barHeight?: number;
  /** Bar styles: its thickness (default 4 for a key holder, else the drawing's thickness + 1). */
  barThickness?: number;
  /** Bar styles: how far the bar reaches past the drawing on each side, default 6. */
  overhang?: number;

  /** Key holder: number of pegs (default one per ~60 mm, at least 2). */
  hooks?: number;
  /** Key holder: how far a peg sticks out of the bar, default 15. */
  hookLength?: number;
  /** Key holder: peg diameter, default 6 (the cap is 3 mm wider). */
  hookDiameter?: number;

  /** Name sign: the text raised on the bar. */
  text?: string;
  /** Name sign: font (as H.text), default Roboto Bold. */
  font?: string;
  /** Name sign: cap height of the text, default 60 % of the bar's height. */
  textHeight?: number;
  /** Name sign: how far the text stands out of the bar, default 1. */
  textDepth?: number;

  /** Framed / medallion: the frame's width in the picture plane, default 4. */
  frameWidth?: number;
  /** Framed / medallion: the frame's thickness, default the drawing's thickness + 1. */
  frameThickness?: number;
  /** Framed / medallion: space between the drawing and the frame, default 0 (the drawing touches it). */
  padding?: number;
  /** Medallion: 'circle' (default) or 'oval' (the drawing's proportions). */
  shape?: 'circle' | 'oval';

  /** Desk stand: depth of the base, default 30. */
  standDepth?: number;
  /** Desk stand: height of the base, default 12 (the slot is 2 mm less). */
  standHeight?: number;

  /**
   * Split a piece bigger than the bed into pieces that each fit it: 'auto' (the fewest), a number of
   * pieces, or a grid [columns, rows]; default off. The user's choice in the Print tab
   * (LINEART_SPLIT_KEY) wins over it.
   */
  split?: SplitSpec | 'off';
  /** A split piece: 'print' (default: the pieces side by side to print), 'assembled' (together as on the wall) or 'exploded' (pulled apart). */
  layout?: 'print' | 'assembled' | 'exploded';
  /** A split piece: engrave each piece's name (A1, A2, B1…) on its back, default true. */
  labels?: boolean;
  /** A split piece: space per side between a dovetail and its socket, default 0.15 mm. */
  clearance?: number;
}

/** One piece of a split line art, and what Jig fixed on it. */
export interface LineArtPieceInfo {
  /** Row letter from the top + column number from the left, as seen from the front: A1, A2, B1… */
  label: string;
  col: number;
  row: number;
  /** Its size [width, height] and box [x0, y0, x1, y1] on the wall (the assembled piece's XY), mm. */
  size: [number, number];
  box: [number, number, number, number];
  bridges: number;
  longestBridge: number;
  dropped: number;
  endsJoined: number;
  endsFree: number;
  /** Dovetail tabs and sockets on it. */
  joints: number;
  /** Cap height of its engraved name, mm (0: no room for it). */
  labelSize: number;
}

/** How a line art was split into pieces (on the first piece's lineArt), in the assembled piece's XY, mm. */
export interface LineArtSplitInfo {
  /** What it was split by: 'auto', a number of pieces ('4') or a grid ('3x2'). */
  spec: string;
  cols: number;
  rows: number;
  pieces: LineArtPieceInfo[];
  /** The cuts: vertical ones top to bottom, horizontal ones left to right; lines of the drawing each cuts. */
  seams: { dir: 'v' | 'h'; points: [number, number][]; crossings: number }[];
  /** Dovetails where a seam crosses the bar or frame: the tab's and socket's pieces, its head width. */
  joints: { at: [number, number]; tab: string; socket: string; width: number }[];
  /** Crossings of the bar or frame without a dovetail, and why. */
  noJoint: { at: [number, number]; why: string }[];
  /** The bar or frame's outline, for the layout picture. */
  anchor: [number, number][][];
}

/** What a line-art part was made from and what Jig fixed, for the Print tab and Claude's report (PartMesh.lineArt). */
export interface LineArtInfo {
  style: LineArtStyle;
  /** The drawings, left to right. */
  sources: string[];
  /** Size of the whole piece [width, height] in the picture plane, mm. */
  size: [number, number];
  thickness: number;
  lineWidth: number;
  lines: 'even' | 'keep';
  /** Bridges Jig added to join loose bits, and the longest one, mm. */
  bridges: number;
  longestBridge: number;
  /** Loose bits too small to print that were dropped. */
  dropped: number;
  /** Openings of the drawing (spaces between its lines) that closed up because the lines are too close at this size: detail lost. */
  closed: number;
  /** Openings of the drawing at all (at least minIsland big), to judge `closed` by. */
  openings: number;
  /** Loose lines and branches (held at one point only) Jig joined to a nearby line, and those left loose (nothing within joinEnds). */
  endsJoined: number;
  endsFree: number;
  /** Key holder pegs. */
  hooks: number;
  /**
   * Where each drawing sits in the piece, for editing it by hand: a point (x, y) of the drawing
   * (its own units: 1 = its height, centred, y up) is at (x·k + tx, y·k + ty) mm in the piece's XY.
   * `fp` is the drawing's fingerprint (hand edits belong to it).
   */
  frames: { name: string; k: number; tx: number; ty: number; fp: string }[];
  /** Hand edits (LINEART_EDITS_KEY) applied, over all drawings. */
  edits: number;
  /** Split into pieces (bridges, specks and loose lines above are then the totals over the pieces); only on the first piece. */
  split?: LineArtSplitInfo;
  /** This part is one piece of a split line art: its name, and how far the layout moved it from its place on the wall (mm). */
  piece?: { label: string; offset: [number, number] };
}

/** What H.lineart returns; a script returns it as it is (or adds to its parts). */
export interface LineArtResult {
  /** The piece (lineArt on it), plus the base for a desk stand; split, one part per piece (named by its label), each on its own plate. */
  parts: { name: string; shape: unknown; color: string; lineArt?: LineArtInfo; plate?: number }[];
  print: { layerHeight: number; walls: number; infill: number; infillPattern: string; brim: Brim };
  lineArt: LineArtInfo;
  /** How to print and hang it. */
  note: string;
  /** A split piece: putting it up, piece by piece (the app animates it). */
  assembly?: { label: string; parts: string[]; from: [number, number, number] }[];
}

/** Whether a model script builds line art (H.lineart): its follow-ups stay line art. */
export function isLineArt(code: string | undefined): boolean {
  return !!code && /\bH\.lineart\s*\(/.test(code);
}

/** A part's line-art info from a script's output, checked, lengths scaled with the part. */
export function cleanLineArtInfo(raw: unknown, scale = 1): LineArtInfo | undefined {
  const o = raw as LineArtInfo | null;
  if (!o || typeof o !== 'object' || !isLineArtStyle(o.style) || !Array.isArray(o.sources) || !Array.isArray(o.size)) return undefined;
  const len = [o.size[0], o.size[1], o.thickness, o.lineWidth, o.longestBridge].map(Number);
  if (!len.every((v) => Number.isFinite(v) && v >= 0)) return undefined;
  const [w, h, thickness, lineWidth, longestBridge] = len.map((v) => v * scale);
  const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
  const frames = (Array.isArray(o.frames) ? o.frames : []).slice(0, 8).filter((f) => f && typeof f.name === 'string' && [f.k, f.tx, f.ty].every((v) => Number.isFinite(v)) && f.k > 0)
    .map((f) => ({ name: f.name.slice(0, 120), k: f.k * scale, tx: f.tx * scale, ty: f.ty * scale, fp: String(f.fp ?? '').slice(0, 80) }));
  return {
    frames, edits: count(o.edits),
    ...cleanSplit(o, scale),
    style: o.style, sources: o.sources.filter((s) => typeof s === 'string').slice(0, 8).map((s) => s.slice(0, 120)),
    size: [w, h], thickness, lineWidth, lines: o.lines === 'even' ? 'even' : 'keep',
    bridges: count(o.bridges), longestBridge, dropped: count(o.dropped), closed: count(o.closed), openings: count(o.openings), endsJoined: count(o.endsJoined), endsFree: count(o.endsFree), hooks: count(o.hooks),
  };
}

/** A line art's split and piece info (LineArtInfo.split, .piece), checked and scaled. */
function cleanSplit(o: LineArtInfo, scale: number): Pick<LineArtInfo, 'split' | 'piece'> {
  const out: Pick<LineArtInfo, 'split' | 'piece'> = {};
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
  const pt = (p: unknown): [number, number] | null => (Array.isArray(p) && fin(p[0]) && fin(p[1]) ? [p[0] * scale, p[1] * scale] : null);
  const line = (ps: unknown, max: number) => (Array.isArray(ps) ? ps.slice(0, max).map(pt).filter((p): p is [number, number] => !!p) : []);
  const pc = o.piece;
  if (pc && typeof pc.label === 'string' && pt(pc.offset)) out.piece = { label: pc.label.slice(0, 12), offset: pt(pc.offset)! };
  const s = o.split;
  if (!s || typeof s !== 'object' || !Number.isInteger(s.cols) || !Number.isInteger(s.rows) || !Array.isArray(s.pieces)) return out;
  const str = (v: unknown, n: number) => String(v ?? '').slice(0, n);
  out.split = {
    spec: str(s.spec, 12), cols: s.cols, rows: s.rows,
    pieces: s.pieces.slice(0, 100).filter((p) => p && typeof p.label === 'string' && Array.isArray(p.size) && Array.isArray(p.box) && [...p.size, ...p.box].every(fin)).map((p) => ({
      label: p.label.slice(0, 12), col: count(p.col), row: count(p.row),
      size: [p.size[0] * scale, p.size[1] * scale], box: p.box.map((v) => v * scale) as LineArtPieceInfo['box'],
      bridges: count(p.bridges), longestBridge: fin(p.longestBridge) ? p.longestBridge * scale : 0, dropped: count(p.dropped),
      endsJoined: count(p.endsJoined), endsFree: count(p.endsFree), joints: count(p.joints), labelSize: fin(p.labelSize) ? p.labelSize * scale : 0,
    })),
    seams: (Array.isArray(s.seams) ? s.seams : []).slice(0, 200).filter((m) => m && (m.dir === 'v' || m.dir === 'h')).map((m) => ({ dir: m.dir, points: line(m.points, 5000), crossings: count(m.crossings) })),
    joints: (Array.isArray(s.joints) ? s.joints : []).slice(0, 400).filter((j) => j && pt(j.at)).map((j) => ({ at: pt(j.at)!, tab: str(j.tab, 12), socket: str(j.socket, 12), width: fin(j.width) ? j.width * scale : 0 })),
    noJoint: (Array.isArray(s.noJoint) ? s.noJoint : []).slice(0, 400).filter((j) => j && pt(j.at)).map((j) => ({ at: pt(j.at)!, why: str(j.why, 200) })),
    anchor: (Array.isArray(s.anchor) ? s.anchor : []).slice(0, 8).map((c) => line(c, 2000)).filter((c) => c.length >= 3),
  };
  return out;
}

/** Hand edits of line-art drawings (the Line art editor's brush), by drawing name: { fp, strokes }. */
export const LINEART_EDITS_KEY = '$lineartEdits';
/** The user's split choice (Print tab): 'off', 'auto', a number of pieces ('4') or a grid ('3x2'); wins over the script's split option. */
export const LINEART_SPLIT_KEY = '$lineartSplit';
/** The layout of a split piece when the script has no layout parameter of its own ('print', 'assembled', 'exploded'). */
export const LINEART_LAYOUT_KEY = '$lineartLayout';
export const LINEART_LAYOUTS = ['print', 'assembled', 'exploded'] as const;

/** The split choice from the design's values (LINEART_SPLIT_KEY), checked; undefined when the script decides. */
export function parseLineArtSplit(raw: unknown): SplitSpec | 'off' | undefined {
  return parseSplitSpec(raw);
}

/**
 * The whole piece's size the user typed in the Print tab, which wins over the script's width and
 * height (its sliders' limits and a height written in the script included): "800x" (that width,
 * the height following the drawing), "x600" (that height) or "800x600" (the piece exactly that
 * size where the style allows: a frame's outer box or a medallion's oval exactly W × H, the art
 * fitted inside, centred, never stretched; a bar W wide; an outline fits inside both).
 */
export const LINEART_SIZE_KEY = '$lineartSize';
export const MAX_LINEART_SIZE = 3000;
export function parseLineArtSize(raw: unknown): { width?: number; height?: number } | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = /^(\d+(?:\.\d+)?)?x(\d+(?:\.\d+)?)?$/.exec(raw.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  const ok = (v?: string) => (v && Number(v) >= 20 && Number(v) <= MAX_LINEART_SIZE ? Number(v) : undefined);
  const width = ok(m[1]), height = ok(m[2]);
  return width || height ? { ...(width ? { width } : {}), ...(height ? { height } : {}) } : undefined;
}
export const formatLineArtSize = (s: { width?: number; height?: number }) => `${s.width ? +s.width.toFixed(1) : ''}x${s.height ? +s.height.toFixed(1) : ''}`;
/** The most strokes kept per drawing, and points per stroke. */
export const MAX_LINEART_STROKES = 400;
export const MAX_STROKE_POINTS = 2000;

/**
 * One brush stroke on a drawing: 'draw' adds a line `width` mm wide (default: the piece's
 * lineWidth), 'erase' removes everything within width / 2 of its path (default 3 mm) – also what
 * Jig drew there, so a join or bridge can be erased. Points are in the drawing's own units (1 = its
 * height, centred, y up), so an edit stays put when the piece is resized.
 */
export interface LineArtStroke { mode: 'draw' | 'erase'; width?: number; points: [number, number][] }
/** The strokes on a drawing, with the fingerprint of the drawing they were made on: a new drawing under the same name leaves them out. */
export type LineArtEdits = Record<string, { fp: string; strokes: LineArtStroke[] }>;

/** A drawing's fingerprint: hand edits only apply to the drawing they were drawn on. */
export function drawingFingerprint(d: SvgDrawing): string {
  let h = 0, pts = 0;
  for (const sh of d.shapes) for (const c of sh.contours) for (const [x, y] of c) { h = (h * 31 + Math.round(x * 1e5) * 7 + Math.round(y * 1e5)) | 0; pts++; }
  return `${d.aspect.toFixed(6)}:${pts}:${h}`;
}

/** Hand edits from the design's values (LINEART_EDITS_KEY), checked. */
export function parseLineArtEdits(raw: unknown): LineArtEdits {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return {}; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: LineArtEdits = {};
  for (const [name, e] of Object.entries(o as Record<string, { fp?: unknown; strokes?: unknown }>).slice(0, 12)) {
    if (!e || typeof e.fp !== 'string' || !Array.isArray(e.strokes)) continue;
    const strokes: LineArtStroke[] = [];
    for (const st of e.strokes.slice(-MAX_LINEART_STROKES) as LineArtStroke[]) {
      if (!st || (st.mode !== 'draw' && st.mode !== 'erase') || !Array.isArray(st.points)) continue;
      const points = st.points.slice(0, MAX_STROKE_POINTS).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]] as [number, number]);
      if (!points.length) continue;
      const width = Number(st.width);
      strokes.push({ mode: st.mode, points, ...(width > 0 && width <= 50 ? { width } : {}) });
    }
    if (strokes.length) out[name.slice(0, 120)] = { fp: e.fp.slice(0, 80), strokes };
  }
  return out;
}

/**
 * A drawing as a black-on-white picture `heightPx` high (RGBA, anti-aliased), with its hand edits
 * drawn in – what the image model gets to change part of a drawing. `mmPerUnit`: the drawing's
 * size in the piece (its frame's k), for the strokes' widths.
 */
export function drawingPicture(d: SvgDrawing, strokes: LineArtStroke[], heightPx: number, mmPerUnit: number, lineWidth = 1): { width: number; height: number; rgba: Uint8Array } {
  const S = 2, H = Math.round(heightPx) * S, W = Math.round(d.aspect * heightPx) * S;
  const g: LineArtGrid = { w: W, h: H, px: 1 / H, x0: -d.aspect / 2, y1: 0.5 };
  const ink = new Uint8Array(W * H);
  // Shapes in paint order: the line colours add ink, the others (white-ish paper) cover it.
  const dark = defaultColors(d), lines = dark ? new Set(dark) : null;
  for (const sh of d.shapes) {
    const m = rasterize(sh.contours as Pt[][], g);
    const on = !lines || lines.has(sh.color ?? '');
    for (let i = 0; i < m.length; i++) if (m[i]) ink[i] = on ? 1 : 0;
  }
  const toPx = ([x, y]: [number, number]): Pt => [(x - g.x0) * H - 0.5, (g.y1 - y) * H - 0.5];
  for (const st of strokes) {
    const r = ((st.width ?? (st.mode === 'draw' ? lineWidth : 3)) / 2 / mmPerUnit) * H;
    const m = new Uint8Array(W * H), pts = st.points.map(toPx);
    if (pts.length === 1) capsuleXY(m, W, H, pts[0], pts[0], r);
    for (let k = 0; k + 1 < pts.length; k++) capsuleXY(m, W, H, pts[k], pts[k + 1], r);
    for (let i = 0; i < m.length; i++) if (m[i]) ink[i] = st.mode === 'draw' ? 1 : 0;
  }
  const w = W / S, h = H / S, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let n = 0;
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) n += ink[(y * S + dy) * W + x * S + dx];
    const v = 255 - Math.round((255 * n) / (S * S)), o = (y * w + x) * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = 255;
  }
  return { width: w, height: h, rgba };
}

/** Print settings for line art: flat, one colour, solid (2 mm is all top and bottom layers anyway), no brim to pick out of the lines. */
export function lineArtPrint(): LineArtResult['print'] {
  return { layerHeight: 0.2, walls: 2, infill: 100, infillPattern: 'zig-zag', brim: 'none' };
}

// ---------------------------------------------------------------------------
// The drawing on a pixel grid
// ---------------------------------------------------------------------------
//
// The drawing is rasterized at its final size (about 5 pixels per line width), and the work is done
// on pixels, where widths and gaps are easy to measure: the lines' centre lines (a thinned
// skeleton) are drawn again at an even width, areas much wider than a line stay solid, loose bits
// are joined to the rest along the shortest gaps (a minimum spanning tree) or dropped when too
// small to print, and the result is traced back into smooth polygons.

/** A pixel grid over the piece: pixel (i, j) has its centre at (x0 + (i + ½)·px, y1 − (j + ½)·px) mm; row 0 is the top. */
export interface LineArtGrid { w: number; h: number; px: number; x0: number; y1: number }

type Pt = [number, number];

/** Even-odd fill of `contours` (mm) on the grid. */
export function rasterize(contours: Pt[][], g: LineArtGrid, out = new Uint8Array(g.w * g.h)): Uint8Array {
  // Edges bucketed by the first row they cross, so each row only looks at its own edges.
  const rows: number[][] = Array.from({ length: g.h }, () => []);
  const edges: number[] = [];
  for (const c of contours) {
    for (let k = 0; k < c.length; k++) {
      const [ax, ay] = c[k], [bx, by] = c[(k + 1) % c.length];
      if (ay === by) continue;
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      // Rows whose centre Y may lie in [lo, hi) – a row more each way, as rounding here may differ
      // from the crossing test below, which decides (a missed crossing would streak a whole row).
      const jTop = Math.max(0, Math.ceil((g.y1 - hi) / g.px - 0.5) - 1), jBot = Math.min(g.h - 1, Math.floor((g.y1 - lo) / g.px - 0.5) + 1);
      if (jTop > jBot) continue;
      const e = edges.length;
      edges.push(ax, ay, bx, by, jBot);
      rows[jTop].push(e);
    }
  }
  let active: number[] = [];
  const xs: number[] = [];
  for (let j = 0; j < g.h; j++) {
    active = active.filter((e) => edges[e + 4] >= j);
    for (const e of rows[j]) active.push(e);
    const y = g.y1 - (j + 0.5) * g.px;
    xs.length = 0;
    for (const e of active) {
      const ax = edges[e], ay = edges[e + 1], bx = edges[e + 2], by = edges[e + 3];
      if ((ay <= y) === (by <= y)) continue;
      xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.px - 0.5)), i1 = Math.min(g.w - 1, Math.floor((xs[k + 1] - g.x0) / g.px - 0.5));
      if (i1 >= i0) out.fill(1, j * g.w + i0, j * g.w + i1 + 1);
    }
  }
  return out;
}

const FAR = 1e20;

/** Squared distance (pixels²) from every pixel to the nearest pixel where `src` is set (Felzenszwalb–Huttenlocher). */
export function sqDistance(src: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : FAR;
  const n = Math.max(w, h), f = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) ** 2 + f[v[k]]; }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) d[y * w + x] = out[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) d[y * w + x] = out[x];
  }
  return d;
}

/**
 * Zhang–Suen thinning: the one-pixel centre lines of `img` (changed in place), its pixels in
 * order. The border pixels must be empty. Only pixels on the edge (an empty neighbour) can go, so
 * each pass looks at those alone: thick areas cost their area once, not once per pass.
 */
function thin(img: Uint8Array, w: number) {
  const nb = N8(w);
  const queued = new Uint8Array(img.length);
  let edge: number[] = [];
  for (let i = 0; i < img.length; i++) if (img[i] && nb.some((k) => !img[i + k])) { edge.push(i); queued[i] = 1; }
  const del: number[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (const i of edge) {
        const p2 = img[i - w], p3 = img[i - w + 1], p4 = img[i + 1], p5 = img[i + w + 1], p6 = img[i + w], p7 = img[i + w - 1], p8 = img[i - 1], p9 = img[i - w - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const a = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) + (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
        if (a !== 1) continue;
        if (step === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
        del.push(i);
      }
      for (const i of del) img[i] = 0;
      if (del.length) {
        changed = true;
        // What a deleted pixel uncovers is on the edge now.
        const next = edge.filter((i) => img[i]);
        for (const i of del) for (const k of nb) { const j = i + k; if (img[j] && !queued[j]) { queued[j] = 1; next.push(j); } }
        edge = next;
      }
    }
  }
  const fg: number[] = [];
  for (let i = 0; i < img.length; i++) if (img[i]) fg.push(i);
  return fg;
}

const N8 = (w: number) => [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];

/**
 * Removes the spurs thinning leaves at a thick line's corners (branches up to `k` pixels long):
 * every loose end is cut back `k` pixels, then the ends that are left grow back along the skeleton
 * (real line ends get their length back, spurs don't), and a short line or dot that would vanish
 * altogether is kept.
 */
function prune(img: Uint8Array, fg: number[], w: number, k: number) {
  const nb = N8(w);
  const orig = img.slice();
  const count = (a: Uint8Array, i: number) => nb.reduce((n, o) => n + a[i + o], 0);
  for (let it = 0; it < k; it++) {
    const ends = fg.filter((i) => img[i] && count(img, i) === 1);
    if (!ends.length) break;
    for (const i of ends) img[i] = 0;
  }
  let ends = fg.filter((i) => img[i] && count(img, i) <= 1);
  for (let it = 0; it < k && ends.length; it++) {
    const next: number[] = [];
    for (const i of ends) for (const o of nb) if (orig[i + o] && !img[i + o]) { img[i + o] = 1; next.push(i + o); }
    ends = next;
  }
  // Skeleton pieces with nothing left (isolated pixels were never cut, so these are short lines).
  const seen = new Uint8Array(img.length);
  for (const s of fg) {
    if (seen[s] || !orig[s]) continue;
    const comp = [s];
    seen[s] = 1;
    let kept = false;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q];
      if (img[i]) kept = true;
      for (const o of nb) if (orig[i + o] && !seen[i + o]) { seen[i + o] = 1; comp.push(i + o); }
    }
    if (!kept) for (const i of comp) img[i] = 1;
  }
}

/** Removes the corner pixels of a skeleton's staircases (an L of two neighbours that touch each other anyway), so a line's pixels form a simple chain. */
function unstair(img: Uint8Array, fg: number[], w: number) {
  for (const i of fg) {
    if (!img[i]) continue;
    const n = img[i - w], e = img[i + 1], s = img[i + w], wv = img[i - 1];
    if ((n && e && !s && !wv && !img[i + w - 1]) || (e && s && !n && !wv && !img[i - w - 1]) || (s && wv && !n && !e && !img[i - w + 1]) || (wv && n && !s && !e && !img[i + w + 1])) img[i] = 0;
  }
}

/** The skeleton as chains of pixels from one end or junction to the next (closed loops too; a lone pixel is a chain of one). */
function skeletonChains(img: Uint8Array, fg: number[], w: number): number[][] {
  unstair(img, fg, w);
  const nb = N8(w);
  const nbrs = (i: number) => nb.map((k) => i + k).filter((j) => img[j]);
  const node = (i: number) => nbrs(i).length !== 2;
  const used = new Uint8Array(img.length), pairs = new Set<number>(), chains: number[][] = [];
  for (const s of fg) {
    if (!img[s] || !node(s)) continue;
    const ns = nbrs(s);
    if (!ns.length) { chains.push([s]); continue; }
    for (const first of ns) {
      if (used[first]) continue;
      const chain = [s];
      let prev = s, cur = first;
      for (;;) {
        chain.push(cur);
        if (node(cur)) break;
        used[cur] = 1;
        const next = nbrs(cur).find((j) => j !== prev)!;
        prev = cur; cur = next;
      }
      // Two junctions side by side: the same chain from both ends.
      if (chain.length === 2) {
        const key = Math.min(s, cur) * img.length + Math.max(s, cur);
        if (pairs.has(key)) continue;
        pairs.add(key);
      }
      chains.push(chain);
    }
  }
  // Closed loops (no end or junction on them).
  for (const s of fg) {
    if (!img[s] || used[s] || node(s)) continue;
    const chain = [s];
    used[s] = 1;
    let prev = s, cur = nbrs(s)[0];
    while (cur !== s && !used[cur]) {
      chain.push(cur); used[cur] = 1;
      const next = nbrs(cur).find((j) => j !== prev)!;
      prev = cur; cur = next;
    }
    chain.push(s);
    chains.push(chain);
  }
  return chains;
}

/** A chain of pixels drawn `r` px wide around its smoothed path, so a line drawn again doesn't follow the pixel steps of its skeleton; returns that path. */
function strokePolyline(img: Uint8Array, w: number, h: number, chain: number[], r: number): Pt[] {
  const raw: Pt[] = chain.map((i) => [i % w, (i / w) | 0]);
  // A running average over about half a line width takes out the skeleton's pixel zigzag; the
  // ends stay where they are (they meet other lines there).
  const m = Math.max(2, Math.round(r));
  const pts = raw.map((p, k): Pt => {
    if (k === 0 || k === raw.length - 1) return p;
    const a = Math.max(0, k - m), b = Math.min(raw.length - 1, k + m), c = Math.min(k - a, b - k);
    let x = 0, y = 0;
    for (let j = k - c; j <= k + c; j++) { x += raw[j][0]; y += raw[j][1]; }
    return [x / (2 * c + 1), y / (2 * c + 1)];
  });
  const path = pts.length > 2 ? simplifyOpen(pts, 0.4) : pts;
  if (path.length === 1) capsuleXY(img, w, h, path[0], path[0], r);
  for (let k = 0; k + 1 < path.length; k++) capsuleXY(img, w, h, path[k], path[k + 1], r);
  return path;
}

/** Ramer–Douglas–Peucker on an open polyline. */
function simplifyOpen(pts: Pt[], tol: number): Pt[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const A = pts[s], B = pts[e], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy || 1e-12;
    let worst = -1, wd = tol * tol;
    for (let k = s + 1; k < e; k++) {
      const P = pts[k], t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2));
      const d = (P[0] - A[0] - t * dx) ** 2 + (P[1] - A[1] - t * dy) ** 2;
      if (d > wd) { wd = d; worst = k; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([s, worst], [worst, e]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Draws a round-capped line of radius `r` px from point a to point b (pixel coordinates). */
function capsuleXY(img: Uint8Array, w: number, h: number, [ax, ay]: Pt, [bx, by]: Pt, r: number) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= r * r) img[y * w + x] = 1;
  }
}

export interface LineArtMaskOptions {
  lineWidth: number;
  /** Bridge every loose bit, however small (they were dropped beforehand, from the drawing itself). */
  keepSpecks?: boolean;
  /** Join loose line ends to the nearest line within this many mm (0: leave them). */
  joinEnds?: number;
  /**
   * No bridge longer than this (mm) between two bits that are both at least `minPart` mm² (a big
   * piece split into pieces: such bits become pieces of their own rather than get a long strut).
   */
  maxBridge?: number;
  minPart?: number;
  /** Where bridges and joins may go (a piece of a split: its outline); default anywhere. */
  inside?: Uint8Array | null;
  fill: number;
  minIsland: number;
  lines: 'even' | 'keep';
}

/**
 * The drawing `art` made printable as one piece, on grid `g`: lines redrawn at an even width (or
 * only thin ones thickened), specks dropped, and loose bits bridged to the rest and to `anchor`
 * (the bar or frame, which is not part of the result). `mask` is the whole result; `paths` the
 * centre lines of what Jig drew (thickened lines and bridges, `lineWidth` wide, in pixels), which
 * lines 'keep' adds to the drawing as it was.
 */
export function lineArtMask(art: Uint8Array, anchor: Uint8Array | null, g: LineArtGrid, o: LineArtMaskOptions): { mask: Uint8Array; paths: Pt[][]; bridges: number; longestBridge: number; dropped: number; closed: number; openings: number; endsJoined: number; endsFree: number } {
  const { w, h, px } = g, N = w * h;
  const r = o.lineWidth / px / 2;
  // Keep the outermost pixels empty (thinning and tracing rely on it).
  for (let x = 0; x < w; x++) { art[x] = 0; art[N - w + x] = 0; }
  for (let y = 0; y < h; y++) { art[y * w] = 0; art[y * w + w - 1] = 0; }

  const nb = N8(w);
  const stack: number[] = [];
  // Loose bits of the drawing too small to print on their own are dropped (pieces touching the bar
  // or frame are never loose).
  const minPx = o.minIsland / (px * px);
  let dropped = 0;
  {
    const seen = new Uint8Array(N), comp: number[] = [];
    for (let s = 0; s < N; s++) {
      if (seen[s] || !art[s]) continue;
      comp.length = 0; comp.push(s); seen[s] = 1;
      let anchored = false;
      for (let q = 0; q < comp.length; q++) {
        const i = comp[q];
        if (anchor?.[i]) anchored = true;
        for (const k of nb) { const j = i + k; if (!seen[j] && (art[j] || anchor?.[j])) { seen[j] = 1; comp.push(j); } }
      }
      if (!o.keepSpecks && !anchored && comp.length < minPx) { for (const i of comp) art[i] = 0; dropped++; }
    }
  }

  // Solid areas: what an opening by a disc as wide as `fill` keeps.
  const bg = new Uint8Array(N);
  for (let i = 0; i < N; i++) bg[i] = art[i] ? 0 : 1;
  const inside = sqDistance(bg, w, h);
  const R = Math.max(r + 1, (o.fill / px + 1) / 2);
  const core = new Uint8Array(N);
  let anyCore = false;
  for (let i = 0; i < N; i++) if (inside[i] >= R * R) { core[i] = 1; anyCore = true; }
  const solid = new Uint8Array(N);
  if (anyCore) {
    const near = sqDistance(core, w, h);
    for (let i = 0; i < N; i++) if (art[i] && near[i] <= R * R) solid[i] = 1;
  }

  // Lines: the skeleton, followed as smoothed polylines and drawn `lineWidth` wide – every line
  // ('even'), or ('keep') only where the drawing's own line is thinner than that, so lines thick
  // enough stay exactly as drawn.
  const skel = art.slice();
  const fg = thin(skel, w);
  if (o.lines === 'even') prune(skel, fg, w, Math.ceil(r) + 1);
  // Thinning can wipe out a small blob (a dot, an eye) altogether: it keeps its middle pixel.
  const seen = new Uint8Array(N), comp: number[] = [];
  for (let s = 0; s < N; s++) {
    if (!art[s] || seen[s]) continue;
    comp.length = 0; comp.push(s); seen[s] = 1;
    let has = false, mid = s;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q];
      if (skel[i]) has = true;
      if (inside[i] > inside[mid]) mid = i;
      for (const k of nb) if (art[i + k] && !seen[i + k]) { seen[i + k] = 1; comp.push(i + k); }
    }
    if (!has) { skel[mid] = 1; fg.push(mid); }
  }
  const strokes = new Uint8Array(N);
  // The centre lines drawn (pixel coordinates), each `r` px wide: lines 'keep' builds them as exact shapes.
  const paths: Pt[][] = [];
  // A thin stretch shorter than this at a free end, joined to a thick line, is a corner's tip or a
  // thinning spur, not a line of its own: it keeps its drawn shape.
  const tip = Math.ceil(4 * r);
  // Thin: clearly under lineWidth (a line drawn at exactly lineWidth measures a little under it at its bends and on the pixel grid).
  const thinAt = (i: number) => inside[i] < (r - 0.25) ** 2;
  for (const chain of skeletonChains(skel, fg, w)) {
    if (o.lines === 'even') { paths.push(strokePolyline(strokes, w, h, chain, r)); continue; }
    const deg = (i: number) => nb.reduce((n, k) => n + skel[i + k], 0);
    for (let k = 0; k < chain.length;) {
      if (!thinAt(chain[k])) { k++; continue; }
      // One stretch, through short thick bits (a line about as wide as lineWidth flickers between
      // the two): one stroke, not several with jogs between them.
      let e = k;
      for (let j = k + 1; j < chain.length && j - e <= tip; j++) if (thinAt(chain[j])) e = j;
      const atStart = k === 0, atEnd = e === chain.length - 1;
      const freeTip = (atStart && deg(chain[0]) <= 1 && !atEnd) || (atEnd && deg(chain[chain.length - 1]) <= 1 && !atStart);
      // A thin run between two thick stretches or reaching a junction is a line; one alone at a
      // free end of a thick line is a tip.
      if (!(freeTip && e - k + 1 < tip)) paths.push(strokePolyline(strokes, w, h, chain.slice(Math.max(0, k - 1), e + 2), r));
      k = e + 1;
    }
  }
  const out = o.lines === 'keep' ? art.slice() : solid;
  for (let i = 0; i < N; i++) if (strokes[i]) out[i] = 1;
  // Detail lost: openings between the lines that were there and aren't any more.
  const openings = countOpenings(art, w, h, minPx), closed = Math.max(0, openings - countOpenings(out, w, h, minPx));

  // Pieces (8-connected), with the bar or frame.
  const label = new Int32Array(N);
  const sizes = [0];
  for (let s = 0; s < N; s++) {
    if (label[s] || !(out[s] || anchor?.[s])) continue;
    const l = sizes.length;
    let n = 0;
    label[s] = l; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      for (const k of nb) { const j = i + k; if (j >= 0 && j < N && !label[j] && (out[j] || anchor?.[j])) { label[j] = l; stack.push(j); } }
    }
    sizes.push(n);
  }
  // Bridges: grow every piece across the empty pixels at once; where two meet, the nearest points
  // of the two pieces are a candidate bridge. The shortest bridges that join everything (Kruskal).
  let bridges = 0, longest = 0;
  if (sizes.length > 2) {
    const src = new Int32Array(N).fill(-1);
    let queue: number[] = [];
    for (let i = 0; i < N; i++) if (label[i]) { src[i] = i; queue.push(i); }
    const best = new Map<number, [number, number, number, number]>(), more = new Map<number, [number, number, number, number][]>();
    const L = sizes.length;
    const dist = (a: number, b: number) => Math.hypot((a % w) - (b % w), ((a / w) | 0) - ((b / w) | 0));
    const meet = (i: number, j: number) => {
      const a = label[i], b = label[j];
      if (!b || a === b) return;
      const key = a < b ? a * L + b : b * L + a, d = dist(src[i], src[j]);
      const cur = best.get(key);
      if (!cur || d < cur[0]) best.set(key, [d, src[i], src[j], i]);
      // Kept inside the piece, the nearest points may not do: a few more of the nearest pairs.
      if (o.inside) {
        // (Spread out: one per line width along the two.)
        const list = more.get(key) ?? more.set(key, []).get(key)!, si = src[i], sj = src[j];
        if (list.length < 24 || d < list[list.length - 1][0]) {
          const near = list.findIndex((c) => dist(c[1], si) < 2 * r && dist(c[2], sj) < 2 * r);
          if (near < 0 || d < list[near][0]) {
            if (near >= 0) list.splice(near, 1);
            list.push([d, si, sj, i]);
            list.sort((x, y) => x[0] - y[0]);
            if (list.length > 24) list.pop();
          }
        }
      }
    };
    while (queue.length) {
      const next: number[] = [];
      for (const i of queue) {
        for (const k of nb) {
          const j = i + k;
          if (j < 0 || j >= N || (o.inside && !o.inside[j])) continue;
          if (!label[j]) { label[j] = label[i]; src[j] = src[i]; next.push(j); } else meet(i, j);
        }
      }
      queue = next;
    }
    const parent = Array.from({ length: L }, (_, l) => l);
    const find = (l: number): number => (parent[l] === l ? l : (parent[l] = find(parent[l])));
    const size = sizes.slice(), minPart = (o.minPart ?? 0) / (px * px);
    for (const [key, [d0, a0, b0, m0]] of [...best].sort((x, y) => x[1][0] - y[1][0])) {
      const ra = find(Math.floor(key / L)), rb = find(key % L);
      if (ra === rb) continue;
      const xy = (i: number): Pt => [i % w, (i / w) | 0];
      // Kept inside the piece: the nearest points straight, else the next nearest, else bent where the two grew together.
      let path: Pt[] | null = [xy(a0), xy(b0)], d = d0;
      if (o.inside && !within(o.inside, w, path[0], path[1])) {
        const cands = more.get(key) ?? [[d0, a0, b0, m0]];
        const ok = cands.find(([, a, b]) => within(o.inside!, w, xy(a), xy(b))) ?? cands.find(([, a, b, m]) => within(o.inside!, w, xy(a), xy(m)) && within(o.inside!, w, xy(m), xy(b)));
        path = !ok ? null : within(o.inside, w, xy(ok[1]), xy(ok[2])) ? [xy(ok[1]), xy(ok[2])] : [xy(ok[1]), xy(ok[3]), xy(ok[2])];
        if (path) d = path.reduce((n, p, k) => (k ? n + Math.hypot(p[0] - path![k - 1][0], p[1] - path![k - 1][1]) : 0), 0);
      }
      if (!path) continue;
      if (o.maxBridge != null && d * px - o.lineWidth > o.maxBridge && size[ra] >= minPart && size[rb] >= minPart) continue;
      parent[ra] = rb;
      size[rb] += size[ra];
      for (let k = 0; k + 1 < path.length; k++) capsuleXY(out, w, h, path[k], path[k + 1], r);
      paths.push(path);
      bridges++;
      longest = Math.max(longest, Math.max(0, d * px - o.lineWidth));
    }
  }
  const ends = o.joinEnds ? joinLooseEnds(out, anchor, g, o.lineWidth, o.joinEnds, paths, o.inside) : { joined: 0, free: 0 };
  return { mask: out, paths, bridges, longestBridge: longest, dropped, closed, openings, endsJoined: ends.joined, endsFree: ends.free };
}

/** Whether the straight line from pixel a to pixel b stays on set pixels of `mask` (w wide). */
function within(mask: Uint8Array, w: number, [ax, ay]: Pt, [bx, by]: Pt): boolean {
  const n = Math.ceil(2 * Math.hypot(bx - ax, by - ay)) + 1;
  for (let k = 0; k <= n; k++) if (!mask[Math.round(ay + ((by - ay) * k) / n) * w + Math.round(ax + ((bx - ax) * k) / n)]) return false;
  return true;
}

/**
 * Joins what hangs loose: a line or a branch of lines (a bracket with a plate on it) attached to
 * the rest at one point only lifts off the wall, as only the tape behind the rest holds it. The
 * skeleton's loose ends are peeled off again and again, which leaves what is held at two or more
 * points; each hanging branch longer than max(3 mm, 3 line widths) gets a bridge from its farthest
 * end to the nearest other line within `reach` mm, preferring the way that line was going. Thick
 * shapes (windows, tyres) hold themselves and are never peeled. Bridges are drawn into `out`, and
 * their centre lines added to `paths`.
 */
function joinLooseEnds(out: Uint8Array, anchor: Uint8Array | null, g: LineArtGrid, lineWidth: number, reach: number, paths: Pt[][], inside?: Uint8Array | null): { joined: number; free: number } {
  const { w, h, px } = g, N = w * h;
  const r = lineWidth / px / 2, R = reach / px, minArm = Math.max(3, 3 * lineWidth) / px;
  const whole = new Uint8Array(N), bg = new Uint8Array(N);
  for (let i = 0; i < N; i++) { whole[i] = out[i] || anchor?.[i] ? 1 : 0; bg[i] = whole[i] ? 0 : 1; }
  const depth = sqDistance(bg, w, h);
  const skel = whole.slice();
  const chains = skeletonChains(skel, thin(skel, w), w);
  const nb = N8(w);
  const deg = (i: number) => nb.reduce((n, k) => n + skel[i + k], 0);
  // A line is about lineWidth wide; a chain mostly deeper than this runs through something solid.
  const lineDepth = (1.6 * r + 1) ** 2;
  const thick = chains.map((c) => c.filter((i) => depth[i] > lineDepth).length * 2 > c.length);

  // Peel: a chain with a loose end goes, and its other end may become loose in turn.
  const at = new Map<number, number[]>();
  chains.forEach((c, k) => { for (const e of [c[0], c[c.length - 1]]) (at.get(e) ?? at.set(e, []).get(e)!).push(k); });
  const alive = chains.map(() => true);
  const live = (node: number) => (at.get(node) ?? []).filter((k) => alive[k]).length;
  const queue = [...at.keys()].filter((n) => live(n) === 1);
  while (queue.length) {
    const n = queue.pop()!;
    if (live(n) !== 1) continue;
    const k = at.get(n)!.find((c) => alive[c])!;
    const c = chains[k];
    if (thick[k] || c[0] === c[c.length - 1]) continue;
    alive[k] = false;
    const other = c[0] === n ? c[c.length - 1] : c[0];
    if (live(other) === 1) queue.push(other);
  }

  // The hanging branches: peeled chains joined at their ends, each with the point it hangs from.
  const seenChain = chains.map(() => false);
  const stamp = new Int32Array(N), steps = new Int32Array(N);
  let joined = 0, free = 0, run = 0;
  for (let k0 = 0; k0 < chains.length; k0++) {
    if (alive[k0] || seenChain[k0]) continue;
    const tree: number[] = [], todo = [k0];
    seenChain[k0] = true;
    let hang = -1;
    while (todo.length) {
      const k = todo.pop()!;
      tree.push(k);
      for (const e of [chains[k][0], chains[k][chains[k].length - 1]]) {
        if (live(e) > 0) hang = e;
        for (const j of at.get(e) ?? []) if (!alive[j] && !seenChain[j]) { seenChain[j] = true; todo.push(j); }
      }
    }
    const length = tree.reduce((n, k) => n + chains[k].length, 0);
    // A whole piece without any loop has nothing to hang from: leave it.
    if (hang < 0 || length < minArm) continue;
    const hx = hang % w, hy = (hang / w) | 0;
    // Its loose ends, farthest from where it hangs first, each with the chain leading to it.
    const ends: { e: number; chain: number[] }[] = [];
    for (const k of tree) {
      const c = chains[k];
      if (deg(c[0]) <= 1) ends.push({ e: c[0], chain: c });
      if (deg(c[c.length - 1]) <= 1) ends.push({ e: c[c.length - 1], chain: [...c].reverse() });
    }
    ends.sort((a, b) => Math.hypot((b.e % w) - hx, ((b.e / w) | 0) - hy) - Math.hypot((a.e % w) - hx, ((a.e / w) | 0) - hy));
    let done = false;
    for (const { e, chain } of ends) {
      const ex = e % w, ey = (e / w) | 0;
      // What belongs to the branch itself: all within its length along the piece from this end.
      run++;
      const limit = length + 3 * r;
      let wave = [e];
      stamp[e] = run; steps[e] = 0;
      while (wave.length) {
        const next: number[] = [];
        for (const i of wave) for (const o of nb) {
          const j = i + o;
          if (whole[j] && stamp[j] !== run && steps[i] + 1 <= limit) { stamp[j] = run; steps[j] = steps[i] + 1; next.push(j); }
        }
        wave = next;
      }
      // The way the line was going at its end.
      const back = chain[Math.min(chain.length - 1, Math.round(3 * r))];
      let dx = ex - (back % w), dy = ey - ((back / w) | 0);
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl; dy /= dl;
      let best = -1, bestScore = Infinity;
      const x0 = Math.max(1, Math.floor(ex - R)), x1 = Math.min(w - 2, Math.ceil(ex + R)), y0 = Math.max(1, Math.floor(ey - R)), y1 = Math.min(h - 2, Math.ceil(ey + R));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (!whole[i] || stamp[i] === run) continue;
        const d = Math.hypot(x - ex, y - ey);
        if (d > R || d < 1) continue;
        const cos = ((x - ex) * dx + (y - ey) * dy) / d;
        if (cos < -0.2) continue;
        const score = d * (2 - cos);
        if (score < bestScore && (!inside || within(inside, w, [ex, ey], [x, y]))) { bestScore = score; best = i; }
      }
      if (best < 0) continue;
      const bx = best % w, by = (best / w) | 0;
      // Reach a little into the line it joins, so the two overlap.
      const d = Math.hypot(bx - ex, by - ey), tx = bx + ((bx - ex) / d) * Math.min(r, d) * 0.5, ty = by + ((by - ey) / d) * Math.min(r, d) * 0.5;
      capsuleXY(out, w, h, [ex, ey], [tx, ty], r);
      capsuleXY(whole, w, h, [ex, ey], [tx, ty], r);
      paths.push([[ex, ey], [tx, ty]]);
      joined++;
      done = true;
      break;
    }
    if (!done) free++;
  }
  return { joined, free };
}

/** Enclosed empty areas of `img` (4-connected, not touching the border) of at least `min` pixels. */
function countOpenings(img: Uint8Array, w: number, h: number, min: number): number {
  const seen = new Uint8Array(w * h), stack: number[] = [];
  let n = 0;
  for (let s = 0; s < w * h; s++) {
    if (img[s] || seen[s]) continue;
    let size = 0, edge = false;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i / w) | 0;
      size++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { edge = true; }
      if (x > 0 && !img[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && !img[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !img[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && !img[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (!edge && size >= min) n++;
  }
  return n;
}

/** The outlines of `mask` (lightly smoothed, then marching squares at half height), simplified to `tol` mm; mm coordinates, even-odd. */
export function traceMask(mask: Uint8Array, g: LineArtGrid, tol: number): Pt[][] {
  const { w, h } = g;
  // A 3×3 box blur rounds the pixel steps off.
  const v = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    v[i] = (mask[i - w - 1] + mask[i - w] + mask[i - w + 1] + mask[i - 1] + mask[i] + mask[i + 1] + mask[i + w - 1] + mask[i + w] + mask[i + w + 1]) / 9;
  }
  return traceField(v, g, 0.5, tol);
}

/**
 * The outlines where `v` crosses `iso` (marching squares, the crossing placed between pixels by
 * their values, so an anti-aliased picture gives sub-pixel edges), simplified to `tol`; mm
 * coordinates of grid `g`, even-odd. The outermost pixels must be below `iso`.
 */
export function traceField(v: ArrayLike<number>, g: LineArtGrid, iso: number, tol: number): Pt[][] {
  const { w, h, px } = g;
  // Crossing points on cell edges: horizontal edge (x, y)–(x+1, y) is 2·(y·w + x), vertical (x, y)–(x, y+1) is 2·(y·w + x) + 1.
  const pts = new Map<number, Pt>();
  const at = (e: number): Pt => {
    let p = pts.get(e);
    if (p) return p;
    const i = e >> 1, x = i % w, y = (i / w) | 0, j = e & 1 ? i + w : i + 1;
    const t = (iso - v[i]) / (v[j] - v[i]);
    const fx = e & 1 ? x : x + t, fy = e & 1 ? y + t : y;
    p = [g.x0 + (fx + 0.5) * px, g.y1 - (fy + 0.5) * px];
    pts.set(e, p);
    return p;
  };
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    const a = v[i] > iso, b = v[i + 1] > iso, c = v[i + w + 1] > iso, d = v[i + w] > iso;
    if (a === b && b === c && c === d) continue;
    const T = 2 * i, B = 2 * (i + w), Lf = 2 * i + 1, Rt = 2 * (i + 1) + 1;
    const cross = [a !== b && T, b !== c && Rt, d !== c && B, a !== d && Lf].filter((e) => e !== false) as number[];
    if (cross.length === 2) link(cross[0], cross[1]);
    else {
      // A saddle: the centre decides which corners are joined.
      const mid = (v[i] + v[i + 1] + v[i + w + 1] + v[i + w]) / 4 > iso;
      if (a === mid) { link(T, Rt); link(B, Lf); } else { link(T, Lf); link(Rt, B); }
    }
  }
  const seen = new Set<number>();
  const loops: Pt[][] = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop: Pt[] = [];
    let prev = -1, cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      loop.push(at(cur));
      const nx = links.get(cur)!;
      const next = nx[0] !== prev ? nx[0] : nx[1];
      prev = cur; cur = next;
      if (cur == null) break;
    }
    if (loop.length >= 3) loops.push(simplify(loop, tol));
  }
  return loops.filter((l) => l.length >= 3);
}

/** Ramer–Douglas–Peucker on a closed loop. */
function simplify(loop: Pt[], tol: number): Pt[] {
  if (loop.length < 8) return loop;
  // Split at the point farthest from the first, so both halves are open polylines.
  let far = 0, fd = -1;
  for (let k = 1; k < loop.length; k++) { const d = (loop[k][0] - loop[0][0]) ** 2 + (loop[k][1] - loop[0][1]) ** 2; if (d > fd) { fd = d; far = k; } }
  const keep = new Uint8Array(loop.length);
  keep[0] = keep[far] = 1;
  const t2 = tol * tol;
  const stack: [number, number][] = [[0, far], [far, loop.length]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const A = loop[s], Bp = loop[e % loop.length];
    const dx = Bp[0] - A[0], dy = Bp[1] - A[1], L2 = dx * dx + dy * dy || 1e-12;
    let worst = -1, wd = t2;
    for (let k = s + 1; k < e; k++) {
      const P = loop[k], t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2));
      const d = (P[0] - A[0] - t * dx) ** 2 + (P[1] - A[1] - t * dy) ** 2;
      if (d > wd) { wd = d; worst = k; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([s, worst], [worst, e]); }
  }
  return loop.filter((_, k) => keep[k]);
}

// ---------------------------------------------------------------------------
// The piece
// ---------------------------------------------------------------------------

/** Round-capped strokes `r` mm wide along `paths` (mm) as counter-clockwise outlines – a quad per segment and a disc per point – whose union (NonZero) is the strokes. */
function strokeOutlines(paths: Pt[][], r: number, n: number): Pt[][] {
  const m = Math.max(8, Math.round(n));
  const disc: Pt[] = Array.from({ length: m }, (_, k) => [Math.cos((2 * Math.PI * k) / m) * r, Math.sin((2 * Math.PI * k) / m) * r]);
  const out: Pt[][] = [];
  for (const p of paths) {
    for (const [x, y] of p) out.push(disc.map(([dx, dy]) => [x + dx, y + dy]));
    for (let k = 0; k + 1 < p.length; k++) {
      const [ax, ay] = p[k], [bx, by] = p[k + 1], L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-9) continue;
      const nx = (-(by - ay) / L) * r, ny = ((bx - ax) / L) * r;
      out.push([[ax - nx, ay - ny], [bx - nx, by - ny], [bx + nx, by + ny], [ax + nx, ay + ny]]);
    }
  }
  return out;
}

/** What buildLineArt needs from the runtime (Manifold's classes, the text and drawing helpers). */
export interface LineArtDeps {
  M: any;
  C: any;
  quality: 'draft' | 'normal' | 'high';
  /** A drawing at unit height as a CrossSection (its lines), or an error. */
  section: (name: string, colors?: string[]) => any;
  /** A drawing's fingerprint, so a cached result is only reused for the same drawing (and hand edits only apply to it). */
  fingerprint: (name: string) => string;
  /** The hand edits made on a drawing (already matched to its fingerprint). */
  edits: (name: string) => LineArtStroke[];
  text: (s: string, o: { size: number; font?: string; halign: 'center'; valign: 'center' }) => any;
  /** The user's split choice (LINEART_SPLIT_KEY), which wins over the script's split option. */
  split?: SplitSpec | 'off';
  /** The layout of a split piece when the script passes none (LINEART_LAYOUT_KEY). */
  layout?: string;
  /** The whole piece's size the user typed (LINEART_SIZE_KEY), which wins over the script's width and height. */
  size?: { width?: number; height?: number };
}

/** Recent traced results: a live preview evaluates the same drawing on every slider move. */
const cache = new Map<string, { loops: Pt[][]; paths: Pt[][]; bridges: number; longestBridge: number; dropped: number; closed: number; openings: number; endsJoined: number; endsFree: number }>();
const CACHE_SIZE = 6;
/** The most pixels of a grid (the pixels grow past it). */
const MAX_PIXELS = { draft: 1_500_000, normal: 4_000_000, high: 8_000_000 };
/** The A1's bed. */
const BED = 256;
/** The largest piece H.lineart makes (split into pieces that fit the bed), mm. */
const MAX_SIZE = 3000;

export function buildLineArt(d: LineArtDeps, source: string | string[], opts: LineArtOptions = {}): LineArtResult {
  // The size the user typed wins: a width alone frees the height (it follows the drawing), a
  // height alone sets the largest width, so the height decides.
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
  const joinEnds = num('joinEnds', 8, 0, 50);
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
  const brush = (st: LineArtStroke, toUnit: (p: Pt) => Pt, mmPerUnit: number) =>
    new C(strokeOutlines([st.points.map(toUnit)], (st.width ?? (st.mode === 'draw' ? lineWidth : 3)) / 2 / mmPerUnit, segs / 4), 'NonZero');
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
      for (const st of u.edits) cs = st.mode === 'draw' ? cs.add(brush(st, toUnit, s)) : cs.subtract(brush(st, toUnit, s));
      const p = cs.scale(s).translate([x, 0]);
      art = art ? art.add(p) : p;
      frames.push({ name: u.name, k: s / u.h, tx: x - (u.bx * s) / u.h, ty: -(u.by * s) / u.h, fp: d.fingerprint(u.name) });
      x += u.w * s + gap;
    }
    return art;
  };
  const moveFrames = (dx: number, dy: number, scale = 1) => { for (const f of frames) { f.k *= scale; f.tx = (f.tx + dx) * scale; f.ty = (f.ty + dy) * scale; } };
  const heightFor = (artW: number) => (artW - gap * (names.length - 1)) / sumW;

  // How far the art reaches into a bar or frame it touches.
  const overlap = Math.min(lineWidth, bar ? barHeight / 3 : frameWidth / 2);
  const ov = padding > 0 ? 0 : overlap;
  let s: number;
  if (style === 'outline') s = heightFor(width);
  else if (bar) s = heightFor(width - 2 * overhang);
  else if (style === 'framed') s = heightFor(width - 2 * (frameWidth + padding - ov));
  else s = heightFor(width - 2 * frameWidth); // medallion: refined below
  if (!(s > 0)) throw new Error('H.lineart: the drawing has no room – make width larger or gap, overhang or frameWidth smaller');
  // A height limit shrinks the art.
  if (opts.height != null) {
    const H = num('height', 0, 5, MAX_SIZE);
    const room = style === 'outline' ? H : bar ? H - barHeight + overlap : style === 'framed' ? H - 2 * (frameWidth + padding - ov) : H - 2 * frameWidth;
    if (!(room > 0)) throw new Error('H.lineart: height leaves no room for the drawing');
    s = Math.min(s, room);
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
  const grid = splitSpec === 'off' ? null : splitGrid(ab.max[0] - ab.min[0], ab.max[1] - ab.min[1], splitSpec, MAX_PIECE, SPLIT_RESERVE);

  // Key holder: pegs out of the bar's front, printed standing up: a flared foot, the stem, and a
  // cap that keeps the keys on (its underside a 45° cone, no support).
  let hooks = 0, peg: any = null, pegFoot = 0;
  const pegAt: Pt[] = [];
  if (style === 'keyholder') {
    hooks = Math.round(num('hooks', Math.max(2, Math.round(width / 70)), 1, 20));
    const len = num('hookLength', 15, 6, 60), dia = num('hookDiameter', 6, 3, 20);
    const r = dia / 2, foot = 1, cap = 1.5, flare = 1.5;
    peg = M.cylinder(foot, r + foot, r, segs / 2)
      .add(M.cylinder(len - cap - flare, r, r, segs / 2))
      .add(M.cylinder(flare, r, r + flare, segs / 2).translate([0, 0, len - cap - flare]))
      .add(M.cylinder(cap, r + flare, r + flare, segs / 2).translate([0, 0, len - cap]));
    pegFoot = r + flare;
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

  let parts: LineArtResult['parts'];
  let info: LineArtInfo;
  let sp: SplitResult | null = null;
  if (!grid || grid.cols * grid.rows < 2) {
    // The drawing made printable, on a pixel grid over the whole piece.
    let px = lineWidth / (d.quality === 'draft' ? 3 : d.quality === 'high' ? 6 : 5);
    const area = (ab.max[0] - ab.min[0] + 8 * px) * (ab.max[1] - ab.min[1] + 8 * px);
    px = Math.max(px, Math.sqrt(area / MAX_PIXELS[d.quality]));
    const key = JSON.stringify([names.map((n) => d.fingerprint(n)), opts.colors ?? null, style, s, aw, gap, lineWidth, lines, fill, minIsland, pieceW, pieceH, barHeight, overhang, frameWidth, padding, opts.shape ?? '', px, joinEnds, units.map((u) => u.edits)]);
    let res = cache.get(key);
    if (!res) {
      const g: LineArtGrid = { px, x0: ab.min[0] - 4 * px, y1: ab.max[1] + 4 * px, w: Math.ceil((ab.max[0] - ab.min[0]) / px) + 8, h: Math.ceil((ab.max[1] - ab.min[1]) / px) + 8 };
      const m = lineArtMask(rasterize(art.toPolygons(), g), anchor ? rasterize(anchor.toPolygons(), g) : null, g, { lineWidth, fill, minIsland, lines, keepSpecks: lines === 'keep', joinEnds });
      const mm = ([x, y]: Pt): Pt => [g.x0 + (x + 0.5) * px, g.y1 - (y + 0.5) * px];
      res = { loops: lines === 'keep' ? [] : traceMask(m.mask, g, px * 0.35), paths: lines === 'keep' ? m.paths.map((p) => p.map(mm)) : [], bridges: m.bridges, longestBridge: m.longestBridge, dropped: m.dropped, closed: m.closed, openings: m.openings, endsJoined: m.endsJoined, endsFree: m.endsFree };
      cache.set(key, res);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    }
    // Lines kept as drawn: the drawing itself, exactly, with what Jig drew (thickened lines, bridges) added as exact shapes.
    let lineCs = lines === 'keep' ? (res.paths.length ? art.add(new C(strokeOutlines(res.paths, lineWidth / 2, segs / 4), 'NonZero')) : art) : new C(res.loops, 'EvenOdd');
    // Erasing by hand has the last word: also over what Jig drew there (a join, a bridge).
    units.forEach((u, i) => {
      const f = frames[i];
      for (const st of u.edits) if (st.mode === 'erase') lineCs = lineCs.subtract(brush(st, ([x, y]) => [x * f.k + f.tx, y * f.k + f.ty], 1));
    });
    let shape = lineCs.extrude(thickness);
    if (anchor) shape = shape.add(anchor.extrude(anchorThickness));
    shape = decorate(shape);
    info = { style, sources: names, size: [pieceW, pieceH], thickness, lineWidth, lines, bridges: res.bridges, longestBridge: res.longestBridge, dropped: res.dropped + vectorDropped, closed: res.closed, openings: res.openings, endsJoined: res.endsJoined, endsFree: res.endsFree, hooks, frames, edits: units.reduce((n, u) => n + u.edits.length, 0) };
    parts = [{ name: 'Line art', shape, color, lineArt: info }];
  } else {
    // Split into pieces: Jig's clean-up runs on each piece on its own, so each holds together by itself.
    let erase: any = null;
    units.forEach((u, i) => {
      const f = frames[i];
      for (const st of u.edits) if (st.mode === 'erase') { const b = brush(st, ([x, y]) => [x * f.k + f.tx, y * f.k + f.ty], 1); erase = erase ? erase.add(b) : b; }
    });
    const key = JSON.stringify([names.map((n) => d.fingerprint(n)), opts.colors ?? null, style, s, aw, gap, lineWidth, lines, fill, minIsland, pieceW, pieceH, barHeight, overhang, frameWidth, padding, opts.shape ?? '', joinEnds, units.map((u) => u.edits), d.quality, grid, hooks, opts.text ?? '', opts.clearance ?? null]);
    sp = splitPieces({
      d, key, art, anchor, erase, ab, cols: grid.cols, rows: grid.rows, lineWidth, fill, minIsland, lines, joinEnds, segs,
      clearance: num('clearance', 0.15, 0, 1), maxBridge: SPLIT_MAX_BRIDGE, minPart: SPLIT_MIN_PART * lineWidth, pegAt, pegZone: pegFoot + 1, barHeight, signText,
    });
    const totals = sp.pieces.reduce((t, p) => ({ bridges: t.bridges + p.info.bridges, longestBridge: Math.max(t.longestBridge, p.info.longestBridge), dropped: t.dropped + p.info.dropped, endsJoined: t.endsJoined + p.info.endsJoined, endsFree: t.endsFree + p.info.endsFree, closed: t.closed + p.closed, openings: t.openings + p.openings }), { bridges: 0, longestBridge: 0, dropped: vectorDropped, endsJoined: 0, endsFree: 0, closed: 0, openings: 0 });
    info = { style, sources: names, size: [pieceW, pieceH], thickness, lineWidth, lines, ...totals, hooks, frames, edits: units.reduce((n, u) => n + u.edits.length, 0) };
    const labels = opts.labels !== false;
    const res = sp;
    parts = res.pieces.map((p, i) => {
      let shape = p.lineCs.isEmpty() ? p.anchor.extrude(anchorThickness) : p.lineCs.extrude(thickness);
      if (p.anchor && !p.lineCs.isEmpty()) shape = shape.add(p.anchor.extrude(anchorThickness));
      shape = decorate(shape, (q) => res.pieceAt(q) === i, p.region);
      // Its name engraved on the back, mirrored so it reads from the back.
      const at = labels ? res.label(i) : null;
      if (at) {
        let t = d.text(p.info.label, { size: at.size, halign: 'center', valign: 'center' });
        const tb = t.bounds();
        t = t.translate([-(tb.min[0] + tb.max[0]) / 2, -(tb.min[1] + tb.max[1]) / 2]).mirror([1, 0]);
        if (at.rot) t = t.rotate(90);
        shape = shape.subtract(t.translate([at.x, at.y]).extrude(LABEL_DEPTH + 1).translate([0, 0, -1]));
      }
      p.info.labelSize = at ? at.size : 0;
      return { name: p.info.label, shape, color, lineArt: info, plate: i + 1 };
    });
  }

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
  for (const p of parts) { const b = (p.shape as any).boundingBox(); lo = [Math.min(lo[0], b.min[0]), Math.min(lo[1], b.min[1])]; hi = [Math.max(hi[0], b.max[0]), Math.max(hi[1], b.max[1])]; }
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
  if (Math.abs(cx) > 1e-6 || Math.abs(cy) > 1e-6) {
    for (const p of parts) p.shape = (p.shape as any).translate([-cx, -cy, 0]);
    moveFrames(-cx, -cy);
  }
  let note: string, assembly: LineArtResult['assembly'];
  if (!sp) {
    const big = pieceW > BED || pieceH > BED ? ` It is ${pieceW.toFixed(0)} × ${pieceH.toFixed(0)} mm, bigger than the A1's ${BED} mm bed: make it smaller${grid ? '' : ', or split it into pieces'}.` : '';
    note = `Print it flat, back on the bed, in one colour (black PLA): 0.2 mm layers, 100 % infill, no brim. ${style === 'keyholder' ? `The ${hooks} pegs print standing up. ` : ''}${style === 'stand' ? '' : 'Hang it with double-sided tape or Command strips.'}${slotNote}${big}`;
  } else {
    const split = splitInfo(sp, splitSpec as SplitSpec, grid!, -cx, -cy, anchor);
    info.split = split;
    // The layout: on the wall with hairline gaps (assembled), pulled apart (exploded), or each piece in a grid to print.
    const n = sp.pieces.length;
    const offsets = layoutOffsets(parts, n, split, layout, Math.max(pieceW, pieceH));
    parts.forEach((p, i) => {
      const [dx, dy] = offsets[i];
      if (dx || dy) p.shape = (p.shape as any).translate([dx, dy, 0]);
      if (i < n) p.lineArt = { ...info, ...(i ? { split: undefined } : {}), piece: { label: p.name, offset: [dx, dy] } };
    });
    const big = split.pieces.filter((p) => p.size[0] > BED || p.size[1] > BED);
    const order = split.pieces.map((p) => p.label);
    assembly = order.slice(1).map((l) => ({ label: `Stick ${l} on the wall against the pieces already up`, parts: [l], from: [0, 0, Math.max(30, 0.15 * Math.max(pieceW, pieceH))] }));
    const lab = split.pieces.filter((p) => p.labelSize > 0).length;
    note = `Split into ${n} pieces (${grid!.cols} × ${grid!.rows}: ${order.join(', ')}), each on its own plate. Print each flat, back on the bed, in one colour (black PLA): 0.2 mm layers, 100 % infill, no brim. ${style === 'keyholder' ? `The ${hooks} pegs print standing up. ` : ''}`
      + `${split.joints.length ? `The ${split.joints.length} dovetail${split.joints.length > 1 ? 's' : ''} on the ${anchorWord(style)} lock the pieces together; ` : ''}lines that cross a seam just meet end to end, so each piece is taped up on its own. `
      + `${lab ? `Each piece's name (row letter from the top, column number from the left) is engraved on its back${lab < n ? ` (${n - lab} had no room for it)` : ''}. ` : ''}`
      + `Put it up from the top left: A1 first, then along the row and down. Mark a level line, tape each piece up and push it against the one before.${slotNote}`
      + `${big.length ? ` ${big.map((p) => `${p.label} is ${p.size[0].toFixed(0)} × ${p.size[1].toFixed(0)} mm`).join(', ')}: bigger than the A1's ${BED} mm bed – use more pieces.` : ''}`;
  }
  return { parts, print: lineArtPrint(), lineArt: info, note, ...(assembly ? { assembly } : {}) };
}

/** Room kept in each piece for seams that wander and for dovetails (mm): Auto picks enough pieces for it. */
const SPLIT_RESERVE = 24;
/** A split piece's bits farther apart than this (mm) aren't bridged when each is at least SPLIT_MIN_PART × lineWidth mm²: they become pieces of their own. */
const SPLIT_MAX_BRIDGE = 30;
const SPLIT_MIN_PART = 200;
/** A split's pieces together get at most this many times the pixels the whole would get unsplit (MAX_PIXELS). */
const SPLIT_PIXELS = 2;
/** How deep a piece's name is engraved in its back, mm. */
const LABEL_DEPTH = 0.4;

const anchorWord = (style: LineArtStyle) => (style === 'framed' || style === 'medallion' ? 'frame' : 'bar');

/** A split as cached: the seams, each piece's outline and cleaned-up drawing, the dovetails, where the names go. */
interface SplitCached {
  seams: Seam[];
  /** Each piece's outline (with its tabs, without its sockets), its place in the grid and what the clean-up drew. */
  pieces: { col: number; row: number; region: Pt[][]; loops: Pt[][]; paths: Pt[][]; bridges: number; longestBridge: number; dropped: number; closed: number; openings: number; endsJoined: number; endsFree: number }[];
  joints: LineArtSplitInfo['joints'];
  /** Each joint's tab (as joints). */
  tabs: Pt[][];
  noJoint: LineArtSplitInfo['noJoint'];
  /** Where each piece's name goes (found when first asked). */
  labels: ({ x: number; y: number; size: number; rot: boolean } | null | undefined)[];
}
/** Recent splits, like `cache`. */
const splitCache = new Map<string, SplitCached>();

interface SplitResult {
  seams: Seam[];
  /** The pieces in label order; `region` is the cell's outline on the first piece of a cell (null on A2b…). */
  pieces: { info: LineArtPieceInfo; region: any; lineCs: any; anchor: any; closed: number; openings: number }[];
  joints: LineArtSplitInfo['joints'];
  noJoint: LineArtSplitInfo['noJoint'];
  /** The piece (its index) a point is on, -1 for none. */
  pieceAt: (p: Pt) => number;
  /** Where a piece's name goes on its back. */
  label: (i: number) => { x: number; y: number; size: number; rot: boolean } | null;
}

interface SplitInput {
  d: LineArtDeps;
  key: string;
  art: any;
  anchor: any;
  /** What the user erased by hand (mm), taken off each piece after the clean-up. */
  erase: any;
  ab: { min: number[]; max: number[] };
  cols: number;
  rows: number;
  lineWidth: number;
  fill: number;
  minIsland: number;
  lines: 'even' | 'keep';
  joinEnds: number;
  segs: number;
  clearance: number;
  /** Bits of a piece farther apart than maxBridge (mm) and at least minPart mm² each become pieces of their own. */
  maxBridge: number;
  minPart: number;
  /** Key holder pegs on the bar: a seam keeps clear of each one's foot (`pegZone` mm) and room for a dovetail. */
  pegAt: Pt[];
  pegZone: number;
  barHeight: number;
  signText: any;
}

/**
 * The piece cut into cols × rows pieces: the seams (vertical ones the whole height, horizontal ones
 * per column), each piece's outline with dovetails where a seam crosses the bar or frame, and each
 * piece's drawing cleaned up on its own (specks dropped, loose bits bridged, dangling lines joined),
 * so a piece holds together without its neighbours.
 */
function splitPieces(o: SplitInput): SplitResult {
  const { d, art, anchor, ab, cols, rows, lineWidth } = o;
  const { C } = d;
  const x0 = ab.min[0], x1 = ab.max[0], y0 = ab.min[1], y1 = ab.max[1], W = x1 - x0, H = y1 - y0;
  const Wc = W / cols, Hr = H / rows;
  // How far a seam may wander from the ideal cut: the pieces must still fit the bed.
  const bandFor = (cell: number) => Math.max(3, Math.min(40, 0.3 * cell, (MAX_PIECE - 10 - cell) / 2));
  const Bv = bandFor(Wc), Bh = bandFor(Hr), margin = 3;
  const Yt = y1 + 2 * margin + 1, Yb = y0 - 2 * margin - 1, Xl = x0 - 2 * margin - 1, Xr = x1 + 2 * margin + 1;
  let c = splitCache.get(o.key);
  // Each piece's outline and drawing as just cut (not cached: Manifold's objects), so they aren't cut twice.
  const fresh: { region: any; pan: any; pa: any }[] = [];
  if (!c) {
    const artPolys = art.toPolygons(), anchorPolys = anchor ? anchor.toPolygons() : null;
    const textPolys = o.signText ? o.signText.offset(0.5, 'Round').toPolygons() : null;
    const pxFor = (area: number) => Math.max(lineWidth / 4, Math.sqrt(area / 3e6));
    // What a seam's band holds; `rowSpan` (horizontal seams) keeps only what is in the seam's column.
    const sample = (g: SplitGrid, rowSpan?: (y: number) => [number, number]) => {
      const ink = rasterize(artPolys, g), anc = anchorPolys ? rasterize(anchorPolys, g) : null;
      const heavy = textPolys ? rasterize(textPolys, g) : null;
      // A peg's foot, and room beside it for a dovetail's tab and socket.
      const zone = o.pegZone + 12;
      const avoid = o.pegAt.length ? new Uint8Array(g.w * g.h) : null;
      if (avoid) for (const [x, y] of o.pegAt) rasterize([[[x - zone, y - o.barHeight], [x + zone, y - o.barHeight], [x + zone, y + o.barHeight], [x - zone, y + o.barHeight]]], g, avoid);
      if (rowSpan) for (let j = 0; j < g.h; j++) {
        const [a, b] = rowSpan(g.y1 - (j + 0.5) * g.px);
        for (let i = 0; i < g.w; i++) {
          const x = g.x0 + (i + 0.5) * g.px;
          if (x >= a && x <= b) continue;
          const k = j * g.w + i;
          ink[k] = 0; if (anc) anc[k] = 0; if (heavy) heavy[k] = 0; if (avoid) avoid[k] = 0;
        }
      }
      return { ink, anchor: anc, heavy, avoid };
    };
    let seams: Seam[] = [];
    for (let k = 1; k < cols; k++) {
      const xi = x0 + k * Wc, px = pxFor(2 * Bv * (H + 2 * margin));
      const g: SplitGrid = { px, x0: xi - Bv, y1: y1 + margin, w: Math.ceil((2 * Bv) / px) + 1, h: Math.ceil((H + 2 * margin) / px) };
      seams.push({ ...routeSeam(g, sample(g), 'v', xi, Bv, lineWidth), col: k, row: 0 });
    }
    const vg = seamGeometry(seams, cols, rows, Xl, Xr, Yt, Yb);
    for (let col = 0; col < cols; col++) {
      const left = vg.vLine(col), right = vg.vLine(col + 1);
      const xl = Math.min(...left.map((p) => p[0])) - 1, xr = Math.max(...right.map((p) => p[0])) + 1;
      for (let r = 1; r < rows; r++) {
        const yi = y1 - r * Hr, px = pxFor((xr - xl) * 2 * Bh);
        const g: SplitGrid = { px, x0: xl, y1: yi + Bh, w: Math.ceil((xr - xl) / px), h: Math.ceil((2 * Bh) / px) + 1 };
        seams.push({ ...routeSeam(g, sample(g, (y) => [seamAt(left, y, 1), seamAt(right, y, 1)]), 'h', yi, Bh, lineWidth), col, row: r });
      }
    }
    // A bit of the drawing a seam leaves on its own in a piece goes to the piece it carries on into.
    const pa = Math.max(lineWidth / 2, Math.sqrt(((Xr - Xl) * (Yt - Yb)) / 4e6));
    const ga: SplitGrid = { px: pa, x0: Xl, y1: Yt, w: Math.ceil((Xr - Xl) / pa), h: Math.ceil((Yt - Yb) / pa) };
    const kept = keepTogether({ g: ga, ink: rasterize(artPolys, ga), anchor: anchorPolys ? rasterize(anchorPolys, ga) : null, seams, cols, rows, box: [Xl, Xr, Yt, Yb], maxBridge: o.maxBridge, minPart: o.minPart, maxPiece: MAX_PIECE - 2 });
    seams = kept.seams;
    const geo = seamGeometry(seams, cols, rows, Xl, Xr, Yt, Yb);
    // Each piece's outline: its column's strip ∩ its row's strip in that column.
    const strip = (a: Pt[], b: Pt[]) => new C([[...a, ...[...b].reverse()]], 'EvenOdd');
    const regions: any[] = [];
    for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) regions.push(strip(geo.vLine(col), geo.vLine(col + 1)).intersect(strip(geo.hLine(col, r), geo.hLine(col, r + 1))));
    // Dovetails where a seam runs straight across the bar or frame: a tab on the piece before the
    // seam, its socket (with clearance) in the next one.
    const joints: LineArtSplitInfo['joints'] = [], noJoint: LineArtSplitInfo['noJoint'] = [], tabs: Pt[][] = [];
    for (const m of seams) for (const run of m.runs) {
      const mid: Pt = [(run.a[0] + run.b[0]) / 2, (run.a[1] + run.b[1]) / 2];
      const n = m.dir === 'v' ? [1, 0] : [0, -1];
      const owner = geo.pieceAt([mid[0] - n[0], mid[1] - n[1]]), other = geo.pieceAt([mid[0] + n[0], mid[1] + n[1]]);
      if (owner === other) continue;
      const across = Math.hypot(run.b[0] - run.a[0], run.b[1] - run.a[1]);
      let made: { tab: Pt[]; head: number } | null = null, r2 = run, why = '';
      for (let k = 0; k < 4 && !made; k++) {
        const t = dovetail(r2, m.dir, o.clearance);
        if (!t) { why = k ? 'no room for a dovetail inside it here' : `only ${across.toFixed(1)} mm across here, too narrow for a dovetail (needs about ${(3 + 2.4 + 2 * o.clearance).toFixed(1)} mm)`; break; }
        // Its socket and a wall around it must stay inside the bar or frame.
        if (new C([t.tab], 'EvenOdd').offset(o.clearance + 0.6, 'Miter').subtract(anchor).area() < 0.01) { made = t; break; }
        why = 'no room for a dovetail inside it here';
        const sh = 0.85, cxm = (r2.a[0] + r2.b[0]) / 2, cym = (r2.a[1] + r2.b[1]) / 2;
        r2 = { a: [cxm + (r2.a[0] - cxm) * sh, cym + (r2.a[1] - cym) * sh], b: [cxm + (r2.b[0] - cxm) * sh, cym + (r2.b[1] - cym) * sh] };
      }
      if (!made) { noJoint.push({ at: mid, why }); continue; }
      const tab = new C([made.tab], 'EvenOdd');
      regions[owner] = regions[owner].add(tab);
      regions[other] = regions[other].subtract(tab.offset(o.clearance, 'Miter'));
      joints.push({ at: mid, tab: pieceLabel(owner % cols, Math.floor(owner / cols)), socket: pieceLabel(other % cols, Math.floor(other / cols)), width: made.head });
      tabs.push(made.tab);
    }
    // Each piece cleaned up on its own, its pixels as fine as for a piece this size, but all of them
    // together no more than twice the pixels the whole would get unsplit (a wall-sized piece).
    const pieces: SplitCached['pieces'] = [];
    const pxMin = Math.max(lineWidth / (d.quality === 'draft' ? 3 : d.quality === 'high' ? 6 : 5), Math.sqrt((W * H) / (SPLIT_PIXELS * MAX_PIXELS[d.quality])));
    regions.forEach((region, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const pan = anchor ? anchor.intersect(region) : null;
      const pa = dropSpecks(C, art.intersect(region), pan, o.minIsland);
      if (pa.cs.isEmpty() && (!pan || pan.isEmpty())) return;
      const b = (pan && !pan.isEmpty() ? pa.cs.add(pan) : pa.cs).bounds();
      let px = pxMin;
      px = Math.max(px, Math.sqrt(((b.max[0] - b.min[0] + 8 * px) * (b.max[1] - b.min[1] + 8 * px)) / MAX_PIXELS[d.quality]));
      const g: LineArtGrid = { px, x0: b.min[0] - 4 * px, y1: b.max[1] + 4 * px, w: Math.ceil((b.max[0] - b.min[0]) / px) + 8, h: Math.ceil((b.max[1] - b.min[1]) / px) + 8 };
      const m = lineArtMask(rasterize(pa.cs.toPolygons(), g), pan && !pan.isEmpty() ? rasterize(pan.toPolygons(), g) : null, g, { lineWidth, fill: o.fill, minIsland: o.minIsland, lines: o.lines, keepSpecks: o.lines === 'keep', joinEnds: o.joinEnds, maxBridge: o.maxBridge, minPart: o.minPart, inside: rasterize(region.toPolygons(), g) });
      const mm = ([x, y]: Pt): Pt => [g.x0 + (x + 0.5) * px, g.y1 - (y + 0.5) * px];
      fresh.push({ region, pan, pa: pa.cs });
      pieces.push({
        col, row, region: region.toPolygons(),
        loops: o.lines === 'keep' ? [] : traceMask(m.mask, g, px * 0.35), paths: o.lines === 'keep' ? m.paths.map((p) => p.map(mm)) : [],
        bridges: m.bridges, longestBridge: m.longestBridge, dropped: m.dropped + pa.dropped, closed: m.closed, openings: m.openings, endsJoined: m.endsJoined, endsFree: m.endsFree,
      });
    });
    c = { seams, pieces, joints, tabs, noJoint, labels: [] };
    splitCache.set(o.key, c);
    if (splitCache.size > 2) splitCache.delete(splitCache.keys().next().value!);
  }
  const cached = c;
  const geo = seamGeometry(cached.seams, cols, rows, Xl, Xr, Yt, Yb);
  // Each cell's parts: its main one (`mains`: the cells whose main part it is) and bits too far to bridge.
  interface Part { cell: number; lc: any; an: any; region: any; stats: SplitCached['pieces'][number][]; mains: number[] }
  const parts: Part[] = [];
  for (const [i, p] of cached.pieces.entries()) {
    const f = fresh[i];
    const region = f ? f.region : new C(p.region, 'EvenOdd');
    const pan = f ? f.pan : anchor ? anchor.intersect(region) : null;
    const pa = f ? f.pa : dropSpecks(C, art.intersect(region), pan, o.minIsland).cs;
    let lineCs = o.lines === 'keep' ? (p.paths.length ? pa.add(new C(strokeOutlines(p.paths, lineWidth / 2, o.segs / 4), 'NonZero')) : pa) : new C(p.loops, 'EvenOdd');
    if (o.erase) lineCs = lineCs.subtract(o.erase);
    // What Jig drew stays on the piece: a bridge or a thickened line ends at the seam.
    lineCs = lineCs.intersect(region);
    const anc = pan && !pan.isEmpty() ? pan : null;
    // Bits too far apart to bridge become pieces of their own (A2, A2b…): the one on the bar or frame, or the biggest, first.
    const comps = (anc ? lineCs.add(anc) : lineCs).decompose().map((cs: any) => ({ cs, area: cs.area(), onAnchor: !!anc && !cs.intersect(anc).isEmpty() }));
    const big = comps.filter((q: { area: number }) => q.area >= o.minPart).sort((a: { onAnchor: boolean; area: number }, b: { onAnchor: boolean; area: number }) => +b.onAnchor - +a.onAnchor || b.area - a.area);
    const groups = big.length > 1 ? big.map((q: { cs: any }) => q.cs) : [null];
    // Smaller loose bits (cut apart by an erase) stay with the first.
    if (big.length > 1) for (const q of comps) if (q.area < o.minPart) groups[0] = groups[0].add(q.cs);
    const cell = p.row * cols + p.col;
    groups.forEach((g: any, k: number) => {
      const lc = g ? lineCs.intersect(g) : lineCs, an = anc && g ? anc.intersect(g) : anc;
      parts.push({ cell, lc, an: an && !an.isEmpty() ? an : null, region: k ? null : region, stats: k ? [] : [p], mains: k ? [] : [cell] });
    });
  }
  // A strip of the bar or frame with nothing else on it joins the strip it meets in the next piece
  // when the two still fit the bed (the dovetail between them filled in): no short sliver of frame
  // is a piece of its own.
  const boxOf = (q: Part) => (q.an ? q.lc.add(q.an) : q.lc).bounds();
  const alive = parts.map(() => true), tabs = cached.tabs.map((t) => new C([t], 'EvenOdd'));
  const jointLive = cached.joints.map(() => true);
  const bare = (q: Part) => !!q.an && q.lc.isEmpty();
  for (;;) {
    let best: [number, number] | null = null, bestSize = Infinity;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j];
      if (!alive[i] || !alive[j] || !bare(a) || !bare(b)) continue;
      const ba = boxOf(a), bb = boxOf(b);
      const size = Math.max(Math.max(ba.max[0], bb.max[0]) - Math.min(ba.min[0], bb.min[0]), Math.max(ba.max[1], bb.max[1]) - Math.min(ba.min[1], bb.min[1]));
      if (size > MAX_PIECE || size >= bestSize) continue;
      // They meet (across a seam, or a dovetail's clearance).
      if (ba.min[0] > bb.max[0] + 1 || bb.min[0] > ba.max[0] + 1 || ba.min[1] > bb.max[1] + 1 || bb.min[1] > ba.max[1] + 1) continue;
      if (a.an.offset(o.clearance + 0.05, 'Miter').intersect(b.an).isEmpty()) continue;
      best = [i, j]; bestSize = size;
    }
    if (!best) break;
    const [i, j] = best, a = parts[i], b = parts[j];
    let an = a.an.add(b.an);
    // A dovetail between them: its clearance filled.
    tabs.forEach((t: any, k: number) => {
      if (!jointLive[k]) return;
      const around = t.offset(o.clearance + 0.05, 'Miter');
      if (around.intersect(a.an).isEmpty() || around.intersect(b.an).isEmpty()) return;
      an = an.add(anchor.intersect(around));
      jointLive[k] = false;
    });
    parts[i] = { cell: a.cell, lc: a.lc, an, region: a.region && b.region ? a.region.add(b.region) : a.region ?? b.region, stats: [...a.stats, ...b.stats], mains: [...a.mains, ...b.mains] };
    alive[j] = false;
  }
  // Names: each piece's cell, then b, c… for more parts of that cell.
  const pieces: SplitResult['pieces'] = [];
  const mainOf = new Map<number, number>(), count = new Map<number, number>();
  parts.forEach((q, i) => {
    if (!alive[i]) return;
    const k = count.get(q.cell) ?? 0;
    count.set(q.cell, k + 1);
    for (const m of q.mains) mainOf.set(m, pieces.length);
    const label = `${pieceLabel(q.cell % cols, Math.floor(q.cell / cols))}${k ? String.fromCharCode(97 + k) : ''}`;
    const bb = boxOf(q), sum = (f: (s: SplitCached['pieces'][number]) => number) => q.stats.reduce((n, s) => n + f(s), 0);
    const info: LineArtPieceInfo = {
      label, col: q.cell % cols, row: Math.floor(q.cell / cols), size: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]], box: [bb.min[0], bb.min[1], bb.max[0], bb.max[1]],
      bridges: sum((s) => s.bridges), longestBridge: Math.max(0, ...q.stats.map((s) => s.longestBridge)), dropped: sum((s) => s.dropped), endsJoined: sum((s) => s.endsJoined), endsFree: sum((s) => s.endsFree),
      joints: 0, labelSize: 0,
    };
    pieces.push({ info, region: q.region, lineCs: q.lc, anchor: q.an, closed: sum((s) => s.closed), openings: sum((s) => s.openings) });
  });
  // The dovetails left, named by the pieces they join: the tab's piece holds it, the socket's piece meets it.
  const joints: LineArtSplitInfo['joints'] = [];
  cached.joints.forEach((jt, k) => {
    if (!jointLive[k]) return;
    const t = tabs[k], around = t.offset(o.clearance + 0.3, 'Miter');
    const tab = pieces.findIndex((q) => q.anchor && !q.anchor.intersect(t).isEmpty());
    const socket = pieces.findIndex((q, i) => i !== tab && q.anchor && !q.anchor.intersect(around).isEmpty());
    const named = { ...jt, tab: tab >= 0 ? pieces[tab].info.label : jt.tab, socket: socket >= 0 ? pieces[socket].info.label : jt.socket };
    joints.push(named);
    for (const q of pieces) if (q.info.label === named.tab || q.info.label === named.socket) q.info.joints++;
  });
  return {
    seams: cached.seams, pieces, joints, noJoint: cached.noJoint,
    pieceAt: (q) => mainOf.get(geo.pieceAt(q)) ?? -1,
    label: (i) => {
      if (cached.labels[i] === undefined) cached.labels[i] = placeLabel(d, pieces[i]);
      return cached.labels[i] ?? null;
    },
  };
}

/** `cs` without its loose bits smaller than `minIsland` mm² (those touching `anchor` aren't loose), and how many went. */
function dropSpecks(C: any, cs: any, anchor: any, minIsland: number): { cs: any; dropped: number } {
  const comps = cs.decompose();
  if (comps.length < 2) return { cs, dropped: 0 };
  const kept = comps.filter((p: any) => p.area() >= minIsland || (anchor && !p.intersect(anchor).isEmpty()));
  return kept.length === comps.length ? { cs, dropped: 0 } : { cs: C.compose(kept), dropped: comps.length - kept.length };
}

/**
 * Where a piece's name fits on its back: on the bar or frame if it can, else on the drawing's
 * solid areas – the biggest size that fits (8 mm cap height down to 3 mm, lying or standing; then
 * 2.5 mm, for a narrow frame, bar or line), as near the piece's middle as it can; null when it fits
 * nowhere.
 */
function placeLabel(d: LineArtDeps, p: { info: LineArtPieceInfo; lineCs: any; anchor: any }): { x: number; y: number; size: number; rot: boolean } | null {
  const [bx0, by0, bx1, by1] = p.info.box, prefer: Pt = [(bx0 + bx1) / 2, (by0 + by1) / 2];
  // A little of the piece all round the letters (they are only engraved 0.4 mm into its back).
  const lp = 0.25;
  const texts = [8, 6, 5, 4, 3, 2.5].map((size) => {
    const b = d.text(p.info.label, { size, halign: 'center', valign: 'center' }).bounds(), margin = size < 3 ? 0.4 : 0.6;
    return { size, w: b.max[0] - b.min[0] + 2 * margin, h: b.max[1] - b.min[1] + 2 * margin };
  });
  const fitters = new Map<any, { g: LineArtGrid; fit: ReturnType<typeof boxFitter> }>();
  const fitter = (cs: any) => {
    if (!fitters.has(cs)) {
      const b = cs.bounds();
      const g: LineArtGrid = { px: lp, x0: b.min[0] - lp, y1: b.max[1] + lp, w: Math.ceil((b.max[0] - b.min[0]) / lp) + 3, h: Math.ceil((b.max[1] - b.min[1]) / lp) + 3 };
      fitters.set(cs, { g, fit: boxFitter(rasterize(cs.toPolygons(), g), g.w, g.h) });
    }
    return fitters.get(cs)!;
  };
  for (const [cs, small] of [[p.anchor, false], [p.lineCs, false], [p.anchor, true], [p.lineCs, true]] as const) {
    if (!cs || cs.isEmpty()) continue;
    const { g, fit: fitBox } = fitter(cs);
    for (const t of texts) for (const rot of [false, true]) {
      if (t.size < 3 !== small) continue;
      const fit = fitBox(Math.ceil((rot ? t.h : t.w) / lp), Math.ceil((rot ? t.w : t.h) / lp), (prefer[0] - g.x0) / lp, (g.y1 - prefer[1]) / lp);
      if (fit) return { x: g.x0 + fit.x * lp, y: g.y1 - fit.y * lp, size: t.size, rot };
    }
  }
  return null;
}

/** The split for the Print tab, Jig's report and the editor, moved by (dx, dy) like the piece. */
function splitInfo(sp: SplitResult, spec: SplitSpec, grid: { cols: number; rows: number }, dx: number, dy: number, anchor: any): LineArtSplitInfo {
  const mv = ([x, y]: Pt): [number, number] => [x + dx, y + dy];
  return {
    spec: formatSplitSpec(spec), cols: grid.cols, rows: grid.rows,
    pieces: sp.pieces.map((p) => ({ ...p.info, box: [p.info.box[0] + dx, p.info.box[1] + dy, p.info.box[2] + dx, p.info.box[3] + dy] })),
    seams: sp.seams.map((m) => ({ dir: m.dir, points: m.points.map(mv), crossings: m.crossings })),
    joints: sp.joints.map((j) => ({ ...j, at: mv(j.at) })),
    noJoint: sp.noJoint.map((j) => ({ ...j, at: mv(j.at) })),
    anchor: anchor ? anchor.simplify(0.1).toPolygons().slice(0, 8).map((c: Pt[]) => c.map(mv)) : [],
  };
}

/**
 * How far the layout moves each part from its place on the wall: 'assembled' leaves hairline gaps
 * between the pieces, 'exploded' pulls them apart, 'print' sets the pieces (and a stand's base
 * pieces, below them) in a grid with room between them, centred on the origin.
 */
function layoutOffsets(parts: LineArtResult['parts'], n: number, split: LineArtSplitInfo, layout: string, size: number): [number, number][] {
  const pieces = split.pieces;
  if (layout !== 'print') {
    const g = layout === 'assembled' ? 0.6 : Math.max(15, 0.06 * size);
    return parts.map((_, i): [number, number] => (i < n ? [(pieces[i].col - (split.cols - 1) / 2) * g, -(pieces[i].row - (split.rows - 1) / 2) * g] : [0, 0]));
  }
  const gap = 10;
  // A cell's pieces (A2, A2b…) side by side.
  const cells = new Map<number, number[]>();
  pieces.forEach((p, i) => { const k = p.row * split.cols + p.col; (cells.get(k) ?? cells.set(k, []).get(k)!).push(i); });
  const cellW = (k: number) => (cells.get(k) ?? []).reduce((a, i, j) => a + pieces[i].size[0] + (j ? gap : 0), 0);
  const colW: number[] = Array(split.cols).fill(0), rowH: number[] = Array(split.rows).fill(0);
  for (const [k, list] of cells) {
    const col = k % split.cols, row = Math.floor(k / split.cols);
    colW[col] = Math.max(colW[col], cellW(k));
    for (const i of list) rowH[row] = Math.max(rowH[row], pieces[i].size[1]);
  }
  const X = colW.map((_, c) => colW.slice(0, c).reduce((a, b) => a + b + gap, 0)), Y = rowH.map((_, r) => -rowH.slice(0, r).reduce((a, b) => a + b + gap, 0));
  const out: [number, number][] = pieces.map(() => [0, 0]);
  for (const [k, list] of cells) {
    const col = k % split.cols, row = Math.floor(k / split.cols);
    let x = X[col] + (colW[col] - cellW(k)) / 2;
    for (const i of list) {
      const p = pieces[i];
      out[i] = [x - p.box[0], Y[row] - (rowH[row] - p.size[1]) / 2 - p.box[3]];
      x += p.size[0] + gap;
    }
  }
  // A stand's base pieces in a row under the pieces.
  let bx = 0;
  const by = Y[split.rows - 1] - rowH[split.rows - 1] - gap;
  for (const p of parts.slice(n)) {
    const b = (p.shape as any).boundingBox();
    out.push([bx - b.min[0], by - b.max[1]]);
    bx += b.max[0] - b.min[0] + gap;
  }
  // Centred on the origin.
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  parts.forEach((p, i) => {
    const b = i < n ? { min: [pieces[i].box[0], pieces[i].box[1]], max: [pieces[i].box[2], pieces[i].box[3]] } : (p.shape as any).boundingBox();
    lo = [Math.min(lo[0], b.min[0] + out[i][0]), Math.min(lo[1], b.min[1] + out[i][1])]; hi = [Math.max(hi[0], b.max[0] + out[i][0]), Math.max(hi[1], b.max[1] + out[i][1])];
  });
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
  return out.map(([x, y]) => [x - cx, y - cy]);
}
