import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STARTERS, ideaModes, pickStarters, cleanIdeaText, parseIdeas, topUp, ideasPrompt, type IdeaMode } from '../shared/ideas';

const ALL: IdeaMode[] = ['off', 'artwork', 'layertone', 'lithophane', 'lineart', 'figure'];

test('ideaModes: off always, picture modes with artwork, figure with meshy', () => {
  assert.deepEqual(ideaModes({ artwork: false, meshy: false }), ['off']);
  assert.deepEqual([...ideaModes({ artwork: true, meshy: false })].sort(), ['artwork', 'layertone', 'lineart', 'lithophane', 'off']);
  assert.deepEqual([...ideaModes({ artwork: true, meshy: true })].sort(), [...ALL].sort());
});

test('pickStarters: one per mode in preference order, then more 3D model ones', () => {
  assert.deepEqual(pickStarters(ALL).map((i) => i.mode), ['off', 'layertone', 'lithophane', 'lineart']);
  const off = pickStarters(['off']);
  assert.equal(off.length, 4);
  assert.ok(off.every((i) => i.mode === 'off'));
  assert.equal(new Set(off.map((i) => i.text)).size, 4);
});

test('STARTERS: short, plain, distinct, every mode covered', () => {
  for (const s of STARTERS) {
    assert.ok(s.text.length <= 120, s.text);
    assert.ok(!/[\u2013\u2014]/.test(s.text), s.text);
  }
  assert.equal(new Set(STARTERS.map((s) => s.text.toLowerCase())).size, STARTERS.length);
  for (const m of ALL) assert.ok(STARTERS.some((s) => s.mode === m), m);
  assert.ok(STARTERS.filter((s) => s.mode === 'off').length >= 8);
});

test('STARTERS: every named size fits a 180 x 180 mm bed', () => {
  for (const s of STARTERS) {
    for (const m of s.text.matchAll(/(\d+(?:\.\d+)?)\s*(cm|mm)\b/g)) {
      const mm = Number(m[1]) * (m[2] === 'cm' ? 10 : 1);
      // The cable clip names a 20 mm desk edge, not a printed size.
      if (/desk edge/.test(s.text) && mm <= 20) continue;
      assert.ok(mm <= 180, s.text);
    }
  }
});

test('cleanIdeaText: marker, quotes, dashes, whitespace, length', () => {
  assert.equal(cleanIdeaText('1. "A moon lamp \u2013 10 cm"'), 'A moon lamp, 10 cm');
  assert.equal(cleanIdeaText('- A box\u2014lid'), 'A box-lid');
  assert.equal(cleanIdeaText('  *  A   box \n with lid '), 'A box with lid');
  const long = cleanIdeaText('word '.repeat(40));
  assert.ok(long.length <= 120);
  assert.ok(long.endsWith('word'));
});

test('parseIdeas drops unavailable modes', () => {
  const t = 'Here: [{"text":"Dragon","mode":"figure"},{"text":"Moon","mode":"lithophane"},{"text":"Box","mode":"off"}]';
  assert.deepEqual(parseIdeas(t, ['off', 'lithophane']), [{ text: 'Moon', mode: 'lithophane' }, { text: 'Box', mode: 'off' }]);
});

test('parseIdeas drops duplicates and non-strings, caps at 4, throws without an array', () => {
  const arr = [{ text: 'A', mode: 'off' }, { text: 'a', mode: 'off' }, { text: 5, mode: 'off' }, { text: 'B', mode: 'off' }, { text: 'C', mode: 'off' }, { text: 'D', mode: 'off' }, { text: 'E', mode: 'off' }];
  assert.deepEqual(parseIdeas(JSON.stringify(arr), ['off']).map((i) => i.text), ['A', 'B', 'C', 'D']);
  assert.throws(() => parseIdeas('no json', ['off']), /No ideas came back/);
  assert.throws(() => parseIdeas('[{oops]', ['off']), /No ideas came back/);
});

test('topUp fills from the starters, skipping avoided texts', () => {
  const r = topUp([{ text: 'Box', mode: 'off' }], ['off'], [STARTERS[0].text]);
  assert.equal(r.length, 4);
  assert.equal(r[0].text, 'Box');
  assert.ok(r.every((i) => i.text !== STARTERS[0].text));
});

test('ideasPrompt names the bed, the allowed modes and what was shown', () => {
  const p = ideasPrompt({ modes: ['off', 'lithophane'], bed: [256, 256], height: 256, printerName: 'Bambu A1', shown: ['A moon', 'A box'] });
  assert.ok(p.includes('256 x 256'));
  assert.ok(p.includes('off') && p.includes('lithophane'));
  assert.ok(p.includes('A moon') && p.includes('A box'));
  for (const m of ['artwork', 'layertone', 'lineart', 'figure']) assert.ok(!p.includes(m), m);
});

