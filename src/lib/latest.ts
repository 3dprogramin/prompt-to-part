/**
 * Only the latest of several overlapping requests counts: `begin()` starts one and returns a check
 * that stays true until another one begins. Opening design A (slow) and then B ends on B, as
 * A's answer, arriving last, sees it is no longer wanted.
 */
export function latestOnly() {
  let seq = 0;
  return {
    begin(): () => boolean {
      const mine = ++seq;
      return () => mine === seq;
    },
  };
}
