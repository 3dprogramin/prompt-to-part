import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connection } from '../../shared/api';
import { api } from '../lib/api';
import type { Design, DesignSummary } from '../../shared/types';
import type { DesignKind } from '../../shared/designKind';
import { TEMP_TAG } from '../../shared/tags';
import { cleanFilter, tagCounts, type DesignFilter } from '../lib/designList';
import { load, store } from '../lib/storage';
import { Icon } from './Icon';
import { JigMark } from './JigMark';
import { DesignsMenu, KindIcon } from './DesignsMenu';
import { DesignTagsButton } from './Tags';
import { DesignTabs, type DesignTab } from './DesignTabs';
import { VersionMenu } from './VersionMenu';
import { usePopover } from './usePopover';

interface Props {
  design: Design;
  /** What kind of design the open one is (designKind). */
  kind: DesignKind;
  onRename: (name: string) => void;
  onRestore: (versionIndex: number) => void;
  /** New design from a version. */
  onFork: (versionIndex: number) => void;
  /** Slider/scale/text/print changes not saved in any version yet. */
  unsavedSettings: boolean;
  onSaveSettings: () => void;
  /** Why the open design's latest change isn't saved, or undefined. */
  saveError?: string;
  onRetrySave: () => void;
  tabs: DesignTab[];
  onOpen: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Close every tab Claude isn't working on. */
  onCloseAllTabs: () => void;
  /** A new design, with these tags once it is saved. */
  onNew: (tags?: string[]) => void;
  designs: DesignSummary[];
  /** Why the design list couldn't be loaded, or null. */
  listError: string | null;
  onRefreshList: () => void;
  isRunning: (id: string) => boolean;
  /** Generations running in this tab: the connection chip rechecks the connection when one ends. */
  generating: number;
  onDelete: (id: string) => void;
  /** Bulk actions of the Designs menu. */
  onDeleteMany: (ids: string[]) => Promise<void>;
  onStar: (ids: string[], on: boolean) => void;
  onTag: (ids: string[], tag: string, on: boolean) => void;
  /** Replaces a design's tags (a new one's are kept until it is saved). */
  onSetTags: (id: string, tags: string[]) => void;
  /** The open design's tags. */
  tags: string[];
  /** A phone's narrow bar: icons for the buttons, no design tabs (Designs lists them), New in the Designs menu. */
  compact?: boolean;
}

