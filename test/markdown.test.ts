import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseInline } from '../src/components/Markdown';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));
const link = (href: string, text = href) => ({ kind: 'link', href, children: [{ kind: 'text', text }] });

test('markdown links: [text](url), with parentheses in the text and the URL', () => {
  assert.deepEqual(parseInline('See [DJI Store – Battery (1950 mAh)](https://store.dji.com/gr/product/x?vid=170481).'), [
    { kind: 'text', text: 'See ' }, link('https://store.dji.com/gr/product/x?vid=170481', 'DJI Store – Battery (1950 mAh)'), { kind: 'text', text: '.' },
  ]);
  assert.deepEqual(parseInline('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))'), [link('https://en.wikipedia.org/wiki/Foo_(bar)', 'Foo')]);
  // A link inside parentheses.
  assert.deepEqual(parseInline('(a [25 mm](https://www.walmart.com/ip/1)).'), [
    { kind: 'text', text: '(a ' }, link('https://www.walmart.com/ip/1', '25 mm'), { kind: 'text', text: ').' },
  ]);
  assert.deepEqual(parseInline('[mail](mailto:a@b.c "Mail")'), [link('mailto:a@b.c', 'mail')]);
});

test('markdown links: only http(s) and mailto; anything else keeps just its text', () => {
  assert.deepEqual(parseInline('[click](javascript:alert(1))'), [{ kind: 'text', text: 'click' }]);
  assert.deepEqual(parseInline('[x](data:text/html,hi) and [y](#top)'), [{ kind: 'text', text: 'x and y' }]);
  assert.deepEqual(parseInline('[not a link] (here) and `[m](x, y)`'), [{ kind: 'text', text: '[not a link] (here) and ' }, { kind: 'code', text: '[m](x, y)' }]);
});

test('markdown links: bare URLs without the punctuation after them', () => {
  assert.deepEqual(parseInline('Specs: https://example.com/a_(b), and (https://example.com/c).'), [
    { kind: 'text', text: 'Specs: ' }, link('https://example.com/a_(b)'), { kind: 'text', text: ', and (' }, link('https://example.com/c'), { kind: 'text', text: ').' },
  ]);
  assert.deepEqual(parseInline('<https://example.com/x>'), [link('https://example.com/x')]);
  assert.deepEqual(parseInline('just https:// alone'), [{ kind: 'text', text: 'just https:// alone' }]);
});

test('markdown links: rendered in bold and list items, opening in a new tab', () => {
  const out = html('- **Battery:** [DJI](https://store.dji.com/p) or **https://a.com/x**\n- `https://not.a/link`');
  assert.match(out, /<li><strong>Battery:<\/strong> <a href="https:\/\/store.dji.com\/p" target="_blank" rel="noopener noreferrer">DJI<\/a> or <strong><a href="https:\/\/a.com\/x" target="_blank" rel="noopener noreferrer">https:\/\/a.com\/x<\/a><\/strong><\/li>/);
  assert.match(out, /<code>https:\/\/not.a\/link<\/code>/);
  assert.match(html('**[Bold link](https://a.com)**'), /<strong><a href="https:\/\/a.com"[^>]*>Bold link<\/a><\/strong>/);
  assert.doesNotMatch(html('[x](javascript:alert(1))'), /<a /);
});

test('markdown tables: header, alignment and body; pipes without a |---| row stay text', () => {
  const out = html('Options:\n\n| Clearance | Slot | Lean |\n|---|:--:|---:|\n| 1 mm | 6.9 mm | **2°** |\n| 2 mm | 8.9 mm |\n\nDone.');
  assert.match(out, /<p>Options:<\/p><div class="md-table"><table><thead><tr><th>Clearance<\/th><th style="text-align:center">Slot<\/th><th style="text-align:right">Lean<\/th><\/tr><\/thead>/);
  assert.match(out, /<td style="text-align:right"><strong>2°<\/strong><\/td>/);
  // A short row is padded to the header's width.
  assert.match(out, /<td>2 mm<\/td><td style="text-align:center">8.9 mm<\/td><td style="text-align:right"><\/td><\/tr><\/tbody><\/table><\/div><p>Done.<\/p>/);
  assert.equal(html('| not | a table |'), '<div class="md"><p>| not | a table |</p></div>');
});

test('markdown headings become headings, without their # marks', () => {
  assert.equal(html('## What I would do\nSet it to 2 mm.'), '<div class="md"><h4>What I would do</h4><p>Set it to 2 mm.</p></div>');
});
