import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import { withFonts } from '../shared/text';
import { loadFontBuffers } from '../server/fonts';

const run = (code: string) => withFonts(() => evaluateScript(code, {}, 'draft'), loadFontBuffers);

test('H.warn adds a warning', async () => {
  const r = await run("function build() { H.warn('The name is too long'); return Manifold.cube([10,10,10]); }");
  assert.ok(r.warnings.includes('The name is too long'));
});
test('H.warn twice with the same text gives one warning', async () => {
  const r = await run("function build() { H.warn('x'); H.warn('x'); return Manifold.cube([5,5,5]); }");
  assert.equal(r.warnings.filter((w) => w === 'x').length, 1);
});
test('a long H.warn message is cut', async () => {
  const r = await run("function build() { H.warn('a'.repeat(1000)); return Manifold.cube([5,5,5]); }");
  assert.ok(r.warnings.every((w) => w.length <= 330));
});
