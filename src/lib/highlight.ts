// Syntax colours for the Code tab: a small JavaScript tokenizer that copes with half-typed code
// (an unclosed string or comment just runs to the end), so it can colour every keystroke.

export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'global' | 'function' | 'property' | 'plain';
export interface Token { kind: TokenKind; text: string }

const KEYWORDS = new Set(('async await break case catch class const continue debugger default delete do else export extends ' +
  'finally for function if import in instanceof let new of return static super switch this throw try typeof var void while yield').split(' '));
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
/** What model scripts get from Jig (and Math, which they use everywhere). */
const GLOBALS = new Set(['H', 'Manifold', 'CrossSection', 'quality', 'Math']);

const RULES: [TokenKind | 'word', RegExp][] = [
  ['comment', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
  ['string', /'(?:\\[\s\S]|[^'\\\n])*'?|"(?:\\[\s\S]|[^"\\\n])*"?|`(?:\\[\s\S]|[^`\\])*`?/y],
  ['number', /(?:0[xX][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y],
  ['word', /[A-Za-z_$][\w$]*/y],
  ['plain', /\s+|\.\.\.|[^\sA-Za-z_$\d'"`/.]+|[/.]/y],
];

export function tokenize(code: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  let afterDot = false;
  while (at < code.length) {
    for (const [kind, re] of RULES) {
      re.lastIndex = at;
      const m = re.exec(code);
      if (!m || !m[0]) continue;
      const text = m[0];
      at += text.length;
      let k: TokenKind = kind === 'word' ? 'plain' : kind;
      if (kind === 'word') {
        if (afterDot) k = /^\s*\(/.test(code.slice(at, at + 20)) ? 'function' : 'property';
        else if (KEYWORDS.has(text)) k = 'keyword';
        else if (LITERALS.has(text)) k = 'literal';
        else if (GLOBALS.has(text)) k = 'global';
        else if (/^\s*\(/.test(code.slice(at, at + 20))) k = 'function';
      }
      if (!/^\s+$/.test(text)) afterDot = text === '.';
      // Join neighbouring plain text so the page holds fewer elements.
      const last = out[out.length - 1];
      if (k === 'plain' && last?.kind === 'plain') last.text += text;
      else out.push({ kind: k, text });
      break;
    }
  }
  return out;
}

/** Code coloured while it streams in: `chunks` hold finished lines (kept as they are), `tail` the line still being written. */
export interface LiveTokens { done: string; chunks: Token[][]; tail: Token[] }

/** Colours `code` from where `prev` left off: only the text after the last finished line is tokenized again. */
export function tokenizeMore(prev: LiveTokens | undefined, code: string): LiveTokens {
  const base = prev && code.startsWith(prev.done) ? prev : { done: '', chunks: [], tail: [] };
  const rest = code.slice(base.done.length);
  const tokens = tokenize(rest);
  // A line is finished at its last line break outside a string or comment, unless it ends in a '.'
  // (the next line's first word is then a property).
  let end = rest.length;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    end -= t.text.length;
    const nl = t.kind === 'plain' ? t.text.lastIndexOf('\n') : -1;
    if (nl < 0) continue;
    const cut = end + nl + 1;
    if (rest.slice(0, cut).trimEnd().endsWith('.')) break;
    const head = tokens.slice(0, i);
    head.push({ kind: 'plain', text: t.text.slice(0, nl + 1) });
    const tail = tokens.slice(i + 1);
    if (nl + 1 < t.text.length) tail.unshift({ kind: 'plain', text: t.text.slice(nl + 1) });
    return { done: base.done + rest.slice(0, cut), chunks: [...base.chunks, head], tail };
  }
  return { ...base, tail: tokens };
}
