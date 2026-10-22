import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connection } from '../../shared/api';
import { currentWindow, formatReset, usageSummary } from '../../shared/usage';
import { api } from '../lib/api';
import type { Design, DesignSummary } from '../../shared/types';
import { DESIGN_KIND_LABEL, type DesignKind } from '../../shared/designKind';
import { Icon } from './Icon';
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
  onNew: () => void;
  designs: DesignSummary[];
  /** Why the design list couldn't be loaded, or null. */
  listError: string | null;
  onRefreshList: () => void;
  isRunning: (id: string) => boolean;
  /** Generations running in this tab: the connection chip rechecks the usage when one ends. */
  generating: number;
  onDelete: (id: string) => void;
  /** A phone's narrow bar: icons for the buttons, no design tabs (Designs lists them), New in the Designs menu. */
  compact?: boolean;
}

/** Each kind's icon, as in the chat's picture menu; a plain parametric model has none. */
const KIND_ICON: Partial<Record<DesignKind, string>> = { lineart: 'lineart', layertone: 'layers', lithophane: 'lamp', figure: 'figure', artwork: 'palette' };

/** A small, quiet icon telling what kind of design it is (nothing for a parametric model). */
function KindIcon({ kind, size }: { kind: DesignKind | undefined; size: number }) {
  const icon = kind && KIND_ICON[kind];
  return icon ? <span className="kind-icon" title={DESIGN_KIND_LABEL[kind]} aria-label={DESIGN_KIND_LABEL[kind]} role="img"><Icon name={icon} size={size} /></span> : null;
}

/** Recent designs the Designs menu lists before "Load more". */
const PAGE = 10;

/** Logo, design name, versions, open designs and the Designs menu. */
export function TopBar(p: Props) {
  const [showList, setShowList] = useState(false);
  const listWrap = useRef<HTMLDivElement>(null);
  usePopover(showList, () => setShowList(false), listWrap);
  const open = (id: string) => { setShowList(false); p.onOpen(id); };
  // The most recent designs, PAGE at a time; starred ones (the important ones) are marked. A star
  // shows at once and stays until the refreshed list arrives.
  const [shown, setShown] = useState(PAGE);
  // Search by name: case and accents don't matter (ș finds s), the matches page like the list.
  const [query, setQuery] = useState('');
  const fold = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const matches = useMemo(() => {
    const q = fold(query.trim());
    return q ? p.designs.filter((d) => fold(d.name).includes(q)) : p.designs;
  }, [p.designs, query]);
  const [starNow, setStarNow] = useState<Record<string, boolean>>({});
  useEffect(() => setStarNow({}), [p.designs]);
  const isStarred = (d: DesignSummary) => starNow[d.id] ?? !!d.starred;
  const star = (d: DesignSummary) => {
    const on = !isStarred(d);
    setStarNow((s) => ({ ...s, [d.id]: on }));
    api.starDesign(d.id, on).catch(() => {}).finally(p.onRefreshList);
  };
  const row = (d: DesignSummary) => (
    <div key={d.id} className={`menu-item ${d.id === p.design.id ? 'on' : ''} ${isStarred(d) ? 'starred' : ''}`}>
      <button className="menu-open" onClick={() => open(d.id)}>
        <span>{p.isRunning(d.id) && <span className="spinner" />} {d.name} <KindIcon kind={d.kind} size={12} /></span>
        <span className="dim small">{new Date(d.updatedAt).toLocaleString()} · {d.versions} {d.versions === 1 ? 'version' : 'versions'}</span>
      </button>
      <button className={`icon-btn menu-star ${isStarred(d) ? 'on' : ''}`} title={isStarred(d) ? 'Unstar' : 'Star: mark it as important'}
        aria-label={`${isStarred(d) ? 'Unstar' : 'Star'} ${d.name}`} aria-pressed={isStarred(d)} onClick={() => star(d)}><Icon name="star" size={14} /></button>
      <button className="icon-btn" title="Delete" aria-label={`Delete ${d.name}`} onClick={() => p.onDelete(d.id)}><Icon name="trash" size={14} /></button>
    </div>
  );
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
  const newHere = (e: React.MouseEvent) => { if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); p.onNew(); } };
  return (
    <header className="topbar">
      {/* Real links (logo and New), so they can be opened in a new tab. */}
      <a className="brand" href="/" title="New design" onClick={newHere}>
        <span className="logo"><Icon name="cube" size={18} /></span> <span className="brand-name">Jig</span>
      </a>
      <span className="app-version" title="Jig version">v{import.meta.env.VITE_APP_VERSION}</span>
      {/* As wide as the name (CSS field-sizing, or this width where that isn't supported), so the
          version menu sits right after it. */}
      <KindIcon kind={p.kind} size={14} />
      <input className="design-name" aria-label="Design name" value={p.design.name} onChange={(e) => p.onRename(e.target.value)}
        style={{ '--name-chars': p.design.name.length } as React.CSSProperties} />
      {p.design.versions.length > 0 && <VersionMenu versions={p.design.versions} current={p.design.currentVersion} onRestore={p.onRestore} onFork={p.onFork} />}
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
        <button className="btn ghost close-all" onClick={p.onCloseAllTabs} title="Close all tabs (designs Jig is working on stay open; nothing is deleted)">
          <Icon name="x" size={13} /> Close all
        </button>
      )}
      <ConnectionChip generating={p.generating} />
      {!p.compact && <a className="btn ghost" href="/" title="New design" onClick={newHere}><Icon name="plus" size={14} /> New</a>}
      <div className="menu-wrap" ref={listWrap}>
        <button className="btn ghost" aria-haspopup="menu" aria-expanded={showList} aria-label="Designs"
          onClick={() => { p.onRefreshList(); if (!importing) setBackupNote(null); setShown(PAGE); setQuery(''); setShowList(!showList); }}><Icon name="folder" size={14} /> <span className="btn-label">Designs</span></button>
        {showList && (
          <div className="menu">
            {p.designs.length > 0 && (
              <div className="menu-search">
                <Icon name="search" size={13} />
                <input autoFocus type="search" placeholder="Search designs" aria-label="Search designs" value={query}
                  onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) open(matches[0].id); }} />
                {query && <button className="icon-btn" title="Clear the search" aria-label="Clear the search" onClick={() => { setQuery(''); setShown(PAGE); }}><Icon name="x" size={12} /></button>}
              </div>
            )}
            {p.listError
              ? <div className="menu-empty">Could not load your designs: {p.listError} <button className="link" onClick={p.onRefreshList}>Try again</button></div>
              : p.designs.length === 0 ? <div className="menu-empty">No saved designs yet</div>
              : matches.length === 0 && <div className="menu-empty">No design's name contains “{query.trim()}”</div>}
            {matches.slice(0, shown).map(row)}
            {matches.length > shown && (
              <button className="menu-more" onClick={() => setShown((n) => n + PAGE)}>Load more ({matches.length - shown} more)</button>
            )}
            <div className="menu-foot">
              {p.compact && (
                <a className="menu-action" href="/" onClick={(e) => { setShowList(false); newHere(e); }}><Icon name="plus" size={13} /> New design</a>
              )}
              {backupNote && (
                <div className={`menu-note ${backupNote.error ? 'error' : ''}`} role="status">
                  {backupNote.text}{backupNote.detail && <div className="dim small">{backupNote.detail}</div>}
                </div>
              )}
              <a className="menu-action" href="/api/backup" download title="Download every design (with its images and meshes) and your cost settings and filaments as one zip">
                <Icon name="download" size={13} /> Export all designs
              </a>
              <button className="menu-action" disabled={importing} onClick={() => backupInput.current?.click()} title="Add the designs from a Jig backup zip (designs already here are kept as they are)">
                {importing ? <span className="spinner" /> : <Icon name="restore" size={13} />} {importing ? 'Importing…' : 'Import designs…'}
              </button>
              <input ref={backupInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importBackup(f); }} />
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

