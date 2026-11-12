// Whether a picture edit's version lines up with the version it came from, measured once on its
// build: used for edits kept from the brush editor (usePictureEdit) and made in the chat (useReplies).
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Box3, Design, EvalResult } from '../../shared/types';
import { linesUp } from '../lib/pictureEdit';

/** A picture edit's version waiting for its build: the design and values it was made with, the parent's box, what the edit said. */
export interface LinesUpWatch { designId: string; version: number; values: Design['values']; parentBox: Box3 | null; masked: boolean; outsideSame: boolean }

/**
 * Returns `watch`: the version given is measured on the first build after it (the build on screen
 * when `watch` is called does not count). A change before that build is in (a slider, another edit,
 * another design opened) leaves lines up false. Safe to call inside a state updater.
 */
export function useLinesUp({ design, setDesign, result, busy }: { design: Design; setDesign: Dispatch<SetStateAction<Design>>; result: EvalResult | null; busy: boolean }) {
  const resultRef = useRef(result);
  resultRef.current = result;
  const measure = useRef<(LinesUpWatch & { before: EvalResult | null }) | null>(null);

  useEffect(() => {
    const m = measure.current;
    if (!m || busy) return;
    if (design.id !== m.designId || design.values !== m.values) { measure.current = null; return; }
    if (!result || result === m.before) return;
    measure.current = null;
    if (!linesUp(m, m.parentBox, result.bbox)) return;
    setDesign((d) => {
      const v = d.versions[m.version];
      if (d.id !== m.designId || !v?.pictureEdit) return d;
      return { ...d, versions: d.versions.map((x, i) => (i === m.version ? { ...v, pictureEdit: { ...v.pictureEdit!, linesUp: true } } : x)) };
    });
  }, [design, result, busy]);

  return (w: LinesUpWatch) => { measure.current = { ...w, before: resultRef.current }; };
}
