// The colour paint palette (PAINT_LIBRARY) is built from the frozen base list: a Bambu Lab PLA Basic
// colour added to the library later must not join it. PAINT_LIBRARY is computed when shared/meshColors
// loads, so this file adds the entry first and only then imports it (node:test runs each file in its
// own process; nothing imported above loads shared/meshColors).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILAMENT_LIBRARY } from '../shared/filamentLibrary';
import type { LibraryFilament } from '../shared/filaments';

test('a Bambu Lab PLA Basic colour added to the library is not in the paint palette', async () => {
  const added: LibraryFilament = { brand: 'Bambu Lab', line: 'PLA Basic', name: 'PLA Basic Zz Test', color: '#12ab34', td: 2, source: 'test' };
  FILAMENT_LIBRARY.push(added);
  try {
    const { PAINT_LIBRARY } = await import('../shared/meshColors');
    assert.equal(PAINT_LIBRARY.length, 55);
    assert.ok(!PAINT_LIBRARY.includes(added));
  } finally {
    FILAMENT_LIBRARY.splice(-1);
  }
});
