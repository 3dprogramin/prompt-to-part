// Text parameters can limit their length and the characters they accept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, normalizeParams, resolveValues, textProblem } from '../shared/params';

test('normalizeParams keeps maxLength and chars', () => {
  const p: any = normalizeParams({ name: { type: 'text', value: 'ANA', maxLength: 14, chars: 'letters' }, year: { type: 'text', value: '2026', maxLength: 4, chars: 'digits' }, tag: { type: 'text', value: 'A', chars: { only: 'AB-' } } });
  assert.deepEqual([p.name.maxLength, p.name.chars], [14, 'letters']);
  assert.equal(p.year.chars, 'digits');
  assert.deepEqual(p.tag.chars, { only: 'AB-' });
});
test('normalizeParams drops unusable limits', () => {
  const p: any = normalizeParams({ a: { type: 'text', value: '', maxLength: 0, chars: 'emoji' }, b: { type: 'text', value: '', maxLength: 99999 } });
  assert.equal(p.a.maxLength, undefined); assert.equal(p.a.chars, undefined);
  assert.equal(p.b.maxLength, 2000);
});
test('textProblem', () => {
  assert.equal(textProblem({ chars: 'letters' }, 'Zoë Ana'), null);
  assert.equal(textProblem({ chars: 'letters' }, 'Ana!'), 'Only letters and spaces');
  assert.equal(textProblem({ chars: 'digits', maxLength: 4 }, '20265'), 'At most 4 characters');
  assert.equal(textProblem({ chars: 'digits' }, '20a6'), 'Only digits (0 to 9)');
  assert.equal(textProblem({ maxLength: 3 }, 'ÉÉÉ'), null);
  assert.equal(textProblem({ chars: { only: 'AB-' } }, 'AC'), 'Only these characters: AB-');
  assert.equal(textProblem({ maxLength: 1 }, '😀'), null);
});
test('cleanText drops refused characters, then cuts to maxLength', () => {
  assert.equal(cleanText({ chars: 'digits', maxLength: 4 }, '2a0b2c6d7'), '2026');
  assert.equal(cleanText({}, 'anything *!'), 'anything *!');
});
test('resolveValues cleans text values the script gets', () => {
  const p = normalizeParams({ year: { type: 'text', value: '2026', maxLength: 4, chars: 'digits' } });
  assert.equal(resolveValues(p, { year: '1999x9' }).year, '1999');
});
test('a design without limits is unchanged', () => {
  const p = normalizeParams({ name: { type: 'text', value: 'ANA' } });
  assert.equal(resolveValues(p, { name: 'a*b!' }).name, 'a*b!');
});
