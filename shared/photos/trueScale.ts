// True scale layout: where a light switch or a mug goes beside the product in a size photo's render,
// and the area of wall or table the render frames.
import type { Vec3 } from '../types';
import type { ScaleRef } from './shop';

// The references' sizes (mm): a standard EU switch plate with a rocker, a plain coffee mug.
export const SWITCH_PLATE = { side: 85, depth: 10 };
export const MUG_SIZE = { diameter: 82, height: 95 };
/** The share of the render's width or height the product and its reference fill together. */
const REF_FILL = 0.7;
/** The share a wall piece fills alone on its wall at true scale (`wall`: no reference, room to show around it). */
const WALL_FILL = 0.45;

/** A render at true scale: the reference beside the product, and for a resize the product's size in the earlier photo (scaleRefLayout's `base`). */
export interface TrueScale { ref: ScaleRef; base?: Vec3 }

type Box = { min: Vec3; max: Vec3 };
export interface ScaleRefLayout {
  /** The reference's box (mm, the model's coordinates; the wall or the table is the plane z = the product's min z). */
  ref: Box;
  /** The box the render's camera frames: the wall or table area the picture shows. */
  frame: Box;
}

/**
 * Where the reference goes beside the product (its box, mm): a light switch on the wall to its
 * right, its centre a third of the way up the piece, with free wall between them; a mug on the
 * table beside it, along `side` (the render's right on the table, a unit vector), so it is as far
 * from the camera as the product. The frame shows both with free wall or table around them, for a
 * picture of `aspect` (width / height). `base`: the product's size in the earlier photo of another
 * sale size; the reference keeps its spot from that photo and the frame its area (moved or grown
 * only when this size would not fit), so only the product's size changes.
 */
export function scaleRefLayout(kind: ScaleRef, box: Box, aspect: number, o: { side?: [number, number]; base?: Vec3 } = {}): ScaleRefLayout {
  const own = [0, 1, 2].map((k) => box.max[k] - box.min[k]) as Vec3;
  const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2, z = box.min[2];
  // The product centred on the same spot, at a size.
  const at = (s: Vec3): Box => ({ min: [cx - s[0] / 2, cy - s[1] / 2, z], max: [cx + s[0] / 2, cy + s[1] / 2, z + s[2]] });
  const place = (s: Vec3, clear: Vec3): Box => {
    // (The wall alone: nothing beside the product.)
    if (kind === 'wall') return { min: [cx, cy, z], max: [cx, cy, z] };
    if (kind === 'switch') {
      const side = SWITCH_PLATE.side;
      // At least 30 mm of free wall, more beside a bigger piece; never closer to this size than that.
      const x = Math.max(cx + s[0] / 2 + Math.max(30, 0.6 * s[0]), cx + clear[0] / 2 + 30) + side / 2;
      const y = cy - s[1] / 2 + s[1] / 3;
      return { min: [x - side / 2, y - side / 2, z], max: [x + side / 2, y + side / 2, z + SWITCH_PLATE.depth] };
    }
    const [ux, uy] = o.side ?? [1, 0], r = MUG_SIZE.diameter / 2;
    // How far the product reaches along the side, then a gap.
    const reach = (v: Vec3) => (Math.abs(ux) * v[0] + Math.abs(uy) * v[1]) / 2;
    const d = Math.max(reach(s) + Math.max(25, 0.15 * Math.max(s[0], s[1])), reach(clear) + 20) + r;
    const mx = cx + ux * d, my = cy + uy * d;
    return { min: [mx - r, my - r, z], max: [mx + r, my + r, z + MUG_SIZE.height] };
  };
  const ref = place(o.base ?? own, own);
  const union = (a: Box, b: Box): Box => ({ min: a.min.map((v, k) => Math.min(v, b.min[k])) as Vec3, max: a.max.map((v, k) => Math.max(v, b.max[k])) as Vec3 });
  // The area around a product and its reference: on the wall a rectangle of the picture's shape,
  // on the table their box grown about its middle.
  const around = (b: Box): Box => {
    const c = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2), half = [0, 1, 2].map((k) => (b.max[k] - b.min[k]) / 2 / (kind === 'wall' ? WALL_FILL : REF_FILL));
    if (kind !== 'mug') {
      const w = Math.max(half[0], half[1] * aspect);
      half[0] = w; half[1] = w / aspect; half[2] = (b.max[2] - b.min[2]) / 2;
    }
    return { min: c.map((v, k) => v - half[k]) as Vec3, max: c.map((v, k) => v + half[k]) as Vec3 };
  };
  const frame = around(union(box, ref));
  // A resize: the earlier photo's area, grown only if this size needs more.
  return { ref, frame: o.base ? union(around(union(at(o.base), place(o.base, o.base))), frame) : frame };
}
