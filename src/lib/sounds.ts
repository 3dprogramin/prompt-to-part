// Short chimes made on the fly (no sound files): one when Jig needs you (questions to answer,
// concept pictures to approve, an error), another when a reply has finished.

export type Cue = 'attention' | 'done';

let ctx: AudioContext | null = null;

/**
 * Browsers only let a page play sound after the user has interacted with it, so the audio is
 * started on the first click or key press; from then on a cue also plays with the tab in the back.
 */
export function unlockSounds(): void {
  const start = () => {
    try {
      ctx ??= new AudioContext();
      if (ctx.state === 'suspended') void ctx.resume();
    } catch { /* no Web Audio: no sounds */ }
  };
  for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, start, { capture: true, passive: true });
}

/** Notes of each cue (Hz, start s, length s): a rising pair asks for you, a soft falling pair says it's done. */
const NOTES: Record<Cue, [number, number, number][]> = {
  attention: [[784, 0, 0.18], [1175, 0.14, 0.32]],
  done: [[880, 0, 0.22], [659, 0.16, 0.38]],
};

export function playCue(cue: Cue, volume = 0.18): void {
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime + 0.02;
  for (const [hz, at, len] of NOTES[cue]) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    // A quick attack and a smooth fade, so it rings like a small bell instead of beeping.
    gain.gain.setValueAtTime(0, t0 + at);
    gain.gain.linearRampToValueAtTime(volume, t0 + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + len + 0.05);
  }
}
