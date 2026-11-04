// OpenRouter's model list for the model menu (when Claude runs through OpenRouter), and the price of
// a reply at OpenRouter's own rates: Claude Code prices only Claude models itself.
import type { OpenRouterModel } from '../shared/api';

const URL = 'https://openrouter.ai/api/v1/models';
const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

/** One entry of OpenRouter's /api/v1/models, as far as the app reads it. */
export interface RawModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
  supported_parameters?: string[];
}

/** The top of the menu: per family the newest model, in this order. */
const FAMILIES: RegExp[] = [
  /^anthropic\/claude-opus-/,
  /^anthropic\/claude-sonnet-/,
  /^anthropic\/claude-haiku-/,
  /^moonshotai\/kimi-/,
  /^deepseek\/deepseek-v[\d.]+-flash$/,
  /^google\/gemini-[\d.]+-flash$/,
  /^openai\/gpt-[\d.]+$/,
  /^z-ai\/glm-[\d.]+$/,
  /^x-ai\/grok-[\d.]+$/,
  /^qwen\/qwen3?-coder/,
];

const price = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** The models that can run the app (tools, text in and out), mapped; null for one that can't. */
function toModel(m: RawModel): OpenRouterModel | null {
  if (typeof m?.id !== 'string' || m.id.endsWith(':batch')) return null;
  if (!m.supported_parameters?.includes('tools')) return null;
  const input = m.architecture?.input_modalities ?? [];
  if (!input.includes('text') || !(m.architecture?.output_modalities ?? []).includes('text')) return null;
  const prompt = price(m.pricing?.prompt), completion = price(m.pricing?.completion);
  if (prompt === null || completion === null) return null;
  const fullName = m.name?.trim() || m.id;
  return {
    id: m.id,
    name: fullName.replace(/^[^:]{1,40}:\s+/, ''),
    fullName,
    created: m.created ?? 0,
    contextLength: m.context_length ?? null,
    pricing: { prompt, completion, cacheRead: price(m.pricing?.input_cache_read) ?? prompt, cacheWrite: price(m.pricing?.input_cache_write) ?? prompt },
    images: input.includes('image'),
  };
}

/** OpenRouter's list as the menu shows it: the featured models first (featured: true), then the rest, newest first. */
export function menuModels(raw: RawModel[]): OpenRouterModel[] {
  const models = raw.map(toModel).filter((m): m is OpenRouterModel => !!m);
  const newest = [...models].sort((a, b) => b.created - a.created);
  const featured: OpenRouterModel[] = [];
  for (const family of FAMILIES) {
    const m = newest.find((x) => family.test(x.id) && !featured.includes(x));
    if (m) featured.push(m);
  }
  return [...featured.map((m) => ({ ...m, featured: true })), ...newest.filter((m) => !featured.includes(m))];
}

let cache: { at: number; models: OpenRouterModel[] } | null = null;
let pending: Promise<OpenRouterModel[]> | null = null;

/** The menu's models, fetched at most once an hour; a failed refresh keeps the copy it has. */
export function openRouterModels(fetchImpl: typeof fetch = fetch): Promise<OpenRouterModel[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.models);
  pending ??= (async () => {
    try {
      const key = process.env.OPENROUTER_API_KEY;
      const res = await fetchImpl(URL, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
      const body = (await res.json()) as { data?: RawModel[] };
      if (!Array.isArray(body?.data)) throw new Error('OpenRouter sent no model list');
      cache = { at: Date.now(), models: menuModels(body.data) };
      return cache.models;
    } catch (e) {
      if (cache) return cache.models;
      throw e;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** For tests: forget the cached list. */
export function forgetOpenRouterModels() {
  cache = null;
  pending = null;
}

/** Claude Code's per-model usage of a reply (its result message's modelUsage), as far as pricing needs it. */
export interface UsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

/**
 * What the usage costs at OpenRouter's rates: a model in the list by its exact ID is priced from its
 * tokens; any other (Claude Code's own claude-* names) keeps the price Claude Code gave it.
 */
export function priceUsage(usage: Record<string, UsageEntry>, models: OpenRouterModel[]): number {
  const byId = new Map(models.map((m) => [m.id, m]));
  let total = 0;
  for (const [id, u] of Object.entries(usage)) {
    const m = byId.get(id);
    total += m
      ? (u.inputTokens || 0) * m.pricing.prompt + (u.outputTokens || 0) * m.pricing.completion
        + (u.cacheReadInputTokens || 0) * m.pricing.cacheRead + (u.cacheCreationInputTokens || 0) * m.pricing.cacheWrite
      : u.costUSD || 0;
  }
  return total;
}

/** A model ID as OpenRouter writes them ("deepseek/deepseek-v4.1-flash", "~deepseek/deepseek-flash-latest"). */
export const OPENROUTER_MODEL_ID = /^~?[a-z0-9][\w.-]*\/[\w.:~-]+$/;
