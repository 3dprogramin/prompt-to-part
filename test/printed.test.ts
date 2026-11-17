import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanPrintedMap, PRINTED_FILE, printedFileName, type PrintedMark } from '../shared/printed';
import { BACK_TEXT_KEY, setBackTextDefault } from '../shared/backText';
import type { Design } from '../shared/types';

// The migration writes designs and printed.json: its own data folder, set before the server code loads.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ptp-printed-test-'));
process.env.PTP_DATA = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
const { printedGuard, versionFingerprint: fp, pinLegacyBackText, PRINTED_JSON, readPrinted } = await import('../server/printed');
const { markProblem, pinForPrint, printedActions } = await import('../src/app/printed');

test('fingerprint ignores key order and changes with code or any value', () => {
  const a = fp({ code: 'a', values: { x: 1, y: { b: 2, a: 1 } } as never });
  assert.equal(fp({ code: 'a', values: { y: { a: 1, b: 2 }, x: 1 } as never }), a);
  assert.notEqual(fp({ code: 'b', values: { x: 1, y: { b: 2, a: 1 } } as never }), a);
  assert.notEqual(fp({ code: 'a', values: { x: 2, y: { b: 2, a: 1 } } as never }), a);
});

test('guard finds a printed version that changed, went missing or moved', () => {
  const v = (code: string) => ({ code, values: {} }) as never;
  const [A, B, B2, C] = [v('A'), v('B'), v('B2'), v('C')];
  const mark: PrintedMark = { v: 1, at: 1, fp: fp(B), file: false, settings: false };
  assert.equal(printedGuard({ versions: [A, B] }, [mark]), null);
  assert.equal(printedGuard({ versions: [A, B, C] }, [mark]), null);
  for (const versions of [[A, B2], [A], [B, A]]) assert.equal(printedGuard({ versions }, [mark]), mark);
});

test('cleanPrintedMap keeps good marks, one per version, sorted', () => {
  const m = (v: number) => ({ v, at: 5, fp: 'f', file: false, settings: false });
  const got = cleanPrintedMap({
    'design-0001': [m(3), m(1), m(3)], 'bad id': [m(1)], 'design-0002': [], 'design-0003': [{ v: -1 }],
  }, (id) => /^design-\d{4}$/.test(id));
  assert.deepEqual(got, { 'design-0001': [m(1), m(3)] });
});

test('printed file names', () => {
  assert.equal(printedFileName(6), 'v7.3mf');
  for (const bad of ['../v7.3mf', 'v0.3mf', 'v7.stl']) assert.equal(PRINTED_FILE.test(bad), false);
  assert.equal(PRINTED_FILE.test('v7.3mf'), true);
});

test('markProblem gives the first reason marking can\'t happen', () => {
  const ok = { generating: false, unsavedSettings: false, hasCode: true };
  assert.equal(markProblem({ ...ok, generating: true, unsavedSettings: true, hasCode: false }), 'Wait for the reply to finish');
  assert.equal(markProblem({ ...ok, unsavedSettings: true, hasCode: false }), 'Save or discard your settings first');
  assert.equal(markProblem({ ...ok, hasCode: false }), 'Nothing to print yet');
  assert.equal(markProblem(ok), null);
});

const LT_CODE = 'return H.layertone({});';
const ltDesign = (id: string, versions: { code: string; values?: Design['values'] }[], current = versions.length - 1): Design => ({
  id, name: id, createdAt: 0, updatedAt: 0, messages: [], currentVersion: current,
  code: versions[current].code, values: { ...(versions[current].values ?? {}) },
  versions: versions.map((v) => ({ ...v, summary: '', createdAt: 0, source: 'ai' as const })),
});
const designsDir = path.join(dataDir, 'designs');
const writeDesign = (d: Design) => { mkdirSync(designsDir, { recursive: true }); writeFileSync(path.join(designsDir, `${d.id}.json`), JSON.stringify(d)); };
const readDesign = (id: string) => JSON.parse(readFileSync(path.join(designsDir, `${id}.json`), 'utf8')) as Design;
const OFF = '{"off":true}';

