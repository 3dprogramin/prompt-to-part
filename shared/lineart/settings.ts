// Line art's settings kept in a design's values (split, layout, size, joins, loose ends), checked.
import { parseSplitSpec, type SplitSpec } from '../split';

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
/** The longest join (bridge) the app may add inside a split piece, mm, as the user set it in the Print tab; beyond it, a bit becomes a piece of its own. */
export const LINEART_JOIN_KEY = '$lineartJoin';
export const DEFAULT_SPLIT_JOIN = 30;
export function parseLineArtJoin(raw: unknown): number | undefined {
  const v = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(v) && v >= 5 && v <= 300 ? v : undefined;
}
/** How far the app reaches to join a loose line's end to another line (joinEnds), mm, as the user set it in the Print tab; 0 = off (the drawing as traced). */
export const LINEART_ENDS_KEY = '$lineartEnds';
export const DEFAULT_JOIN_ENDS = 8;
/** The most joins, and loose ends, a part keeps where they are (LineArtInfo.joins, .loose). */
export const MAX_JOIN_MARKS = 200;
export function parseLineArtEnds(raw: unknown): number | undefined {
  const v = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(v) && v >= 0 && v <= 50 ? v : undefined;
}

/**
 * How deep the colours painted in Edit drawing go, per design, as the user set it in the Print tab:
 * 'through' the whole piece, or only its top layers (the face that shows, the piece's own filament
 * under them, so the AMS changes filament on those layers only): 'auto', each colour as few as hide
 * what is under it (colourLayers), or that many layers for every colour. Unset: through, as colours
 * were before there was a choice (the first colour painted on a piece sets 'auto').
 */

export const formatLineArtSize = (s: { width?: number; height?: number }) => `${s.width ? +s.width.toFixed(1) : ''}x${s.height ? +s.height.toFixed(1) : ''}`;
