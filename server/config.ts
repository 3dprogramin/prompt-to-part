// Settings from the environment, read once. Paths are resolved from the app's folder rather than the
// working directory, so the server also works when started from somewhere else.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CURRENCY, parseCurrency } from '../shared/cost';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Secrets such as ELEVENLABS_API_KEY can live in .env next to package.json (git ignores it);
// variables already set in the environment win.
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
export const PORT = Number(process.env.PORT ?? 8787);
/** The address the server listens on: this computer only, unless PTP_HOST says otherwise (0.0.0.0 in the Docker image). */
export const HOST = process.env.PTP_HOST?.trim() || '127.0.0.1';
/** More names the app answers to besides localhost (PTP_HOSTS, comma-separated), e.g. this computer's address on the network for a phone. */
export const EXTRA_HOSTS = (process.env.PTP_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
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
 * How the app signs in to Claude (read when it is needed, so a changed environment counts):
 * - 'api-key' (the default): ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN with an Anthropic-compatible
 *   ANTHROPIC_BASE_URL;
 * - 'subscription' (PTP_AUTH=subscription): the Claude account the `claude` CLI is logged in with, or
 *   the long-lived token in CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`, how the Docker image signs
 *   in), only for your own use on your own computer (see the README).
 */
export function authMode(): 'api-key' | 'subscription' {
  return process.env.PTP_AUTH === 'subscription' ? 'subscription' : 'api-key';
}

/**
 * Claude through OpenRouter: in API-key mode, when OPENROUTER_API_KEY is set and no Anthropic key
 * or token is (an Anthropic key wins, and OpenRouter is then used for artwork only).
 */
export function claudeViaOpenRouter(): boolean {
  return authMode() === 'api-key' && !!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN;
}

/** Why the app can't run Claude as configured, or null. Without a key it never falls back to the CLI's login. */
export function claudeAuthProblem(): string | null {
  if (authMode() === 'subscription') {
    // A container has no `claude` login of its own: it needs the long-lived token from `claude setup-token`
    // (or a login made inside it, kept in the CLAUDE_CONFIG_DIR volume).
    const credentials = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
    if (process.env.PTP_DOCKER && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !existsSync(credentials)) {
      return 'prompt-to-part runs in Docker on your Claude subscription (PTP_AUTH=subscription) but has no login: run `claude setup-token` on your computer, put the token in .env as CLAUDE_CODE_OAUTH_TOKEN and restart prompt-to-part (docker compose up -d). See docs/running.md.';
    }
    return null;
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.OPENROUTER_API_KEY) return null;
  return 'No Claude API key: set OPENROUTER_API_KEY or ANTHROPIC_API_KEY (in .env or the environment) and restart prompt-to-part. See "Claude API key" in docs/configuration.md.';
}

/** What to tell the user when the Claude API refuses the app's API key or token (HTTP 401 or 403). */
export function claudeKeyRefused(status?: number): string {
  const code = status ? ` (HTTP ${status})` : '';
  if (claudeViaOpenRouter()) return `OpenRouter refused the key in OPENROUTER_API_KEY${code}: it may be wrong, revoked or out of credit. Check it, then restart prompt-to-part.`;
  if (process.env.ANTHROPIC_AUTH_TOKEN) return `${process.env.ANTHROPIC_BASE_URL || 'The API'} refused the token in ANTHROPIC_AUTH_TOKEN${code}. Check it, then restart prompt-to-part.`;
  return `Anthropic refused the key in ANTHROPIC_API_KEY${code}: it may be wrong or revoked. Check it at platform.claude.com, then restart prompt-to-part.`;
}

/** The currency costs and price suggestions are in (PTP_CURRENCY, e.g. USD, EUR, RON; US dollars by default). */
export const appCurrency = () => parseCurrency(process.env.PTP_CURRENCY) ?? DEFAULT_CURRENCY;
/** Where the maker sells, for the price suggestion (PTP_COUNTRY, e.g. Romania), or '' for no country. */
export const appCountry = () => (process.env.PTP_COUNTRY ?? '').trim().slice(0, 60);

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The chat's starting model (PTP_MODEL: fable, opus, sonnet, haiku or a full model ID such as claude-opus-5-5). */
export const defaultModel = () => process.env.PTP_MODEL?.trim() || 'opus';
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