const VIA_LABEL: Record<Connection['via'], string> = {
  subscription: 'Claude subscription',
  openrouter: 'OpenRouter API',
  anthropic: 'Anthropic API',
  custom: 'Custom API',
  none: 'No Claude access',
};

/**
 * What Jig runs Claude on and whether it answers, with the subscription's usage: checked on load,
 * every 5 minutes, on click and when a generation ends.
 */
function ConnectionChip({ generating }: { generating: number }) {
  const [conn, setConn] = useState<Connection | null>(null);
  const [checking, setChecking] = useState(true);
  const check = (fresh: boolean) => {
    setChecking(true);
    api.connection(fresh).then(setConn, (e: Error) => setConn({ via: 'none', ok: false, detail: `Jig's server didn't answer: ${e.message}` })).finally(() => setChecking(false));
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
  const usage = usageSummary(conn?.usage);
  const state = checking && !conn ? 'checking' : !conn?.ok || usage?.level === 'limited' ? 'bad' : usage?.level === 'warn' ? 'warn' : 'ok';
  const extra = conn?.credit != null ? `$${conn.credit.toFixed(2)}`
    : usage?.level === 'limited' ? `limit reached${usage.until ? ` until ${formatReset(usage.until)}` : ''}`
    : usage ? `${Math.round(usage.percent)}%` : '';
  // Which limit the percentage is: the 5-hour one or the weekly one ("7d") can be the nearer.
  const which = conn?.credit == null && usage ? <span className="conn-win" title={usage.window.startsWith('7d') ? 'The weekly limit' : 'The 5-hour limit'}>{usage.window}</span> : null;
  const windows = (conn?.usage ?? []).map((u) => currentWindow(u)).map((w) => `\n${w.label} limit: ${Math.round(w.percent)}% used${w.limited ? ' (reached)' : ''}${w.resetsAt ? `, resets ${formatReset(w.resetsAt)}` : ''}`).join('');
  const asOf = conn?.usage?.length ? `\nUsage as of ${formatReset(Math.max(...conn.usage.map((w) => w.at)))}.` : '';
  return (
    <button className={`conn-chip ${state}`} onClick={() => check(true)} disabled={checking}
      title={`${conn ? `${VIA_LABEL[conn.via]}: ${conn.detail}` : 'Checking the connection…'}${windows || asOf ? `${windows}${asOf}\n` : ' '}Click to check again.`}>
      {/* A phone shows the dot, the percentage and its limit (the rest is in the tooltip). */}
      <span className="conn-dot" /> <span className="conn-via">{conn ? VIA_LABEL[conn.via] : 'Checking…'}{extra && ' · '}</span>{extra && <span className="conn-extra">{extra}</span>}{which}
    </button>
  );
}
