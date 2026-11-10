import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { FILAMENT_LIBRARY, matchFilament, normalizeFilamentText, searchFilaments } from '../shared/filaments';

// The server reads its data folder when loaded: a folder of its own, and a stand-in for Claude.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-filaments-test-'));
process.env.PTP_DATA = dataDir;
process.env.PTP_AUTH = 'subscription';
const { lookupFilament, parseLookup } = await import('../server/filaments');
const { createApp } = await import('../server/app');

const id = (f: { brand: string; name: string }) => `${f.brand} ${f.name}`;

test('every library filament has a colour, a usable TD and a source', () => {
  assert.ok(FILAMENT_LIBRARY.length >= 80);
  const seen = new Set<string>();
  for (const f of FILAMENT_LIBRARY) {
    assert.match(f.color, /^#[0-9a-f]{6}$/, id(f));
    assert.ok(f.td >= 0.1 && f.td <= 20, `${id(f)}: TD ${f.td}`);
    assert.match(f.source ?? '', /^https:\/\/\S+$/, id(f));
    assert.ok(f.line && f.name.startsWith(`${f.line} `), `${id(f)}: the name starts with the line`);
    assert.ok(!seen.has(id(f)), `${id(f)} twice`);
    seen.add(id(f));
  }
  // Sorted by brand, line, then name.
  const key = (f: (typeof FILAMENT_LIBRARY)[number]) => [f.brand, f.line ?? '', f.name].map((s) => s.toLowerCase()).join('\u0000');
  const keys = FILAMENT_LIBRARY.map(key);
  assert.deepEqual(keys, [...keys].sort());
  for (const brand of ['Bambu Lab', 'eSUN']) assert.ok(FILAMENT_LIBRARY.some((f) => f.brand === brand), brand);
});

test('aliases: Bambu Lab, PLA Plus and grey', () => {
  assert.equal(normalizeFilamentText('Bambu Lab PLA Plus Grey'), 'bambu pla+ gray');
  assert.equal(normalizeFilamentText('BambuLab  PLA+ (Silk)'), 'bambu pla+ silk');
  assert.equal(normalizeFilamentText('eSUN PLA +'), 'esun pla+');
});

test('search ranks the closest filaments first', () => {
  const first = (q: string) => id(searchFilaments(q)[0]);
  assert.equal(first('bambu black'), 'Bambu Lab PLA Basic Black');
  assert.equal(first('Bambu Lab PLA Basic Black'), 'Bambu Lab PLA Basic Black');
  assert.equal(first('bambu matte charcoal'), 'Bambu Lab PLA Matte Charcoal');
  assert.equal(first('esun pla+ red'), 'eSUN PLA+ Red');
  assert.equal(first('esun pla plus red'), 'eSUN PLA+ Red');
  assert.equal(first('esun gray'), 'eSUN PLA+ Grey');
  assert.equal(first('bambu white'), 'Bambu Lab PLA Basic Jade White');
  assert.equal(first('bambu silk gold'), 'Bambu Lab PLA Silk+ Gold');
  assert.deepEqual(searchFilaments('red', 3).map(id), ['Bambu Lab PLA Basic Red', 'eSUN PLA+ Red', 'Bambu Lab PLA Basic Maroon Red']);
  // Every result has every word, in some form.
  for (const f of searchFilaments('bambu red')) assert.match(id(f).toLowerCase(), /bambu.*red/);
  for (const f of searchFilaments('pla+')) assert.equal(f.brand, 'eSUN');
  assert.ok(searchFilaments('esun').every((f) => f.brand === 'eSUN'));
  assert.equal(searchFilaments('bambu').length, 20);
  assert.equal(searchFilaments('bambu', 5).length, 5);
  assert.deepEqual(searchFilaments('unobtainium'), []);
  assert.equal(searchFilaments('').length, 20);
});

test('a brand and name find the library filament they mean', () => {
  const m = (brand: string, name: string) => { const f = matchFilament(brand, name); return f && id(f); };
  assert.equal(m('Bambu Lab', 'PLA Basic Black'), 'Bambu Lab PLA Basic Black');
  assert.equal(m('bambu', 'Black'), 'Bambu Lab PLA Basic Black');
  assert.equal(m('BambuLab', 'Bambu Lab PLA Black'), 'Bambu Lab PLA Basic Black');
  assert.equal(m('Bambu Lab', 'PLA Matte Ash Grey'), 'Bambu Lab PLA Matte Ash Gray');
  assert.equal(m('eSUN', 'PLA Plus Red'), 'eSUN PLA+ Red');
  assert.equal(m('eSUN', 'Red'), 'eSUN PLA+ Red');
  assert.equal(m('Bambu', 'Silk+ Gold'), 'Bambu Lab PLA Silk+ Gold');
  assert.equal(m('Bambu Lab', 'Jade White'), 'Bambu Lab PLA Basic Jade White');
  // Not this brand's, or a colour the name doesn't say.
  assert.equal(m('eSUN', 'PLA Basic Jade White'), undefined);
  assert.equal(m('Bambu Lab', 'Ash'), undefined);
  assert.equal(m('Bambu Lab', 'Ash Gray'), undefined); // PLA Matte Ash Gray: the finish is part of the filament
  assert.equal(m('Bambu Lab', 'White'), undefined);
  assert.equal(m('Polymaker', 'PolyTerra Charcoal Black'), undefined);
  assert.equal(m('Bambu Lab', ''), undefined);
});

test('Claude\'s answers are checked', () => {
  const q = { brand: 'Polymaker', name: 'PolyTerra Charcoal Black' };
  const ok = parseLookup('Here it is: {"name": "PolyTerra PLA Charcoal Black", "line": "PolyTerra PLA", "color": "#1A1A1A", "td": 0.43, "source": "https://filamentcolors.xyz/swatch/1/", "match": "exact", "note": "Measured swatch."}', q);
  assert.deepEqual(ok, {
    filament: { brand: 'Polymaker', line: 'PolyTerra PLA', name: 'PolyTerra PLA Charcoal Black', color: '#1a1a1a', td: 0.4, source: 'https://filamentcolors.xyz/swatch/1/' },
    confidence: 'similar',
    note: 'Found on the web, not in the built-in library: Measured swatch.',
  });
  const est = parseLookup('{"color": "#ffffff", "td": 4, "match": "estimate", "note": "From similar whites."}', q);
  assert.equal(est.confidence, 'estimate');
  assert.equal(est.filament.name, q.name);
  assert.equal(est.filament.source, 'AI estimate');
  const bad = (text: string) => assert.throws(() => parseLookup(text, q));
  bad('no idea');
  bad('{"color": "white", "td": 4, "match": "estimate"}');
  bad('{"color": "#ffffff", "td": 40, "match": "estimate"}');
  bad('{"color": "#ffffff", "td": 0, "match": "estimate"}');
  bad('{"color": "#ffffff", "td": 2, "match": "exact"}');
  bad('{"color": "#ffffff", "td": 2, "match": "similar", "source": "http://127.0.0.1/x"}');
});

// The API on a free port; the app needs the port for its Host check.
const server: Server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
const asked: string[] = [];
server.on('request', createApp({
  port,
  lookup: (q) => lookupFilament(q, async ({ brand, name }) => {
    asked.push(`${brand} ${name}`);
    if (name === 'Fails') throw new Error('no luck');
    return JSON.stringify({ name, color: '#336699', td: 2.5, source: 'https://example.com/td', match: 'similar', note: 'From a close match.' });
  }),
}));
after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/filaments/lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PTP': '1' }, body: JSON.stringify(body) });

test('the lookup route checks what it is sent', async () => {
  for (const body of [{}, { brand: 'eSUN' }, { name: 'Red' }, { brand: 1, name: 'Red' }, { brand: 'eSUN', name: ['Red'] }, { brand: ' ', name: 'Red' }, { brand: 'eSUN', name: 'x'.repeat(121) }, { brand: 'x'.repeat(61), name: 'Red' }]) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok((await r.json()).error);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/filaments/lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"brand":"eSUN","name":"Red"}' })).status, 403);
  assert.deepEqual(asked, []);
});

