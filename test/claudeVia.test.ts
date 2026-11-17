import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeEnv } from '../server/agent';
import { authMode, claudeAuthProblem, claudeKeyRefused, claudeVia, claudeViaOpenRouter } from '../server/config';
import { checkConnection } from '../server/connection';

const KEYS = ['PTP_CLAUDE', 'PTP_AUTH', 'PTP_DOCKER', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENROUTER_API_KEY', 'MESHY_API_KEY', 'ELEVENLABS_API_KEY'];
let saved: NodeJS.ProcessEnv;
const realFetch = globalThis.fetch;

beforeEach(() => { saved = { ...process.env }; });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  globalThis.fetch = realFetch;
});

/** Only these of the app's sign-in variables set, whatever the shell has. */
function env(vars: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}

function stubFetch(fn: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => fn(String(input), init)) as typeof fetch;
}

// The logic before PTP_CLAUDE, copied as it was, so the inferred mode can be proven unchanged.
const oldAuthMode = () => (process.env.PTP_AUTH === 'subscription' ? 'subscription' : 'api-key');
const oldViaOpenRouter = () => oldAuthMode() === 'api-key' && !!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN;
function oldClaudeEnv(): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'prompt-to-part/1.0' };
  if (oldAuthMode() === 'subscription') { delete e.ANTHROPIC_API_KEY; delete e.ANTHROPIC_AUTH_TOKEN; delete e.ANTHROPIC_BASE_URL; }
  else {
    delete e.CLAUDE_CODE_OAUTH_TOKEN;
    if (oldViaOpenRouter()) Object.assign(e, { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: process.env.OPENROUTER_API_KEY, ANTHROPIC_API_KEY: '' });
  }
  delete e.ELEVENLABS_API_KEY;
  delete e.OPENROUTER_API_KEY;
  delete e.MESHY_API_KEY;
  return e;
}
/** Where the old connection check went for an API-key setup (null: no key at all). */
function oldVia(): string | null {
  if (oldAuthMode() === 'subscription') return 'subscription';
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.OPENROUTER_API_KEY) return null;
  if (oldViaOpenRouter()) return 'openrouter';
  const base = process.env.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, '');
  return base && !/^https:\/\/api\.anthropic\.com$/.test(base) ? 'custom' : 'anthropic';
}

