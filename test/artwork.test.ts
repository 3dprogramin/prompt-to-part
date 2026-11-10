import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artworkPrompt, traceArtwork } from '../server/artwork';
import { claudeEnv } from '../server/agent';

/** A 300×200 picture: white background, a black disc with a grey square inside it, and grey specks. */
function picture() {
  const W = 300, H = 200, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let v = 255;
    if ((x - 150) ** 2 + (y - 100) ** 2 < 80 ** 2) v = 10;
    if (Math.abs(x - 150) < 25 && Math.abs(y - 100) < 25) v = 128;
    if (x % 50 === 5 && y % 50 === 5) v = 128; // single-pixel specks on the background
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}

test('artwork tracing: one shape per colour, no background, no specks', () => {
  const r = traceArtwork(picture(), ['#000000', '#808080'], 4, 'disc');
  assert.equal(r.drawing.name, 'disc');
  assert.equal(r.drawing.aspect, 1.5);
  assert.deepEqual(r.drawing.shapes.map((s) => s.color), ['#000000', '#808080'], 'darkest first, white background dropped');
  const grey = r.tones.find((t) => t.color === '#808080')!;
  const expected = 50 * 50 / (Math.PI * 80 * 80);
  assert.ok(Math.abs(grey.share - expected) < 0.02, `grey share ${grey.share} ≈ ${expected}`);
  // Everything lies inside the disc (the specks joined the background), in units of the picture height.
  for (const s of r.drawing.shapes) for (const c of s.contours) for (const [x, y] of c) assert.ok(Math.hypot(x, y) < 0.42, `${x},${y} inside the disc`);
});

test('artwork tracing without colours finds the tones itself (white as background here)', () => {
  const r = traceArtwork(picture(), undefined, 3, 'disc');
  assert.equal(r.drawing.shapes.length, 2);
  assert.ok(r.drawing.shapes[0].color! < r.drawing.shapes[1].color!, 'dark tone first');
});

test('artwork prompt: the subject inside the print rules', () => {
  const p = artworkPrompt({ subject: 'a fox sitting in the snow', colors: ['#111111', '#e05a00', '#ffffff'] });
  assert.match(p, /Subject: a fox sitting in the snow/);
  assert.match(p, /exactly these 3 flat colours and no others: #111111, #e05a00, #ffffff/);
  assert.match(p, /plain pure white \(#FFFFFF\) background/);
  assert.match(artworkPrompt({ subject: 'a lighthouse', tones: 3 }), /exactly 3 flat tones of grey/);
});

test('OPENROUTER_API_KEY runs Claude through OpenRouter unless an Anthropic key is set', () => {
  const saved = { ...process.env };
  try {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'PTP_AUTH']) delete process.env[k];
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    let env = claudeEnv();
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-or-test');
    assert.equal(env.ANTHROPIC_API_KEY, '');
    assert.equal(env.OPENROUTER_API_KEY, undefined, 'Claude never sees the OpenRouter key under its own name');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    env = claudeEnv();
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