test('library filaments come back listed, others from Claude (once)', async () => {
  const listed = await post({ brand: 'Bambu Lab', name: 'PLA Basic Black' });
  assert.equal(listed.status, 200);
  const l = await listed.json();
  assert.equal(l.confidence, 'listed');
  assert.equal(id(l.filament), 'Bambu Lab PLA Basic Black');
  assert.deepEqual(asked, []);
  const unverified = await (await post({ brand: 'Bambu Lab', name: 'PLA Silk+ Gold' })).json();
  assert.equal(unverified.confidence, 'estimate');
  assert.equal(unverified.filament.unverified, true);
  assert.ok(unverified.note);
  const found = await (await post({ brand: 'Polymaker', name: 'PolyTerra Teal' })).json();
  assert.deepEqual(found, { filament: { brand: 'Polymaker', name: 'PolyTerra Teal', color: '#336699', td: 2.5, source: 'https://example.com/td' }, confidence: 'similar', note: 'From a close match.' });
  await post({ brand: 'polymaker', name: 'polyterra  teal' });
  assert.deepEqual(asked, ['Polymaker PolyTerra Teal']);
  // A failure is reported and not remembered.
  for (let i = 0; i < 2; i++) {
    const r = await post({ brand: 'Acme', name: 'Fails' });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error, 'no luck');
  }
  assert.equal(asked.filter((a) => a === 'Acme Fails').length, 2);
});

