import type { Box3, Vec3 } from './types';

/** "bedslinger": the bed moves in Y (Bambu Studio's "i3", A1 and A1 mini); "corexy": the bed only moves in Z. */
export type Structure = 'bedslinger' | 'corexy';

/**
 * A printer the user can pick: a Bambu Studio machine preset (one model with one nozzle), or a
 * built-in fallback entry when Bambu Studio isn't installed. Its build volume and nozzle are used
 * by the viewer, validation, both 3MF exporters and the AI's instructions; its Bambu Studio presets
 * by the Bambu project template (server/bambu.ts).
 */
export interface Printer {
  /** The machine preset's name ("Bambu Lab A1 0.4 nozzle"), or the user preset's. */
  id: string;
  /** What users and the AI see: "Bambu Lab A1", "Bambu Lab A1 (0.2 nozzle)", or the user preset's name. */
  name: string;
  /** Bambu Studio's printer_model ("Bambu Lab A1"). */
  model: string;
  nozzle: number;
  /** Width and depth of the printable area (mm). */
  bed: [number, number];
  /** The printable area's min corner in bed coordinates (mm). */
  origin: [number, number];
  height: number;
  structure: Structure;
  /** Bambu Studio presets the project template is built from; null for a built-in fallback entry. */
  presets: { machine: string; process: string; filament: string } | null;
  /** One of the user's own presets saved in Bambu Studio. */
  custom: boolean;
}

/** The saved choice (data/printer.json). */
export interface PrinterSetup {
  printerId: string;
  /** Filaments the printer loads at once (its AMS slots), 1 to 16. */
  filaments: number;
}

/** The chosen printer with its filament count. */
export interface ActivePrinter extends Printer {
  filaments: number;
}

export const DEFAULT_FILAMENTS = 4;
export const MAX_FILAMENTS = 16;

/** "Bambu Lab A1" for the 0.4 nozzle (so today's wording stays), "Bambu Lab A1 (0.2 nozzle)" for others. */
export function printerName(model: string, nozzle: number): string {
  return nozzle === 0.4 ? model : `${model} (${nozzle} nozzle)`;
}

const builtin = (model: string, bed: [number, number], height: number, structure: Structure): Printer => ({
  id: `${model} 0.4 nozzle`, name: printerName(model, 0.4), model, nozzle: 0.4, bed, origin: [0, 0], height, structure, presets: null, custom: false,
});

/** Used when Bambu Studio isn't installed (no project template or slicing then). Values from Bambu Studio 2.8's presets. */
export const BUILTIN_PRINTERS: Printer[] = [
  builtin('Bambu Lab A1', [256, 256], 256, 'bedslinger'),
  builtin('Bambu Lab A1 mini', [180, 180], 180, 'bedslinger'),
  builtin('Bambu Lab P1S', [256, 256], 250, 'corexy'),
  builtin('Bambu Lab X1 Carbon', [256, 256], 250, 'corexy'),
  builtin('Bambu Lab H2D', [350, 320], 325, 'corexy'),
];

/** Bambu Lab A1, 0.4 nozzle, 0.20 mm Standard, Bambu PLA Basic, 4 filaments (one AMS lite): the printer until one is picked. */
export const DEFAULT_PRINTER: ActivePrinter = {
  ...BUILTIN_PRINTERS[0],
  presets: { machine: 'Bambu Lab A1 0.4 nozzle', process: '0.20mm Standard @BBL A1', filament: 'Bambu PLA Basic @BBL A1' },
  filaments: DEFAULT_FILAMENTS,
};

let current: ActivePrinter = DEFAULT_PRINTER;

/** The chosen printer: set on the server from data/printer.json, in the app from /api/printer, in the geometry workers with every job. */
export function printer(): ActivePrinter {
  return current;
}

export function setPrinter(p: ActivePrinter): void {
  current = p;
}

export function isBedSlinger(p: Printer = current): boolean {
  return p.structure === 'bedslinger';
}

/** Filaments loaded at once: a whole number from 1 to 16, 4 when unset or unreadable. */
export function clampFilaments(n: unknown): number {
  const v = typeof n === 'number' ? n : typeof n === 'string' && n.trim() !== '' ? Number(n) : NaN;
  return Number.isFinite(v) ? Math.min(MAX_FILAMENTS, Math.max(1, Math.round(v))) : DEFAULT_FILAMENTS;
}

/** Layer heights of Bambu Studio's process presets for each nozzle (2.8). */
const LAYERS: Record<string, number[]> = {
  '0.2': [0.06, 0.08, 0.1, 0.12, 0.14],
  '0.4': [0.08, 0.12, 0.16, 0.2, 0.24, 0.28],
  '0.6': [0.18, 0.24, 0.3, 0.36, 0.42],
  '0.8': [0.24, 0.32, 0.4, 0.48, 0.56],
};

/** The layer heights that make sense for a nozzle (another size: the nearest of 0.2 / 0.4 / 0.6 / 0.8). */
export function layerHeights(nozzle: number): number[] {
  const near = Object.keys(LAYERS).reduce((a, b) => (Math.abs(Number(b) - nozzle) < Math.abs(Number(a) - nozzle) ? b : a));
  return LAYERS[near];
}

/** The largest a split piece may be (mm): the bed's shorter side less a margin (the A1: 250). */
export function maxPiece(p: Printer = current): number {
  return Math.min(p.bed[0], p.bed[1]) - 6;
}

/** Translation that puts the parts, as one block, on the plate (z = 0) and centred on the bed. */
export function bedShift(boxes: Box3[], p: Printer = current): Vec3 {
  const lo = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k])));
  return [p.origin[0] + p.bed[0] / 2 - (lo[0] + hi[0]) / 2, p.origin[1] + p.bed[1] / 2 - (lo[1] + hi[1]) / 2, -lo[2]];
}

/**
 * What must fit one plate: the whole model, or – when parts have plates of their own (the pieces
 * of a split model, PartMesh.plate) – each plate's parts, the biggest first.
 */
export function plateBounds(parts: { bbox: Box3; plate?: number }[], all: Box3 | null): Box3[] {
  const ids = [...new Set(parts.map((p) => p.plate ?? 1))];
  if (ids.length < 2) return all ? [all] : [];
  const boxes = ids.map((id) => {
    const on = parts.filter((p) => (p.plate ?? 1) === id);
    return { min: [0, 1, 2].map((k) => Math.min(...on.map((p) => p.bbox.min[k]))) as Vec3, max: [0, 1, 2].map((k) => Math.max(...on.map((p) => p.bbox.max[k]))) as Vec3 };
  });
  const size = (b: Box3) => Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
  return boxes.sort((a, b) => size(b) - size(a));
}

/** Returns a problem description if the box doesn't fit the build volume (assuming it is centered on the plate). */
export function fitProblem(b: Box3 | null, p: Printer = current): string | null {
  if (!b) return null;
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  const over: string[] = [];
  if (sx > p.bed[0]) over.push(`X ${sx.toFixed(1)} > ${p.bed[0]}`);
  if (sy > p.bed[1]) over.push(`Y ${sy.toFixed(1)} > ${p.bed[1]}`);
  if (sz > p.height) over.push(`Z ${sz.toFixed(1)} > ${p.height}`);
  return over.length ? `Too big for the ${p.name} build volume (${p.bed[0]} × ${p.bed[1]} × ${p.height} mm): ${over.join(', ')} mm` : null;
}
