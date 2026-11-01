// Warnings about an evaluated model that both the user (Model tab) and Claude (evaluate_model
// report) see, so the two are always told the same thing.
import { fitProblem, plateBounds, printer } from './printer';
import type { Box3 } from './types';
import { filamentLabel, type PaintFilament } from './meshColors';

interface Evaluated {
  bbox: Box3 | null;
  warnings: string[];
  parts: { name: string; components: number; color?: string; paint?: { filaments: PaintFilament[] }; bbox: Box3; plate?: number; lineArt?: { components?: number; paintedIn?: PaintFilament } }[];
}

/** The filaments a design with coloured meshes prints with: each painted part's, and the colour of every other part (one per colour). */
export function designFilaments(parts: Evaluated['parts']): PaintFilament[] {
  const out: PaintFilament[] = [];
  for (const p of parts) for (const f of p.paint?.filaments ?? (p.color ? [{ color: p.color }] : [])) {
    const same = out.findIndex((g) => g.color.toLowerCase() === f.color.toLowerCase());
    if (same < 0) out.push(f); else if (!out[same].name && f.name) out[same] = f;
  }
  return out;
}

/** The script's own warnings plus build-volume, plate-contact and disconnected-piece checks. */
export function modelWarnings(r: Evaluated): string[] {
  const out = [...r.warnings];
  // Each plate's parts must fit (a split model has a plate per piece).
  const fit = plateBounds(r.parts, r.bbox).map((b) => fitProblem(b)).find(Boolean);
  if (fit) out.push(fit);
  if (r.bbox && Math.abs(r.bbox.min[2]) > 0.01) out.push(`Model does not rest on the build plate: min Z = ${r.bbox.min[2].toFixed(2)} mm (should be 0)`);
  // A coloured figure prints in the filaments the printer loads at once, together with the design's other parts.
  if (r.parts.some((p) => p.paint || p.lineArt?.paintedIn)) {
    const all = designFilaments(r.parts);
    const what = r.parts.some((p) => p.paint) ? "give the other parts one of the figure's filament colours, or give the figure fewer colours" : 'colour the lines in fewer filaments (Edit drawing)';
    const loads = printer().filaments;
    if (all.length > loads) out.push(`The design needs ${all.length} filaments (${all.map(filamentLabel).join(', ')}), but the ${printer().name} loads ${loads} at once: the rest are swapped by hand during the print. To avoid that, ${what}`);
  }
  for (const p of r.parts) {
    // Line art in several filaments: its colours are parts of their own, one piece with the rest.
    if (p.lineArt?.paintedIn) continue;
    const n = p.lineArt?.components ?? p.components;
    if (n > 1) out.push(`Part "${p.name}" consists of ${n} disconnected pieces: if it should be one solid, make the sub-shapes overlap (≥0.05 mm) before union`);
  }
  return out;
}
