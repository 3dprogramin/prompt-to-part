import type { Box3 } from './types';

/** The user's printer. Change here to retarget the whole app. */
export const PRINTER = {
  name: 'Bambu Lab A1',
  bed: [256, 256] as [number, number],
  height: 256,
  nozzle: 0.4,
};

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
