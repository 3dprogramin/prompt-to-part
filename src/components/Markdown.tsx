import { Fragment, type ReactNode } from 'react';

interface Item { text: string; ordered: boolean; num: number; depth: number }

/** Minimal markdown: paragraphs, bullet and numbered lists (nested by indentation), **bold**, `code`, links. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let items: Item[] = [];
  let para: string[] = [];
  const flushPara = () => { if (para.length) { blocks.push(<p key={blocks.length}>{inline(para.join('\n'))}</p>); para = []; } };
  const flushList = () => { if (items.length) { blocks.push(<Fragment key={blocks.length}>{renderList(items)}</Fragment>); items = []; } };
  for (const line of text.split('\n')) {
    const m = /^(\s*)(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      items.push({ text: m[4], ordered: !!m[3], num: m[3] ? Number(m[3]) : 0, depth: Math.floor(m[1].replace(/\t/g, '  ').length / 2) });
    } else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line.replace(/^#+\s*/, '')); }
  }
  flushPara();
  flushList();
  return <div className="md">{blocks}</div>;
}

/** Turn a flat list of items with depths into nested <ul>/<ol>. */
function renderList(items: Item[]): ReactNode {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const group: { item: Item; children: Item[] }[] = [];
    const ordered = items[i].ordered;
    const level = items[i].depth; // this list's indentation, whatever the source used
    while (i < items.length && (group.length === 0 || (items[i].depth <= level && items[i].ordered === ordered))) {
      const item = items[i++];
      const children: Item[] = [];
      while (i < items.length && items[i].depth > level) children.push(items[i++]);
      group.push({ item, children });
    }
    const lis = group.map(({ item, children }, k) => (
      <li key={k} value={item.ordered ? item.num : undefined}>
        {inline(item.text)}
        {children.length > 0 && renderList(children)}
      </li>
    ));
    out.push(ordered ? <ol key={out.length}>{lis}</ol> : <ul key={out.length}>{lis}</ul>);
  }
  return out;
}

function inline(s: string): ReactNode {
  return renderInline(parseInline(s));
}

function renderInline(tokens: Inline[]): ReactNode {
  return tokens.map((t, i) => {
    if (t.kind === 'bold') return <strong key={i}>{renderInline(t.children)}</strong>;
    if (t.kind === 'code') return <code key={i}>{t.text}</code>;
    if (t.kind === 'link') return <a key={i} href={t.href} target="_blank" rel="noopener noreferrer">{renderInline(t.children)}</a>;
    return <Fragment key={i}>{t.text}</Fragment>;
  });
}

export type Inline =
  | { kind: 'text' | 'code'; text: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] };

/** Where a link may go: web pages and e-mail only (no javascript: and the like). */
export function safeHref(url: string): string | null {
  return /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(url) ? url : null;
}

// What can start something other than plain text: `code`, **bold**, [text](url), <url> and a bare URL.
const START = /`[^`]+`|\*\*[^*]+\*\*|\[|<(?:https?:\/\/|mailto:)[^\s<>]+>|\bhttps?:\/\//g;

/** The inline parts of a line of markdown; links aren't looked for inside a link's text. */
export function parseInline(s: string, links = true): Inline[] {
  const out: Inline[] = [];
  const add = (t: Inline) => {
    const last = out.at(-1);
    if (t.kind === 'text' && last?.kind === 'text') last.text += t.text;
    else if (t.kind !== 'text' || t.text) out.push(t);
  };
  const re = new RegExp(START);
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const tok = m[0];
    let end = m.index + tok.length;
    let parts: Inline[] | null = null;
    if (tok.startsWith('`')) parts = [{ kind: 'code', text: tok.slice(1, -1) }];
    else if (tok.startsWith('**')) parts = [{ kind: 'bold', children: parseInline(tok.slice(2, -2), links) }];
    else if (!links) parts = null;
    else if (tok === '[') {
      const l = link(s, m.index);
      if (l) {
        end = l.end;
        const children = parseInline(l.text, false);
        // A link to somewhere not allowed keeps just its text.
        parts = l.href ? [{ kind: 'link', href: l.href, children }] : children;
      }
    } else if (tok.startsWith('<')) {
      const href = safeHref(tok.slice(1, -1));
      if (href) parts = [{ kind: 'link', href, children: [{ kind: 'text', text: href.replace(/^mailto:/i, '') }] }];
    } else {
      const url = bareUrl(s.slice(m.index));
      end = m.index + url.length;
      if (url.length > tok.length) parts = [{ kind: 'link', href: url, children: [{ kind: 'text', text: url }] }];
    }
    if (!parts) { re.lastIndex = m.index + 1; continue; }
    add({ kind: 'text', text: s.slice(at, m.index) });
    parts.forEach(add);
    at = end;
    re.lastIndex = end;
  }
  add({ kind: 'text', text: s.slice(at) });
  return out;
}

/** [text](url "title") starting at `from`: the brackets and parentheses may nest, as in Wikipedia's URLs. */
function link(s: string, from: number): { text: string; href: string | null; end: number } | null {
  let depth = 0;
  let i = from;
  for (; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']' && --depth === 0) break;
  }
  if (i >= s.length || s[i + 1] !== '(') return null;
  const text = s.slice(from + 1, i);
  const start = i + 2;
  depth = 1;
  for (i = start; i < s.length && !/\s/.test(s[i]); i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) break;
  }
  const url = s.slice(start, i).replace(/^<(.*)>$/, '$1');
  if (depth > 0) {
    // An optional title after the URL.
    const title = /^\s+(?:"[^"]*"|'[^']*')?\s*\)/.exec(s.slice(i));
    if (!title) return null;
    i += title[0].length - 1;
  }
  if (!text.trim() || !url) return null;
  return { text, href: safeHref(url), end: i + 1 };
}

/** A URL in running text, without the punctuation after it or a closing parenthesis around it. */
function bareUrl(s: string): string {
  let url = /^[^\s<>]+/.exec(s)![0];
  for (;;) {
    const trimmed = url.replace(/[.,;:!?'"*_\]]+$/, '');
    const unbalanced = trimmed.endsWith(')') && (trimmed.match(/\(/g)?.length ?? 0) < (trimmed.match(/\)/g)?.length ?? 0);
    const next = unbalanced ? trimmed.slice(0, -1) : trimmed;
    if (next === url) return url;
    url = next;
  }
}
