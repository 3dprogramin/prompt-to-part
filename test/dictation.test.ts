import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDictation } from '../src/lib/dictation';

// Stand-ins for the browser's microphone, audio and WebSocket, to check what dictation lets go of.
function fakeBrowser(fail: 'module' | 'node') {
  const seen = { tracksStopped: 0, ctxClosed: 0, wsClosed: 0 };
  const g = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(['navigator', 'fetch', 'AudioContext', 'AudioWorkletNode', 'WebSocket'].map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  const set = (k: string, value: unknown) => Object.defineProperty(g, k, { value, configurable: true, writable: true });
  set('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => seen.tracksStopped++ }] }) } });
  set('fetch', async () => new Response(JSON.stringify({ token: 't' }), { status: 200 }));
  set('AudioContext', class {
    sampleRate = 48000;
    state = 'running';
    audioWorklet = { addModule: async () => { if (fail === 'module') throw new Error('no worklet'); } };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() { this.state = 'closed'; seen.ctxClosed++; }
  });
  set('AudioWorkletNode', class { constructor() { if (fail === 'node') throw new Error('no node'); } });
  set('WebSocket', class {
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }); }
    send() {}
    close() { seen.wsClosed++; this.readyState = 3; this.onclose?.(); }
  });
  const restore = () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, k, d); else delete g[k];
    }
  };
  return { seen, restore };
}

for (const fail of ['module', 'node'] as const) {
  test(`dictation: a failing audio ${fail === 'module' ? 'worklet' : 'node'} lets go of the microphone, audio and connection`, async () => {
    const { seen, restore } = fakeBrowser(fail);
    const errors: string[] = [];
    try {
      await assert.rejects(startDictation(() => {}, (m) => errors.push(m)), fail === 'module' ? /no worklet/ : /no node/);
      assert.ok(seen.tracksStopped >= 1, 'the microphone is stopped');
      assert.ok(seen.ctxClosed >= 1, 'the audio context is closed');
      assert.equal(seen.wsClosed, 1, 'the connection is closed');
      // The thrown error is the one reported, not "the connection closed" on top of it.
      assert.deepEqual(errors, []);
    } finally {
      restore();
    }
  });
}
