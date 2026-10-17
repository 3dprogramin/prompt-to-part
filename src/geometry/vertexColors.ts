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

/** The part's colours when there is one RGB triple per vertex; anything else is ignored. */
export function usableColors(colors: Float32Array | undefined, positions: Float32Array): Float32Array | undefined {
  return colors && colors.length === positions.length ? colors : undefined;
}
