import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Raster } from '../shared/meshFormats';
import { ASPECTS } from '../server/artwork';
import { ALIGN_MAX_ERROR, alignTo, chooseCrop, featherPaste, resizeTo, seamlessPaste } from '../server/pictureEdit/raster';

// A deterministic random source, so every run sees the same pictures.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * A picture-like scene as a function of continuous coordinates (0..W, 0..H): colour gradients, soft
 * edged discs and boxes, and a smooth texture, so the alignment has the kind of content it meets
 * (flat areas, edges, fine detail) rather than a flat image or pure noise.
 */
function scene(seed: number, W: number, H: number) {
  const rnd = random(seed);
  const discs = Array.from({ length: 14 }, () => ({
    x: rnd() * W, y: rnd() * H, r: (0.04 + rnd() * 0.12) * H, c: [rnd() * 255, rnd() * 255, rnd() * 255],
  }));
  const boxes = Array.from({ length: 10 }, () => ({
    x: rnd() * W, y: rnd() * H, w: (0.05 + rnd() * 0.2) * W, h: (0.05 + rnd() * 0.2) * H, c: [rnd() * 255, rnd() * 255, rnd() * 255],
  }));
  const g0 = [rnd() * 255, rnd() * 255, rnd() * 255], g1 = [rnd() * 255, rnd() * 255, rnd() * 255];
  const f1 = 0.05 + rnd() * 0.05, f2 = 0.07 + rnd() * 0.05, ph = rnd() * 6;
  return (x: number, y: number): [number, number, number] => {
    const t = (x / W + y / H) / 2;
    let r = g0[0] * (1 - t) + g1[0] * t, g = g0[1] * (1 - t) + g1[1] * t, b = g0[2] * (1 - t) + g1[2] * t;
    const over = (a: number, c: number[]) => { r += (c[0] - r) * a; g += (c[1] - g) * a; b += (c[2] - b) * a; };
    for (const q of boxes) {
      const a = Math.min(1, 0.5 + Math.min(x - q.x, q.x + q.w - x, y - q.y, q.y + q.h - y));
      if (a > 0) over(a, q.c);
    }
    for (const d of discs) {
      if (Math.abs(x - d.x) > d.r + 1 || Math.abs(y - d.y) > d.r + 1) continue;
      const a = Math.min(1, 0.5 + d.r - Math.hypot(x - d.x, y - d.y));
      if (a > 0) over(a, d.c);
    }
    const tex = 12 * Math.sin(x * f1 + ph) * Math.cos(y * f2 - ph) + 6 * Math.sin((x + y) * 0.31 + ph);
    return [r + tex, g + tex, b + tex];
  };
}

type Look = (x: number, y: number) => [number, number, number];

/** Renders `look` at w x h, where pixel (i, j) shows the look at `at(i, j)` (default its own centre). */
function render(look: Look, w: number, h: number, at: (i: number, j: number) => [number, number] = (i, j) => [i + 0.5, j + 0.5], post?: (c: number, k: number) => number): Raster {
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const [x, y] = at(i, j);
    const c = look(x, y), o = (j * w + i) * 4;
    for (let k = 0; k < 3; k++) data[o + k] = clamp255(post ? post(c[k], k) : c[k]);
    data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}

/**
 * The image model's answer: the sent picture moved so that the content at sent pixel p sits at
 * c + scale * (p - c) + shift (`scale` one number, or one for x and one for y), a blob painted over the marked disc, drawn at outW x outH (another
 * size and aspect is stretched back, as a model ignoring the asked ratio would).
 */
function answer(look: Look, w: number, h: number, shift: [number, number], scale: number | [number, number], outW = w, outH = h, post?: (c: number, k: number) => number, edit?: { x: number; y: number; r: number }) {
  const cx = w / 2, cy = h / 2, [sx, sy] = typeof scale === 'number' ? [scale, scale] : scale;
  const edited: Look = (x, y) => (edit && Math.hypot(x - edit.x, y - edit.y) < edit.r ? [250, 40 + 0.3 * x, 200] : look(x, y));
  return render(edited, outW, outH, (i, j) => {
    const qx = (i + 0.5) * w / outW, qy = (j + 0.5) * h / outH;
    return [cx + (qx - cx - shift[0]) / sx, cy + (qy - cy - shift[1]) / sy];
  }, post);
}

/** 1 outside a disc (the area the alignment may use), 0 inside it. */
function outsideOf(w: number, h: number, disc: { x: number; y: number; r: number }) {
  const m = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) m[j * w + i] = Math.hypot(i + 0.5 - disc.x, j + 0.5 - disc.y) < disc.r ? 0 : 1;
  return m;
}

