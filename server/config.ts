// Settings from the environment, read once. Paths are resolved from the Jig folder rather than the
// working directory, so the server also works when started from somewhere else.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Secrets such as ELEVENLABS_API_KEY can live in .env next to package.json (git ignores it);
// variables already set in the environment win.
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
export const PORT = Number(process.env.PORT ?? 8787);
/** Designs, workspaces and the Bambu template cache. */
export const DATA_DIR = process.env.JIG_DATA ? path.resolve(process.env.JIG_DATA) : path.join(ROOT, 'data');
/** Serve the built app from dist/ as well as the API (`npm start`). */
export const PRODUCTION = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
/**
 * How Jig signs in to Claude (read when it is needed, so a changed environment counts):
 * - 'api-key' (the default): ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN with an Anthropic-compatible
 *   ANTHROPIC_BASE_URL;
 * - 'subscription' (JIG_AUTH=subscription): the Claude account the `claude` CLI is logged in with,
 *   only for your own use on your own computer (see the README).
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
  if (authMode() === 'subscription' || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.OPENROUTER_API_KEY) return null;
  return 'Jig has no Claude API key: set OPENROUTER_API_KEY or ANTHROPIC_API_KEY (in .env or the environment) and restart Jig. See "Claude account or API key" in the README.';
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The chat's starting model (JIG_MODEL: opus, sonnet, haiku or a full model ID such as claude-opus-5-5). */
export const defaultModel = () => process.env.JIG_MODEL?.trim() || 'opus';
/** The chat's starting reasoning effort (JIG_EFFORT). */
export const defaultEffort = () => (EFFORTS.includes(process.env.JIG_EFFORT?.trim() ?? '') ? process.env.JIG_EFFORT!.trim() : 'high');
