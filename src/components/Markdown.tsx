import { Fragment, type ReactNode } from 'react';

interface Item { text: string; ordered: boolean; num: number; depth: number }

/** Minimal markdown: paragraphs, bullet and numbered lists (nested by indentation), **bold**, `code`. */
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
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}
