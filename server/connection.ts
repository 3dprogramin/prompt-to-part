// What the app runs Claude on (subscription, OpenRouter, Anthropic API, a custom provider) and whether that
// service answers, for the chip in the top bar, with the subscription's usage limits. Checked at most once
// a minute; no check costs a request to the model.
import os from 'node:os';
import { query, type SDKControlGetUsageResponse, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Connection } from '../shared/api';
import { claudeEnv } from './agent';
import { authMode, claudeAuthProblem, claudeViaOpenRouter } from './config';
import { recordUsage, usageWindows } from './usage';

const TIMEOUT_MS = 8000;
let cached: { at: number; value: Connection } | null = null;

export async function checkConnection(fresh = false): Promise<Connection> {
  if (fresh || !cached || Date.now() - cached.at >= 60_000) cached = { at: Date.now(), value: await check() };
  if (cached.value.via !== 'subscription' || !cached.value.ok) return cached.value;
  // The usage as last reported (replies report it as they run), so a check right after one is current.
  await refreshUsage(fresh);
  return { ...cached.value, usage: usageWindows() };
}

let asked = 0;
let asking: Promise<void> | null = null;
let unavailableUntil = 0;

/**
 * Asks Claude Code for its /usage data (the plan's windows from claude.ai): at most every 5 minutes,
 * or every minute when the user clicks the chip. It starts Claude Code without a prompt, so nothing
 * goes to the model and no usage is spent (about a second of Claude Code starting up).
 */
function refreshUsage(fresh: boolean): Promise<void> {
  const now = Date.now();
  if (asking) return asking;
  if (now < unavailableUntil || now - asked < (fresh ? 60_000 : 5 * 60_000)) return Promise.resolve();
  asked = now;
  asking = askUsage().then((r) => {
    if (r.rate_limits_available && r.rate_limits) recordUsage(r.rate_limits);
    // Not every login may read it (a token from `claude setup-token` may not): replies still report it.
    else unavailableUntil = Date.now() + 60 * 60_000;
  }, (e: Error) => console.warn('[connection] Claude Code did not report the usage:', e.message)).finally(() => { asking = null; });
  return asking;
}

async function askUsage(): Promise<SDKControlGetUsageResponse> {
  const abort = new AbortController();
  // The session waits for a prompt that never comes, until it is closed.
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
    await new Promise((resolve) => abort.signal.addEventListener('abort', resolve, { once: true }));
  }
  const q = query({
    prompt: noPrompt(),
    options: {
      cwd: os.tmpdir(),
      tools: [],
      settingSources: [],
      persistSession: false,
      env: claudeEnv(),
      abortController: abort,
      pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || undefined,
      stderr: (d) => { if (process.env.DEBUG_AGENT) process.stderr.write(d); },
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer in 20 s')), 20_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    q.close();
    abort.abort();
  }
}

async function check(): Promise<Connection> {
  const problem = claudeAuthProblem();
  if (authMode() === 'subscription') {
    const login = process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'the token in CLAUDE_CODE_OAUTH_TOKEN' : "the `claude` CLI's login";
    if (problem) return { via: 'subscription', ok: false, detail: problem };
    // The subscription's token can't be checked without spending usage: only that Anthropic answers.
    const reach = await reachable('https://api.anthropic.com/v1/models');
    return { via: 'subscription', ok: reach === true, detail: reach === true ? `Signed in with ${login}; Anthropic's servers answer.` : `Signed in with ${login}, but Anthropic's servers don't answer: ${reach}` };
  }
  if (problem) return { via: 'none', ok: false, detail: problem };
  if (claudeViaOpenRouter()) return openRouter(process.env.OPENROUTER_API_KEY!);
  const base = process.env.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (base && !/^https:\/\/api\.anthropic\.com$/.test(base)) {
    const reach = await reachable(`${base}/v1/models`);
    return { via: 'custom', ok: reach === true, detail: reach === true ? `${base} answers.` : `${base} doesn't answer: ${reach}` };
  }
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
  if (process.env.ANTHROPIC_API_KEY) headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
  else headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return { via: 'anthropic', ok: true, detail: 'Anthropic API key accepted.' };
    return { via: 'anthropic', ok: false, detail: res.status === 401 || res.status === 403 ? 'Anthropic refused the API key (invalid or revoked).' : `Anthropic answered ${res.status}.` };
  } catch (e) {
    return { via: 'anthropic', ok: false, detail: `Anthropic's servers don't answer: ${(e as Error).message}` };
  }
}

/** OpenRouter: the key must be accepted; the credit left is shown when the key may read it. */
async function openRouter(key: string): Promise<Connection> {
  const get = (p: string) => fetch(`https://openrouter.ai/api/v1/${p}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  try {
    const res = await get('key');
    if (!res.ok) return { via: 'openrouter', ok: false, detail: res.status === 401 ? 'OpenRouter refused the key in OPENROUTER_API_KEY (invalid or revoked).' : `OpenRouter answered ${res.status}.` };
    const credits = await get('credits').then((r) => (r.ok ? r.json() : null)).catch(() => null) as { data?: { total_credits?: number; total_usage?: number } } | null;
    const c = credits?.data;
    const credit = c && typeof c.total_credits === 'number' && typeof c.total_usage === 'number' ? c.total_credits - c.total_usage : undefined;
    return { via: 'openrouter', ok: true, credit, detail: `OpenRouter key accepted${credit != null ? `; $${credit.toFixed(2)} credit left` : ''}.` };
  } catch (e) {
    return { via: 'openrouter', ok: false, detail: `OpenRouter doesn't answer: ${(e as Error).message}` };
  }
}

/** true when the server answers at all (any HTTP status), else why not. */
async function reachable(url: string): Promise<true | string> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return true;
  } catch (e) {
    return (e as Error).message;
  }
}
