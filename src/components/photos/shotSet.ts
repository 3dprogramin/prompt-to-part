// Taking a shop set's renders one by one. The panel is a closure over the design it was clicked on,
// but the viewer (`shoot`) shows whatever design is open now, so a switch between the click and a
// render would photograph the new design and bill it to the old one: the set stops instead.

export type ShotSet<R> = { switched: true } | { switched: false; shots: R[] };

/**
 * Runs `shoot` for each item in order, `pause` before each. `current` is read after every wait (the
 * panel's latest design id): when it is no longer `designId` nothing more is shot and nothing starts.
 * `shoot` may throw or return a value the caller treats as a failure; it ends the run as `failed`.
 */
export async function takeShots<I, R>(designId: string, current: () => string, items: I[], pause: () => Promise<void>, shoot: (item: I, i: number) => R | null): Promise<ShotSet<R> | { switched: false; failed: true }> {
  const shots: R[] = [];
  for (const [i, item] of items.entries()) {
    await pause();
    if (current() !== designId) return { switched: true };
    const shot = shoot(item, i);
    if (shot == null) return { switched: false, failed: true };
    shots.push(shot);
  }
  return { switched: false, shots };
}
