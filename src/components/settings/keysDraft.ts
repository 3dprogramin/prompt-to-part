// Every decision of the Keys and services tab, kept apart from the markup: what is staged, what Save
// sends, what Reset changes and what the tab says about it. A typed key lives only in the Draft.
import type { Connection } from '../../../shared/api';
import { CLAUDE_VIA, SETTINGS, cleanSettingValue, settingProblem, type ClaudeVia, type SettingRow, type SettingsChange } from '../../../shared/settings';

/** What the user has changed and not saved: env to the new value, or null for back to .env. */
export type Draft = Record<string, string | null>;

const defOf = (env: string) => SETTINGS.find((d) => d.env === env);
const labelOf = (env: string) => defOf(env)?.label ?? env;

/** The tab's rows: a row holds one setting, or a few that belong together (each with its own label). */
export interface KeyRow { label: string; hint?: string; envs: string[] }
export const KEY_ROWS: KeyRow[] = [
  { label: 'Claude runs on', envs: ['PTP_CLAUDE'] },
  { label: 'Subscription token', envs: ['CLAUDE_CODE_OAUTH_TOKEN'] },
  { label: 'Anthropic API key', envs: ['ANTHROPIC_API_KEY'] },
  { label: 'OpenRouter key', hint: 'Also pictures and product photos.', envs: ['OPENROUTER_API_KEY'] },
  { label: 'Other provider token', envs: ['ANTHROPIC_AUTH_TOKEN'] },
  { label: 'Other provider address', envs: ['ANTHROPIC_BASE_URL'] },
  { label: 'Meshy key', hint: '3D figures.', envs: ['MESHY_API_KEY'] },
  { label: 'ElevenLabs key', hint: 'Dictation.', envs: ['ELEVENLABS_API_KEY'] },
  { label: 'Chat starts with', hint: 'For a new chat; the chat can still pick another.', envs: ['PTP_MODEL', 'PTP_EFFORT'] },
  { label: 'Picture model, fallback', hint: 'OpenRouter models for pictures.', envs: ['PTP_IMAGE_MODEL', 'PTP_IMAGE_FALLBACK'] },
  { label: 'Currency, country', hint: 'Cost tab and price suggestion.', envs: ['PTP_CURRENCY', 'PTP_COUNTRY'] },
  { label: 'Back text', envs: ['PTP_BACK_TEXT'] },
];

/** The names of the "Claude runs on" choices. */
export const VIA_NAMES: Record<ClaudeVia, string> = { subscription: 'Subscription', anthropic: 'Anthropic key', openrouter: 'OpenRouter', custom: 'Other provider' };

export function isDirty(draft: Draft): boolean {
  return Object.keys(draft).length > 0;
}

/** Problems per env for the draft (settingProblem on the cleaned value; an emptied secret is no problem: it means not set here). */
export function draftProblems(draft: Draft): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [env, raw] of Object.entries(draft)) {
    const def = defOf(env);
    if (!def || raw === null) continue;
    const v = cleanSettingValue(raw);
    const problem = v ? settingProblem(def, v) : undefined;
    if (problem) out[env] = problem;
  }
  return out;
}

/** The change to send: cleaned values, empty strings turned into null, rows equal to what is already saved here left out. */
export function toChange(draft: Draft, rows: SettingRow[]): SettingsChange {
  const out: SettingsChange = {};
  for (const [env, raw] of Object.entries(draft)) {
    if (raw === null) { out[env] = null; continue; }
    const v = cleanSettingValue(raw);
    const row = rows.find((r) => r.env === env);
    if (v && row?.source === 'here' && row.value === v) continue;
    out[env] = v || null;
  }
  return out;
}

/** The rows Reset would change, by label, for the confirmation text. */
export function resetList(rows: SettingRow[]): string[] {
  return rows.filter((r) => r.source === 'here').map((r) => labelOf(r.env));
}

/** The source label of a row: 'set here', '.env' or 'not set'. */
export function sourceLabel(row: SettingRow): string {
  return row.source === 'here' ? 'set here' : row.source === 'env' ? '.env' : 'not set';
}

/** The badge a row shows: its source label, except the Claude choice while it is Automatic (its hint says that). */
export function sourceBadge(row: SettingRow, draft: Draft): string | undefined {
  return row.env === 'PTP_CLAUDE' && row.source === 'unset' && !(row.env in draft) ? undefined : sourceLabel(row);
}

/** Save is possible with a change that has no problem. */
export function canSave(draft: Draft): boolean {
  return isDirty(draft) && !Object.keys(draftProblems(draft)).length;
}

/**
 * The draft after typing `value` into a row. Typing back what the row shows stages nothing, and so does
 * emptying a new key (the row keeps its key); an emptied text row stages "not set here".
 */
export function stage(draft: Draft, row: SettingRow, value: string): Draft {
  const { [row.env]: _, ...rest } = draft;
  const unchanged = defOf(row.env)?.kind === 'secret' ? value === '' : value === (row.value ?? '');
  return unchanged ? rest : { ...rest, [row.env]: value };
}

/** The draft without a row's change. */
export function unstage(draft: Draft, env: string): Draft {
  const { [env]: _, ...rest } = draft;
  return rest;
}

/** What a staged row says next to its source: nothing when nothing is staged (an emptied row goes back to .env). */
export function pendingLabel(staged: string | null | undefined): string | undefined {
  if (staged === undefined) return undefined;
  return staged === null || !cleanSettingValue(staged) ? 'Back to .env on Save' : 'Not saved yet';
}

const isVia = (v: string | null | undefined): v is ClaudeVia => CLAUDE_VIA.includes(v as ClaudeVia);

/** The "Claude runs on" choice to show checked: the staged one, else the saved one; null for none. */
export function claudeShown(row: SettingRow, draft: Draft): ClaudeVia | null {
  if (row.env in draft) return isVia(draft[row.env]) ? draft[row.env] as ClaudeVia : null;
  return isVia(row.value) ? row.value : null;
}

/** With no choice here or in .env: says it is Automatic and what the server inferred from the keys. */
export function claudeHint(row: SettingRow, via: ClaudeVia | null, draft: Draft): string | undefined {
  if (row.source !== 'unset' || row.env in draft) return undefined;
  return via ? `Automatic: no choice is saved, so it follows the keys that are set and runs on ${VIA_NAMES[via]}.`
    : 'Automatic: no choice is saved, and there is no key to run Claude on yet.';
}

/** What a connection check cannot prove: for the subscription and another provider, only that the service answers. */
export function checkScope(via: Connection['via']): string | undefined {
  return via === 'subscription' || via === 'custom' ? 'This check only shows that the service answers, not that the sign-in works.' : undefined;
}

/** The note by Save while replies are running. */
export function runningNote(running: number): string | undefined {
  if (running <= 0) return undefined;
  return running === 1 ? '1 reply is running: it keeps the sign-in it started with.' : `${running} replies are running: they keep the sign-in they started with.`;
}

/** Reset's confirmation: what goes back to .env, by label. */
export function resetQuestion(rows: SettingRow[], dirty: boolean): string {
  return `These go back to .env: ${resetList(rows).join(', ')}.${dirty ? ' The changes you have not saved are dropped too.' : ''} Reset to defaults?`;
}

/** Asked before closing the dialog or leaving the tab with a draft. */
export const DISCARD_QUESTION = 'Discard the changes you have not saved?';
