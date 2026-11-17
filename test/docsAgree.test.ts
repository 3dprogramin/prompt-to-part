// Prose that must keep agreeing with the code or with each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

test('lineart/depth.ts describes the coverage as LayerTone computes it (k = 30), not the old k = 3', () => {
  assert.doesNotMatch(read('shared/lineart/depth.ts'), /e\^\(-3t\/TD\)/);
});

test('SECURITY.md allows an HTTPS reverse proxy the way docs/running.md describes it, and keeps the warning', () => {
  const security = read('SECURITY.md');
  assert.doesNotMatch(security, /or put it behind a public proxy/);
  assert.match(security, /PTP_ORIGINS/);
  assert.match(security, /PTP_PASSWORD/);
  assert.match(security, /don't expose it to the internet/i);
});
