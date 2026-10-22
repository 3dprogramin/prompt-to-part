import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, tokenizeMore, type LiveTokens, type Token } from '../src/lib/highlight';

/** The kind of every character, so differently split plain text still compares equal. */
const kinds = (tokens: Token[]) => tokens.flatMap((t) => [...t.text].map(() => t.kind)).join(',');

const SCRIPT = `// A box with a hole
const size = 20; /* mm,
  wide */
const s = \`top
\${size}\`;
const box = Manifold.cube([size, size, 10])
  .translate([0, 0, 1]).
  rotate([0, 0, 45]);
return box.subtract(H.cylinder(2, "a\\"b"));
`;

test('streamed code: coloured a line at a time, the same as colouring it whole', () => {
  let live: LiveTokens | undefined;
  for (let n = 1; n <= SCRIPT.length; n++) {
    const code = SCRIPT.slice(0, n);
    live = tokenizeMore(live, code);
    assert.equal(live.done + live.tail.map((t) => t.text).join(''), code);
    assert.equal(kinds([...live.chunks.flat(), ...live.tail]), kinds(tokenize(code)), `after ${n} characters`);
  }
  // Finished lines were kept, not redone: earlier chunks are the same arrays.
  const before = live!.chunks;
  const after = tokenizeMore(live, SCRIPT + 'x');
  assert.ok(after.chunks.every((c, i) => c === before[i]));
  // Code that changed earlier on starts over.
  assert.equal(kinds(tokenizeMore(live, 'let a = 1;\n').chunks.flat()), kinds(tokenize('let a = 1;\n')));
});
