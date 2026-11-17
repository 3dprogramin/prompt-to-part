// The back text's length and size limits live in shared/backText.ts only; the panel, the config and the agent tool use them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as shared from '../shared/backText';

const root = path.resolve(import.meta.dirname, '..');
const source = (f: string) => readFileSync(path.join(root, f), 'utf8');

test('the back text limits are exported once', () => {
  assert.equal(shared.BACK_TEXT_MAX_LENGTH, 40);
  assert.equal(shared.BACK_TEXT_MIN_SIZE, 20);
  assert.equal(shared.BACK_TEXT_MAX_SIZE, 95);
});

test('the panel, the config and the agent tool take the limits from shared/backText', () => {
  assert.doesNotMatch(source('src/components/LayerTonePanel.tsx'), /BACK_TEXT_MAX = 40|min=\{20\} max=\{95\}/);
  assert.doesNotMatch(source('server/config.ts'), /slice\(0, 40\)/);
  assert.doesNotMatch(source('server/tools/layerTone.ts'), /max\(40\)/);
});
