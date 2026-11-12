import type { Design } from '../../shared/types';
import { EDIT_HISTORY_KEY } from '../../shared/editHistory';
import { LINEART_LAYOUT_KEY } from '../../shared/lineart/settings';
import { HIDDEN_KEY } from './settings';

/** Settings that only change how the model is looked at, not what is printed. */
export const VIEW_KEYS: readonly string[] = [HIDDEN_KEY, LINEART_LAYOUT_KEY, EDIT_HISTORY_KEY];

/** True when `next` would change the code or settings of a printed (locked) version of the same design. */
export function blockedChange(prev: Design, next: Design, locked: ReadonlySet<number>): boolean {
  if (prev.id !== next.id || !locked.has(prev.currentVersion) || next.currentVersion !== prev.currentVersion) return false;
  if (next.code !== prev.code || next.versions.length !== prev.versions.length) return true;
  const keys = new Set([...Object.keys(prev.values), ...Object.keys(next.values)]);
  for (const k of keys) {
    if (VIEW_KEYS.includes(k)) continue;
    if (JSON.stringify(prev.values[k]) !== JSON.stringify(next.values[k])) return true;
  }
  return false;
}
