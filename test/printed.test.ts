import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPrintedMap, PRINTED_FILE, printedFileName, type PrintedMark } from '../shared/printed';
import { printedGuard, versionFingerprint as fp } from '../server/printed';
import { markProblem } from '../src/app/printed';

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
