import type { Box3, DesignVersion } from '../../shared/types';

/** Two bounding boxes agree to this many mm on all six bounds. */
const BOX_TOLERANCE = 0.01;

/** The six bounds of a box, or null when it is not a box (a stored value can be anything). */
function bounds(b: Box3): number[] | null {
  if (!Array.isArray(b.min) || !Array.isArray(b.max)) return null;
  const all = [...b.min, ...b.max];
  return all.length === 6 && all.every(Number.isFinite) ? all : null;
}

/** Whether a picture edit's build lines up with the version it came from: masked, unchanged outside the mark, same bounding box. */
export function linesUp(e: { masked: boolean; outsideSame: boolean }, parentBox: Box3 | null, box: Box3 | null): boolean {
  if (!e.masked || !e.outsideSame || !parentBox || !box) return false;
  const a = bounds(parentBox);
  const b = bounds(box);
  if (!a || !b) return false;
  return a.every((x, i) => Math.abs(x - b[i]) <= BOX_TOLERANCE);
}

/** The line under a version in the version menu: where it came from. */
export function versionNote(v: DesignVersion, count?: number): string {
  const e = v.pictureEdit;
  if (e) {
    // Versions only grow in normal use, so a parent index stays valid and is not remapped; one that is
    // missing, malformed or past the list (a hand-edited backup, an older client) is not named.
    const p = e.parent as unknown;
    const named = typeof p === 'number' && Number.isInteger(p) && p >= 0 && (count === undefined || p < count);
    return e.masked && e.linesUp && named ? `your picture edit, lines up with v${(p as number) + 1}` : 'your picture edit';
  }
  return v.source === 'manual' ? 'your code edit' : v.source === 'settings' ? 'your saved settings' : 'from the chat';
}
