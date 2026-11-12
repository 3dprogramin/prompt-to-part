import type { Box3, DesignVersion } from '../../shared/types';

/** Two bounding boxes agree to this many mm on all six bounds. */
const BOX_TOLERANCE = 0.01;

/** Whether a picture edit's build lines up with the version it came from: masked, unchanged outside the mark, same bounding box. */
export function linesUp(e: { masked: boolean; outsideSame: boolean }, parentBox: Box3 | null, box: Box3 | null): boolean {
  if (!e.masked || !e.outsideSame || !parentBox || !box) return false;
  const a = [...parentBox.min, ...parentBox.max];
  const b = [...box.min, ...box.max];
  return a.every((x, i) => Math.abs(x - b[i]) <= BOX_TOLERANCE);
}

/** The line under a version in the version menu: where it came from. */
export function versionNote(v: DesignVersion): string {
  const e = v.pictureEdit;
  if (e) return e.masked && e.linesUp ? `your picture edit, lines up with v${e.parent + 1}` : 'your picture edit';
  return v.source === 'manual' ? 'your code edit' : v.source === 'settings' ? 'your saved settings' : 'from the chat';
}
