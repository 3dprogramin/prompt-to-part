import { useEffect, useRef } from 'react';

// Escape closes only the innermost open layer: a menu over a pinned panel, a picture over the
// activity panel. Layers register in the order they open and one Escape closes the last one.
// Fields that use Escape themselves (an edit box, the code editor) call preventDefault() first.
const layers: { close: () => void }[] = [];
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || !layers.length) return;
  e.preventDefault();
  layers[layers.length - 1].close();
}

/** While `open`, Escape calls `close`, unless a layer that opened later is still open. */
export function useEscape(open: boolean, close: () => void) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!open) return;
    const layer = { close: () => ref.current() };
    if (!layers.length) window.addEventListener('keydown', onKey);
    layers.push(layer);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      if (!layers.length) window.removeEventListener('keydown', onKey);
    };
  }, [open]);
}
