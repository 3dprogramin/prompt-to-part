import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { IMAGE_MODES } from '../src/components/chat/PictureModeMenus.tsx';
import { MODE_TEXT } from '../src/components/chat/modeExamples.ts';

test('every mode has an example', () => {
  for (const { mode } of IMAGE_MODES) {
    const ex = MODE_TEXT[mode];
    assert.ok(ex, mode);
    assert.ok(ex.request.trim().length > 0, mode);
    assert.ok(ex.facts.length >= 2 && ex.facts.length <= 4, mode);
    assert.doesNotMatch(JSON.stringify(ex), /[–—]/, mode);
    for (const f of [`${mode}.webp`, `${mode}-big.webp`]) {
      assert.ok(existsSync(new URL(`../src/assets/modes/${f}`, import.meta.url)), f);
    }
  }
});
