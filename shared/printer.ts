import type { Box3, Vec3 } from './types';

/**
 * The user's printer: its build volume and nozzle are used by the viewer, validation, both 3MF
 * exporters and Claude's instructions, and its Bambu Studio presets by the Bambu project export.
 * The baseline print settings (A1_DEFAULTS) are in shared/print.ts, the "bed-slinger" printing
 * advice in server/systemPrompt.ts.
 */
export const PRINTER = {
  name: 'Bambu Lab A1',
  bed: [256, 256] as [number, number],
  height: 256,
  nozzle: 0.4,
  /** Bambu Studio system presets the project template is built from (server/bambu.ts). */
  bambu: { machine: 'Bambu Lab A1 0.4 nozzle', process: '0.20mm Standard @BBL A1', filament: 'Bambu PLA Basic @BBL A1' },
};

/** Translation that puts the parts, as one block, on the plate (z = 0) and centred on the bed. */
export function bedShift(boxes: Box3[]): Vec3 {
  const lo = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k])));
  return [PRINTER.bed[0] / 2 - (lo[0] + hi[0]) / 2, PRINTER.bed[1] / 2 - (lo[1] + hi[1]) / 2, -lo[2]];
}

/** Returns a problem description if the box doesn't fit the build volume (assuming it is centered on the plate). */
export function fitProblem(b: Box3 | null): string | null {
  if (!b) return null;
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  const over: string[] = [];
  if (sx > PRINTER.bed[0]) over.push(`X ${sx.toFixed(1)} > ${PRINTER.bed[0]}`);
  if (sy > PRINTER.bed[1]) over.push(`Y ${sy.toFixed(1)} > ${PRINTER.bed[1]}`);
  if (sz > PRINTER.height) over.push(`Z ${sz.toFixed(1)} > ${PRINTER.height}`);
  return over.length ? `Too big for the ${PRINTER.name} build volume (${PRINTER.bed[0]} × ${PRINTER.bed[1]} × ${PRINTER.height} mm): ${over.join(', ')} mm` : null;
}
