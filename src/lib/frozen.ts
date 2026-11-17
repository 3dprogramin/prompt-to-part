// A value fixed at the first moment it is ready: a list ordered by something (the user's filaments) must
// not reorder while it is on screen, so what it is ordered by is read once, when that became known.
import { useRef } from 'react';

/** A function that returns undefined until it is called with ready true, then the value of that first ready call, always. */
export function freezer<T>(): (value: T, ready: boolean) => T | undefined {
  let held: { value: T } | undefined;
  return (value, ready) => {
    if (!held && ready) held = { value };
    return held?.value;
  };
}

/** `value` as it was on the first render with `ready` true (undefined before); it stays while the component stays mounted. */
export function useFrozenWhenReady<T>(value: T, ready: boolean): T | undefined {
  const f = useRef<ReturnType<typeof freezer<T>>>(undefined);
  f.current ??= freezer<T>();
  return f.current(value, ready);
}
