// Settings from the environment, read once. Paths are resolved from the app's folder rather than the
// working directory, so the server also works when started from somewhere else.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CURRENCY, parseCurrency } from '../shared/cost';
import { BACK_TEXT_MAX_LENGTH } from '../shared/backText';
import { cleanAppBuild, type AppBuild } from '../shared/appBuild';
import { CLAUDE_VIA, type ClaudeVia } from '../shared/settings';

export type { ClaudeVia };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Secrets such as ELEVENLABS_API_KEY can live in .env next to package.json (git ignores it);
// variables already set in the environment win.
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
/** The build this server runs: the package.json version and, when known, the commit (PTP_COMMIT, set by the Docker build). */
export const APP_BUILD: AppBuild = cleanAppBuild({ version: JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, commit: process.env.PTP_COMMIT }) ?? { version: 'unknown' };
export const PORT = Number(process.env.PORT ?? 8787);
/** The address the server listens on: this computer only, unless PTP_HOST says otherwise (0.0.0.0 in the Docker image). */
export const HOST = process.env.PTP_HOST?.trim() || '127.0.0.1';
/** More names the app answers to besides localhost (PTP_HOSTS, comma-separated), e.g. this computer's address on the network for a phone. */
export const EXTRA_HOSTS = (process.env.PTP_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
/**
 * Public addresses the app is reached on through an HTTPS reverse proxy (PTP_ORIGINS, comma-separated,
 * e.g. https://ptp.example.com). Only what the operator lists is trusted: the Host and Origin checks
 * never read X-Forwarded-* headers, which any client can send.
 */
export const EXTRA_ORIGINS = (process.env.PTP_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
/**
 * The password the app asks for (HTTP Basic auth, any user name) on every page and API call, or '' for
 * none. Off by default (the app on this computer only); set PTP_PASSWORD when it is reachable from a network.
 */
export const PASSWORD = process.env.PTP_PASSWORD ?? '';
/** Most replies worked on at once, over all designs (PTP_MAX_GENERATIONS, default 4). */
export const MAX_GENERATIONS = positiveInt(process.env.PTP_MAX_GENERATIONS) ?? 4;
/** Designs, workspaces and the Bambu template cache. */
export const DATA_DIR = process.env.PTP_DATA ? path.resolve(process.env.PTP_DATA) : path.join(ROOT, 'data');
/** Serve the built app from dist/ as well as the API (`pnpm start`). */
export const PRODUCTION = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
/**
 * How the app runs Claude (read when it is needed, so a changed environment counts):
 * - 'subscription': the Claude account the `claude` CLI is logged in with, or the long-lived token in
 *   CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`, how the Docker image signs in), only for your own
 *   use on your own computer (see the README);
 * - 'anthropic': ANTHROPIC_API_KEY (or, inferred, ANTHROPIC_AUTH_TOKEN) at Anthropic;
 * - 'openrouter': OPENROUTER_API_KEY through OpenRouter's Anthropic-compatible endpoint;
 * - 'custom': ANTHROPIC_AUTH_TOKEN at another Anthropic-compatible provider, ANTHROPIC_BASE_URL.
 * PTP_CLAUDE names one outright (the Settings dialog sets it). Without it the mode is inferred from what
 * is set: PTP_AUTH=subscription; else OpenRouter when its key is the only one (an Anthropic key or token
 * wins, and OpenRouter is then used for artwork only); else another provider when ANTHROPIC_BASE_URL is
 * set to an address other than Anthropic's; else Anthropic. null: nothing to run Claude on.
 */
export function claudeVia(): ClaudeVia | null {
  if (claudeViaChosen()) return process.env.PTP_CLAUDE!.trim() as ClaudeVia;
  if (process.env.PTP_AUTH === 'subscription') return 'subscription';
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return process.env.OPENROUTER_API_KEY ? 'openrouter' : null;
  const base = claudeBaseUrl();
  return base && !/^https:\/\/api\.anthropic\.com$/.test(base) ? 'custom' : 'anthropic';
}

/** True when PTP_CLAUDE names the mode (rather than it being inferred). */
export const claudeViaChosen = () => CLAUDE_VIA.includes(process.env.PTP_CLAUDE?.trim() as ClaudeVia);

/** ANTHROPIC_BASE_URL without surrounding spaces or a trailing slash, or '' when unset. */
export const claudeBaseUrl = () => process.env.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, '') ?? '';

/** 'subscription', or 'api-key' for every way that runs on a key or token (and for none). */
export function authMode(): 'api-key' | 'subscription' {
  return claudeVia() === 'subscription' ? 'subscription' : 'api-key';
}

/** Claude through OpenRouter (and the model menu offers OpenRouter's models). */
export function claudeViaOpenRouter(): boolean {
  return claudeVia() === 'openrouter';
}

const FIX_IN_SETTINGS = 'Open Settings (the gear) to fix it.';

/** Why the app can't run Claude as configured, or null. Without a key it never falls back to the CLI's login. */
export function claudeAuthProblem(): string | null {
  const via = claudeVia();
  if (via === 'subscription') {
    // A container has no `claude` login of its own: it needs the long-lived token from `claude setup-token`
    // (or a login made inside it, kept in the CLAUDE_CONFIG_DIR volume).
    const credentials = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
    if (process.env.PTP_DOCKER && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !existsSync(credentials)) {
      return claudeViaChosen()
        ? `prompt-to-part runs in Docker on your Claude subscription but has no login: run \`claude setup-token\` on your computer and save the token as the subscription token (CLAUDE_CODE_OAUTH_TOKEN). ${FIX_IN_SETTINGS} See docs/running.md.`
        : 'prompt-to-part runs in Docker on your Claude subscription (PTP_AUTH=subscription) but has no login: run `claude setup-token` on your computer, put the token in .env as CLAUDE_CODE_OAUTH_TOKEN and restart prompt-to-part (docker compose up -d), or open Settings (the gear) and save it there. See docs/running.md.';
    }
    return null;
  }
  if (claudeViaChosen()) {
    if (via === 'anthropic' && !process.env.ANTHROPIC_API_KEY) return `prompt-to-part is set to run Claude on an Anthropic API key, but ANTHROPIC_API_KEY is not set. ${FIX_IN_SETTINGS}`;
    if (via === 'openrouter' && !process.env.OPENROUTER_API_KEY) return `prompt-to-part is set to run Claude through OpenRouter, but OPENROUTER_API_KEY is not set. ${FIX_IN_SETTINGS}`;
    if (via === 'custom') {
      const missing = [!process.env.ANTHROPIC_AUTH_TOKEN && 'no token (ANTHROPIC_AUTH_TOKEN)', !claudeBaseUrl() && 'no address (ANTHROPIC_BASE_URL)'].filter(Boolean);
      if (missing.length) return `prompt-to-part is set to run Claude on another provider, but it has ${missing.join(' and ')}. ${FIX_IN_SETTINGS}`;
    }
    return null;
  }
  if (via) return null;
  return 'No Claude API key: set OPENROUTER_API_KEY or ANTHROPIC_API_KEY (in .env or the environment) and restart prompt-to-part, or open Settings (the gear). See "Claude API key" in docs/configuration.md.';
}

/** What to tell the user when the Claude API refuses the app's API key or token (HTTP 401 or 403). */
export function claudeKeyRefused(status?: number): string {
  const code = status ? ` (HTTP ${status})` : '';
  const via = claudeVia();
  if (via === 'openrouter') return `OpenRouter refused the key in OPENROUTER_API_KEY${code}: it may be wrong, revoked or out of credit. Check it in Settings.`;
  // Inferred, a token wins the message whenever one is set, as it did before PTP_CLAUDE.
  const token = claudeViaChosen() ? via === 'custom' : !!process.env.ANTHROPIC_AUTH_TOKEN;
  if (token) return `${(claudeViaChosen() ? claudeBaseUrl() : process.env.ANTHROPIC_BASE_URL) || 'The API'} refused the token in ANTHROPIC_AUTH_TOKEN${code}. Check it in Settings.`;
  return `Anthropic refused the key in ANTHROPIC_API_KEY${code}: it may be wrong or revoked (see platform.claude.com). Check it in Settings.`;
}

/** The currency costs and price suggestions are in (PTP_CURRENCY, e.g. USD, EUR, RON; US dollars by default). */
export const appCurrency = () => parseCurrency(process.env.PTP_CURRENCY) ?? DEFAULT_CURRENCY;
/** Where the maker sells, for the price suggestion (PTP_COUNTRY, e.g. Romania), or '' for no country. */
export const appCountry = () => (process.env.PTP_COUNTRY ?? '').trim().slice(0, 60);

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The chat's starting model (PTP_MODEL: fable, opus, sonnet, haiku or a full model ID such as claude-opus-5-5). */
export const defaultModel = () => process.env.PTP_MODEL?.trim() || 'fable';
/**
 * The model Claude Code is asked for. Its own names (opus, sonnet, haiku) and full IDs go as they
 * are; fable goes by its ID, because the bundled Claude Code's "fable" is still an older one.
 */
export const claudeModel = (model: string) => (model === 'fable' ? 'claude-fable-5-2' : model);
/** The chat's starting reasoning effort (PTP_EFFORT). */
export const defaultEffort = () => (EFFORTS.includes(process.env.PTP_EFFORT?.trim() ?? '') ? process.env.PTP_EFFORT!.trim() : 'high');

/** A whole number of at least 1 from an environment variable, or null when unset or not one. */
function positiveInt(v: string | undefined): number | null {
  const n = Number(v?.trim() || NaN);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** The text printed mirrored on the back of every LayerTone print (PTP_BACK_TEXT); empty turns it off. */
export const backText = () => (process.env.PTP_BACK_TEXT ?? '').trim().slice(0, BACK_TEXT_MAX_LENGTH);
