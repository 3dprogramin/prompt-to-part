// Line art's options, styles and the info a line-art part carries (what Jig fixed, for the Print
// tab and Claude's report), checked when it comes back from a script.
import type { Brim } from '../print';
import { cleanFilament, type PartFilament } from '../params';
import type { SplitSpec } from '../split';
import { type ColourDepth, type LineArtPaint, type PaintMaterial, parseLineArtDepth, type PrintLayers } from './depth';
import { LINEART_LAYOUTS, MAX_JOIN_MARKS } from './settings';
import type { LineArtStroke } from './strokes';

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
  /** Split: the longest join (bridge, mm) Jig adds inside a piece, default 30; bits farther apart become pieces of their own (a small detail is joined up to 60 mm, or this when it is more). */
  splitJoin?: number;
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
  /** How the pieces are laid out ('print', 'assembled', 'exploded'). */
  layout?: 'print' | 'assembled' | 'exploded';
  cols: number;
  rows: number;
  pieces: LineArtPieceInfo[];
  /**
   * The cuts: vertical ones top to bottom, horizontal ones left to right; lines of the drawing each
   * cuts. `cuts`: the stretches of it where two pieces really meet, to draw (not where pieces were
   * joined back into one, nor where a horizontal one runs past its column); all of it when missing.
   */
  seams: { dir: 'v' | 'h'; points: [number, number][]; crossings: number; cuts?: [number, number][][] }[];
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
  /** How far Jig reached to join them (joinEnds as used, before the design's scale), mm; 0: joining off. */
  joinEnds?: number;
  /**
   * Where: each join from the loose end to the point of the line it joined, and the loose ends left
   * (not those erased by hand), on this part, in the piece's XY (a split piece: on the wall, without
   * its layout offset), mm; at most MAX_JOIN_MARKS of each.
   */
  joins?: [number, number][][];
  loose?: [number, number][];
  /** Key holder pegs. */
  hooks: number;
  /**
   * Where each drawing sits in the piece, for editing it by hand: a point (x, y) of the drawing
   * (its own units: 1 = its height, centred, y up) is at (x·k + tx, y·k + ty) mm in the piece's XY.
   * `fp` is the drawing's fingerprint (hand edits belong to it).
   */
  /** Each drawing in the piece: mm per its unit (`k`), where it sits, and `k0`: the k its strokes
   * saved without one were drawn at (the script's own size, before the whole piece's typed size). */
  frames: { name: string; k: number; tx: number; ty: number; fp: string; k0?: number }[];
  /** Hand edits (LINEART_EDITS_KEY) applied, over all drawings. */
  edits: number;
  /** Filled bits (Edit drawing's Fill) that touched nothing of the piece, so would fall off: dropped. */
  fillsLoose?: number;
  /** Split into pieces (bridges, specks and loose lines above are then the totals over the pieces); only on the first piece. */
  split?: LineArtSplitInfo;
  /** This part is one piece of a split line art: its name, and how far the layout moved it from its place on the wall (mm). */
  piece?: { label: string; offset: [number, number] };
  /** Lines coloured in other filaments (Edit drawing's paint and coloured lines): those filaments, each a part of its own beside the piece. */
  colours?: PartFilament[];
  /** This part is the piece's lines in one of `colours` (the rest of the piece is the part without it). */
  paintedIn?: PartFilament;
  /** A coloured piece: how many separate bodies it and its coloured parts make together (each part alone may be in bits). */
  components?: number;
  /** A coloured piece (each piece, split): its colours and how deep they go. */
  paint?: LineArtPaint;
}

/** What H.lineart returns; a script returns it as it is (or adds to its parts). */
export interface LineArtResult {
  /** The piece (lineArt on it), plus the base for a desk stand; split, one part per piece (named by its label), each on its own plate. */
  parts: { name: string; shape: unknown; color: string; lineArt?: LineArtInfo; plate?: number }[];
  print: { layerHeight: number; firstLayerHeight: number; walls: number; infill: number; infillPattern: string; brim: Brim };
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
  const pt = (p: unknown): [number, number] | null => (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0] * scale, p[1] * scale] : null);
  const joins = (Array.isArray(o.joins) ? o.joins : []).slice(0, MAX_JOIN_MARKS).map((j) => (Array.isArray(j) && j.length === 2 ? j.map(pt) : [null])).filter((j): j is [number, number][] => j.every((p) => !!p));
  const loose = (Array.isArray(o.loose) ? o.loose : []).slice(0, MAX_JOIN_MARKS).map(pt).filter((p): p is [number, number] => !!p);
  const frames = (Array.isArray(o.frames) ? o.frames : []).slice(0, 8).filter((f) => f && typeof f.name === 'string' && [f.k, f.tx, f.ty].every((v) => Number.isFinite(v)) && f.k > 0)
    .map((f) => ({ name: f.name.slice(0, 120), k: f.k * scale, tx: f.tx * scale, ty: f.ty * scale, fp: String(f.fp ?? '').slice(0, 80), ...(Number.isFinite(f.k0) && f.k0! > 0 ? { k0: f.k0! * scale } : {}) }));
  const colours = (Array.isArray(o.colours) ? o.colours : []).slice(0, 16).map(cleanFilament).filter((f): f is PartFilament => !!f);
  const paintedIn = cleanFilament(o.paintedIn);
  return {
    frames, edits: count(o.edits), ...(count(o.fillsLoose) ? { fillsLoose: count(o.fillsLoose) } : {}),
    ...cleanSplit(o, scale),
    ...(colours.length ? { colours } : {}), ...(paintedIn ? { paintedIn } : {}), ...(Number.isInteger(o.components) && o.components! > 0 ? { components: o.components } : {}),
    style: o.style, sources: o.sources.filter((s) => typeof s === 'string').slice(0, 8).map((s) => s.slice(0, 120)),
    size: [w, h], thickness, lineWidth, lines: o.lines === 'even' ? 'even' : 'keep',
    bridges: count(o.bridges), longestBridge, dropped: count(o.dropped), closed: count(o.closed), openings: count(o.openings), endsJoined: count(o.endsJoined), endsFree: count(o.endsFree), hooks: count(o.hooks),
    ...(Number.isFinite(o.joinEnds) && o.joinEnds! >= 0 ? { joinEnds: o.joinEnds } : {}),
    ...(joins.length ? { joins } : {}), ...(loose.length ? { loose } : {}),
    ...cleanPaint(o.paint, scale),
  };
}