/** Mean absolute RGB difference of two same-size pictures over pixels where `where` is 1, ignoring a border. */
function meanDiff(a: Raster, b: Raster, where: Uint8Array, border = 12) {
  let s = 0, n = 0;
  for (let j = border; j < a.height - border; j++) for (let i = border; i < a.width - border; i++) {
    const p = j * a.width + i;
    if (!where[p]) continue;
    for (let k = 0; k < 3; k++) s += Math.abs(a.data[p * 4 + k] - b.data[p * 4 + k]);
    n += 3;
  }
  return s / n;
}

const W = 400, H = 300;
const look = scene(7, W, H);
const sent = render(look, W, H);
const edit = { x: 210, y: 140, r: 55 };
const outside = outsideOf(W, H, { ...edit, r: edit.r + 4 });

/** Each axis's scale within a pixel at the far edges (`half`: half the picture's size). */
const scaleNear = (scale: [number, number], want: number, half: number) => scale.every((v) => Math.abs(v - want) * half <= 1);

const ratio = (a: string) => { const [x, y] = a.split(':').map(Number); return x / y; };

function assertCrop(c: ReturnType<typeof chooseCrop>, mark: { x: number; y: number; w: number; h: number }, pic: { width: number; height: number }) {
  for (const v of [c.x, c.y, c.w, c.h]) assert.ok(Number.isInteger(v), `integer ${JSON.stringify(c)}`);
  assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= pic.width && c.y + c.h <= pic.height, `inside ${JSON.stringify(c)}`);
  assert.ok(c.x <= mark.x && c.y <= mark.y && c.x + c.w >= mark.x + mark.w && c.y + c.h >= mark.y + mark.h, `holds the mark ${JSON.stringify(c)}`);
  assert.ok((ASPECTS as readonly string[]).includes(c.aspect), c.aspect);
}

test('chooseCrop of a mark at the picture corner stays inside, holds the mark and has an allowed aspect', () => {
  const pic = { width: 1000, height: 800 };
  for (const mark of [{ x: 0, y: 0, w: 100, h: 80 }, { x: 900, y: 720, w: 100, h: 80 }, { x: 0, y: 700, w: 60, h: 100 }]) {
    const c = chooseCrop(mark, pic, ASPECTS);
    assertCrop(c, mark, pic);
    assert.ok(Math.abs(c.w / c.h - ratio(c.aspect)) <= ratio(c.aspect) / c.h + 1e-9, `ratio ${JSON.stringify(c)}`);
    assert.ok(c.w >= 2 * mark.w && c.h >= 2 * mark.h, `keeps the margin ${JSON.stringify(c)}`);
  }
});

test('chooseCrop grows the mark by its size on each side, centred, at the nearest aspect', () => {
  const pic = { width: 2000, height: 2000 };
  assert.deepEqual(chooseCrop({ x: 950, y: 950, w: 100, h: 100 }, pic, ASPECTS), { x: 850, y: 850, w: 300, h: 300, aspect: '1:1' });
  const wide = chooseCrop({ x: 800, y: 950, w: 300, h: 100 }, pic, ASPECTS);
  assert.equal(wide.aspect, '21:9');
  assert.equal(wide.w, 900);
  assert.ok(Math.abs(wide.w / wide.h - 21 / 9) <= (21 / 9) / wide.h, JSON.stringify(wide));
  assertCrop(wide, { x: 800, y: 950, w: 300, h: 100 }, pic);
  const tall = chooseCrop({ x: 900, y: 900, w: 100, h: 150 }, pic, ASPECTS);
  assert.equal(tall.aspect, '2:3');
  assert.deepEqual([tall.w, tall.h], [300, 450]);
  const half = chooseCrop({ x: 950, y: 950, w: 100, h: 100 }, pic, ASPECTS, 0.5);
  assert.deepEqual([half.w, half.h], [200, 200]);
});

test('chooseCrop shrinks the margin in a small picture, and takes the whole side when even the mark does not fit an aspect', () => {
  const small = { width: 300, height: 300 };
  const c = chooseCrop({ x: 50, y: 50, w: 200, h: 200 }, small, ASPECTS);
  assertCrop(c, { x: 50, y: 50, w: 200, h: 200 }, small);
  assert.equal(c.aspect, '1:1');
  assert.deepEqual([c.w, c.h], [300, 300]);
  const strip = { width: 1000, height: 150 };
  const mark = { x: 100, y: 0, w: 800, h: 150 };
  const s = chooseCrop(mark, strip, ASPECTS);
  assertCrop(s, mark, strip);
  assert.equal(s.aspect, '21:9');
  assert.equal(s.h, 150);
});

