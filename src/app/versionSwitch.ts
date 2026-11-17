// Switching the open design to another of its versions: whether it can happen now, and what it does.
import type { Design } from '../../shared/types';
import { withEditHistoryOf } from './designValues';

/** The design showing version `vi`: its code and settings, keeping the design's restore points. */
export function withVersion(d: Design, vi: number): Design {
  const v = d.versions[vi];
  return v ? { ...d, code: v.code, currentVersion: vi, values: withEditHistoryOf(v.values, d.values), updatedAt: Date.now() } : d;
}

/**
 * What a click on version `to` does: `wait` while a reply runs on the design (`replying`), `ask`
 * first when the settings shown aren't saved (a printed version's can't be saved, so there is
 * nothing to ask), else `switch`. A reply puts its pictures, drawings and meshes into the settings
 * shown and makes its version from them: a switch would replace the ones it already made, and on a
 * printed version the lock would drop the rest, though they were paid for.
 */
export function restoreChoice({ to, current, unsavedSettings, locked, replying }: { to: number; current: number; unsavedSettings: boolean; locked: boolean; replying: boolean }): 'wait' | 'ask' | 'switch' {
  if (replying) return 'wait';
  return to !== current && unsavedSettings && !locked ? 'ask' : 'switch';
}
