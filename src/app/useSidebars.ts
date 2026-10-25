// The collapsible sidebars (T and N) and their widths, dragged at their inner edges.
import { useEffect, useRef, useState } from 'react';
import { load, store } from '../lib/storage';

export function useSidebars() {
  // Collapsible sidebars (Blender-style: T = left, N = right).
  const [leftOpen, setLeftOpen] = useState<boolean>(() => load('leftOpen', true));
  const [rightOpen, setRightOpen] = useState<boolean>(() => load('rightOpen', true));
  useEffect(() => store('leftOpen', leftOpen), [leftOpen]);
  // Sidebar widths: dragged at their inner edges; only a width the user dragged is remembered, so a
  // better default still reaches everyone else. A double-click goes back to the default. The chat's
  // default fits the whole composer bar on one row.
  const narrow = window.innerWidth <= 1100;
  const DEFAULT_W = { left: narrow ? 300 : 440, right: narrow ? 280 : 320 };
  const [userWidths, setUserWidths] = useState<Partial<{ left: number; right: number }>>(() => {
    const saved = load<Partial<{ left: number; right: number }> | null>('sidebarWidthsUser', null);
    if (saved) return saved;
    // Earlier versions saved every width, defaults (360/320) included: keep only widths that were dragged.
    const old = load<Partial<{ left: number; right: number }>>('sidebarWidths', {});
    return { ...(old.left && old.left !== 360 ? { left: old.left } : {}), ...(old.right && old.right !== 320 ? { right: old.right } : {}) };
  });
  useEffect(() => store('sidebarWidthsUser', userWidths), [userWidths]);
  const widths = { ...DEFAULT_W, ...userWidths };
  const workspace = useRef<HTMLElement>(null);
  const resize = (side: 'left' | 'right') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const box = workspace.current!.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => setUserWidths((u) => {
      // Each sidebar 240–700 px, and the 3D view keeps at least 320 px.
      const w = { ...DEFAULT_W, ...u };
      const other = side === 'left' ? (rightOpen ? w.right : 0) : (leftOpen ? w.left : 0);
      const want = side === 'left' ? ev.clientX - box.left : box.right - ev.clientX;
      return { ...u, [side]: Math.round(Math.max(240, Math.min(700, box.width - other - 320, want))) };
    });
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); document.body.classList.remove('resizing'); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.classList.add('resizing');
  };
  useEffect(() => store('rightOpen', rightOpen), [rightOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if ((t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 't' || e.key === 'T') setLeftOpen((o) => !o);
      if (e.key === 'n' || e.key === 'N') setRightOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return { leftOpen, setLeftOpen, rightOpen, setRightOpen, setUserWidths, widths, workspace, resize };
}