test('resizeTo keeps a flat colour and a gradient', () => {
  const flat = render(() => [10, 200, 30], 7, 5);
  const big = resizeTo(flat, 20, 9);
  assert.equal(big.width, 20);
  assert.equal(big.height, 9);
  for (let p = 0; p < 20 * 9; p++) assert.deepEqual([...big.data.slice(p * 4, p * 4 + 4)], [10, 200, 30, 255]);
  const ramp = render((x) => [x * 10, 0, 0], 20, 2);
  const half = resizeTo(ramp, 10, 1);
  for (let i = 0; i < 10; i++) assert.ok(Math.abs(half.data[i * 4] - (2 * i + 1) * 10) <= 1, `${i}: ${half.data[i * 4]}`);
});

test('alignTo recovers a 7 px shift and a 2 % scale, from another size and aspect', () => {
  for (const [outW, outH] of [[W, H], [512, 512]]) {
    const returned = answer(look, W, H, [7, -5], 1.02, outW, outH, undefined, edit);
    const r = alignTo(returned, sent, outside);
    assert.ok(r.ok, `ok, error ${r.error}`);
    assert.ok(Math.abs(r.shift[0] - 7) <= 1 && Math.abs(r.shift[1] + 5) <= 1, `shift ${r.shift}`);
    assert.ok(scaleNear(r.scale, 1.02, W / 2), `scale ${r.scale}`);
    assert.equal(r.image.width, W);
    assert.equal(r.image.height, H);
    assert.ok(meanDiff(r.image, sent, outside) < 4, `lined up ${meanDiff(r.image, sent, outside)}`);
  }
});

test('alignTo lines up a picture too small to halve', () => {
  const w = 120, h = 90, small = scene(21, w, h), dot = { x: 66, y: 40, r: 16 };
  const r = alignTo(answer(small, w, h, [2, -2], 0.975, 160, 100, undefined, dot), render(small, w, h), outsideOf(w, h, { ...dot, r: dot.r + 3 }));
  assert.ok(r.ok, `ok, error ${r.error}`);
  assert.ok(Math.abs(r.shift[0] - 2) <= 1 && Math.abs(r.shift[1] + 2) <= 1 && scaleNear(r.scale, 0.975, w / 2), `${r.shift} ${r.scale}`);
});

test('alignTo with tones recovers a +20 brightness and 0.9 contrast change', () => {
  const returned = answer(look, W, H, [-6, 4], 0.98, W, H, (c) => 0.9 * c + 20, edit);
  const plain = alignTo(returned, sent, outside);
  const r = alignTo(returned, sent, outside, { tones: true });
  assert.ok(r.ok, `ok, error ${r.error}`);
  assert.ok(r.error < plain.error, `${r.error} < ${plain.error}`);
  assert.ok(Math.abs(r.shift[0] + 6) <= 1 && Math.abs(r.shift[1] - 4) <= 1, `shift ${r.shift}`);
  assert.ok(scaleNear(r.scale, 0.98, W / 2), `scale ${r.scale}`);
  assert.ok(meanDiff(r.image, sent, outside) < 4, `lined up ${meanDiff(r.image, sent, outside)}`);
});

test('alignTo passes a shifted copy with mild noise', () => {
  const rnd = random(3);
  const noisy = answer(look, W, H, [3, 6], 1.01, 600, 400, (c) => c + (rnd() + rnd() + rnd() - 1.5) * 8, edit);
  const r = alignTo(noisy, sent, outside, { tones: true });
  assert.ok(r.ok, `ok, error ${r.error}`);
  assert.ok(Math.abs(r.shift[0] - 3) <= 1 && Math.abs(r.shift[1] - 6) <= 1, `shift ${r.shift}`);
});

test('alignTo fails on noise and on a different picture, with or without tones', () => {
  const rnd = random(11);
  const noise: Raster = { width: W, height: H, data: Uint8Array.from({ length: W * H * 4 }, (_, k) => (k % 4 === 3 ? 255 : Math.floor(rnd() * 256))) };
  const other = render(scene(99, W, H), W, H);
  for (const returned of [noise, other]) for (const tones of [false, true]) {
    const r = alignTo(returned, sent, outside, { tones });
    assert.equal(r.ok, false, `error ${r.error}`);
    assert.ok(r.error > ALIGN_MAX_ERROR);
    assert.equal(r.reason, 'different picture');
  }
});

