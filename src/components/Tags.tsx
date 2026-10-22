import { useRef, useState } from 'react';
import { builtinTag, cleanTag, foldText, MAX_TAG_CHARS, MAX_TAGS, withTag } from '../../shared/tags';
import { Icon } from './Icon';
import { usePopover } from './usePopover';

/** A design's tag: a built-in one in its colour with its icon, the user's own ones plain. */
export function TagChip({ tag }: { tag: string }) {
  const b = builtinTag(tag);
  return (
    <span className={`tag-chip ${b ? `tag-${b.name.toLowerCase()}` : ''}`} title={b?.title ?? `Tag: ${tag}`}>
      {b && <Icon name={b.icon} size={10} />}{tag}
    </span>
  );
}

/** A design's tags in a row, the first `max` of them and how many more. */
export function TagChips({ tags, max = 4 }: { tags?: readonly string[]; max?: number }) {
  if (!tags?.length) return null;
  return (
    <span className="tag-chips">
      {tags.slice(0, max).map((t) => <TagChip key={t} tag={t} />)}
      {tags.length > max && <span className="tag-more" title={tags.slice(max).join(', ')}>+{tags.length - max}</span>}
    </span>
  );
}

interface EditorProps {
  /** Every tag to offer (the built-ins first, then the user's). */
  tags: readonly string[];
  /** Whether the design (or all, some or none of the picked designs) has the tag. */
  stateOf: (tag: string) => 'all' | 'some' | 'none';
  onChange: (tag: string, on: boolean) => void;
  /** No more tags fit: only taking one away is offered. */
  full?: boolean;
  /** What the tags apply to, for screen readers ("this design", "3 designs"). */
  what: string;
}

/**
 * Tag toggles: a click adds the tag (to every picked design when only some have it) or takes it
 * away; a new tag is typed and added with Enter.
 */
export function TagEditor({ tags, stateOf, onChange, full, what }: EditorProps) {
  const [text, setText] = useState('');
  const add = () => {
    const t = cleanTag(text);
    if (!t || t.length > MAX_TAG_CHARS) return;
    // An existing tag in another case keeps its spelling.
    onChange(tags.find((x) => foldText(x) === foldText(t)) ?? t, true);
    setText('');
  };
  return (
    <div className="tag-editor" role="group" aria-label={`Tags of ${what}`}>
      <div className="tag-toggles">
        {tags.map((t) => {
          const s = stateOf(t), b = builtinTag(t);
          return (
            <button key={t} className={`tag-toggle ${b ? `tag-${b.name.toLowerCase()}` : ''} ${s}`} aria-pressed={s === 'all' ? true : s === 'some' ? 'mixed' : false}
              disabled={full && s === 'none'} onClick={() => onChange(t, s !== 'all')}
              title={`${b ? `${b.title}. ` : ''}${s === 'all' ? `Take "${t}" away` : s === 'some' ? `Some have "${t}": add it to all` : `Add "${t}"`}`}>
              {b ? <Icon name={b.icon} size={11} /> : s === 'all' && <Icon name="check" size={11} />}{s === 'some' && <Icon name="minus" size={11} />}{t}
            </button>
          );
        })}
      </div>
      <div className="tag-add">
        <Icon name="tag" size={12} />
        <input value={text} maxLength={MAX_TAG_CHARS} disabled={full} placeholder={full ? 'No more tags fit' : 'New tag, e.g. Ornamente'} aria-label={`New tag for ${what}`}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button className="link" disabled={full || !cleanTag(text)} onClick={add}>Add</button>
      </div>
    </div>
  );
}

/** The open design's tags in the top bar, and a button opening the tag toggles. */
export function DesignTagsButton({ tags, allTags, onChange, compact }: { tags: string[]; allTags: readonly string[]; onChange: (tags: string[]) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  usePopover(open, () => setOpen(false), wrap);
  const has = (t: string) => tags.some((x) => foldText(x) === foldText(t));
  return (
    <div className="menu-wrap design-tags" ref={wrap}>
      <button className={`version-btn tags-btn ${open ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
        title={tags.length ? `Tags: ${tags.join(', ')}. Click to change them.` : 'Tags: mark it as a shop product, a throwaway test or your own group'}
        aria-label={tags.length ? `Tags: ${tags.join(', ')}` : 'Add tags'}>
        {tags.length && !compact ? <TagChips tags={tags} max={3} /> : <Icon name="tag" size={13} />}
      </button>
      {open && (
        <div className="menu left tag-menu">
          <TagEditor tags={allTags} what="this design" full={tags.length >= MAX_TAGS}
            stateOf={(t) => (has(t) ? 'all' : 'none')}
            onChange={(t, on) => onChange(withTag(tags, t, on))} />
        </div>
      )}
    </div>
  );
}
