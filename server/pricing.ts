// A selling price suggested by Claude for a printed design, from what it costs to print and what it is.
import { printer } from '../shared/printer';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv } from './agent';
import { claudeAuthProblem, jigCountry, jigCurrency } from './config';
import { duration, money } from '../shared/cost';
import type { PriceRequest, PriceSuggestion } from '../shared/api';

const prompt = (currency: string, country: string) => `You suggest a retail price for a 3D-printed item that a hobbyist maker${country ? ` in ${country}` : ''} sells (for example online or at a local market). Prices are in ${currency}.
Take into account: the material and electricity cost given (the electricity cost may be unknown), the print time (machine time and the printer's wear), the maker's time to remove supports, post-process and package it, failed prints, the design's usefulness and complexity, and what similar printed items typically sell for. Do not invent costs that were given as unknown; reason about them instead.
Answer with ONLY a JSON object, no other text:
{"price": <suggested price, number>, "low": <reasonable lowest price>, "high": <reasonable highest price>, "reasoning": "<2–4 short sentences: what drives the price>"}`;

function describe(r: PriceRequest): string {
  const lines = [
    `Item: ${r.name}`,
    r.description && `What it is: ${r.description}`,
    `Size: ${r.size}`,
    `Parts: ${r.parts}${r.colours > 1 ? `, ${r.colours} filament colours (AMS)` : ''}`,
    `Material: PLA, ${r.grams.toFixed(1)} g (Bambu Studio slice, supports and purge included)`,
    `Print time: ${duration(r.seconds)} on the ${printer().name} (Bambu Studio estimate)`,
    `Filament cost: ${r.filamentCost != null ? money(r.filamentCost, jigCurrency()) : 'unknown (no filament price set)'}`,
    `Electricity cost: ${r.electricityCost != null ? money(r.electricityCost, jigCurrency()) : 'unknown (the printer\'s power hasn\'t been measured)'}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** Parse Claude's answer: the first JSON object in it, checked. */
export function parseSuggestion(text: string): PriceSuggestion {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('The answer had no price');
  const o = JSON.parse(m[0]) as Record<string, unknown>;
  const price = Number(o.price), low = Number(o.low ?? o.price), high = Number(o.high ?? o.price);
  if (![price, low, high].every((n) => Number.isFinite(n) && n >= 0)) throw new Error('The answer had no price');
  return { price, low: Math.min(low, price), high: Math.max(high, price), reasoning: String(o.reasoning ?? '').slice(0, 1000), currency: jigCurrency() };
}

export async function suggestPrice(r: PriceRequest): Promise<PriceSuggestion> {
  const authProblem = claudeAuthProblem();
  if (authProblem) throw new Error(authProblem);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 90_000);
  try {
    let text = '';
    for await (const msg of query({
      prompt: `${describe(r)}\n\nSuggest the selling price.`,
      options: {
        systemPrompt: prompt(jigCurrency(), jigCountry()),
        model: 'sonnet',
        tools: [],
        maxTurns: 1,
        settingSources: [],
        permissionMode: 'default',
        canUseTool: async () => ({ behavior: 'deny', message: 'No tools here.' }),
        env: claudeEnv(),
        abortController: abort,
        pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || undefined,
      },
    })) {
      if (msg.type === 'result') {
        if (msg.subtype !== 'success') throw new Error(`Couldn't suggest a price (${msg.subtype})`);
        text = msg.result;
      }
    }
    return parseSuggestion(text);
  } finally {
    clearTimeout(timer);
  }
}