test('without Claude, only library filaments can be looked up', async () => {
  const saved = { auth: process.env.PTP_AUTH, key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN, openrouter: process.env.OPENROUTER_API_KEY };
  delete process.env.PTP_AUTH; delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN; delete process.env.OPENROUTER_API_KEY;
  try {
    assert.equal((await post({ brand: 'eSUN', name: 'PLA+ Red' })).status, 200);
    const r = await post({ brand: 'Polymaker', name: 'PolyTerra Sakura' });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
    assert.ok(!asked.includes('Polymaker PolyTerra Sakura'));
  } finally {
    for (const [k, v] of [['PTP_AUTH', saved.auth], ['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_AUTH_TOKEN', saved.token], ['OPENROUTER_API_KEY', saved.openrouter]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

const mineUrl = () => `http://127.0.0.1:${port}/api/filaments/mine`;
const putMine = (body: unknown) => fetch(mineUrl(), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PTP': '1' }, body: JSON.stringify(body) });

test('my filaments: checked, saved in the data folder, read back', async () => {
  assert.deepEqual(await (await fetch(mineUrl())).json(), { filaments: [] });
  const ok = { name: 'PolyTerra Teal', brand: 'Polymaker', color: '#33AA77', td: 2.5 };
  for (const body of [{}, { filaments: 'x' }, { filaments: [{ ...ok, name: '' }] }, { filaments: [{ ...ok, name: 'x'.repeat(121) }] }, { filaments: [{ ...ok, brand: 'x'.repeat(61) }] },
    { filaments: [{ ...ok, brand: 3 }] }, { filaments: [{ ...ok, color: 'teal' }] }, { filaments: [{ ...ok, color: '#33aa7' }] }, { filaments: [{ ...ok, td: 0.01 }] }, { filaments: [{ ...ok, td: 21 }] },
    { filaments: [{ ...ok, td: '2' }] }, { filaments: Array.from({ length: 101 }, (_, i) => ({ ...ok, name: `F${i}` })) }]) {
    const r = await putMine(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 120));
    assert.ok((await r.json()).error);
  }
  assert.equal((await fetch(mineUrl(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filaments: [ok] }) })).status, 403);
  // Trimmed, colour in lower case, one per brand and name (the last wins), no brand allowed.
  const r = await putMine({ filaments: [{ ...ok, name: ' PolyTerra Teal ' }, { name: 'Leftover grey', color: '#808080', td: 0.05 }, { ...ok, name: 'polyterra teal', td: 3 }] });
  assert.equal(r.status, 200);
  const want = [{ name: 'Leftover grey', color: '#808080', td: 0.05 }, { name: 'polyterra teal', brand: 'Polymaker', color: '#33aa77', td: 3 }];
  assert.deepEqual((await r.json()).filaments, want);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'filaments.json'), 'utf8')), { filaments: want });
  assert.deepEqual((await (await fetch(mineUrl())).json()).filaments, want);
  const { readMyFilaments } = await import('../server/myFilaments');
  assert.deepEqual(await readMyFilaments(), want);
  // A broken file reads as none.
  writeFileSync(path.join(dataDir, 'filaments.json'), '{not json');
  assert.deepEqual(await readMyFilaments(), []);
  assert.equal((await putMine({ filaments: [] })).status, 200);
});

test('my filaments go into the LayerTone prompt, marked as the user\'s own', async () => {
  const { buildSystemPrompt } = await import('../server/systemPrompt');
  const mine = [{ name: 'PolyTerra Teal', brand: 'Polymaker', color: '#33aa77', td: 2.5 }, { name: 'Leftover grey', color: '#808080', td: 1 }];
  const p = buildSystemPrompt({ workspaceFile: '/w/model.js', webSearch: false, layerTone: { pictures: false, mine } });
  assert.match(p, /The user's own filaments[^\n]*prefer them/);
  assert.match(p, /PolyTerra Teal \(Polymaker\) #33aa77 2\.5/);
  assert.match(p, /Leftover grey #808080 1\n/);
  const none = buildSystemPrompt({ workspaceFile: '/w/model.js', webSearch: false, layerTone: { pictures: false } });
  assert.doesNotMatch(none, /The user's own filaments/);
  assert.doesNotMatch(buildSystemPrompt({ workspaceFile: '/w/model.js', webSearch: false }), /The user's own filaments/);
});
