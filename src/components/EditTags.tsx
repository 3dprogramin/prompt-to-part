import type { AgentStep } from '../../shared/types';

/** Git-style line counts of a saved change: +added −removed, and how many edits went into it. */
export function EditTags({ edit, edits = 1 }: { edit: NonNullable<AgentStep['edit']>; edits?: number }) {
  return (
    <span className="diff-tags" aria-label={`${edit.added} lines added, ${edit.removed} removed${edits > 1 ? ` in ${edits} edits` : ''}`}>
      <span className="diff-tag add">+{edit.added}</span>
      <span className="diff-tag del">−{edit.removed}</span>
      {edits > 1 && <span className="diff-count">{edits} edits</span>}
    </span>
  );
}

/** Consecutive edits of the same file as one step, their line counts added up. */
export function groupEdits(steps: AgentStep[]): (AgentStep & { edits?: number })[] {
  const out: (AgentStep & { edits?: number })[] = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (s.edit && last?.edit && last.edit.file === s.edit.file) {
      out[out.length - 1] = { ...s, edits: (last.edits ?? 1) + 1, edit: { file: s.edit.file, added: last.edit.added + s.edit.added, removed: last.edit.removed + s.edit.removed } };
    } else out.push(s);
  }
  return out;
}
