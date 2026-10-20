// Line art: wall cut-outs of a drawing (a car and a motorbike on a key holder, a figure in a frame),
// printed flat in one colour as one connected piece. H.lineart takes a drawing (an attached SVG, a
// traced picture or one the image model drew), redraws its lines at an even width at the final
// size, joins loose bits to the rest with short bridges, drops specks too small to print, and adds
// the style's bar, frame, hooks or stand.
import type { Brim } from './print';

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
  /** Width of the drawing's lines, default 1. */
  lineWidth?: number;
  /** 'even' (default): every line redrawn at lineWidth; 'keep': the drawing's own widths, only lines thinner than lineWidth thickened. */
  lines?: 'even' | 'keep';
  /** Areas of the drawing wider than this stay solid fills (tyres, hair, shadows), default 3 × lineWidth. */
  fill?: number;
  /** Loose bits smaller than this (mm²) are dropped rather than bridged, default 4 × lineWidth². */
  minIsland?: number;
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
  /** Key holder pegs. */
  hooks: number;
}

/** What H.lineart returns; a script returns it as it is (or adds to its parts). */
export interface LineArtResult {
  /** The piece (lineArt on it), plus the base for a desk stand. */
  parts: { name: string; shape: unknown; color: string; lineArt?: LineArtInfo }[];
  print: { layerHeight: number; walls: number; infill: number; infillPattern: string; brim: Brim };
  lineArt: LineArtInfo;
  /** How to print and hang it. */
  note: string;
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
  return {
    style: o.style, sources: o.sources.filter((s) => typeof s === 'string').slice(0, 8).map((s) => s.slice(0, 120)),
    size: [w, h], thickness, lineWidth, lines: o.lines === 'keep' ? 'keep' : 'even',
    bridges: count(o.bridges), longestBridge, dropped: count(o.dropped), hooks: count(o.hooks),
  };
}
