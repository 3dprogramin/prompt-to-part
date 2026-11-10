// OpenRouter's models for the model menu: which can run the app, the top ones, a reply's price at
// OpenRouter's rates, the route (only through OpenRouter) and the models a reply may ask for.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { RawModel } from '../server/openRouterModels';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-models-test-'));
process.env.PTP_DATA = dataDir;
const { menuModels, priceUsage, openRouterModels, forgetOpenRouterModels, modelIsTextOnly, withoutPictures, PICTURE_LEFT_OUT } = await import('../server/openRouterModels');
const { formatCost } = await import('../shared/duration');

const model = (id: string, created: number, extra: Partial<RawModel> = {}): RawModel => ({
  id, name: `Maker: ${id.split('/')[1]}`, created, context_length: 100_000,
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  pricing: { prompt: '0.000001', completion: '0.000005', input_cache_read: '0.0000001' },
  supported_parameters: ['tools', 'max_tokens'],
  ...extra,
});

const RAW: RawModel[] = [
  model('anthropic/claude-opus-5.5', 300),
  model('anthropic/claude-opus-5', 200),
  model('anthropic/claude-opus-5.5:batch', 300),
  model('anthropic/claude-sonnet-5.5', 290),
  model('deepseek/deepseek-v4.1-flash', 250, { pricing: { prompt: '0.000000045', completion: '0.0000005' } }),
  model('deepseek/deepseek-v4-flash', 100),
  model('moonshotai/kimi-k3', 260),
  model('some/text-only', 400, { architecture: { input_modalities: ['text'], output_modalities: ['text'] } }),
  model('some/no-tools', 500, { supported_parameters: ['max_tokens'] }),
  model('some/picture-maker', 500, { architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
  model('some/unpriced', 500, { pricing: {} }),
];

test('the menu: models with tools and text in and out, the newest of each family first, then the rest newest first', () => {
  const list = menuModels(RAW);
  assert.deepEqual(list.map((m) => m.id), [
    'anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'moonshotai/kimi-k3', 'deepseek/deepseek-v4.1-flash',
    'some/text-only', 'anthropic/claude-opus-5', 'deepseek/deepseek-v4-flash',
  ]);
  assert.deepEqual(list.map((m) => !!m.featured), [true, true, true, true, false, false, false]);
  const ds = list.find((m) => m.id === 'deepseek/deepseek-v4.1-flash')!;
  assert.equal(ds.name, 'deepseek-v4.1-flash');
  assert.equal(ds.fullName, 'Maker: deepseek-v4.1-flash');
  // No cache prices: cached tokens cost what new ones do.
  assert.deepEqual(ds.pricing, { prompt: 0.000000045, completion: 0.0000005, cacheRead: 0.000000045, cacheWrite: 0.000000045 });
  assert.equal(list.find((m) => m.id === 'some/text-only')!.images, false);
});

test('a reply priced at OpenRouter rates; Claude Code\'s own models keep its price', () => {
  const list = menuModels(RAW);
  const usage = {
    'deepseek/deepseek-v4.1-flash': { inputTokens: 10_000, outputTokens: 2_000, cacheReadInputTokens: 100_000, cacheCreationInputTokens: 0, costUSD: 0.5 },
    'claude-haiku-5-5': { inputTokens: 500, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0012 },
  };
  const want = 10_000 * 0.000000045 + 2_000 * 0.0000005 + 100_000 * 0.000000045 + 0.0012;
  assert.ok(Math.abs(priceUsage(usage, list) - want) < 1e-12);
  assert.equal(priceUsage(usage, []), 0.5012);
});

test('small costs: three decimals below a cent', () => {
  assert.equal(formatCost(0.0001), '<$0.001');
  assert.equal(formatCost(0.0042), '$0.004');
  assert.equal(formatCost(0.3), '$0.30');
  assert.equal(formatCost(1.236), '$1.24');
});

test('the list is fetched once an hour; a failed refresh keeps the copy it has', async () => {
  forgetOpenRouterModels();
  let calls = 0;
  const ok = (async () => { calls++; return new Response(JSON.stringify({ data: RAW })); }) as unknown as typeof fetch;
  const [a, b] = await Promise.all([openRouterModels(ok), openRouterModels(ok)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal((await openRouterModels(ok)).length, a.length);
  assert.equal(calls, 1);
  forgetOpenRouterModels();
  await assert.rejects(openRouterModels((async () => new Response('nope', { status: 500 })) as unknown as typeof fetch), /500/);
});

// The routes, with stand-ins for Claude and the model list.
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const asked: string[] = [];
const { createApp } = await import('../server/app');
server.on('request', createApp({
  port,
  models: async () => menuModels(RAW),
  generate: async (req, send) => { asked.push(req.model ?? ''); send({ type: 'done', durationMs: 1, turns: 1, submitted: false, text: 'ok' }); },
}));
after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });
const A = `http://127.0.0.1:${port}`;
const W = { 'Content-Type': 'application/json', 'X-PTP': '1' };

/** Runs `fn` with only these Claude keys set, then puts the environment back. */
async function withKeys(keys: Record<string, string>, fn: () => Promise<void>) {
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY', 'PTP_AUTH'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  Object.assign(process.env, keys);
  try { await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}

const generate = (model: string, n: number) => fetch(`${A}/api/generate`, { method: 'POST', headers: W, body: JSON.stringify({ designId: `test-mod-0000000${n}`, prompt: 'a cube', model }) });

test('through OpenRouter: the capabilities say so, the list is served and any OpenRouter model may be asked for', async () => {
  await withKeys({ OPENROUTER_API_KEY: 'sk-or-test' }, async () => {
    assert.equal((await (await fetch(`${A}/api/capabilities`)).json()).openRouterModels, true);
    const r = await fetch(`${A}/api/models`);
    assert.equal(r.status, 200);
    const { models } = await r.json();
    assert.equal(models[0].id, 'anthropic/claude-opus-5.5');
    assert.equal(models[0].featured, true);
    const res = await generate('deepseek/deepseek-v4.1-flash', 1);
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(asked.at(-1), 'deepseek/deepseek-v4.1-flash');
    assert.equal((await generate('not a model id', 2)).status, 400);
  });
});

test('with an Anthropic key: no list, and only Claude\'s models', async () => {
  await withKeys({ ANTHROPIC_API_KEY: 'sk-test', OPENROUTER_API_KEY: 'sk-or-test' }, async () => {
    assert.equal((await (await fetch(`${A}/api/capabilities`)).json()).openRouterModels, false);
    assert.equal((await fetch(`${A}/api/models`)).status, 404);
    assert.equal((await generate('deepseek/deepseek-v4.1-flash', 3)).status, 400);
    const res = await generate('sonnet', 4);
    assert.equal(res.status, 200);
    await res.text();
  });
});

test('a model that takes no pictures: known from the list, its pictures swapped for a note', async () => {
  forgetOpenRouterModels();
  const fake = (async () => new Response(JSON.stringify({ data: RAW }))) as typeof fetch;
  assert.equal(await modelIsTextOnly('some/text-only', fake), true);
  assert.equal(await modelIsTextOnly('moonshotai/kimi-k3', fake), false);
  assert.equal(await modelIsTextOnly('opus', fake), false, 'an alias is Claude');
  assert.equal(await modelIsTextOnly('some/not-listed', fake), false, 'unknown: pictures are sent');
  forgetOpenRouterModels();
  assert.equal(await modelIsTextOnly('some/text-only', (async () => { throw new Error('offline'); }) as typeof fetch), false, 'no list: pictures are sent');
  forgetOpenRouterModels();
  const content = [{ type: 'text', text: 'Front:' }, { type: 'image', data: 'x', mimeType: 'image/png' }];
  assert.deepEqual(withoutPictures(content), [{ type: 'text', text: 'Front:' }, { type: 'text', text: PICTURE_LEFT_OUT }]);
});
