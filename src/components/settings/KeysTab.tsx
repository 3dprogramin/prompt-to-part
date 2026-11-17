// The Keys and services tab of Settings: every key masked, changed and saved together with Save, or
// reset to .env. All its decisions are in keysDraft.ts; a typed key lives only in this tab's draft.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Connection, SettingsView } from '../../../shared/api';
import { CLAUDE_VIA, SETTINGS, type ClaudeVia, type SettingDef, type SettingRow } from '../../../shared/settings';
import { api } from '../../lib/api';
import { VIA_LABEL } from '../TopBar';
import { canSave, checkScope, claudeHint, claudeShown, draftProblems, isDirty, KEY_ROWS, pendingLabel, resetList, resetQuestion, runningNote, sourceBadge, stage, toChange, unstage, VIA_NAMES, type Draft, type KeyRow } from './keysDraft';

interface Props {
  /** Set while the tab is open: whether it has changes not saved (the dialog asks before they are lost). */
  dirtyRef: React.RefObject<(() => boolean) | null>;
  /** The settings were saved or reset: the page reads again what it read at load. */
  onSaved: () => void;
  /** A fresh connection check ran: the chip in the top bar shows it too. */
  onChecked: () => void;
  /** The dialog's footer, next to Close: Save, Reset and their notes go there, so they never scroll out of view. */
  footer: HTMLElement | null;
}

const defOf = (env: string) => SETTINGS.find((d) => d.env === env) as SettingDef;

