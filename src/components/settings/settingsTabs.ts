// The tabs of the Settings dialog and which one it opens on.
export type SettingsTab = 'printer' | 'filaments' | 'keys';

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'printer', label: 'Printer' },
  { id: 'filaments', label: 'Filaments' },
  { id: 'keys', label: 'Keys and services' },
];

/** localStorage key of the tab the user was last on. */
export const SETTINGS_TAB_KEY = 'ptp.settings.tab';

/** The tab to open on: the one asked for, else the one remembered (localStorage 'ptp.settings.tab'), else 'printer'. */
export function initialTab(asked: SettingsTab | undefined, remembered: string | null): SettingsTab {
  if (asked) return asked;
  return SETTINGS_TABS.find((t) => t.id === remembered)?.id ?? 'printer';
}