test('versions marked printed without a back text key keep printing without it', async () => {
  const old = ltDesign('design-old-1', [{ code: LT_CODE, values: { w: 1 } }, { code: LT_CODE, values: { w: 2 } }]);
  const recent = ltDesign('design-recent-1', [{ code: LT_CODE, values: { w: 3 } }]);
  const kept = ltDesign('design-kept-1', [{ code: LT_CODE, values: { w: 4, [BACK_TEXT_KEY]: '{"text":"x"}' } }]);
  for (const d of [old, recent, kept]) writeDesign(d);
  const mark = (d: Design, v: number, at: number): PrintedMark => ({ v, at, fp: fp(d.versions[v]), file: true, settings: true });
  const marks = {
    'design-old-1': [mark(old, 0, 5), mark(old, 1, 5)],
    // Marked today by code from before the back text: no date makes it new enough to skip.
    'design-recent-1': [mark(recent, 0, Date.now())],
    'design-kept-1': [mark(kept, 0, 5)],
    // A mark on a design that is gone: skipped, the rest still pinned.
    'design-gone-1': [{ v: 0, at: 5, fp: 'f', file: false, settings: false }],
  };
  writeFileSync(PRINTED_JSON, JSON.stringify({ printed: marks }));
  const keptBefore = readFileSync(path.join(designsDir, 'design-kept-1.json'), 'utf8');

  assert.equal(await pinLegacyBackText(), 3);
  const got = readDesign('design-old-1');
  assert.equal(got.versions[0].values?.[BACK_TEXT_KEY], OFF);
  assert.equal(got.versions[1].values?.[BACK_TEXT_KEY], OFF);
  assert.equal(got.values[BACK_TEXT_KEY], OFF, 'the current version is pinned in the open values too');
  assert.equal(got.versions[1].values?.w, 2);
  assert.equal(got.rev, 1, 'a new revision, so an open tab reloads it');
  const after1 = await readPrinted();
  assert.equal(printedGuard(got, after1['design-old-1']), null, 'the marks follow the pinned versions');
  assert.equal(after1['design-old-1'][0].at, 5, 'the print date stays');
  assert.equal(readDesign('design-recent-1').versions[0].values?.[BACK_TEXT_KEY], OFF, 'a recent mark without the key is pinned too');
  assert.equal(printedGuard(readDesign('design-recent-1'), after1['design-recent-1']), null);
  assert.equal(readFileSync(path.join(designsDir, 'design-kept-1.json'), 'utf8'), keptBefore, 'a version with its own back text is untouched');
  assert.deepEqual(after1['design-kept-1'], marks['design-kept-1']);

  // Again: nothing changes.
  const printedBefore = readFileSync(PRINTED_JSON, 'utf8');
  const oldBefore = readFileSync(path.join(designsDir, 'design-old-1.json'), 'utf8');
  assert.equal(await pinLegacyBackText(), 0);
  assert.equal(readFileSync(PRINTED_JSON, 'utf8'), printedBefore);
  assert.equal(readFileSync(path.join(designsDir, 'design-old-1.json'), 'utf8'), oldBefore);
});

test('the legacy pin leaves a changed version or an unreadable design alone, and mends a half-done run', async () => {
  const changed = ltDesign('design-chg-1', [{ code: LT_CODE, values: { w: 1 } }]);
  const half = ltDesign('design-half-1', [{ code: LT_CODE, values: { w: 1 } }]);
  const fpHalf = fp(half.versions[0]);
  half.versions[0].values = { w: 1, [BACK_TEXT_KEY]: OFF };
  writeDesign(changed);
  writeDesign(half);
  writeFileSync(path.join(designsDir, 'design-bad-1.json'), '{ not json');
  writeFileSync(PRINTED_JSON, JSON.stringify({ printed: {
    'design-chg-1': [{ v: 0, at: 5, fp: 'stale', file: false, settings: false }],
    'design-half-1': [{ v: 0, at: 5, fp: fpHalf, file: false, settings: false }],
    'design-bad-1': [{ v: 0, at: 5, fp: 'f', file: false, settings: false }],
  } }));
  const changedBefore = readFileSync(path.join(designsDir, 'design-chg-1.json'), 'utf8');
  await pinLegacyBackText();
  assert.equal(readFileSync(path.join(designsDir, 'design-chg-1.json'), 'utf8'), changedBefore, 'a version that no longer matches its mark is not pinned');
  const marks = await readPrinted();
  assert.equal(marks['design-chg-1'][0].fp, 'stale');
  assert.equal(printedGuard(readDesign('design-half-1'), marks['design-half-1']), null, 'pinned design whose mark was not rewritten');
});

