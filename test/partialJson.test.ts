import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partialFields } from '../server/partialJson';

test('complete and cut-off JSON', () => {
  assert.deepEqual(partialFields('{"a":"x","b":"y"}'), { a: 'x', b: 'y' });
  assert.equal(partialFields('{"content":"line 1\\nline 2 \\"q').content, 'line 1\nline 2 "q');
  assert.equal(partialFields('{"a":"x\\').a, 'x');
  assert.equal(partialFields('{"a":"x\\u00').a, 'x');
  assert.equal(partialFields('{"a":"\\ud83d\\ude00"}').a, '😀');
  assert.deepEqual(partialFields('no json here'), {});
});

test('nested values come back as raw JSON text', () => {
  const r = partialFields('{"a":{"b":"}"},"c":[1,{"d":2}],"e":"z"}');
  assert.equal(r.e, 'z');
  assert.deepEqual(JSON.parse(r.a), { b: '}' });
  assert.deepEqual(JSON.parse(r.c), [1, { d: 2 }]);
});
