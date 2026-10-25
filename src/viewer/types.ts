// The viewer's public shapes: its options, views, repainting, measurements, photo views and assembly steps.
import type { Vec3 } from '../../shared/types';
import type { PhotoCamera } from '../../shared/photos';

export type ViewName = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface ViewerOptions {
  showBBox: boolean;
  showAnnotations: boolean;
  showEdges: boolean;
  ortho: boolean;
  section: { enabled: boolean; axis: 'x' | 'y' | 'z'; position: number; flip: boolean };
  hiddenParts: string[];
  measure: boolean;
  /** Click on the model to place text. */
  pickText?: boolean;
  /** false = show every part in one neutral colour. */
  colors?: boolean;
  /** The design prints in one colour ("Print in one colour"): every part in this filament colour, without per-part or per-triangle colours. */
  oneColour?: string | null;
  /** The part selected in the Object tab: highlighted. */
  selectedPart?: string | null;
  /** Line art: where Jig joined loose ends to another line, and the ends it left loose (LineArtInfo.joins, .loose). */
  showJoins?: boolean;
}

/** Repainting a coloured mesh by hand (the Object tab's Repaint): what a click or a drag on the model does. */
export interface RepaintView {
  /** The coloured mesh (PaintSource.meshes). */
  mesh: string;
  /** patch: a click picks the patch under it; brush: a left drag on the model paints. */
  mode: 'patch' | 'brush';
  /** Brush radius, mm. */
  radius: number;
  /** The brush's filament colour (#rrggbb), shown while it paints. */
  color: string;
  /** The stored mesh's triangles picked (1 each), highlighted. */
  selected: Uint8Array | null;
}

export interface Measurement { a: Vec3; b: Vec3 }

/**
 * How a product-photo render is framed: the viewer's camera, a 3/4 product angle, a flat print
 * face-on (from above), a close-up (of a flat print's face, else at the 3/4 angle), the front, or
 * from high above (PhotoCamera).
 */
export type PhotoView = 'current' | PhotoCamera;

/** Assembly animation step with per-part start offsets resolved. */
export interface PlaybackStep {
  label: string;
  parts: { name: string; from: Vec3; rotate?: { axis: Vec3; degrees: number; center?: Vec3 } }[];
}
