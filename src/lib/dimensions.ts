import type { Box3, Vec3 } from '../../shared/types';

/** One of the overall width / depth / height lines drawn along a bounding box. */
export interface BoxDimension { axis: 0 | 1 | 2; label: string; from: Vec3; to: Vec3; offset: Vec3; color: string }

const fmt = (n: number) => (Math.abs(n) < 0.005 ? '0' : n.toFixed(2));

/**
 * The X, Y and Z dimension lines of a bounding box, as the viewer shows them and the .blend export
 * recreates them; `size` (the model's largest side) sets how far out they are drawn.
 */
export function boxDimensions(b: Box3, size: number): BoxDimension[] {
  const off = size * 0.12;
  const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
  return [
    { axis: 0, label: `X ${fmt(x1 - x0)} mm`, from: [x0, y0, z0], to: [x1, y0, z0], offset: [0, -off, 0], color: '#e46a6a' },
    { axis: 1, label: `Y ${fmt(y1 - y0)} mm`, from: [x1, y0, z0], to: [x1, y1, z0], offset: [off, 0, 0], color: '#6ac46a' },
    { axis: 2, label: `Z ${fmt(z1 - z0)} mm`, from: [x1, y0, z0], to: [x1, y0, z1], offset: [off * 0.7, -off * 0.7, 0], color: '#6a9ae4' },
  ];
}