export function KeysTab({ dirtyRef, onSaved, onChecked, footer }: Props) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  // The keys whose "Change" or "Add" was clicked: they show an empty input.
  const [editing, setEditing] = useState<string[]>([]);
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [conn, setConn] = useState<Connection | null>(null);
  const [checking, setChecking] = useState(false);
  const checks = useRef(0);
  dirtyRef.current = () => isDirty(draft);
  useEffect(() => () => { dirtyRef.current = null; }, [dirtyRef]);

  /** Only the newest check shows; a fresh one is passed on to the chip. */
  const check = async (fresh: boolean) => {
    const n = ++checks.current;
    setChecking(true);
    let c: Connection;
    try { c = await api.connection(fresh); } catch (e) { c = { via: 'none', ok: false, detail: `The prompt-to-part server didn't answer: ${(e as Error).message}` }; }
    if (n !== checks.current) return;
    setConn(c);
    setChecking(false);
    if (fresh) onChecked();
  };
  useEffect(() => {
    api.settings().then(setView, (e: Error) => setLoadError(`The settings could not be read: ${e.message}`));
    void check(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = view?.rows ?? [];
  const rowOf = (env: string) => rows.find((r) => r.env === env) ?? { env, source: 'unset', editable: true } as SettingRow;
  const problems = draftProblems(draft);
  const dirty = isDirty(draft);

  const set = (row: SettingRow, value: string) => setDraft((d) => stage(d, row, value));
  const undo = (env: string) => {
    setDraft((d) => unstage(d, env));
    if (editing.includes(env)) {
      setEditing((e) => e.filter((x) => x !== env));
      // Focus goes back to the row's Change or Add button.
      requestAnimationFrame(() => document.getElementById(`keys-${env}-edit`)?.focus());
    }
  };
  const done = (next: SettingsView, text: string) => {
    setView(next);
    setDraft({});
    setEditing([]);
    setNote({ text });
    onSaved();
  };
  const save = async () => {
    setBusy('save');
    setNote(null);
    try {
      done(await api.saveSettings(toChange(draft, rows)), 'Saved.');
    } catch (e) {
      setNote({ text: `Not saved: ${(e as Error).message}`, error: true });
      return;
    } finally { setBusy(null); }
    await check(true);
  };
  const reset = async () => {
    if (!window.confirm(resetQuestion(rows, dirty))) return;
    setBusy('reset');
    setNote(null);
    try {
      done(await api.resetSettings(), 'Everything comes from .env again.');
    } catch (e) {
      setNote({ text: `Not reset: ${(e as Error).message}`, error: true });
      return;
    } finally { setBusy(null); }
    await check(true);
  };

  // Save and Reset are in the dialog's footer from the start, and only marked disabled (aria-disabled), so
  // focus stays on them while they run and after (the result line is announced instead).
  const saveOn = !!view && canSave(draft) && !busy;
  const resetOn = !!view && resetList(rows).length > 0 && !busy;
  const running = view ? runningNote(view.running) : undefined;
  const actions = footer && createPortal(
    <>
      <div className="keys-footer-notes">
        <p className="small dim keys-saved" role="status">{note && !note.error ? note.text : ''}</p>
        {note?.error && <p className="small warn-note" role="alert">{note.text}</p>}
        {running && <p className="small warn-note" id="keys-running">{running}</p>}
      </div>
      <button type="button" className="btn ghost" aria-disabled={!resetOn} onClick={() => { if (resetOn) void reset(); }}>{busy === 'reset' ? 'Resetting…' : 'Reset to defaults'}</button>
      <button type="button" className="btn primary" aria-disabled={!saveOn} aria-describedby={running ? 'keys-running' : undefined} onClick={() => { if (saveOn) void save(); }}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
    </>,
    footer,
  );

  if (!view) return <>{loadError ? <p className="small warn-note" role="alert">{loadError}</p> : <p className="dim">Loading the settings…</p>}{actions}</>;

  /** The source, what is staged, and the row's buttons. */
  const status = (row: SettingRow, def: SettingDef, open: boolean) => {
    const staged = draft[row.env];
    return (
      <span className="keys-status">
        {sourceBadge(row, draft) && <span className={`keys-src ${row.source === 'here' ? 'here' : ''}`}>{sourceBadge(row, draft)}</span>}
        {pendingLabel(staged) && <span className="keys-pending">{pendingLabel(staged)}</span>}
        {open ? <button type="button" className="btn ghost small" aria-label={`Cancel the new ${def.label}`} onClick={() => undo(row.env)}>Cancel</button>
          : staged !== undefined ? <button type="button" className="btn ghost small" aria-label={`Undo the ${def.label} change`} onClick={() => undo(row.env)}>Undo</button>
          : row.source === 'here' && <button type="button" className="btn ghost small" aria-label={`${def.label}: back to .env`} onClick={() => setDraft((d) => ({ ...d, [row.env]: null }))}>Back to .env</button>}
      </span>
    );
  };

  const field = (env: string, labelled: string | null) => {
    const def = defOf(env);
    const row = rowOf(env);
    const staged = draft[env];
    const id = `keys-${env}`;
    const problem = problems[env];
    const describedBy = [def.hint && `${id}-hint`, problem && `${id}-err`, !row.editable && `${id}-lock`].filter(Boolean).join(' ') || undefined;
    // A one-setting row is labelled by the row's own label; a row of a few labels each of them.
    const ownLabel = labelled ? null : <label className="keys-field-label" htmlFor={id}>{def.label}</label>;
    let control: React.ReactNode;
    let open = false;

    if (env === 'PTP_CLAUDE') {
      const shown = claudeShown(row, draft);
      const pick = (via: ClaudeVia, focus: boolean) => {
        set(row, via);
        if (focus) document.getElementById(`${id}-${via}`)?.focus();
      };
      const onKey = (e: React.KeyboardEvent) => {
        const at = CLAUDE_VIA.indexOf(shown ?? CLAUDE_VIA[0]);
        const n = CLAUDE_VIA.length;
        const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (at + 1) % n : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at - 1 + n) % n : -1;
        if (to < 0) return;
        e.preventDefault();
        pick(CLAUDE_VIA[to], true);
      };
      control = (
        <div className="seg keys-seg" role="radiogroup" aria-labelledby={labelled ?? undefined} aria-describedby={[`${id}-auto`, describedBy].filter(Boolean).join(' ')} onKeyDown={onKey}>
          {CLAUDE_VIA.map((via) => (
            <button key={via} id={`${id}-${via}`} type="button" role="radio" aria-checked={shown === via} className={shown === via ? 'on' : ''}
              tabIndex={(shown ?? CLAUDE_VIA[0]) === via ? 0 : -1} disabled={!row.editable} onClick={() => pick(via, false)}>{VIA_NAMES[via]}</button>
          ))}
        </div>
      );
    } else if (!row.editable) {
      control = <span className="keys-value" id={id}>{row.value ?? 'not set'}</span>;
    } else if (def.kind === 'secret') {
      open = editing.includes(env) || typeof staged === 'string';
      control = open
        ? <input id={id} className="text-input" type="password" autoComplete="off" spellCheck={false} autoFocus placeholder={`The new ${def.label}`}
            value={staged ?? ''} aria-invalid={!!problem} aria-describedby={describedBy} onChange={(e) => set(row, e.target.value)} />
        : (
          <>
            <span className="keys-value keys-masked" id={id}>{row.preview ?? 'not set'}</span>
            <button type="button" id={`${id}-edit`} className="btn small" aria-label={`${row.preview ? 'Change' : 'Add'} ${def.label}`}
              onClick={() => setEditing((e) => [...e, env])}>{row.preview ? 'Change' : 'Add'}</button>
          </>
        );
    } else if (def.choices) {
      const value = staged === null ? '' : staged ?? row.value ?? '';
      control = (
        <select id={id} value={value} aria-invalid={!!problem} aria-describedby={describedBy} onChange={(e) => set(row, e.target.value)}>
          {!value && <option value="">not set</option>}
          {def.choices.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      );
    } else {
      control = <input id={id} className="text-input" type="text" spellCheck={false} placeholder={env === 'ANTHROPIC_BASE_URL' ? 'https://…' : 'not set'}
        value={staged === null ? '' : staged ?? row.value ?? ''} aria-invalid={!!problem} aria-describedby={describedBy} onChange={(e) => set(row, e.target.value)} />;
    }

    return (
      <div key={env} className="keys-field">
        {ownLabel}
        {env === 'PTP_CLAUDE' ? (
          // The choice fills its line: its source and buttons go on the line under it, beside the hint.
          <>
            <div className="keys-control">{control}</div>
            <div className="keys-control"><p className="dim small keys-claude-hint" id={`${id}-auto`}>{claudeHint(row, view.via, draft) ?? ''}</p>{status(row, def, open)}</div>
          </>
        ) : <div className="keys-control">{control}{status(row, def, open)}</div>}
        {def.hint && <p className="dim small" id={`${id}-hint`}>{def.hint}</p>}
        {!row.editable && row.lockedReason && <p className="dim small" id={`${id}-lock`}>{row.lockedReason}</p>}
        {problem && <p className="small warn-note" id={`${id}-err`} role="alert">{problem}</p>}
      </div>
    );
  };

  const keyRow = (r: KeyRow) => {
    const single = r.envs.length === 1;
    const labelId = `keys-row-${r.envs[0]}`;
    // A single input is labelled by the row's label; the masked view of a key and the Claude choice have no input.
    const env = r.envs[0];
    const hasInput = single && env !== 'PTP_CLAUDE' && rowOf(env).editable && (defOf(env).kind !== 'secret' || editing.includes(env) || typeof draft[env] === 'string');
    return (
      <div key={r.label} className="keys-row">
        <div className="keys-label">
          {hasInput ? <label id={labelId} htmlFor={`keys-${env}`}>{r.label}</label> : <span id={labelId}>{r.label}</span>}
          {r.hint && <small>{r.hint}</small>}
        </div>
        <div className="keys-fields">{r.envs.map((e) => field(e, single ? labelId : null))}</div>
      </div>
    );
  };

  const scope = conn && checkScope(conn.via);
  return (
    <div className="keys-tab">
      <fieldset className="keys-rows" disabled={!!busy}>
        <legend className="sr-only">Keys and services</legend>
        {KEY_ROWS.map((r) => (
          <div key={r.label} className="keys-group">
            {keyRow(r)}
            {/* What the connection check says, under the rows that decide how Claude runs. */}
            {r.envs[0] === 'ANTHROPIC_BASE_URL' && (
              <div className="keys-row keys-conn">
                <div className="keys-label"><span>Connection</span></div>
                <div className="keys-fields">
                  <div className="keys-control">
                    <p className={`small keys-conn-result ${checking || !conn ? 'dim' : conn.ok ? 'ok' : 'bad'}`} role="status">
                      {checking ? 'Checking the connection…' : conn ? `${VIA_LABEL[conn.via]}: ${conn.detail}` : ''}
                    </p>
                    <button type="button" className="btn ghost small" disabled={checking} aria-label="Check the connection again" onClick={() => void check(true)}>Check again</button>
                  </div>
                  {scope && !checking && <p className="dim small">{scope}</p>}
                </div>
              </div>
            )}
          </div>
        ))}
        <p className="keys-row keys-note dim small">Password, port and network: set in .env; they need a restart.</p>
      </fieldset>
      {actions}
    </div>
  );
}
