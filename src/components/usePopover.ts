import { useEffect, useRef, type RefObject } from 'react';
import { useEscape } from './useEscape';

/**
 * Closes an open popover (menu, picker) on Escape or on a mouse press outside `wrap`; Escape also
 * puts the focus back on its trigger (default: the first button in `wrap`).
 */
export function usePopover(open: boolean, close: () => void, wrap: RefObject<HTMLElement | null>, trigger?: RefObject<HTMLElement | null>) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEscape(open, () => {
    closeRef.current();
    (trigger?.current ?? wrap.current?.querySelector<HTMLElement>('button'))?.focus();
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) closeRef.current(); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, wrap]);
}
