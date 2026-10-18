import * as THREE from 'three';
import type { PartMesh } from '../../shared/types';

/**
 * PartMesh.vertexColors are sRGB (like #rrggbb / 255); three.js reads a colour attribute as linear,
 * so they are converted once, here, before drawing.
 */
export function linearColors(srgb: ArrayLike<number>): Float32Array {
  const out = new Float32Array(srgb.length);
  for (let i = 0; i < srgb.length; i++) {
    const c = Math.min(1, Math.max(0, srgb[i]));
    out[i] = c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
  }
  return out;
}

/**
 * A part coloured per triangle (PartMesh.paint) as a geometry of unshared triangles, each corner in its
 * triangle's filament colour (linear); undefined for any other part.
 */
export function paintedGeometry(part: PartMesh): THREE.BufferGeometry | undefined {
  const paint = part.paint;
  const I = part.indices, P = part.positions;
  if (!paint || paint.tri.length !== I.length / 3 || !paint.filaments.length) return undefined;
  const rgb = paint.filaments.map((f) => { const c = new THREE.Color(f.color); return [c.r, c.g, c.b]; });
  const pos = new Float32Array(I.length * 3), col = new Float32Array(I.length * 3);
  for (let k = 0; k < I.length; k++) {
    const v = I[k] * 3, c = rgb[paint.tri[Math.floor(k / 3)]] ?? rgb[0];
    pos[k * 3] = P[v]; pos[k * 3 + 1] = P[v + 1]; pos[k * 3 + 2] = P[v + 2];
    col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** The part's colours when there is one RGB triple per vertex; anything else is ignored. */
export function usableColors(colors: Float32Array | undefined, positions: Float32Array): Float32Array | undefined {
  return colors && colors.length === positions.length ? colors : undefined;
}
