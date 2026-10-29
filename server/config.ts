// Settings from the environment, read once. Paths are resolved from the Jig folder rather than the
// working directory, so the server also works when started from somewhere else.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Secrets such as ELEVENLABS_API_KEY can live in .env next to package.json (git ignores it);
// variables already set in the environment win.
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
export const PORT = Number(process.env.PORT ?? 8787);
/** The address the server listens on: this computer only, unless JIG_HOST says otherwise (0.0.0.0 in the Docker image). */
export const HOST = process.env.JIG_HOST?.trim() || '127.0.0.1';
/** More names Jig answers to besides localhost (JIG_HOSTS, comma-separated), e.g. this computer's address on the network for a phone. */
export const EXTRA_HOSTS = (process.env.JIG_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
/** Designs, workspaces and the Bambu template cache. */
export const DATA_DIR = process.env.JIG_DATA ? path.resolve(process.env.JIG_DATA) : path.join(ROOT, 'data');
/** Serve the built app from dist/ as well as the API (`npm start`). */
export const PRODUCTION = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
/**
 * How Jig signs in to Claude (read when it is needed, so a changed environment counts):
 * - 'api-key' (the default): ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN with an Anthropic-compatible
 *   ANTHROPIC_BASE_URL;
 * - 'subscription' (JIG_AUTH=subscription): the Claude account the `claude` CLI is logged in with, or
 *   the long-lived token in CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`, how the Docker image signs
 *   in), only for your own use on your own computer (see the README).
 */
export function authMode(): 'api-key' | 'subscription' {
  return process.env.JIG_AUTH === 'subscription' ? 'subscription' : 'api-key';
}

/**
 * Claude through OpenRouter: in API-key mode, when OPENROUTER_API_KEY is set and no Anthropic key
 * or token is (an Anthropic key wins, and OpenRouter is then used for artwork only).
 */
export function claudeViaOpenRouter(): boolean {
  return authMode() === 'api-key' && !!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN;
}

/** Why Jig can't run Claude as configured, or null. Without a key it never falls back to the CLI's login. */
export function claudeAuthProblem(): string | null {
  if (authMode() === 'subscription') {
    // A container has no `claude` login of its own: it needs the long-lived token from `claude setup-token`
    // (or a login made inside it, kept in the CLAUDE_CONFIG_DIR volume).
    const credentials = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
    if (process.env.JIG_DOCKER && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !existsSync(credentials)) {
      return 'Jig runs in Docker on your Claude subscription (JIG_AUTH=subscription) but has no login: run `claude setup-token` on your computer, put the token in .env as CLAUDE_CODE_OAUTH_TOKEN and restart Jig (docker compose up -d). See "Docker" in the README.';
    }
    return null;
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.OPENROUTER_API_KEY) return null;
  return 'Jig has no Claude API key: set OPENROUTER_API_KEY or ANTHROPIC_API_KEY (in .env or the environment) and restart Jig. See "Claude account or API key" in the README.';
}

/** What to tell the user when the Claude API refuses Jig's API key or token (HTTP 401 or 403). */
export function claudeKeyRefused(status?: number): string {
  const code = status ? ` (HTTP ${status})` : '';
  if (claudeViaOpenRouter()) return `OpenRouter refused the key in OPENROUTER_API_KEY${code}: it may be wrong, revoked or out of credit. Check it, then restart Jig.`;
  if (process.env.ANTHROPIC_AUTH_TOKEN) return `${process.env.ANTHROPIC_BASE_URL || 'The API'} refused the token in ANTHROPIC_AUTH_TOKEN${code}. Check it, then restart Jig.`;
  return `Anthropic refused the key in ANTHROPIC_API_KEY${code}: it may be wrong or revoked. Check it at platform.claude.com, then restart Jig.`;
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The chat's starting model (JIG_MODEL: opus, sonnet, haiku or a full model ID such as claude-opus-5-5). */
export const defaultModel = () => process.env.JIG_MODEL?.trim() || 'opus';
/** The chat's starting reasoning effort (JIG_EFFORT). */
export const defaultEffort = () => (EFFORTS.includes(process.env.JIG_EFFORT?.trim() ?? '') ? process.env.JIG_EFFORT!.trim() : 'high');