test('alignTo does not pass an answer moved past the allowed range, though its error is small', () => {
  // 3 % of 400 is 12 px: 16 px held at 12 would paste 4 px off.
  for (const [shift, scale] of [[[16, 0], 1], [[0, -12], 1], [[0, 0], 1.045]] as [[number, number], number][]) {
    const r = alignTo(answer(look, W, H, shift, scale, W, H, undefined, edit), sent, outside);
    assert.equal(r.ok, false, `${shift} ${scale}: error ${r.error}, shift ${r.shift}, scale ${r.scale}`);
    assert.equal(r.reason, 'moved past the range');
  }
  const inside = alignTo(answer(look, W, H, [11.6, -8.6], 1.029, W, H, undefined, edit), sent, outside);
  assert.ok(inside.ok, `just inside: error ${inside.error}, shift ${inside.shift}, scale ${inside.scale}`);
});

/**
 * Flat-colour art like an AI artwork: a background and flat discs with black outlines of about 3 px,
 * drawn with 4 samples a pixel. Its error barely rises with a misalignment (most pixels are flat), so
 * here the alignment rests on the search and the past-the-range follow, not on the threshold.
 */
function flatArt(seed: number, N: number): Look {
  const rnd = random(seed);
  const pal = [[230, 60, 50], [40, 120, 200], [250, 210, 60], [60, 170, 90], [240, 240, 235]];
  const discs = Array.from({ length: 16 }, () => ({ x: rnd() * N, y: rnd() * N, r: (0.05 + rnd() * 0.15) * N, c: pal[Math.floor(rnd() * pal.length)] }));
  const point = (x: number, y: number) => {
    let c = [245, 240, 225];
    for (const d of discs) { const q = Math.hypot(x - d.x, y - d.y); if (q < d.r) c = q > d.r - 3 ? [20, 20, 20] : d.c; }
    return c;
  };
  return (x, y) => {
    const acc: [number, number, number] = [0, 0, 0];
    for (const [sx, sy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
      const c = point(x + sx, y + sy);
      for (let k = 0; k < 3; k++) acc[k] += c[k] / 4;
    }
    return acc;
  };
}

test('alignTo lines up flat-colour art within a pixel and does not pass it moved past the range', () => {
  const N = 320, art = flatArt(3, N), flat = render(art, N, N);
  const dot = { x: 160, y: 160, r: 45 }, out = outsideOf(N, N, { ...dot, r: dot.r + 4 });
  const r = alignTo(answer(art, N, N, [5, -4], 1.015, 640, 640, undefined, dot), flat, out);
  assert.ok(r.ok, `ok, error ${r.error}`);
  assert.ok(Math.abs(r.shift[0] - 5) <= 1 && Math.abs(r.shift[1] + 4) <= 1 && scaleNear(r.scale, 1.015, N / 2), `${r.shift} ${r.scale}`);
  // 3 % of 320 is 9.6 px.
  for (const shift of [[14, 0], [0, -12], [11, 8]] as [number, number][]) {
    const past = alignTo(answer(art, N, N, shift, 1, N, N, undefined, dot), flat, out);
    assert.equal(past.ok, false, `${shift}: error ${past.error}, shift ${past.shift}`);
    assert.equal(past.reason, 'moved past the range');
  }
});

test('alignTo is not ok when the mark leaves the answer', () => {
  // A mark touching the right edge: moved 7 px, the answer holds nothing for its last 7 columns.
  const edge = { x: W - 30, y: 150, r: 50 };
  const mark = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (Math.hypot(i + 0.5 - edge.x, j + 0.5 - edge.y) < edge.r) mark[j * W + i] = 1;
  const out = outsideOf(W, H, { ...edge, r: edge.r + 4 });
  const returned = answer(look, W, H, [7, 0], 1, W, H, undefined, edge);
  const r = alignTo(returned, sent, out, { mark });
  assert.equal(r.ok, false, `error ${r.error}, offMark ${r.offMark}`);
  assert.equal(r.reason, 'mark leaves the answer');
  assert.ok(r.offMark > 0.005 * mark.reduce((a, b) => a + b, 0), String(r.offMark));
  const without = alignTo(returned, sent, out);
  assert.ok(without.ok, `without the mark: error ${without.error}`);
  assert.equal(without.offMark, 0);
  const middle = alignTo(answer(look, W, H, [7, 0], 1, W, H, undefined, edit), sent, outside, { mark: Uint8Array.from(outside, (v) => 1 - v) });
  assert.ok(middle.ok, `a mark in the middle: error ${middle.error}`);
  assert.equal(middle.offMark, 0);
  assert.equal(middle.reason, undefined);
});

test('alignTo is not ok with too little outside the mark', () => {
  // Only a 3 px frame is outside: under 5 % of the crop.
  const frame = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (i < 3 || j < 3 || i >= W - 3 || j >= H - 3) frame[j * W + i] = 1;
  const r = alignTo(answer(look, W, H, [2, 1], 1, W, H), sent, frame);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too little outside the mark');
  const none = alignTo(sent, sent, new Uint8Array(W * H));
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'too little outside the mark');
});