/** A coloured piece's LineArtInfo.paint, checked, heights scaled. */
function cleanPaint(raw: unknown, scale: number): Pick<LineArtInfo, 'paint'> {
  const o = raw as LineArtPaint | null;
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!o || typeof o !== 'object' || !o.layers || !Array.isArray(o.materials) || !Array.isArray(o.colours)) return {};
  const depth = parseLineArtDepth(o.depth), lh = o.layers.layerHeight, flh = o.layers.firstLayerHeight;
  if (depth === undefined || !fin(lh) || !fin(flh) || !(lh > 0 && flh > 0)) return {};
  const kinds: PaintMaterial[] = ['lines', 'frame', 'text', 'pegs'];
  const materials = o.materials.slice(0, 4).filter((m) => m && kinds.includes(m.kind) && Array.isArray(m.z) && fin(m.z[0]) && fin(m.z[1]))
    .map((m) => ({ kind: m.kind, z: [m.z[0] * scale, m.z[1] * scale] as [number, number], own: !!m.own }));
  const colours = o.colours.slice(0, 16).flatMap((c) => {
    const filament = cleanFilament(c?.filament);
    return filament && fin(c.td) && Number.isInteger(c.need) && Array.isArray(c.on)
      ? [{ filament, td: c.td, known: !!c.known, need: c.need, on: c.on.filter((k) => kinds.includes(k)) }] : [];
  });
  return materials.length && colours.length ? { paint: { depth, layers: { layerHeight: lh * scale, firstLayerHeight: flh * scale }, materials, colours } } : {};
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
    spec: str(s.spec, 12), cols: s.cols, rows: s.rows, ...((LINEART_LAYOUTS as readonly unknown[]).includes(s.layout) ? { layout: s.layout } : {}),
    pieces: s.pieces.slice(0, 100).filter((p) => p && typeof p.label === 'string' && Array.isArray(p.size) && Array.isArray(p.box) && [...p.size, ...p.box].every(fin)).map((p) => ({
      label: p.label.slice(0, 12), col: count(p.col), row: count(p.row),
      size: [p.size[0] * scale, p.size[1] * scale], box: p.box.map((v) => v * scale) as LineArtPieceInfo['box'],
      bridges: count(p.bridges), longestBridge: fin(p.longestBridge) ? p.longestBridge * scale : 0, dropped: count(p.dropped),
      endsJoined: count(p.endsJoined), endsFree: count(p.endsFree), joints: count(p.joints), labelSize: fin(p.labelSize) ? p.labelSize * scale : 0,
    })),
    seams: (Array.isArray(s.seams) ? s.seams : []).slice(0, 200).filter((m) => m && (m.dir === 'v' || m.dir === 'h')).map((m) => ({
      dir: m.dir, points: line(m.points, 5000), crossings: count(m.crossings),
      ...(Array.isArray(m.cuts) ? { cuts: m.cuts.slice(0, 200).map((c) => line(c, 5000)).filter((c) => c.length >= 2) } : {}),
    })),
    joints: (Array.isArray(s.joints) ? s.joints : []).slice(0, 400).filter((j) => j && pt(j.at)).map((j) => ({ at: pt(j.at)!, tab: str(j.tab, 12), socket: str(j.socket, 12), width: fin(j.width) ? j.width * scale : 0 })),
    noJoint: (Array.isArray(s.noJoint) ? s.noJoint : []).slice(0, 400).filter((j) => j && pt(j.at)).map((j) => ({ at: pt(j.at)!, why: str(j.why, 200) })),
    anchor: (Array.isArray(s.anchor) ? s.anchor : []).slice(0, 8).map((c) => line(c, 2000)).filter((c) => c.length >= 3),
  };
  return out;
}

/** Print settings for line art: flat, one colour, solid (2 mm is all top and bottom layers anyway), no brim to pick out of the lines; the first layer as high as the rest (colours are cut to the layers). */
export function lineArtPrint(): LineArtResult['print'] {
  return { layerHeight: 0.2, firstLayerHeight: 0.2, walls: 2, infill: 100, infillPattern: 'zig-zag', brim: 'none' };
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
  /** The longest join in a split piece the user set (LINEART_JOIN_KEY), mm. */
  join?: number;
  /** How far loose ends reach to join a line, as the user set it (LINEART_ENDS_KEY), mm; 0 = off. Wins over the script's joinEnds. */
  ends?: number;
  /** How deep the colours go (LINEART_DEPTH_KEY; unset: through). */
  depth?: ColourDepth;
  /** The print's layers the colours are cut to (the user's layer heights in the Print tab; default lineArtPrint's). */
  layers?: PrintLayers;
}
