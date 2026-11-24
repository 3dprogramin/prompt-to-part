import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchStandardFont, standardFontFiles, standardFontId } from '../shared/fontCatalog';

test('matchStandardFont', () => {
  assert.equal(standardFontId(matchStandardFont('Montserrat Black')!), 'std:montserrat-900');
  assert.equal(standardFontId(matchStandardFont('std:lobster-400')!), 'std:lobster-400');
  assert.equal(standardFontId(matchStandardFont('roboto')!), 'std:roboto-400');
  assert.equal(matchStandardFont('Comic Sans'), null);
});

test('standardFontFiles lists the latin and latin-ext files', () => {
  assert.deepEqual(standardFontFiles(matchStandardFont('Montserrat Black')!), ['montserrat/files/montserrat-latin-900-normal.woff', 'montserrat/files/montserrat-latin-ext-900-normal.woff']);
});