test('alignTo lines up 1024 x 1024 at an interactive speed', () => {
  const N = 1024, big = scene(5, N, N);
  const s = render(big, N, N);
  const out = outsideOf(N, N, { x: 500, y: 540, r: 150 });
  const returned = answer(big, N, N, [-20, 13], 1.025, 1024, 1024, undefined, { x: 500, y: 540, r: 140 });
  const t0 = performance.now();
  const r = alignTo(returned, s, out, { tones: true });
  const ms = performance.now() - t0;
  assert.ok(r.ok, `ok, error ${r.error}`);
  assert.ok(Math.abs(r.shift[0] + 20) <= 1 && Math.abs(r.shift[1] - 13) <= 1, `shift ${r.shift}`);
  assert.ok(scaleNear(r.scale, 1.025, N / 2), `scale ${r.scale}`);
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
  console.log(`alignTo 1024 x 1024: ${ms.toFixed(0)} ms`);
});

/**
 * How far (pixels) the found transform puts the content at the sent picture's far edges from where
 * `truth` has it: the worst of the four sides' midpoints along their own axis.
 */
function edgeOff(r: { shift: [number, number]; scale: [number, number] }, w: number, h: number, shift: [number, number], scale: [number, number]) {
  // Pixel p (index) of the sent picture is at c + s * (p - c) + d in the answer, c = (size - 1) / 2.
  const at = (p: number, size: number, s: number, d: number) => (size - 1) / 2 + s * (p - (size - 1) / 2) + d;
  return Math.max(...[0, w - 1].map((x) => Math.abs(at(x, w, r.scale[0], r.shift[0]) - at(x, w, scale[0], shift[0]))),
    ...[0, h - 1].map((y) => Math.abs(at(y, h, r.scale[1], r.shift[1]) - at(y, h, scale[1], shift[1]))));
}

test('alignTo recovers a different scale on x and y (an answer stretched back from the model\'s own size)', () => {
  // Gemini's 1K sizes for 4:3 and the like are about 2.8 % off the ratio asked for: resized back, one
  // axis comes out scaled and the other not.
  const truth: [number, number] = [1.028, 1];
  const r = alignTo(answer(look, W, H, [4, -3], truth, W, H, undefined, edit), sent, outside);
  assert.ok(r.ok, `ok, error ${r.error}`);
  assert.ok(edgeOff(r, W, H, [4, -3], truth) <= 1, `off ${edgeOff(r, W, H, [4, -3], truth).toFixed(2)} px: shift ${r.shift}, scale ${r.scale}`);
  const N = 320, art = flatArt(3, N), flat = render(art, N, N), dot = { x: 160, y: 160, r: 45 };
  const tall: [number, number] = [1, 0.975];
  const a = alignTo(answer(art, N, N, [-3, 5], tall, 512, 640, undefined, dot), flat, outsideOf(N, N, { ...dot, r: dot.r + 4 }));
  assert.ok(a.ok, `flat art ok, error ${a.error}`);
  assert.ok(edgeOff(a, N, N, [-3, 5], tall) <= 1, `flat art off ${edgeOff(a, N, N, [-3, 5], tall).toFixed(2)} px: shift ${a.shift}, scale ${a.scale}`);
});

