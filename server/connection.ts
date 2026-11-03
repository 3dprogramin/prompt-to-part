// What Jig runs Claude on (OpenRouter, Anthropic API, a custom provider) and whether that service answers,
// for the chip in the top bar. Checked at most once a minute; no check costs a request to the model.
import type { Connection } from '../shared/api';
import { claudeAuthProblem, claudeViaOpenRouter } from './config';

const TIMEOUT_MS = 8000;
let cached: { at: number; value: Connection } | null = null;

export async function checkConnection(fresh = false): Promise<Connection> {
  if (fresh || !cached || Date.now() - cached.at >= 60_000) cached = { at: Date.now(), value: await check() };
  return cached.value;
}

async function check(): Promise<Connection> {
  const problem = claudeAuthProblem();
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