/** Logo, design name, versions, open designs and the Designs menu. */
export function TopBar(p: Props) {
  const [showList, setShowList] = useState(false);
  const listWrap = useRef<HTMLDivElement>(null);
  usePopover(showList, () => setShowList(false), listWrap);
  const open = (id: string) => { setShowList(false); p.onOpen(id); };
  // The tag (or the stars) the Designs menu shows, remembered; while it shows Temp, new designs are Temp too.
  const [filter, setFilterState] = useState<DesignFilter>(() => cleanFilter(load('designFilter', null)));
  const setFilter = (f: DesignFilter) => { setFilterState(f); store('designFilter', f); };
  const newTags = filter.kind === 'tag' && filter.tag === TEMP_TAG ? [TEMP_TAG] : undefined;
  const allTags = useMemo(() => tagCounts(p.designs).map((c) => c.tag), [p.designs]);
  // Backups: "Export all designs" is a download link; an import's result stays in the menu.
  const backupInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [backupNote, setBackupNote] = useState<{ text: string; detail?: string; error?: boolean } | null>(null);
  const importBackup = async (file: File) => {
    setImporting(true);
    setBackupNote(null);
    try {
      const r = await api.importBackup(file);
      const settings = r.settings.length ? `, restored your ${r.settings.join(' and ')}` : '';
      const skipped = r.skipped.map((s) => `${s.name} (${s.reason})`);
      setBackupNote({ text: `Imported ${r.imported.length}, skipped ${r.skipped.length}${settings}`, detail: skipped.length ? `Skipped: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ` and ${skipped.length - 3} more` : ''}` : undefined });
      p.onRefreshList();
    } catch (e) {
      setBackupNote({ text: `Not imported: ${(e as Error).message}`, error: true });
    } finally {
      setImporting(false);
      if (backupInput.current) backupInput.current.value = '';
    }
  };
  // A plain click starts a new design in place; a modified click or the context menu opens a new tab.
  const newHere = (e: React.MouseEvent) => { if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); p.onNew(newTags); } };
  const newTitle = newTags ? 'New design (tagged Temp: the Designs menu shows Temp)' : 'New design';
  return (
    <header className="topbar">
      {/* Real links (logo and New), so they can be opened in a new tab. */}
      <a className="brand" href="/" title={newTitle} onClick={newHere}>
        <span className="logo"><JigMark /></span> <span className="brand-name">prompt-to-part</span>
      </a>
      <span className="app-version" title="prompt-to-part version">v{import.meta.env.VITE_APP_VERSION}</span>
      {/* As wide as the name (CSS field-sizing, or this width where that isn't supported), so the
          version menu sits right after it. */}
      <KindIcon kind={p.kind} size={14} />
      <input className="design-name" aria-label="Design name" value={p.design.name} onChange={(e) => p.onRename(e.target.value)}
        style={{ '--name-chars': p.design.name.length } as React.CSSProperties} />
      {p.design.versions.length > 0 && <VersionMenu versions={p.design.versions} current={p.design.currentVersion} onRestore={p.onRestore} onFork={p.onFork} />}
      <DesignTagsButton tags={p.tags} allTags={allTags} onChange={(tags) => p.onSetTags(p.design.id, tags)} compact={p.compact} />
      {p.unsavedSettings && (
        <button className="btn save-settings" onClick={p.onSaveSettings} title="Your slider, scale, text or print changes are not saved in any version yet – save them as a new version">
          <Icon name="save" size={13} /> <span className="btn-label">Save as </span>v{p.design.versions.length + 1}
        </button>
      )}
      {p.saveError && (
        <button
          className="btn save-error"
          onClick={p.onRetrySave}
          title={`Your latest changes are not saved: ${p.saveError}. ${/X-Jig/.test(p.saveError) ? 'This page is older than the server – reload it.' : 'Click to try again.'}`}
        >
          <Icon name="alert" size={13} /> <span className="btn-label">Not saved – retry</span>
        </button>
      )}
      {p.tabs.length > 1 && !p.compact ? <DesignTabs tabs={p.tabs} current={p.design.id} onOpen={p.onOpen} onClose={p.onCloseTab} /> : <span className="spacer" />}
      {p.tabs.filter((t) => !t.running).length > 1 && !p.compact && (
        <button className="btn ghost close-all" onClick={p.onCloseAllTabs} title="Close all tabs (designs being worked on stay open; nothing is deleted)">
          <Icon name="x" size={13} /> Close all
        </button>
      )}
      <ConnectionChip generating={p.generating} />
      {!p.compact && <a className={`btn ghost ${newTags ? 'new-temp' : ''}`} href="/" title={newTitle} onClick={newHere}><Icon name="plus" size={14} /> New</a>}
      <div className="menu-wrap" ref={listWrap}>
        <button className="btn ghost" aria-haspopup="menu" aria-expanded={showList} aria-label="Designs"
          onClick={() => { p.onRefreshList(); if (!importing) setBackupNote(null); setShowList(!showList); }}><Icon name="folder" size={14} /> <span className="btn-label">Designs</span></button>
        {showList && (
          <DesignsMenu designs={p.designs} listError={p.listError} currentId={p.design.id} onRefreshList={p.onRefreshList} isRunning={p.isRunning}
            onOpen={open} onDelete={p.onDelete} onDeleteMany={p.onDeleteMany} onStar={p.onStar} onSetTags={p.onSetTags} onTag={p.onTag} filter={filter} onFilter={setFilter}>
              {p.compact && (
                <a className="menu-action" href="/" title={newTitle} onClick={(e) => { setShowList(false); newHere(e); }}><Icon name="plus" size={13} /> New design</a>
              )}
              {backupNote && (
                <div className={`menu-note ${backupNote.error ? 'error' : ''}`} role="status">
                  {backupNote.text}{backupNote.detail && <div className="dim small">{backupNote.detail}</div>}
                </div>
              )}
              <a className="menu-action" href="/api/backup" download title="Download every design (with its images and meshes) and your cost settings and filaments as one zip">
                <Icon name="download" size={13} /> Export all designs
              </a>
              <button className="menu-action" disabled={importing} onClick={() => backupInput.current?.click()} title="Add the designs from a prompt-to-part backup zip (designs already here are kept as they are)">
                {importing ? <span className="spinner" /> : <Icon name="restore" size={13} />} {importing ? 'Importing…' : 'Import designs…'}
              </button>
              <input ref={backupInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importBackup(f); }} />
          </DesignsMenu>
        )}
      </div>
    </header>
  );
}

const VIA_LABEL: Record<Connection['via'], string> = {
  openrouter: 'OpenRouter API',
  anthropic: 'Anthropic API',
  custom: 'Custom API',
  none: 'No Claude access',
};

/**
 * What the app runs Claude on and whether it answers: checked on load,
 * every 5 minutes, on click and when a generation ends.
 */
function ConnectionChip({ generating }: { generating: number }) {
  const [conn, setConn] = useState<Connection | null>(null);
  const [checking, setChecking] = useState(true);
  const check = (fresh: boolean) => {
    setChecking(true);
    api.connection(fresh).then(setConn, (e: Error) => setConn({ via: 'none', ok: false, detail: `The prompt-to-part server didn't answer: ${e.message}` })).finally(() => setChecking(false));
  };
  useEffect(() => {
    check(false);
    const t = setInterval(() => check(false), 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  const wasGenerating = useRef(generating);
  useEffect(() => {
    if (generating < wasGenerating.current) check(false);
    wasGenerating.current = generating;
  }, [generating]);
  const state = checking && !conn ? 'checking' : !conn?.ok ? 'bad' : 'ok';
  const extra = conn?.credit != null ? `$${conn.credit.toFixed(2)}` : '';
  return (
    <button className={`conn-chip ${state}`} onClick={() => check(true)} disabled={checking}
      title={`${conn ? `${VIA_LABEL[conn.via]}: ${conn.detail}` : 'Checking the connection…'} Click to check again.`}>
      {/* A phone shows the dot and the credit (the rest is in the tooltip). */}
      <span className="conn-dot" /> <span className="conn-via">{conn ? VIA_LABEL[conn.via] : 'Checking…'}{extra && ' · '}</span>{extra && <span className="conn-extra">{extra}</span>}
    </button>
  );
}
