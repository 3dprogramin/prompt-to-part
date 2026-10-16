// Warnings about an evaluated model that both the user (Model tab) and Claude (evaluate_model
// report) see, so the two are always told the same thing.
import { fitProblem } from './printer';
import type { Box3 } from './types';

interface Evaluated {
  bbox: Box3 | null;
  warnings: string[];
  parts: { name: string; components: number }[];
}

/** The script's own warnings plus build-volume, plate-contact and disconnected-piece checks. */
export function modelWarnings(r: Evaluated): string[] {
  const out = [...r.warnings];
  const fit = fitProblem(r.bbox);
  if (fit) out.push(fit);
  if (r.bbox && Math.abs(r.bbox.min[2]) > 0.01) out.push(`Model does not rest on the build plate: min Z = ${r.bbox.min[2].toFixed(2)} mm (should be 0)`);
  for (const p of r.parts) {
    if (p.components > 1) out.push(`Part "${p.name}" consists of ${p.components} disconnected pieces – if it should be one solid, make the sub-shapes overlap (≥0.05 mm) before union`);
  }
  return out;
}
