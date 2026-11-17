// Printed versions: marking the shown version (its 3MF built and saved with it), unmarking one.
import type { Dispatch, SetStateAction } from 'react';
import { BACK_TEXT_KEY, pinBackText } from '../../shared/backText';
import { designKind } from '../../shared/designKind';
import type { Design } from '../../shared/types';
import { api } from '../lib/api';
import { HIDDEN_KEY, parseHidden } from '../lib/settings';
import { withoutEditHistory } from './designValues';
import type { designExports } from './exports';
import type { Notice } from './notice';

/** Why the shown version can't be marked printed now, or null. */
export function markProblem(s: { generating: boolean; unsavedSettings: boolean; hasCode: boolean }): string | null {
  if (s.generating) return 'Wait for the reply to finish';
  if (s.unsavedSettings) return 'Save or discard your settings first';
  if (!s.hasCode) return 'Nothing to print yet';
  return null;
}

/**
 * The design with version vi's back text written out as it prints (pinBackText; in the open values
 * too when it is the current version and they say what the version said), so the print, its 3MF and
 * its fingerprint keep it whatever the default becomes. The same design when it isn't LayerTone or
 * already says exactly that.
 */
export function pinForPrint(design: Design, vi: number): Design {
  const ver = design.versions[vi];
  if (!ver) return design;
  const values = pinBackText(ver.values ?? {}, designKind(ver.code, ver.values) === 'layertone');
  if (values === ver.values || !(BACK_TEXT_KEY in values)) return design;
  const versions = design.versions.map((v, i) => (i === vi ? { ...v, values } : v));
  const open = design.currentVersion === vi && design.values[BACK_TEXT_KEY] === ver.values?.[BACK_TEXT_KEY] ? { ...design.values, [BACK_TEXT_KEY]: values[BACK_TEXT_KEY] } : design.values;
  return { ...design, versions, values: open };
}

/** Mark the shown version printed (or make its 3MF again) and unmark a version. */
export function printedActions({ design, problem, printedVersions, saveNow, setDesign, build3mf, refreshList, setNotice, setMarking }: {
  design: Design;
  /** markProblem's answer for now. */
  problem: string | null;
  /** The design's versions already marked printed (their values stay as they were printed). */
  printedVersions: ReadonlySet<number>;
  saveNow: (d: Design) => Promise<unknown>;
  setDesign: Dispatch<SetStateAction<Design>>;
  build3mf: ReturnType<typeof designExports>['build3mf'];
  refreshList: () => void;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  setMarking: Dispatch<SetStateAction<boolean>>;
}) {
  // The back text it prints with is pinned into the version first (unless it is already printed),
  // here too so the next save keeps it. The design is saved (the server marks the version it has),
  // then the 3MF is built from the version's own values and hidden parts, not what the screen shows.
  // No file still marks it.
  const mark = async () => {
    const vi = design.currentVersion;
    if (problem || !design.versions[vi]) return;
    const pinned = printedVersions.has(vi) ? design : pinForPrint(design, vi);
    const version = pinned.versions[vi];
    if (pinned !== design) setDesign((d) => (d.id === design.id ? pinForPrint(d, vi) : d));
    setMarking(true);
    try {
      await saveNow(pinned);
      const values = withoutEditHistory(version.values);
      const built = await build3mf(values, parseHidden(values[HIDDEN_KEY]));
      const file = 'blob' in built ? built : null;
      await api.markPrinted(design.id, vi, file?.blob ?? null, !!file?.settings);
      refreshList();
      setNotice('error' in built
        ? { text: `Marked v${vi + 1} as printed · no 3MF: ${built.error}`, level: 'warning', details: false }
        : built.settings
          ? { text: `Marked v${vi + 1} as printed · 3MF saved`, level: 'ok', details: false }
          : { text: `Marked v${vi + 1} as printed · 3MF saved without print settings`, level: 'info', details: false });
    } catch (e) {
      setNotice({ text: `Not marked as printed: ${(e as Error).message}`, level: 'error', details: false });
    } finally {
      setMarking(false);
    }
  };
  const unmark = async (vi: number) => {
    if (!confirm(`Unmark v${vi + 1}? Its saved 3MF is deleted and it can be changed again.`)) return;
    try {
      await api.unmarkPrinted(design.id, vi);
      refreshList();
      setNotice({ text: `v${vi + 1} is no longer marked as printed`, level: 'ok', details: false });
    } catch (e) {
      setNotice({ text: `Not unmarked: ${(e as Error).message}`, level: 'error', details: false });
    }
  };
  return { mark, unmark };
}
