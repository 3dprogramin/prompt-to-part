// How deep line art's colours go: layers from a filament's TD, each colour's bands of layers and
// what its filament swaps cost.
import type { PartFilament } from '../params';
import { colourFamilies, FILAMENT_LIBRARY, libraryFilament, matchFilament } from '../filaments';

export const LINEART_DEPTH_KEY = '$lineartColourDepth';
export type ColourDepth = 'through' | 'auto' | number;
export const MAX_COLOUR_LAYERS = 50;
export function parseLineArtDepth(raw: unknown): ColourDepth | undefined {
  if (raw === 'through' || raw === 'auto') return raw;
  const v = Number(raw);
  return raw != null && raw !== '' && Number.isInteger(v) && v >= 1 && v <= MAX_COLOUR_LAYERS ? v : undefined;
}
/** The fewest top layers a colour gets (one alone lets the filament under it show through at its edges). */
export const MIN_COLOUR_LAYERS = 2;

/**
 * A filament's TD (transmission distance, mm: LayerTone's model, where t mm of it hides
 * 1 - e^(-3t/TD) of what is under it, 95 % at t = TD): its own (the user's filaments), the library's,
 * or for one the app doesn't know the middle TD of the library's filaments of its colour (light colours
 * let more through); `known` says which.
 */
export function filamentTd(f: PartFilament): { td: number; known: boolean } {
  if (f.td) return { td: f.td, known: true };
  const lib = f.name ? (f.brand ? libraryFilament({ brand: f.brand, name: f.name }) : matchFilament('', f.name)) : undefined;
  if (lib) return { td: lib.td, known: true };
  const family = colourFamilies(f.color)[0];
  const tds = FILAMENT_LIBRARY.filter((l) => colourFamilies(l.color).includes(family)).map((l) => l.td).sort((a, b) => a - b);
  return { td: tds.length ? tds[Math.floor(tds.length / 2)] : 1, known: false };
}

/** The fewest top layers of a filament with this TD that hide what is under them (95 %: TD thick), at least MIN_COLOUR_LAYERS. */
export function colourLayers(td: number, layerHeight: number): number {
  return Math.max(MIN_COLOUR_LAYERS, Math.ceil(td / layerHeight - 1e-6));
}

/** The print's layers, mm: the first one's height and the others'. */
export interface PrintLayers { layerHeight: number; firstLayerHeight: number }

/**
 * Where a colour's top `n` layers start on material from `bottom` to `top` mm (the lines or the
 * frame from the bed, the sign's text on the bar), on the print's layer boundaries; n = 0 (through)
 * is all of it. On the bed, the first layer stays the piece's own filament (it holds the piece together).
 */
export function colourBottom(n: number, bottom: number, top: number, l: PrintLayers): number {
  if (!(n > 0)) return bottom;
  // (A boundary at or below n layers from the top: off the grid, the top layer is a thin one.)
  const at = l.firstLayerHeight + Math.floor((top - n * l.layerHeight - l.firstLayerHeight) / l.layerHeight + 1e-6) * l.layerHeight;
  return +Math.min(Math.max(at, bottom > 1e-6 ? bottom : l.firstLayerHeight), top).toFixed(6);
}

/** What of a line art a colour can be on: its lines, the bar or frame, the sign's raised text, the key holder's pegs. */
export type PaintMaterial = 'lines' | 'frame' | 'text' | 'pegs';

/**
 * A coloured piece's colours and how deep they go (LineArtInfo.paint), for what they cost in
 * filament changes (colourSwaps). `materials`: what of the piece is there, from z[0] to z[1] mm, and
 * whether some of it is still in the piece's own filament; `colours`: each filament, its TD, the top
 * layers that hide what is under it (`need`), and what it is on.
 */
export interface LineArtPaint {
  depth: ColourDepth;
  layers: PrintLayers;
  materials: { kind: PaintMaterial; z: [number, number]; own: boolean }[];
  colours: { filament: PartFilament; td: number; known: boolean; need: number; on: PaintMaterial[] }[];
}

/** The top layers a colour gets at a depth (0: through). */
export const depthLayers = (depth: ColourDepth, need: number) => (depth === 'through' ? 0 : depth === 'auto' ? need : depth);

/**
 * Where a colour is (z ranges, mm) at a depth: its top layers of each thing it is on; a peg it is on
 * is that colour whole (a peg is seen all along, and above the bar it prints alone).
 */
export function colourBands(p: LineArtPaint, c: LineArtPaint['colours'][number], depth: ColourDepth): [number, number][] {
  const n = depthLayers(depth, c.need);
  return p.materials.filter((m) => c.on.includes(m.kind)).map((m) => [m.kind === 'pegs' ? m.z[0] : colourBottom(n, m.z[0], m.z[1], p.layers), m.z[1]]);
}

/**
 * What filament changes cost, measured on an A1 (AMS lite) with Bambu Studio 2.8's slicer on line
 * art in Bambu PLA Basic from the app's 3MF (2 and 4 mm thick, 3 to 15 changes, a line or the frame
 * coloured; within about 10 % of the slice): each change (cutting, loading, the flush into the prime
 * tower), each layer of the prime tower (built from the bed up to the last change, a change or not),
 * and starting the tower.
 */
export const SWAP_COST = { minutes: 1.6, grams: 0.35, towerMinutes: 0.075, towerGrams: 0.025, startMinutes: 0.35, startGrams: 0.25 };

/**
 * The filament changes a coloured piece needs at a depth, layer by layer as the slicer orders them
 * (each layer starts in the filament the last one ended in): the layers with a change, the changes,
 * and roughly the time and filament they add (SWAP_COST; an estimate, the slice is exact).
 */
export function colourSwaps(p: LineArtPaint, depth: ColourDepth): { layers: number; changes: number; minutes: number; grams: number } {
  const bands = p.colours.map((c) => colourBands(p, c, depth));
  // The piece's own filament is on every layer up to the top of what is still in it (of a thing
  // coloured all over, up to where its colours start).
  let ownTop = 0;
  for (const m of p.materials) {
    const starts = p.colours.flatMap((c, k) => { const j = p.materials.filter((n) => c.on.includes(n.kind)).indexOf(m); return j >= 0 ? [bands[k][j][0]] : []; });
    ownTop = Math.max(ownTop, m.own ? m.z[1] : Math.min(m.z[1], ...starts));
  }
  const top = Math.max(...p.materials.map((m) => m.z[1]));
  const { layerHeight: lh, firstLayerHeight: flh } = p.layers;
  // The filament loaded (-1: the piece's own, else a colour's index).
  let cur: number | null = null, layers = 0, changes = 0, last = -1;
  for (let k = 0, z = 0; z < top - 1e-6; k++) {
    const z1 = k ? z + lh : flh, mid = (z + z1) / 2;
    z = z1;
    const on = [...(mid < ownTop ? [-1] : []), ...bands.flatMap((b, i) => (b.some(([a, c]) => mid > a && mid < c) ? [i] : []))];
    if (!on.length) continue;
    cur ??= on[0];
    const start: number = on.includes(cur) ? cur : on[0];
    const n = on.length - 1 + (start === cur ? 0 : 1);
    if (n > 0) { layers++; changes += n; last = k; }
    // It ends the layer in another filament than it started in.
    cur = on.length > 1 ? on.find((f) => f !== start)! : start;
  }
  if (!changes) return { layers, changes, minutes: 0, grams: 0 };
  const tower = last + 1, c = SWAP_COST;
  return { layers, changes, minutes: c.startMinutes + changes * c.minutes + tower * c.towerMinutes, grams: c.startGrams + changes * c.grams + tower * c.towerGrams };
}
