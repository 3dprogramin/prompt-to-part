// Dictation: the microphone streamed to ElevenLabs' realtime speech-to-text (Scribe v2 Realtime),
// which sends the words back as they are spoken, in any language it recognises (English and
// Romanian included). Jig's server hands out a single-use token, so the API key never reaches
// this page.
import { request } from './api';

const ENDPOINT = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
/** Sample rates Scribe accepts as raw PCM. */
const RATES = [16000, 22050, 24000, 44100, 48000];
/** Audio is sent in blocks of about this long. */
const BLOCK_SECONDS = 0.1;
/** How long stop() waits for the last words to be transcribed. */
const FINAL_WAIT_MS = 2500;

// Passes the microphone's samples from the audio thread to this page.
const WORKLET = `registerProcessor('jig-mic', class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
});`;

export interface Dictation {
  /** Stop listening; resolves once the last words are in (or after a short wait). */
  stop(): Promise<void>;
}

/**
 * Start listening. `onText` gets the whole transcript so far each time it changes (finished
 * sentences plus the one still being spoken); `onError` a problem that ended the dictation.
 */
export async function startDictation(onText: (text: string) => void, onError: (message: string) => void): Promise<Dictation> {
  const { token } = (await (await request('/api/speech/token', { method: 'POST' })).json()) as { token: string };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    throw new Error((e as Error).name === 'NotAllowedError' ? 'Microphone access was refused – allow it for this page in the browser.' : `No microphone: ${(e as Error).message}`);
  }
  let ctx = new AudioContext();
  if (!RATES.includes(ctx.sampleRate)) { await ctx.close(); ctx = new AudioContext({ sampleRate: 48000 }); }
  const rate = ctx.sampleRate;

  const params = new URLSearchParams({ model_id: 'scribe_v2_realtime', token, audio_format: `pcm_${rate}`, commit_strategy: 'vad', no_verbatim: 'true' });
  const ws = new WebSocket(`${ENDPOINT}?${params}`);
  const committed: string[] = [];
  let partial = '';
  let stopping = false;
  let lastWords: (() => void) | null = null;
  const transcript = () => [...committed, partial].filter(Boolean).join(' ');

  const release = () => {
    for (const t of stream.getTracks()) t.stop();
    if (ctx.state !== 'closed') void ctx.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Couldn't connect to ElevenLabs."));
    });
  } catch (e) {
    release();
    throw e;
  }

  ws.onmessage = (ev) => {
    let m: { message_type?: string; text?: string; error?: string };
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.message_type === 'partial_transcript') {
      partial = (m.text ?? '').trim();
      onText(transcript());
    } else if (m.message_type === 'committed_transcript') {
      if (m.text?.trim()) committed.push(m.text.trim());
      partial = '';
      onText(transcript());
      lastWords?.();
    } else if (m.message_type === 'insufficient_audio_activity') {
      lastWords?.(); // silence: nothing more is coming
    } else if (typeof m.error === 'string') {
      onError(`Dictation: ${m.error}`);
    }
  };
  ws.onclose = () => {
    release();
    lastWords?.();
    if (!stopping) onError('Dictation stopped: the connection to ElevenLabs closed.');
  };

  const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(workletUrl).finally(() => URL.revokeObjectURL(workletUrl));
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'jig-mic');
  const block = Math.round(rate * BLOCK_SECONDS);
  let pending: Float32Array[] = [];
  let pendingLength = 0;
  const send = (samples: Float32Array, commit = false) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: samples.length ? toBase64(samples) : '', commit, sample_rate: rate }));
  };
  const flush = () => {
    if (!pendingLength) return;
    const all = new Float32Array(pendingLength);
    let at = 0;
    for (const p of pending) { all.set(p, at); at += p.length; }
    pending = [];
    pendingLength = 0;
    send(all);
  };
  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    pending.push(ev.data);
    pendingLength += ev.data.length;
    if (pendingLength >= block) flush();
  };
  source.connect(node);

  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      node.port.onmessage = null;
      source.disconnect();
      flush();
      release();
      // Ask for the words still being spoken; if none are pending there is nothing to wait for.
      if (ws.readyState === WebSocket.OPEN && partial) {
        const done = new Promise<void>((resolve) => { lastWords = resolve; setTimeout(resolve, FINAL_WAIT_MS); });
        send(new Float32Array(0), true);
        await done;
      }
      ws.close();
    },
  };
}

/** 16-bit little-endian PCM, base64. */
function toBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
