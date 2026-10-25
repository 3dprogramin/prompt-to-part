// The composer chips' menus (model, picture mode, 3D figure and line art options): open or
// closed, moved through with the keyboard, and kept within the room above their chip.
import { useLayoutEffect, useRef, useState } from 'react';
import { usePopover } from '../usePopover';

/** In an open menu: arrows, Home and End move the focus through its items; Tab closes it. */
function menuKeys(e: React.KeyboardEvent, menu: HTMLElement | null, close: () => void) {
  const items = [...(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const to = e.key === 'ArrowDown' ? (i + 1) % items.length : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
  if (to >= 0) { e.preventDefault(); items[to]?.focus(); }
  if (e.key === 'Tab') close();
}

/** A composer chip's menu: open/closed, closed by Escape, Tab or a click outside; arrow keys on the chip open it. */
export function useChipMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  usePopover(open, () => setOpen(false), wrap, trigger);
  // The menu opens upwards: on a short screen (a phone) it may not be taller than the room above
  // its chip, so it scrolls instead of running off the top.
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const el = menu.current, t = trigger.current;
      if (!el || !t) return;
      el.style.maxHeight = `${Math.max(120, t.getBoundingClientRect().top - (window.visualViewport?.offsetTop ?? 0) - 12)}px`;
    };
    fit();
    window.visualViewport?.addEventListener('resize', fit);
    window.addEventListener('resize', fit);
    return () => { window.visualViewport?.removeEventListener('resize', fit); window.removeEventListener('resize', fit); };
  }, [open]);
  return {
    open, setOpen, wrap, trigger, menu,
    triggerProps: {
      ref: trigger,
      'aria-haspopup': 'menu' as const,
      'aria-expanded': open,
      onClick: () => setOpen(!open),
      onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } },
    },
    onMenuKey: (e: React.KeyboardEvent) => menuKeys(e, menu.current, () => setOpen(false)),
    /** Closes the menu and puts the focus back on its chip. */
    close: () => { setOpen(false); trigger.current?.focus(); },
  };
}
