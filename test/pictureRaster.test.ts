import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Raster } from '../shared/meshFormats';
import { ASPECTS } from '../server/artwork';
import { ALIGN_MAX_ERROR, alignTo, chooseCrop, featherPaste, resizeTo } from '../server/pictureEdit/raster';

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
 * c + scale * (p - c) + shift, a blob painted over the marked disc, drawn at outW x outH (another
 * size and aspect is stretched back, as a model ignoring the asked ratio would).
 */
function answer(look: Look, w: number, h: number, shift: [number, number], scale: number, outW = w, outH = h, post?: (c: number, k: number) => number, edit?: { x: number; y: number; r: number }) {
  const cx = w / 2, cy = h / 2;
  const edited: Look = (x, y) => (edit && Math.hypot(x - edit.x, y - edit.y) < edit.r ? [250, 40 + 0.3 * x, 200] : look(x, y));
  return render(edited, outW, outH, (i, j) => {
    const qx = (i + 0.5) * w / outW, qy = (j + 0.5) * h / outH;
    return [cx + (qx - cx - shift[0]) / scale, cy + (qy - cy - shift[1]) / scale];
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
    assert.ok(Math.abs(r.scale - 1.02) * (W / 2) <= 1, `scale ${r.scale}`);
    assert.equal(r.image.width, W);
    assert.equal(r.image.height, H);
    assert.ok(meanDiff(r.image, sent, outside) < 4, `lined up ${meanDiff(r.image, sent, outside)}`);
  }
});

test('alignTo lines up a picture too small to halve', () => {
  const w = 120, h = 90, small = scene(21, w, h), dot = { x: 66, y: 40, r: 16 };
  const r = alignTo(answer(small, w, h, [2, -2], 0.975, 160, 100, undefined, dot), render(small, w, h), outsideOf(w, h, { ...dot, r: dot.r + 3 }));
  assert.ok(r.ok, `ok, error ${r.error}`);
  assert.ok(Math.abs(r.shift[0] - 2) <= 1 && Math.abs(r.shift[1] + 2) <= 1 && Math.abs(r.scale - 0.975) * (w / 2) <= 1, `${r.shift} ${r.scale}`);
});

test('alignTo with tones recovers a +20 brightness and 0.9 contrast change', () => {
  const returned = answer(look, W, H, [-6, 4], 0.98, W, H, (c) => 0.9 * c + 20, edit);
  const plain = alignTo(returned, sent, outside);
  const r = alignTo(returned, sent, outside, { tones: true });
  assert.ok(r.ok, `ok, error ${r.error}`);
  assert.ok(r.error < plain.error, `${r.error} < ${plain.error}`);
  assert.ok(Math.abs(r.shift[0] + 6) <= 1 && Math.abs(r.shift[1] - 4) <= 1, `shift ${r.shift}`);
  assert.ok(Math.abs(r.scale - 0.98) * (W / 2) <= 1, `scale ${r.scale}`);
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
  }
});

test('alignTo does not pass an answer moved past the allowed range, though its error is small', () => {
  // 3 % of 400 is 12 px: 16 px held at 12 would paste 4 px off.
  for (const [shift, scale] of [[[16, 0], 1], [[0, -12], 1], [[0, 0], 1.045]] as [[number, number], number][]) {
    const r = alignTo(answer(look, W, H, shift, scale, W, H, undefined, edit), sent, outside);
    assert.equal(r.ok, false, `${shift} ${scale}: error ${r.error}, shift ${r.shift}, scale ${r.scale}`);
  }
  const inside = alignTo(answer(look, W, H, [11.6, -8.6], 1.029, W, H, undefined, edit), sent, outside);
  assert.ok(inside.ok, `just inside: error ${inside.error}, shift ${inside.shift}, scale ${inside.scale}`);
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
  assert.ok(Math.abs(r.scale - 1.025) * (N / 2) <= 1, `scale ${r.scale}`);
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
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