test('featherPaste keeps every pixel outside the mark byte-identical and takes the edit deep inside', () => {
  const w = 100, h = 80, rnd = random(5);
  const orig: Raster = { width: w, height: h, data: Uint8ClampedArray.from({ length: w * h * 4 }, () => Math.floor(rnd() * 256)) };
  const edited: Raster = { width: w, height: h, data: Uint8Array.from({ length: w * h * 4 }, () => Math.floor(rnd() * 256)) };
  const mask = new Uint8Array(w * h);
  const disc = { x: 45, y: 40, r: 25 };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (Math.hypot(i - disc.x, j - disc.y) < disc.r) mask[j * w + i] = 1;
  // A piece of the mark along the right border: the picture's edge is not the mark's edge.
  for (let j = 30; j < 50; j++) for (let i = 85; i < w; i++) mask[j * w + i] = 1;
  const f = 5;
  const out = featherPaste(orig, edited, mask, f);
  let blended = 0;
  for (let p = 0; p < w * h; p++) {
    const px = [...out.data.slice(p * 4, p * 4 + 4)];
    if (!mask[p]) { assert.deepEqual(px, [...orig.data.slice(p * 4, p * 4 + 4)], `outside ${p}`); continue; }
    const i = p % w, j = Math.floor(p / w);
    const deep = Math.hypot(i - disc.x, j - disc.y) < disc.r - f - 1.5 || (i >= 85 + f + 1 && j >= 30 + f + 1 && j < 50 - f - 1);
    if (deep) assert.deepEqual(px, [...edited.data.slice(p * 4, p * 4 + 4)], `deep ${p}`);
    else if (px.join() !== [...edited.data.slice(p * 4, p * 4 + 4)].join()) blended++;
  }
  assert.ok(blended > 100, `the edge is blended (${blended})`);
  // At the right border, deep in the strip, the pixel is the edit's.
  const p = 40 * w + (w - 1);
  assert.deepEqual([...out.data.slice(p * 4, p * 4 + 4)], [...edited.data.slice(p * 4, p * 4 + 4)]);
  assert.deepEqual([...featherPaste(orig, edited, new Uint8Array(w * h), f).data], [...orig.data]);
});

/** A grey picture (R = G = B, alpha 255) with `v(i, j)` at each pixel. */
function grey(w: number, h: number, v: (i: number, j: number) => number): Raster {
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const o = (j * w + i) * 4, g = clamp255(v(i, j));
    data[o] = data[o + 1] = data[o + 2] = g;
    data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** A mark like brush strokes: a thick straight stroke with round end caps, and a strip out to the right border. */
function strokeMask(w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h), a = [40, 40], b = [110, 75], r = 18;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const ux = b[0] - a[0], uy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((i - a[0]) * ux + (j - a[1]) * uy) / (ux * ux + uy * uy)));
    if (Math.hypot(i - a[0] - t * ux, j - a[1] - t * uy) < r || (i >= 120 && j >= 20 && j < 34)) mask[j * w + i] = 1;
  }
  return mask;
}

/** The mark's edge pixels: in the mark, next to a pixel outside it. */
function edgePixels(mask: Uint8Array, w: number, h: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = j * w + i;
    if (mask[p] && ((i > 0 && !mask[p - 1]) || (i < w - 1 && !mask[p + 1]) || (j > 0 && !mask[p - w]) || (j < h - 1 && !mask[p + w]))) out.push(p);
  }
  return out;
}

/**
 * The worst new step a paste makes near the mark's edge: over every pair of neighbouring pixels
 * (one in the mark, the other outside it or in it) within `band` px of the edge, how much more they
 * differ in `out` than in either the original or the edit (0 when no new step), on channel `k`.
 */
function edgeStep(out: Raster, orig: Raster, edited: Raster, mask: Uint8Array, band: number, k = 0): number {
  const w = out.width, h = out.height, near = new Uint8Array(w * h);
  // Mark pixels within `band` (4-steps) of a pixel outside the mark.
  let ring: number[] = [];
  for (let p = 0; p < w * h; p++) if (!mask[p]) ring.push(p);
  for (let step = 0; step < band; step++) {
    const next: number[] = [];
    for (const p of ring) {
      const i = p % w, j = (p / w) | 0;
      for (const q of [i > 0 ? p - 1 : -1, i < w - 1 ? p + 1 : -1, j > 0 ? p - w : -1, j < h - 1 ? p + w : -1]) {
        if (q >= 0 && mask[q] && !near[q]) { near[q] = 1; next.push(q); }
      }
    }
    ring = next;
  }
  let worst = 0;
  for (let p = 0; p < w * h; p++) {
    if (!near[p]) continue;
    const i = p % w, j = (p / w) | 0;
    for (const q of [i > 0 ? p - 1 : -1, i < w - 1 ? p + 1 : -1, j > 0 ? p - w : -1, j < h - 1 ? p + w : -1]) {
      if (q < 0) continue;
      const d = (r: Raster) => Math.abs(r.data[p * 4 + k] - r.data[q * 4 + k]);
      worst = Math.max(worst, d(out) - Math.max(d(orig), d(edited)));
    }
  }
  return worst;
}

