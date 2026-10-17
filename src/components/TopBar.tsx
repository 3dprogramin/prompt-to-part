import { useRef, useState } from 'react';
import type { Design, DesignSummary } from '../../shared/types';
import { Icon } from './Icon';
import { DesignTabs, type DesignTab } from './DesignTabs';
import { VersionMenu } from './VersionMenu';
import { usePopover } from './usePopover';

interface Props {
  design: Design;
  onRename: (name: string) => void;
  onRestore: (versionIndex: number) => void;
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
  onDelete: (id: string) => void;
}

/** Logo, design name, versions, open designs and the Designs menu. */
export function TopBar(p: Props) {
  const [showList, setShowList] = useState(false);
  const listWrap = useRef<HTMLDivElement>(null);
  usePopover(showList, () => setShowList(false), listWrap);
  const open = (id: string) => { setShowList(false); p.onOpen(id); };
  return (
    <header className="topbar">
      {/* A real link, so it can be opened in a new tab; a plain click starts a new design in place. */}
      <a className="brand" href="/" title="New design" onClick={(e) => { if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); p.onNew(); } }}>
        <span className="logo"><Icon name="cube" size={18} /></span> Jig
      </a>
      {/* As wide as the name (CSS field-sizing, or this width where that isn't supported), so the
          version menu sits right after it. */}
      <input className="design-name" aria-label="Design name" value={p.design.name} onChange={(e) => p.onRename(e.target.value)}
        style={{ '--name-chars': p.design.name.length } as React.CSSProperties} />
      {p.design.versions.length > 0 && <VersionMenu versions={p.design.versions} current={p.design.currentVersion} onRestore={p.onRestore} />}
      {p.unsavedSettings && (
        <button className="btn save-settings" onClick={p.onSaveSettings} title="Your slider, scale, text or print changes are not saved in any version yet – save them as a new version">
          <Icon name="save" size={13} /> Save as v{p.design.versions.length + 1}
        </button>
      )}
      {p.saveError && (
        <button
          className="btn save-error"
          onClick={p.onRetrySave}
          title={`Your latest changes are not saved: ${p.saveError}. ${/X-Jig/.test(p.saveError) ? 'This page is older than the server – reload it.' : 'Click to try again.'}`}
        >
          <Icon name="alert" size={13} /> Not saved – retry
        </button>
      )}
      {p.tabs.length > 1 ? <DesignTabs tabs={p.tabs} current={p.design.id} onOpen={p.onOpen} onClose={p.onCloseTab} /> : <span className="spacer" />}
      {p.tabs.filter((t) => !t.running).length > 1 && (
        <button className="btn ghost close-all" onClick={p.onCloseAllTabs} title="Close all tabs (designs Claude is working on stay open; nothing is deleted)">
          <Icon name="x" size={13} /> Close all
        </button>
      )}
      <button className="btn ghost" onClick={p.onNew}><Icon name="plus" size={14} /> New</button>
      <div className="menu-wrap" ref={listWrap}>
        <button className="btn ghost" aria-haspopup="menu" aria-expanded={showList} onClick={() => { p.onRefreshList(); setShowList(!showList); }}><Icon name="folder" size={14} /> Designs</button>
        {showList && (
          <div className="menu">
            {p.listError
              ? <div className="menu-empty">Could not load your designs: {p.listError} <button className="link" onClick={p.onRefreshList}>Try again</button></div>
              : p.designs.length === 0 && <div className="menu-empty">No saved designs yet</div>}
            {p.designs.map((d) => (
              <div key={d.id} className={`menu-item ${d.id === p.design.id ? 'on' : ''}`}>
                <button className="menu-open" onClick={() => open(d.id)}>
                  <span>{p.isRunning(d.id) && <span className="spinner" />} {d.name}</span>
                  <span className="dim small">{new Date(d.updatedAt).toLocaleString()} · {d.versions} versions</span>
                </button>
                <button className="icon-btn" title="Delete" aria-label={`Delete ${d.name}`} onClick={() => p.onDelete(d.id)}><Icon name="trash" size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
