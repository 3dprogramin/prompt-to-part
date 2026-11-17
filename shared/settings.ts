// The settings the app lets its owner change (keys, services, a few defaults): each one is an
// environment variable, and a value set in the app is laid over the environment's own (server/settings.ts).
import { parseCurrency } from './cost';
import { BACK_TEXT_MAX_LENGTH } from './backText';

export type SettingKind = 'secret' | 'text' | 'choice';
export interface SettingDef { env: string; kind: SettingKind; label: string; hint?: string; choices?: string[]; maxLength?: number; restricted?: boolean }

/** How Claude runs: on a subscription, an Anthropic key, OpenRouter or another Anthropic-compatible provider. */
export type ClaudeVia = 'subscription' | 'anthropic' | 'openrouter' | 'custom';
export const CLAUDE_VIA: ClaudeVia[] = ['subscription', 'anthropic', 'openrouter', 'custom'];

/** In the dialog's row order. */
export const SETTINGS: SettingDef[] = [
  { env: 'PTP_CLAUDE', kind: 'choice', label: 'How Claude runs', choices: CLAUDE_VIA },
  { env: 'CLAUDE_CODE_OAUTH_TOKEN', kind: 'secret', label: 'Subscription token', hint: 'Made with claude setup-token.' },
  { env: 'ANTHROPIC_API_KEY', kind: 'secret', label: 'Anthropic key' },
  { env: 'OPENROUTER_API_KEY', kind: 'secret', label: 'OpenRouter key' },
  { env: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', label: 'Other provider token' },
  { env: 'ANTHROPIC_BASE_URL', kind: 'text', label: 'Other provider address', hint: 'An https:// address.', restricted: true },
  { env: 'MESHY_API_KEY', kind: 'secret', label: 'Meshy key' },
  { env: 'ELEVENLABS_API_KEY', kind: 'secret', label: 'ElevenLabs key' },
  { env: 'PTP_MODEL', kind: 'text', label: 'Model', maxLength: 100 },
  { env: 'PTP_EFFORT', kind: 'choice', label: 'Effort', choices: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { env: 'PTP_IMAGE_MODEL', kind: 'text', label: 'Picture model', maxLength: 100 },
  { env: 'PTP_IMAGE_FALLBACK', kind: 'text', label: 'Fallback picture model', maxLength: 100 },
  { env: 'PTP_CURRENCY', kind: 'text', label: 'Currency', hint: 'A three-letter code such as USD, EUR or RON.' },
  { env: 'PTP_COUNTRY', kind: 'text', label: 'Country', maxLength: 60 },
  { env: 'PTP_BACK_TEXT', kind: 'text', label: 'Back text', hint: 'Printed mirrored on the back of LayerTone prints.', maxLength: BACK_TEXT_MAX_LENGTH },
];

export interface SettingRow { env: string; source: 'here' | 'env' | 'unset'; value?: string; preview?: string; editable: boolean; lockedReason?: string }
/** env name to new value; null means back to the environment's own value. */
export type SettingsChange = Record<string, string | null>;

const SECRET_MAX_LENGTH = 500;

/** A secret's preview: never more than a third of it, and nothing of a short one. */
export function maskSecret(v: string): string {
  if (v.length < 12) return '••••';
  const part = Math.floor(v.length / 6);
  return `${v.slice(0, Math.min(6, part))}…${v.slice(v.length - Math.min(4, part))}`;
}

/** A pasted value without the spaces, line break or one pair of quotes around it ('' means not set). */
export function cleanSettingValue(raw: string): string {
  const v = raw.trim();
  const quoted = v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0];
  return (quoted ? v.slice(1, -1) : v).trim();
}

/** What is wrong with a cleaned, non-empty value, or undefined. Never contains the value (it may be a key). */
export function settingProblem(def: SettingDef, value: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const control = /[\x00-\x1f\x7f]/.test(value);
  if (def.kind === 'secret') {
    if (value.length > SECRET_MAX_LENGTH) return `${def.label} is too long (at most ${SECRET_MAX_LENGTH} characters).`;
    if (control || /\s/.test(value)) return `${def.label} cannot contain spaces or line breaks.`;
    return undefined;
  }
  if (control) return `${def.label} cannot contain line breaks or control characters.`;
  if (def.choices && !def.choices.includes(value)) return `${def.label} must be one of: ${def.choices.join(', ')}.`;
  if (def.maxLength !== undefined && value.length > def.maxLength) return `${def.label} can be at most ${def.maxLength} characters.`;
  if (def.env === 'PTP_CURRENCY' && !parseCurrency(value)) return `${def.label} must be a three-letter code such as USD, EUR or RON.`;
  if (def.env === 'ANTHROPIC_BASE_URL' && !isHttpsUrl(value)) return `${def.label} must be an https:// address.`;
  return undefined;
}

function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}
