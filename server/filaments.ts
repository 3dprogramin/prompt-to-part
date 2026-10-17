// A filament's colour and TD for LayerTone prints: from the library, or found on the web by Claude.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv, publicPage, publicUrl } from './agent';
import { claudeAuthProblem } from './config';
import { matchFilament, normalizeFilamentText, type FilamentLookup } from '../shared/filaments';

export interface FilamentQuery {
  brand: string;
  name: string;
}

const PROMPT = `You find a 3D-printing filament's TD (transmission distance, in mm: the thickness at which the filament hides what is under it) and its colour.
Search the web for a published TD for exactly this filament: HueForge's filament library and posts, 3dfilamentprofiles.com, filamentcolors.xyz, community TD lists. Use only TD values you actually read on a page. If there is none for this exact filament, use the published TD of the closest filament (same brand and line in a similar colour, or the same colour from a similar brand) and say which. Only if nothing close is published, estimate from published values of similar colours and say so.
The colour is the filament's hex colour as the maker publishes it or as measured on a swatch.
Answer with ONLY a JSON object, no other text:
{"name": "<the filament's full name, e.g. PLA Basic Black>", "line": "<product line, e.g. PLA Basic>", "color": "#rrggbb", "td": <mm, 0.1–20>, "source": "<URL of the page the TD comes from>", "match": "exact" | "similar" | "estimate", "note": "<one short sentence: where the value comes from, and which filament it belongs to if not this one>"}`;

/** Parse Claude's answer for the filament asked for: the first JSON object in it, checked. */
export function parseLookup(text: string, q: FilamentQuery): FilamentLookup {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('Jig did not find this filament');
  const o = JSON.parse(m[0]) as Record<string, unknown>;
  const color = String(o.color ?? '').trim().toLowerCase();
  const td = Number(o.td);
  const source = String(o.source ?? '').trim();
  const match = o.match === 'exact' || o.match === 'similar' ? o.match : 'estimate';
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error('Jig did not find the filament\'s colour');
  if (!Number.isFinite(td) || td < 0.1 || td > 20) throw new Error('Jig did not find a usable TD for this filament');
  // A value read on the web names its page; only an estimate may come without one.
  if (match !== 'estimate' && !publicUrl(source)) throw new Error('Jig did not say where the TD comes from');
  const text200 = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);
  const note = text200(o.note);
  return {
    filament: {
      brand: q.brand,
      line: text200(o.line),
      name: text200(o.name) ?? q.name,
      color,
      td: Math.round(td * 10) / 10,
      source: publicUrl(source) ? source.slice(0, 500) : 'estimate by Jig',
    },
    // A TD Claude found on the web is not checked like the library's, so it is never 'listed'.
    confidence: match === 'estimate' ? 'estimate' : 'similar',
    note: match === 'exact' ? `Found on the web, not in Jig's library${note ? `: ${note}` : '.'}` : note,
  };
}

/** Claude searches the web for the filament and answers with the JSON above. */
async function askClaude(q: FilamentQuery): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120_000);
  try {
    let text = '';
    for await (const msg of query({
      prompt: `Brand: ${q.brand}\nFilament: ${q.name}\n\nFind its TD and colour.`,
      options: {
        systemPrompt: PROMPT,
        model: 'haiku',
        tools: ['WebSearch', 'WebFetch'],
        maxTurns: 10,
        settingSources: [],
        permissionMode: 'default',
        // Pages Claude reads could ask it to fetch local addresses (Jig's own API, a router): only
        // public pages, as in a generation (toolPolicy).
        canUseTool: async (name, input) => {
          if (name === 'WebSearch' || (name === 'WebFetch' && await publicPage(input.url))) return { behavior: 'allow', updatedInput: input };
          return { behavior: 'deny', message: name === 'WebFetch' ? 'Only public http(s) web pages can be fetched.' : 'Tool not available here.' };
        },
        env: claudeEnv(),
        abortController: abort,
        pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || undefined,
      },
    })) {
      if (msg.type === 'result') {
        if (msg.subtype !== 'success') throw new Error(`Jig couldn't look up this filament (${msg.subtype})`);
        text = msg.result;
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Claude's answers by brand and name, kept while Jig runs (a lookup costs a web search or several).
// The promise is stored, so asking twice at once searches once; a failure is forgotten.
const cache = new Map<string, Promise<FilamentLookup>>();
const MAX_CACHED = 200;

/** The filament from the library ('listed', or 'estimate' for an unverified TD), or as Claude finds it on the web ('similar' or 'estimate'). */
export async function lookupFilament(q: FilamentQuery, ask: (q: FilamentQuery) => Promise<string> = askClaude): Promise<FilamentLookup> {
  const listed = matchFilament(q.brand, q.name);
  if (listed?.unverified) return { filament: listed, confidence: 'estimate', note: 'From a published list that doesn\'t say how its TD was found; a test print will tell.' };
  if (listed) return { filament: listed, confidence: 'listed' };
  const authProblem = claudeAuthProblem();
  if (authProblem) throw new Error(authProblem);
  const key = `${normalizeFilamentText(q.brand)}\n${normalizeFilamentText(q.name)}`;
  let found = cache.get(key);
  if (!found) {
    found = ask(q).then((text) => parseLookup(text, q));
    cache.set(key, found);
    found.catch(() => cache.delete(key));
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  return found;
}
