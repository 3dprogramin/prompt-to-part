// Opens the Settings dialog from anywhere on the page (a filament picker's "Edit my filaments in
// Settings"): the app registers how, as it owns the dialog.
import type { SettingsTab } from './settingsTabs';

let opener: ((tab?: SettingsTab) => void) | null = null;

/** The app's way to open Settings; returns the way to take it back. */
export function setSettingsOpener(f: (tab?: SettingsTab) => void): () => void {
  opener = f;
  return () => { if (opener === f) opener = null; };
}

/** Opens Settings on a tab (none: the one used last); false when nothing can open it. */
export function openSettings(tab?: SettingsTab): boolean {
  if (!opener) return false;
  opener(tab);
  return true;
}