test('seamlessPaste leaves no step at the mark\'s edge where the edit is re-toned, keeps the edit\'s detail and the outside bytes', () => {
  const w = 160, h = 120, rnd = random(9);
  const base = (i: number, j: number) => 110 + 45 * Math.sin(i / 15) * Math.cos(j / 11) + 4 * rnd();
  const values = Array.from({ length: w * h }, (_, p) => base(p % w, Math.floor(p / w)));
  const orig = grey(w, h, (i, j) => values[j * w + i]);
  // The model's redraw: 40 brighter, a gradient across it, a local bright patch over the stroke's
  // start (so the tone difference varies along the edge), and a drawn dark feature in the middle.
  const feature = { x: 75, y: 57, r: 6 };
  const edited = grey(w, h, (i, j) => Math.hypot(i - feature.x, j - feature.y) < feature.r ? 15
    : values[j * w + i] + 40 + 0.4 * (i - 40) + 30 * Math.exp(-((i - 35) ** 2 + (j - 35) ** 2) / (2 * 14 ** 2)));
  const mask = strokeMask(w, h), feather = 6;

  const out = seamlessPaste(orig, edited, mask, feather);
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) assert.deepEqual([...out.data.slice(p * 4, p * 4 + 4)], [...orig.data.slice(p * 4, p * 4 + 4)], `outside ${p}`);
  }
  const step = edgeStep(out, orig, edited, mask, feather + 2);
  assert.ok(step <= 3, `no new step at the edge (worst ${step})`);
  // A plain feathered paste of the same edit does show one (the test can tell).
  const plain = edgeStep(featherPaste(orig, edited, mask, feather), orig, edited, mask, feather + 2);
  assert.ok(plain >= 6, `the plain paste steps (worst ${plain})`);
  // The drawn feature is still there, much darker than the pasted area around it.
  const at = (i: number, j: number) => out.data[(j * w + i) * 4];
  const ringMean = [0, 1, 2, 3, 4, 5, 6, 7].reduce((s, k) => s + at(Math.round(feature.x + 11 * Math.cos(k * Math.PI / 4)), Math.round(feature.y + 11 * Math.sin(k * Math.PI / 4))), 0) / 8;
  assert.ok(ringMean - at(feature.x, feature.y) >= 60, `feature kept: centre ${at(feature.x, feature.y)}, around ${ringMean.toFixed(0)}`);
  // An empty mark pastes nothing.
  assert.deepEqual([...seamlessPaste(orig, edited, new Uint8Array(w * h), feather).data], [...orig.data]);
});

test('seamlessPaste with a fade keeps a tone change deep inside the mark and ramps it in at the edge, without a step', () => {
  const w = 200, h = 200, rnd = random(11);
  const orig = grey(w, h, (i, j) => 140 + 40 * Math.sin(i / 17) * Math.cos(j / 13) + 4 * rnd());
  // Asked darker: the whole marked area 60 darker, its detail kept.
  const edited = grey(w, h, (i, j) => orig.data[(j * w + i) * 4] - 60);
  const mask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (Math.hypot(i - 100, j - 100) < 60) mask[j * w + i] = 1;
  const fade = 24, out = seamlessPaste(orig, edited, mask, 6, fade);
  for (let p = 0; p < w * h; p++) if (!mask[p]) assert.equal(out.data[p * 4], orig.data[p * 4], `outside ${p}`);
  // Deeper than the fade the change is whole.
  let worstDeep = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = j * w + i;
    if (Math.hypot(i - 100, j - 100) < 60 - fade - 2) worstDeep = Math.max(worstDeep, Math.abs(out.data[p * 4] - edited.data[p * 4]));
  }
  assert.ok(worstDeep <= 1, `the darker middle is kept (off by ${worstDeep})`);
  // At the edge it ramps in: steps of a few levels a pixel, where a plain feathered paste jumps.
  const step = edgeStep(out, orig, edited, mask, fade + 2), plain = edgeStep(featherPaste(orig, edited, mask, 3), orig, edited, mask, fade + 2);
  assert.ok(step <= 6, `ramped in (worst ${step})`);
  assert.ok(plain >= 15, `the plain paste steps (worst ${plain})`);
});

