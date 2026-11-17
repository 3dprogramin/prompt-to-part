// When the messages queued for the open design ("Later") go out on their own.

/**
 * True when the open design's queue can go out: it has messages and isn't paused (a reply that
 * stopped or failed waits for "Send now"), no reply runs on the design here or in another tab, and
 * its own model is built (the reply's new one is on screen). `shownFor`: the design whose model is
 * on screen; the first render after opening another one still has the last one's, whose sliders
 * and screenshot would go out with the message.
 */
export function queueReady({ queued, paused, running, remoteRunning, busy, designId, shownFor }: {
  queued: number; paused: boolean; running: boolean; remoteRunning: boolean; busy: boolean; designId: string; shownFor: string;
}): boolean {
  return queued > 0 && !paused && !running && !remoteRunning && !busy && shownFor === designId;
}
