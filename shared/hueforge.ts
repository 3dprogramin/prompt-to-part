// HueForge-style filament painting: a picture printed flat as a thin relief, where the brightness
// of each point comes from how much light filament lies over darker filament. Filaments are
// stacked bottom → top and swapped at set layer heights; thin layers let the ones below show
// through, by each filament's TD (transmission distance: the thickness at which it hides what is
// under it).
//
// CONTRACT (feat/hueforge). The types and signatures here are shared by the engine (this file,
// shared/helpers.ts H.hueforge, shared/runtime.ts), the viewer, the side panel, the 3MF export
// and the server. Implementations marked TODO belong to the engine work.

/** Values key: the pictures for H.hueforge, as JSON Record<name, HfImage>. */
export const HF_IMAGES_KEY = '$images';
/** Values key: the user's HueForge setup (filaments, swaps), as JSON HueforgeSetup. Edited in the side panel. */
export const HF_KEY = '$hueforge';

/** Most filaments in one HueForge print (4 load in the A1's AMS lite; more need manual swaps). */
export const MAX_HF_FILAMENTS = 8;
/** Longest side of a stored picture, pixels. */
export const MAX_HF_IMAGE_SIDE = 800;

export interface HfFilament {
  /** E.g. "PLA Basic Black". */
  name: string;
  /** E.g. "Bambu Lab", "eSUN". */
  brand?: string;
  /** #rrggbb */
  color: string;
  /** Transmission distance, mm (HueForge's TD). */
  td: number;
}

/** A picture as stored in the design: 8-bit luminance, row by row from the top. */
export interface HfImage {
  name: string;
  width: number;
  height: number;
  /** width × height bytes, base64. */
  luma: string;
}

/** What the user set in the side panel (stored under HF_KEY); script options are the fallback. */
export interface HueforgeSetup {
  /** Bottom (first printed, usually darkest) → top. */
  filaments?: HfFilament[];
  /**
   * The layer (0-based, counted from the bed) at which each filament after the first starts:
   * filaments.length - 1 ascending numbers. Missing = automatic (autoSwaps).
   */
  swaps?: number[];
}

/** H.hueforge options (sliders in the script); all lengths in mm. */
export interface HueforgeOptions {
  /** Width of the picture; its height follows the picture's proportions. */
  width: number;
  /** Default 0.08. */
  layerHeight?: number;
  /** Default 0.16. */
  firstLayerHeight?: number;
  /** Solid backing under the picture, in the first filament (default 0.48: first layer + 4 layers). */
  baseHeight?: number;
  /** Total height at the brightest points (default 1.6). */
  maxHeight?: number;
  /** Plain frame around the picture at full height, mm (default 0 = none). */
  border?: number;
  /** Dark areas high instead of bright ones (default false). */
  invert?: boolean;
  /** Brightness curve before mapping to heights (default 1; < 1 lifts the shadows). */
  gamma?: number;
  /** Filaments when the user hasn't chosen any (default: black and white). */
  filaments?: HfFilament[];
  /** Grid spacing of the relief, mm (default by quality: draft 0.6, normal 0.35, high 0.2). */
  resolution?: number;
}

/** Where each filament starts: z measured from the bed (the part must stay on the bed, z = 0). */
export interface LayerColor {
  /** Height at which this filament starts, mm (the first one starts at 0). */
  z: number;
  /** First layer index printed in this filament. */
  layer: number;
  color: string;
  td: number;
  name?: string;
  brand?: string;
}

/** What H.hueforge returns; a script returns it as a part: { name, ...hf } (shape, layerColors), and hf.print as its print settings. */
export interface HueforgePart {
  shape: unknown; // Manifold
  layerColors: LayerColor[];
  /** Print settings a HueForge print needs (layer heights, 100 % infill…). */
  print: { layerHeight: number; firstLayerHeight: number; infill: number; walls?: number; topLayers?: number; bottomLayers?: number };
}

export const DEFAULT_FILAMENTS: HfFilament[] = [
  { name: 'PLA Basic Black', brand: 'Bambu Lab', color: '#161616', td: 0.6 },
  { name: 'PLA Basic White', brand: 'Bambu Lab', color: '#ffffff', td: 3.0 },
];

/** TODO(engine) RGBA pixels (e.g. from a canvas or a decoded PNG/JPEG) → HfImage, scaled down to MAX_HF_IMAGE_SIDE. */
export function toHfImage(name: string, width: number, height: number, rgba: ArrayLike<number>): HfImage {
  throw new Error(`toHfImage(${name}, ${width}×${height}, ${rgba.length}): not implemented yet`);
}

/** TODO(engine) Automatic swap layers for the picture and filaments (see HueforgeSetup.swaps). */
export function autoSwaps(image: HfImage, filaments: HfFilament[], o: HueforgeOptions): number[] {
  throw new Error(`autoSwaps(${image.name}, ${filaments.length}, ${o.width}): not implemented yet`);
}

/** TODO(engine) The colour a point looks when the print's top there is at height `z` (mm), #rrggbb. */
export function simulateColor(z: number, layers: LayerColor[]): string {
  throw new Error(`simulateColor(${z}, ${layers.length}): not implemented yet`);
}

/** TODO(engine) The whole print as it will look, as RGBA pixels (for the side panel's preview and Claude). */
export function simulateImage(image: HfImage, layers: LayerColor[], o: HueforgeOptions): { width: number; height: number; rgba: Uint8ClampedArray } {
  throw new Error(`simulateImage(${image.name}, ${layers.length}, ${o.width}): not implemented yet`);
}