test('seamlessPaste of a colour edit into a grey picture: the edge meets it exactly in every channel, no step, grey where the edit was only re-tinted', () => {
  const w = 160, h = 120, rnd = random(13);
  const values = Array.from({ length: w * h }, (_, p) => 110 + 45 * Math.sin((p % w) / 15) * Math.cos(Math.floor(p / w) / 11) + 4 * rnd());
  const orig = grey(w, h, (i, j) => values[j * w + i]);
  // A tinted redraw: each channel offset differently, a gradient and a dark feature common to all.
  const tint = [50, 20, -10], feature = { x: 75, y: 57, r: 6 };
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = j * w + i, v = Math.hypot(i - feature.x, j - feature.y) < feature.r ? 15 : values[p] + 0.4 * (i - 40);
    for (let k = 0; k < 3; k++) data[p * 4 + k] = clamp255(v + tint[k]);
    data[p * 4 + 3] = 255;
  }
  const edited: Raster = { width: w, height: h, data }, mask = strokeMask(w, h);
  const out = seamlessPaste(orig, edited, mask, 6);
  for (let p = 0; p < w * h; p++) if (!mask[p]) assert.deepEqual([...out.data.slice(p * 4, p * 4 + 4)], [...orig.data.slice(p * 4, p * 4 + 4)], `outside ${p}`);
  for (const p of edgePixels(mask, w, h)) assert.deepEqual([...out.data.slice(p * 4, p * 4 + 3)], [...orig.data.slice(p * 4, p * 4 + 3)], `edge ${p}`);
  for (let k = 0; k < 3; k++) {
    const step = edgeStep(out, orig, edited, mask, 8, k);
    assert.ok(step <= 3, `no new step on channel ${k} (worst ${step})`);
  }
  // The tint is corrected away channel by channel: the result stays grey (within rounding).
  let spread = 0;
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) continue;
    const c = out.data.slice(p * 4, p * 4 + 3);
    spread = Math.max(spread, Math.max(...c) - Math.min(...c));
  }
  assert.ok(spread <= 3, `grey (channels within ${spread})`);
});

test('seamlessPaste of a small mark keeps a darker tone whole at its middle, the fade and the feather held to half its depth', () => {
  const w = 120, h = 120, rnd = random(17);
  const orig = grey(w, h, (i, j) => 150 + 30 * Math.sin(i / 9) * Math.cos(j / 7) + 4 * rnd());
  const edited = grey(w, h, (i, j) => orig.data[(j * w + i) * 4] - 60);
  // A mark 40 px wide (its deepest point 20 px in), pasted with the photo path's 800 px feather and fade (16, 32).
  const mask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (Math.hypot(i - 60, j - 60) < 20) mask[j * w + i] = 1;
  const out = seamlessPaste(orig, edited, mask, 16, 32);
  for (const p of edgePixels(mask, w, h)) assert.equal(out.data[p * 4], orig.data[p * 4], `edge ${p}`);
  // The middle keeps 100 % of the darkening (within rounding); within 5 px of it at least 95 %.
  const c = 60 * w + 60;
  assert.ok(Math.abs(out.data[c * 4] - edited.data[c * 4]) <= 1, `middle ${out.data[c * 4]}, edit ${edited.data[c * 4]}`);
  let least = Infinity;
  for (let j = 55; j <= 65; j++) for (let i = 55; i <= 65; i++) {
    const p = j * w + i;
    if (Math.hypot(i - 60, j - 60) <= 5) least = Math.min(least, (orig.data[p * 4] - out.data[p * 4]) / 60);
  }
  assert.ok(least >= 0.95, `kept ${(least * 100).toFixed(0)} % of the darkening near the middle`);
});

test('seamlessPaste of half an 800 x 800 picture runs at an interactive speed', () => {
  const N = 800, rnd = random(3);
  const look = (i: number, j: number) => 120 + 60 * Math.sin(i / 37) * Math.cos(j / 23);
  const orig = grey(N, N, (i, j) => look(i, j) + 8 * rnd());
  // Redrawn as the model does: re-toned (less contrast, brighter, unevenly), with its own grain and new content.
  const edited = grey(N, N, (i, j) => Math.hypot(i - 400, j - 400) < 120 ? 60 + 40 * Math.cos(i / 9) + 8 * rnd()
    : 0.85 * look(i, j) + 40 + 25 * Math.sin(i / 150 + j / 210) + 8 * rnd());
  const mask = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (Math.hypot(i - 380, j - 420) < 320) mask[j * N + i] = 1;
  const t0 = performance.now();
  const out = seamlessPaste(orig, edited, mask, 16, 32);
  const ms = performance.now() - t0;
  // The photo path's feather and fade at 800: the re-toning ramps in a few levels a pixel, no step.
  const step = edgeStep(out, orig, edited, mask, 34);
  assert.ok(step <= 5, `no step at the edge (worst ${step})`);
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
});