test('marking a LayerTone version pins the back text it prints with', () => {
  setBackTextDefault('shop.example');
  const d = ltDesign('design-pin-1', [{ code: LT_CODE, values: { w: 1 } }, { code: LT_CODE, values: { w: 2 } }]);
  const pinned = pinForPrint(d, 1);
  const want = JSON.stringify({ text: 'shop.example', size: 30, position: 'corner' });
  assert.equal(pinned.versions[1].values?.[BACK_TEXT_KEY], want);
  assert.equal(pinned.values[BACK_TEXT_KEY], want);
  assert.equal(pinned.versions[0].values?.[BACK_TEXT_KEY], undefined, 'only the marked version');
  assert.equal(pinForPrint(pinned, 1), pinned, 'already pinned: the same design');
  const model = { ...d, code: 'return H.box(1);', versions: d.versions.map((v) => ({ ...v, code: 'return H.box(1);' })) };
  assert.equal(pinForPrint(model, 1), model, 'not LayerTone: unchanged');
  // A setting that says only some of it: written out in the version and the open values alike.
  setBackTextDefault('shop.example');
  const half = { ...d, values: { w: 2, [BACK_TEXT_KEY]: '{"size":50}' }, versions: d.versions.map((v, i) => (i === 1 ? { ...v, values: { w: 2, [BACK_TEXT_KEY]: '{"size":50}' } } : v)) };
  const halfPinned = pinForPrint(half, 1), full = JSON.stringify({ text: 'shop.example', size: 50, position: 'corner' });
  assert.equal(halfPinned.versions[1].values?.[BACK_TEXT_KEY], full);
  assert.equal(halfPinned.values[BACK_TEXT_KEY], full);
  setBackTextDefault('');
  assert.equal(pinForPrint(d, 1).versions[1].values?.[BACK_TEXT_KEY], OFF);
  assert.equal(pinForPrint(half, 1).versions[1].values?.[BACK_TEXT_KEY], OFF, 'no default: it printed none');
});

test('mark saves the pinned design, shows it and builds the 3MF from it', async () => {
  setBackTextDefault('shop.example');
  const d = ltDesign('design-mark-1', [{ code: LT_CODE, values: { w: 1 } }]);
  const want = JSON.stringify({ text: 'shop.example', size: 30, position: 'corner' });
  let saved: Design | null = null, built: Record<string, unknown> | null = null, shown: Design | null = null, posted = '';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { posted = url; return new Response(JSON.stringify({ v: 0, at: 1, file: false, settings: false })); }) as typeof fetch;
  try {
    const { mark } = printedActions({
      design: d, problem: null, printedVersions: new Set(),
      saveNow: async (x) => { saved = x; },
      setDesign: (u) => { shown = typeof u === 'function' ? u(d) : u; },
      build3mf: (async (values: Record<string, unknown>) => { built = values; return { error: 'none here' }; }) as never,
      refreshList: () => {}, setNotice: () => {}, setMarking: () => {},
    });
    await mark();
  } finally {
    globalThis.fetch = realFetch;
    setBackTextDefault('');
  }
  assert.equal(saved!.versions[0].values?.[BACK_TEXT_KEY], want);
  assert.equal(shown!.versions[0].values?.[BACK_TEXT_KEY], want);
  assert.equal(shown!.values[BACK_TEXT_KEY], want);
  assert.equal(built![BACK_TEXT_KEY], want);
  assert.equal(posted, '/api/designs/design-mark-1/printed/0');
});

test('marking again an already printed version keeps it as it was printed', async () => {
  setBackTextDefault('shop.example');
  const d = ltDesign('design-mark-2', [{ code: LT_CODE, values: { w: 1 } }]);
  let saved: Design | null = null, setCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}')) as typeof fetch;
  try {
    const { mark } = printedActions({
      design: d, problem: null, printedVersions: new Set([0]),
      saveNow: async (x) => { saved = x; },
      setDesign: () => { setCalled = true; },
      build3mf: (async () => ({ error: 'none' })) as never,
      refreshList: () => {}, setNotice: () => {}, setMarking: () => {},
    });
    await mark();
  } finally {
    globalThis.fetch = realFetch;
    setBackTextDefault('');
  }
  assert.equal(saved, d);
  assert.equal(setCalled, false);
});
