// Text added with the UI text tool, applied on top of the model script's output.
import type { CrossSection, Manifold } from 'manifold-3d';
import { DEFAULT_FONT, layoutText } from './text';
import type { Vec3 } from './types';

export const TEXT_KEY = '$text';

export type TextFace = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'pick';

export interface TextFeature {
  id: string;
  enabled: boolean;
  text: string;
  font: string;
  /** Capital-letter height, mm */
  size: number;
  /** Raise height or engrave depth, mm */
  depth: number;
  mode: 'emboss' | 'engrave';
  face: TextFace;
  /** Target part name (defaults to the first part) */
  part?: string;
  /** Normalised point inside the part's bounding box (used with face 'pick') */
  anchor: Vec3;
  /** Surface normal for face 'pick' */
  normal: Vec3;
  /** In-plane offset from the anchor [right, up] in mm */
  offset: [number, number];
  /** In-plane rotation, degrees */
  rotation: number;
  curve: 'none' | 'arc' | 'wrap';
  /** Arc radius (mm); negative curves the other way */
  arcRadius: number;
  /** Cylinder radius for wrap; 0 = measure from the surface */
  wrapRadius: number;
  letterSpacing: number;
  lineHeight: number;
  halign: 'left' | 'center' | 'right';
}

export function newTextFeature(id: string, partial: Partial<TextFeature> = {}): TextFeature {
  return {
    id, enabled: true, text: 'TEXT', font: DEFAULT_FONT, size: 8, depth: 0.8, mode: 'emboss', face: 'top',
    anchor: [0.5, 0.5, 1], normal: [0, 0, 1], offset: [0, 0], rotation: 0, curve: 'none', arcRadius: 40, wrapRadius: 0,
    letterSpacing: 0, lineHeight: 1.4, halign: 'center', ...partial,
  };
}

export function parseTextFeatures(raw: unknown): TextFeature[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((f) => f && typeof f.text === 'string').map((f) => newTextFeature(String(f.id), f)) : [];
  } catch {
    return [];
  }
}

const FACE_DIRS: Record<Exclude<TextFace, 'pick'>, { anchor: Vec3; normal: Vec3 }> = {
  top: { anchor: [0.5, 0.5, 1], normal: [0, 0, 1] },
  bottom: { anchor: [0.5, 0.5, 0], normal: [0, 0, -1] },
  front: { anchor: [0.5, 0, 0.5], normal: [0, -1, 0] },
  back: { anchor: [0.5, 1, 0.5], normal: [0, 1, 0] },
  left: { anchor: [0, 0.5, 0.5], normal: [-1, 0, 0] },
  right: { anchor: [1, 0.5, 0.5], normal: [1, 0, 0] },
};

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const SINK = 0.4; // emboss overlaps into the surface so it fuses
const CLEAR = 0.6; // engrave cutter rises above the surface

/** Applies the text features to `shape` (one part). Returns the modified shape. */
export function applyTextFeatures(
  shape: Manifold,
  features: TextFeature[],
  M: typeof Manifold,
  C: typeof CrossSection,
): Manifold {
  let out = shape;
  for (const f of features) {
    if (!f.enabled || !f.text.trim() || !(f.size > 0) || !(f.depth > 0)) continue;
    const bb = out.boundingBox();
    const size: Vec3 = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];
    const preset = f.face === 'pick' ? { anchor: f.anchor, normal: f.normal } : FACE_DIRS[f.face];
    const n = norm(preset.normal);
    const a0: Vec3 = [0, 1, 2].map((k) => bb.min[k] + preset.anchor[k] * size[k]) as Vec3;
    // Snap the anchor onto the actual surface by casting a ray inwards along -normal.
    const diag = Math.hypot(...size) + 10;
    const origin: Vec3 = [a0[0] + n[0] * diag, a0[1] + n[1] * diag, a0[2] + n[2] * diag];
    const end: Vec3 = [a0[0] - n[0] * diag, a0[1] - n[1] * diag, a0[2] - n[2] * diag];
    let P = a0;
    try {
      const hits = out.rayCast(origin, end);
      if (hits.length) P = [...hits.reduce((h, x) => (x.distance < h.distance ? x : h)).position] as Vec3;
    } catch { /* keep bbox point */ }

    // Text frame: right/up span the surface plane, w points out of the surface.
    const upHint: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    let right = norm(cross(upHint, n));
    let up = norm(cross(n, right));
    const rot = (f.rotation * Math.PI) / 180;
    if (rot) {
      const c = Math.cos(rot), s = Math.sin(rot);
      const r2: Vec3 = [right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s];
      const u2: Vec3 = [up[0] * c - right[0] * s, up[1] * c - right[1] * s, up[2] * c - right[2] * s];
      right = r2; up = u2;
    }
    P = [P[0] + right[0] * f.offset[0] + up[0] * f.offset[1], P[1] + right[1] * f.offset[0] + up[1] * f.offset[1], P[2] + right[2] * f.offset[0] + up[2] * f.offset[1]];

    const contours = layoutText(f.text, {
      size: f.size, font: f.font, letterSpacing: f.letterSpacing, lineHeight: f.lineHeight, halign: f.halign, valign: 'center',
      arcRadius: f.curve === 'arc' ? f.arcRadius : undefined,
    });
    if (!contours.length) continue;
    const cs = new C(contours, 'NonZero');
    const z0 = f.mode === 'emboss' ? -SINK : -f.depth;
    const h = f.mode === 'emboss' ? f.depth + SINK : f.depth + CLEAR;
    let solid: Manifold = cs.extrude(h).translate([0, 0, z0]);

    if (f.curve === 'wrap' && Math.abs(n[2]) < 0.9) {
      // Wrap around a vertical cylinder whose axis passes through the part's bbox centre.
      const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
      const R = f.wrapRadius > 0 ? f.wrapRadius : Math.max(1, Math.hypot(P[0] - cx, P[1] - cy));
      const theta0 = Math.atan2(P[1] - cy, P[0] - cx);
      // In-plane rotation for wrapped text is applied in 2D before bending.
      const c = Math.cos(rot), s = Math.sin(rot);
      solid = solid.refineToLength(Math.max(0.4, R / 50)).warp((v) => {
        const x = v[0] * c - v[1] * s, y = v[0] * s + v[1] * c, w = v[2];
        const th = theta0 + x / R;
        const r = R + w;
        v[0] = cx + r * Math.cos(th);
        v[1] = cy + r * Math.sin(th);
        v[2] = P[2] + y;
      });
      // warp above keeps orientation: x→tangent, y→Z, w→outward forms a right-handed frame
    } else {
      const m: number[] = [right[0], right[1], right[2], 0, up[0], up[1], up[2], 0, n[0], n[1], n[2], 0, P[0], P[1], P[2], 1];
      solid = solid.transform(m as Parameters<Manifold['transform']>[0]);
    }
    out = f.mode === 'emboss' ? out.add(solid) : out.subtract(solid);
  }
  return out;
}