// ---- POST /api/ideas (a stand-in for Claude)
const { mkdtempSync, rmSync } = await import('node:fs');
const os = await import('node:os');
const pathMod = await import('node:path');
const { createServer } = await import('node:http');
const { after } = await import('node:test');
const dataDir = mkdtempSync(pathMod.join(os.tmpdir(), 'jig-ideas-test-'));
process.env.JIG_DATA = dataDir;
process.env.ANTHROPIC_API_KEY = 'sk-test';
const { createApp } = await import('../server/app');

let reply: () => string = () => '[]';
let lastPrompt = '';
const ideasServer = createServer();
await new Promise<void>((r) => ideasServer.listen(0, '127.0.0.1', r));
const ideasPort = (ideasServer.address() as { port: number }).port;
ideasServer.on('request', createApp({ port: ideasPort, ideas: async (p) => { lastPrompt = p; return reply(); } }));
after(() => { ideasServer.close(); rmSync(dataDir, { recursive: true, force: true }); });
const postIdeas = (body: unknown) => fetch(`http://127.0.0.1:${ideasPort}/api/ideas`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jig': '1' }, body: JSON.stringify(body) });

test('POST /api/ideas: four ideas, topped up, in available modes', async () => {
  reply = () => '[{"text":"Moon lamp","mode":"off"}]';
  const res = await postIdeas({ shown: [] });
  assert.equal(res.status, 200);
  const { ideas } = (await res.json()) as { ideas: { text: string; mode: string }[] };
  assert.equal(ideas.length, 4);
  assert.deepEqual(ideas[0], { text: 'Moon lamp', mode: 'off' });
  const { artworkAvailable } = await import('../server/artwork');
  const { meshyAvailable } = await import('../server/meshy');
  const modes = ideaModes({ artwork: artworkAvailable(), meshy: meshyAvailable() });
  for (const i of ideas) assert.ok(modes.includes(i.mode as IdeaMode), i.mode);
});

test('POST /api/ideas: the prompt carries the shown ideas', async () => {
  reply = () => '[{"text":"Moon lamp","mode":"off"}]';
  await postIdeas({ shown: ['Wall hook for keys', 'Tiny dragon'] });
  assert.match(lastPrompt, /Wall hook for keys/);
  assert.match(lastPrompt, /Tiny dragon/);
});

test('POST /api/ideas: no ideas is a 502', async () => {
  reply = () => 'sorry';
  const res = await postIdeas({ shown: [] });
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /Couldn't come up with ideas/);
});

test('POST /api/ideas: checks what it is sent', async () => {
  assert.equal((await postIdeas({ shown: 'x' })).status, 400);
  assert.equal((await postIdeas({ shown: Array(9).fill('a') })).status, 400);
  assert.equal((await postIdeas({ shown: [5] })).status, 400);
  assert.equal((await postIdeas({ shown: ['a'.repeat(201)] })).status, 400);
});

test('POST /api/ideas: a failure is a 502 with a plain message', async () => {
  reply = () => { throw new Error('boom'); };
  const res = await postIdeas({ shown: [] });
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { error: string }).error, "Couldn't come up with ideas. Try again.");
});

test('POST /api/ideas: a repeat of a shown idea is never returned as new', async () => {
  const X = 'A moon lamp, 10 cm across';
  reply = () => JSON.stringify([{ text: X.toUpperCase(), mode: 'off' }, { text: 'A pen cup, 8 cm', mode: 'off' }]);
  const res = await postIdeas({ shown: [`  ${X} `] });
  const { ideas } = (await res.json()) as { ideas: { text: string }[] };
  assert.equal(ideas.length, 4);
  assert.equal(ideas[0].text, 'A pen cup, 8 cm');
  assert.ok(ideas.every((i) => i.text.trim().toLowerCase() !== X.toLowerCase()));
});

test('writeIdeas: its own timeout reads as taking too long, not as an abort', async () => {
  const { writeIdeas, IDEAS_TIMEOUT_MESSAGE } = await import('../server/ideas');
  type query = typeof import('@anthropic-ai/claude-agent-sdk').query;
  const run = ((a: { options: { abortController: AbortController } }) => (async function* () {
    await new Promise((_, rej) => a.options.abortController.signal.addEventListener('abort', () => rej(new Error('Claude Code process aborted by user'))));
    yield undefined;
  })()) as unknown as query;
  await assert.rejects(writeIdeas('x', { timeoutMs: 20, run }), new Error(IDEAS_TIMEOUT_MESSAGE));
  const failing = (() => (async function* () { throw new Error('other'); yield undefined; })()) as unknown as query;
  await assert.rejects(writeIdeas('x', { timeoutMs: 1000, run: failing }), /other/);
});

test('POST /api/ideas: 503 without Claude credentials', async () => {
  const KEYS = ['JIG_AUTH', 'JIG_DOCKER', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENROUTER_API_KEY'];
  const saved = { ...process.env };
  try {
    for (const k of KEYS) delete process.env[k];
    const res = await postIdeas({ shown: [] });
    assert.equal(res.status, 503);
  } finally {
    Object.assign(process.env, saved);
  }
});