const TODAY: Record<string, Record<string, string>> = {
  'subscription': { PTP_AUTH: 'subscription', CLAUDE_CODE_OAUTH_TOKEN: 'S', ANTHROPIC_API_KEY: 'A', ANTHROPIC_AUTH_TOKEN: 'T', ANTHROPIC_BASE_URL: 'https://p.example', OPENROUTER_API_KEY: 'O', MESHY_API_KEY: 'M' },
  'Anthropic key': { ANTHROPIC_API_KEY: 'A', CLAUDE_CODE_OAUTH_TOKEN: 'S', ELEVENLABS_API_KEY: 'E' },
  'OpenRouter only': { OPENROUTER_API_KEY: 'O', CLAUDE_CODE_OAUTH_TOKEN: 'S' },
  'token plus address': { ANTHROPIC_AUTH_TOKEN: 'T', ANTHROPIC_BASE_URL: 'https://p.example', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: 'O' },
  'Anthropic key and OpenRouter': { ANTHROPIC_API_KEY: 'A', OPENROUTER_API_KEY: 'O' },
  'Anthropic key with another address': { ANTHROPIC_API_KEY: 'A', ANTHROPIC_BASE_URL: 'https://p.example/' },
  'token without an address': { ANTHROPIC_AUTH_TOKEN: 'T' },
  'token with Anthropic\'s own address': { ANTHROPIC_AUTH_TOKEN: 'T', ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' },
  'address only': { ANTHROPIC_BASE_URL: 'https://p.example' },
  'nothing': {},
  'an unknown PTP_CLAUDE': { PTP_CLAUDE: 'bedrock', ANTHROPIC_API_KEY: 'A', OPENROUTER_API_KEY: 'O' },
};

test('without PTP_CLAUDE the Claude environment is exactly the old one for every setup', () => {
  for (const [name, vars] of Object.entries(TODAY)) {
    env(vars);
    assert.deepEqual(claudeEnv(), oldClaudeEnv(), name);
  }
});

test('without PTP_CLAUDE the mode, OpenRouter and the check go where they went before', () => {
  for (const [name, vars] of Object.entries(TODAY)) {
    env(vars);
    assert.equal(claudeVia(), oldVia(), name);
    assert.equal(authMode(), oldAuthMode(), name);
    assert.equal(claudeViaOpenRouter(), oldViaOpenRouter(), name);
  }
});

test('without PTP_CLAUDE the mode is inferred as before', () => {
  env({ PTP_AUTH: 'subscription' }); assert.equal(claudeVia(), 'subscription');
  env({ ANTHROPIC_API_KEY: 'k' }); assert.equal(claudeVia(), 'anthropic');
  env({ OPENROUTER_API_KEY: 'k' }); assert.equal(claudeVia(), 'openrouter');
  env({ ANTHROPIC_API_KEY: 'k', OPENROUTER_API_KEY: 'o' }); assert.equal(claudeVia(), 'anthropic');
  env({ ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://p.example' }); assert.equal(claudeVia(), 'custom');
  env({}); assert.equal(claudeVia(), null);
});

test('PTP_CLAUDE wins over what is set, and an unknown value is ignored', () => {
  env({ PTP_CLAUDE: 'openrouter', ANTHROPIC_API_KEY: 'k', OPENROUTER_API_KEY: 'o', PTP_AUTH: 'subscription' });
  assert.equal(claudeVia(), 'openrouter'); assert.equal(authMode(), 'api-key'); assert.equal(claudeViaOpenRouter(), true);
  env({ PTP_CLAUDE: 'bedrock', ANTHROPIC_API_KEY: 'k' }); assert.equal(claudeVia(), 'anthropic');
});

test('the Claude environment of each explicit choice carries only that choice', () => {
  const all = { ANTHROPIC_API_KEY: 'A', ANTHROPIC_AUTH_TOKEN: 'T', ANTHROPIC_BASE_URL: 'https://p.example', OPENROUTER_API_KEY: 'O', CLAUDE_CODE_OAUTH_TOKEN: 'S' };
  env({ ...all, PTP_CLAUDE: 'custom' });
  let e = claudeEnv();
  assert.deepEqual([e.ANTHROPIC_BASE_URL, e.ANTHROPIC_AUTH_TOKEN, e.ANTHROPIC_API_KEY, e.CLAUDE_CODE_OAUTH_TOKEN], ['https://p.example', 'T', '', undefined]);
  env({ ...all, PTP_CLAUDE: 'anthropic' }); e = claudeEnv();
  assert.deepEqual([e.ANTHROPIC_API_KEY, e.ANTHROPIC_AUTH_TOKEN, e.ANTHROPIC_BASE_URL, e.CLAUDE_CODE_OAUTH_TOKEN], ['A', undefined, undefined, undefined]);
  env({ ...all, PTP_CLAUDE: 'subscription' }); e = claudeEnv();
  assert.deepEqual([e.ANTHROPIC_API_KEY, e.ANTHROPIC_AUTH_TOKEN, e.ANTHROPIC_BASE_URL, e.CLAUDE_CODE_OAUTH_TOKEN], [undefined, undefined, undefined, 'S']);
  env({ ...all, PTP_CLAUDE: 'openrouter' }); e = claudeEnv();
  assert.deepEqual([e.ANTHROPIC_BASE_URL, e.ANTHROPIC_AUTH_TOKEN, e.ANTHROPIC_API_KEY], ['https://openrouter.ai/api', 'O', '']);
  for (const v of ['custom', 'anthropic', 'subscription', 'openrouter']) { env({ ...all, PTP_CLAUDE: v, MESHY_API_KEY: 'M', ELEVENLABS_API_KEY: 'E' }); e = claudeEnv(); assert.deepEqual([e.OPENROUTER_API_KEY, e.MESHY_API_KEY, e.ELEVENLABS_API_KEY], [undefined, undefined, undefined]); }
});

test('an explicit choice that lacks its key says which, and points to Settings', () => {
  env({ PTP_CLAUDE: 'custom', ANTHROPIC_BASE_URL: 'https://p.example' });
  assert.match(claudeAuthProblem()!, /token/i); assert.match(claudeAuthProblem()!, /Settings/);
  env({ PTP_CLAUDE: 'openrouter' }); assert.match(claudeAuthProblem()!, /OpenRouter/);
  env({ PTP_CLAUDE: 'custom', ANTHROPIC_AUTH_TOKEN: 'T' });
  assert.match(claudeAuthProblem()!, /address/); assert.match(claudeAuthProblem()!, /Open Settings \(the gear\) to fix it\.$/);
  // Another provider's token is not an Anthropic key.
  env({ PTP_CLAUDE: 'anthropic', ANTHROPIC_AUTH_TOKEN: 'T', OPENROUTER_API_KEY: 'O' });
  assert.match(claudeAuthProblem()!, /ANTHROPIC_API_KEY/); assert.match(claudeAuthProblem()!, /Open Settings \(the gear\) to fix it\.$/);
  env({ PTP_CLAUDE: 'anthropic', ANTHROPIC_API_KEY: 'A' }); assert.equal(claudeAuthProblem(), null);
});

test('the texts that send the user to .env also point to Settings, and a refused key says to check it there', () => {
  env({});
  assert.match(claudeAuthProblem()!, /^No Claude API key: .*, or open Settings \(the gear\)/);
  for (const vars of <Record<string, string>[]>[{ OPENROUTER_API_KEY: 'O' }, { ANTHROPIC_API_KEY: 'A' }, { ANTHROPIC_AUTH_TOKEN: 'T', ANTHROPIC_BASE_URL: 'https://p.example' }, { PTP_CLAUDE: 'custom', ANTHROPIC_AUTH_TOKEN: 'T', ANTHROPIC_BASE_URL: 'https://p.example', ANTHROPIC_API_KEY: 'A' }]) {
    env(vars);
    const text = claudeKeyRefused(401);
    assert.match(text, /\(HTTP 401\)/); assert.match(text, /Check it in Settings/); assert.doesNotMatch(text, /restart/);
  }
  env({ PTP_CLAUDE: 'custom', ANTHROPIC_AUTH_TOKEN: 'T', ANTHROPIC_BASE_URL: 'https://p.example', ANTHROPIC_API_KEY: 'A' });
  assert.match(claudeKeyRefused(), /ANTHROPIC_AUTH_TOKEN/);
  env({ PTP_CLAUDE: 'anthropic', ANTHROPIC_AUTH_TOKEN: 'T', ANTHROPIC_API_KEY: 'A' });
  assert.match(claudeKeyRefused(), /ANTHROPIC_API_KEY/);
});

test('the connection check sends no key to another provider', async () => {
  env({ PTP_CLAUDE: 'custom', ANTHROPIC_BASE_URL: 'https://p.example', ANTHROPIC_AUTH_TOKEN: 'T', ANTHROPIC_API_KEY: 'A' });
  const seen: Headers[] = []; const urls: string[] = []; stubFetch((url, init) => { urls.push(url); seen.push(new Headers(init?.headers)); return new Response('{}'); });
  const c = await checkConnection(true);
  assert.equal(c.via, 'custom'); assert.deepEqual(urls, ['https://p.example/v1/models']);
  for (const h of seen) { assert.equal(h.get('x-api-key'), null); assert.equal(h.get('authorization'), null); }
});

test('an explicit Anthropic key is checked at Anthropic, never at another address that is set', async () => {
  env({ PTP_CLAUDE: 'anthropic', ANTHROPIC_BASE_URL: 'https://p.example', ANTHROPIC_AUTH_TOKEN: 'T', ANTHROPIC_API_KEY: 'A' });
  const seen: { url: string; headers: Headers }[] = [];
  stubFetch((url, init) => { seen.push({ url, headers: new Headers(init?.headers) }); return new Response('{}'); });
  const c = await checkConnection(true);
  assert.equal(c.via, 'anthropic'); assert.equal(c.ok, true);
  assert.deepEqual(seen.map((s) => s.url), ['https://api.anthropic.com/v1/models']);
  assert.equal(seen[0].headers.get('x-api-key'), 'A'); assert.equal(seen[0].headers.get('authorization'), null);
});

test('an explicit choice that lacks its key is shown under that choice', async () => {
  env({ PTP_CLAUDE: 'openrouter' });
  stubFetch(() => { throw new Error('no request expected'); });
  const c = await checkConnection(true);
  assert.equal(c.via, 'openrouter'); assert.equal(c.ok, false); assert.match(c.detail, /OpenRouter/);
});
