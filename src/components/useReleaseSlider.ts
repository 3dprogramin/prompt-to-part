import { useEffect, useRef, useState } from 'react';

/**
 * Range input that previews its value while dragging but only commits on release
 * (pointer up, key up, blur or the native change event), so the model is rebuilt once.
 */
export function useReleaseSlider(value: number, onCommit: (v: number) => void) {
  const [live, setLive] = useState<number | null>(null);
  const liveRef = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const el = useRef<HTMLInputElement>(null);

  const commit = () => {
    const v = liveRef.current;
    if (v == null) return;
    liveRef.current = null;
    setLive(null);
    if (v !== value) commitRef.current(v);
  };
  const commitRefFn = useRef(commit);
  commitRefFn.current = commit;

  useEffect(() => {
    const input = el.current;
    if (!input) return;
    const onChange = () => commitRefFn.current(); // native "change" fires on release
    input.addEventListener('change', onChange);
    return () => input.removeEventListener('change', onChange);
  }, []);

  return {
    shown: live ?? value,
    dragging: live != null,
    inputProps: {
      ref: el,
      value: live ?? value,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        liveRef.current = Number(e.target.value);
        setLive(liveRef.current);
      },
      onPointerDown: () => {
        window.addEventListener('pointerup', () => commitRefFn.current(), { once: true });
      },
      onKeyUp: () => commitRefFn.current(),
      onBlur: () => commitRefFn.current(),
    },
  };
}
