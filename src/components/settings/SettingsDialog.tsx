// Settings: the printer, the filaments and the keys and services, as tabs of one dialog. Opened from the
// gear in the top bar and from the connection chip.
import { useEffect, useRef, useState } from 'react';
import type { PrinterInfo } from '../../../shared/api';
import type { PrinterSetup } from '../../../shared/printer';
import { useEscape } from '../useEscape';
import { PrinterTab } from './PrinterTab';
import { initialTab, SETTINGS_TAB_KEY, SETTINGS_TABS, type SettingsTab } from './settingsTabs';

interface Props {
  /** The tab to open on; without it the one used last. */
  tab?: SettingsTab;
  printerInfo: PrinterInfo | null;
  onPrinter: (setup: PrinterSetup) => Promise<void>;
  onClose: () => void;
}

function remembered(): string | null {
  try { return localStorage.getItem(SETTINGS_TAB_KEY); } catch { return null; }
}

export function SettingsDialog({ tab: asked, printerInfo, onPrinter, onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>(() => initialTab(asked, remembered()));
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const dialog = useRef<HTMLDivElement>(null);
  useEscape(true, onClose);
  // Focus goes to the open tab and back to the opener (the gear or the chip) on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    tabRefs.current[tab]?.focus();
    return () => before?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (id: SettingsTab, focus = false) => {
    setTab(id);
    try { localStorage.setItem(SETTINGS_TAB_KEY, id); } catch { /* not remembered */ }
    if (focus) tabRefs.current[id]?.focus();
  };
  const onTabKey = (e: React.KeyboardEvent) => {
    const at = SETTINGS_TABS.findIndex((t) => t.id === tab);
    const to = e.key === 'ArrowRight' ? (at + 1) % SETTINGS_TABS.length
      : e.key === 'ArrowLeft' ? (at - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? SETTINGS_TABS.length - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    choose(SETTINGS_TABS[to].id, true);
  };

  return (
    // The backdrop does not close it: a half-typed key is not lost to a stray click.
    <div className="modal-backdrop">
      <div ref={dialog} className="modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={trapFocus}>
        <h3 id="settings-title">Settings</h3>
        <div className="settings-tabs" role="tablist" aria-label="Settings" onKeyDown={onTabKey}>
          {SETTINGS_TABS.map((t) => (
            <button key={t.id} ref={(el) => { tabRefs.current[t.id] = el; }} type="button" role="tab" id={`settings-tab-${t.id}`}
              aria-selected={tab === t.id} aria-controls={tab === t.id ? `settings-panel-${t.id}` : undefined}
              tabIndex={tab === t.id ? 0 : -1} className={tab === t.id ? 'on' : ''} onClick={() => choose(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="settings-panel" role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
          {tab === 'printer' && <PrinterTab info={printerInfo} onPrinter={onPrinter} />}
          {tab === 'filaments' && <p>Your filaments move here in the next update. For now they are in the LayerTone filament picker.</p>}
          {/* The Keys and services tab replaces this line in the next step. */}
          {tab === 'keys' && <p>Keys and services are added in the next step.</p>}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** Keeps Tab and Shift+Tab inside the dialog (the tabs not in use are skipped: they are reached by the arrows). */
function trapFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
}
