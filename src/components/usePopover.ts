import { useEffect, useRef, type RefObject } from 'react';

/**
 * Closes an open popover (menu, picker) on Escape or on a mouse press outside `wrap`; Escape also
 * puts the focus back on the popover's first button, its trigger.
 */
export function usePopover(open: boolean, close: () => void, wrap: RefObject<HTMLElement | null>) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) closeRef.current(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
      wrap.current?.querySelector<HTMLElement>('button')?.focus();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open, wrap]);
}
