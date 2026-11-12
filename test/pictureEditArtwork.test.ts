import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module from 'manifold-3d';
import { traceArtwork } from '../server/artwork';
import { combineDrawing, offPalette, OFF_PALETTE_DISTANCE, traceCrop } from '../server/pictureEdit/artwork';
import { cleanDrawing, drawingColors, drawingSection, MAX_SVG_POINTS, type SvgDrawing } from '../shared/svgFeatures';
import { markContours, markMask, type PictureMark } from '../shared/pictureEdit/mark';
import { renderDrawing, wholeWindow } from '../shared/pictureEdit/render';
import type { Vec2 } from '../shared/types';

const wasm = await Module();
wasm.setup();
const C = wasm.CrossSection;

const BLACK = '#111111', WHITE = '#ffffff', RED = '#d01c1f', SKIN = '#e0a868';
const SANTA = [BLACK, WHITE, RED, SKIN];
/** A circle of `n` points, counter-clockwise. */
const disc = (r: number, cx = 0, cy = 0, n = 96): Vec2[] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
/** A wobbly outline of `n` points at odd coordinates, as traced outlines are. */
const wobbly = (r: number, cx: number, cy: number, n: number): Vec2[] => Array.from({ length: n }, (_, i) => {
  const a = (2 * Math.PI * i) / n, k = r * (1 + 0.05 * Math.sin(7 * a + 0.3) + 0.01 * Math.sin(53 * a));
  return [cx + k * Math.cos(a), cy + k * Math.sin(a)];
});
const square = (h: number, cx = 0, cy = 0): Vec2[] => [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
const points = (d: SvgDrawing) => d.shapes.reduce((n, s) => n + s.contours.reduce((m, c) => m + c.length, 0), 0);
const area = (d: SvgDrawing, c: string) => drawingSection(d, 1, [c], C)?.area() ?? 0;
const section = (d: SvgDrawing, c?: string) => drawingSection(d, 1, c ? [c] : undefined, C) ?? C.compose([]);

/** Four colours as the tracer leaves them: EvenOdd, darkest first, each holding what is painted on it. */
const santa: SvgDrawing = {
  name: 'santa.svg', aspect: 1,
  shapes: [
    { rule: 'EvenOdd', contours: [disc(0.45, 0, 0, 400)], color: BLACK },
    { rule: 'EvenOdd', contours: [disc(0.3, 0, 0.05, 200), square(0.04, 0.2, 0.15)], color: RED },
    { rule: 'EvenOdd', contours: [wobbly(0.1, 0.0317, -0.0213, 600)], color: SKIN },
    { rule: 'EvenOdd', contours: [disc(0.08, 0.25, -0.25)], color: WHITE },
  ],
};
const middle: PictureMark = { strokes: [{ width: 0.25, points: [[0, 0]] }] };
/** What the image model drew: red everywhere with a small black square in it, in whole-drawing units. */
const redFresh: SvgDrawing = {
  name: 'santa.svg', aspect: 1,
  shapes: [
    { rule: 'EvenOdd', contours: [square(0.5)], color: BLACK },
    { rule: 'EvenOdd', contours: [square(0.5), square(0.05, 0.03, 0.02)], color: RED },
  ],
};

/** The RGBA raster of a render (what the crop sent to the model looks like). */
const rasterOf = (r: ReturnType<typeof renderDrawing>) => ({ width: r.width, height: r.height, data: r.data });

let santaEdit: ReturnType<typeof combineDrawing> | undefined;
/** The Santa drawing with the red edit in the middle (made once: it renders twice at 2400 px). */
const santaEdited = () => (santaEdit ??= combineDrawing(santa, redFresh, middle, C));

test('combineDrawing: outside the mark the old drawing, inside the fresh one, colours never overlap', () => {
  const M = new C(markContours(middle), 'NonZero');
  const r = santaEdited();
  assert.equal(r.drawing.name, 'santa.svg');
  assert.equal(r.drawing.aspect, 1);
  assert.equal(r.simplified, false);
  assert.equal(r.outsideSame, true);
  assert.deepEqual(drawingColors(r.drawing), drawingColors(santa), 'same colours, same paint order');
  for (const c of SANTA) {
    const was = section(santa, c).subtract(M).area(), now = section(r.drawing, c).subtract(M).area();
    assert.ok(Math.abs(now - was) <= 1e-6 * Math.max(was, 1e-9), `${c} outside: ${now} vs ${was}`);
    const want = section(redFresh, c).intersect(M).area(), got = section(r.drawing, c).intersect(M).area();
    assert.ok(Math.abs(got - want) <= 1e-6 * Math.max(want, 1e-3), `${c} inside: ${got} vs ${want}`);
  }
  assert.ok(section(r.drawing, RED).intersect(M).area() > 0.035, 'the mark is red now (but for the black square)');
  for (let i = 0; i < SANTA.length; i++) for (let j = i + 1; j < SANTA.length; j++) {
    const both = section(r.drawing, SANTA[i]).intersect(section(r.drawing, SANTA[j])).area();
    assert.ok(both < 1e-9, `${SANTA[i]} and ${SANTA[j]} overlap by ${both}`);
  }
  // Contours that do not reach the mark stay exactly as they were.
  assert.deepEqual(r.drawing.shapes[0].contours[0], santa.shapes[0].contours[0], 'the outline far from the mark');
  assert.deepEqual(r.drawing.shapes[1].contours.slice(0, 2), santa.shapes[1].contours);
  assert.deepEqual(r.drawing.shapes[3], santa.shapes[3]);
  assert.ok(cleanDrawing(r.drawing), 'a drawing the app keeps');
});

test('combineDrawing builds without slivers at any size', () => {
  // Outlines as the tracer makes them (odd coordinates, many points), and a traced edit: in the
  // mark the skin turns red, a black band crosses it and its right side becomes background (where
  // nothing painted on top hides a sliver).
  const whole = wholeWindow(santa);
  const r = renderDrawing(santa, [], whole, 600);
  const bg = Uint8Array.from(r.labels, (l) => (l < 0 ? 1 : 0));
  const traced = traceCrop(rasterOf(r), SANTA, whole, bg, 'santa.svg', MAX_SVG_POINTS);
  const answer = r.data.slice(), inMark = markMask(middle, { w: r.width, h: r.height, px: 1 / r.height, x0: whole.x0, y1: whole.y1 });
  for (let j = 0; j < r.height; j++) for (let i = 0; i < r.width; i++) {
    const p = j * r.width + i;
    if (!inMark[p]) continue;
    if (i > r.width / 2 - 30) answer.set([255, 255, 255], p * 4);
    else if (Math.abs(j - r.height / 2) < 8) answer.set([0x11, 0x11, 0x11], p * 4);
    else if (r.labels[p] === SANTA.indexOf(SKIN)) answer.set([0xd0, 0x1c, 0x1f], p * 4);
  }
  // The background mask joins the new white on the right to the background through a gap in the ring.
  const fresh = traceCrop({ width: r.width, height: r.height, data: answer }, SANTA, whole, bg, 'santa.svg', MAX_SVG_POINTS);
  const edited = combineDrawing(traced, fresh, middle, C);
  assert.equal(edited.outsideSame, true);
  // Built at sizes in mm, no colour has a hairline piece (area under 1e-10 of the height squared:
  // 1 um2 at 100 mm). Old contours plus their part in the mark (an XOR) leave a dozen here.
  for (const h of [37.3, 60, 100]) {
    for (const c of SANTA) {
      const polys = drawingSection(edited.drawing, h, [c], C)?.toPolygons() ?? [];
      const tiny = polys.filter((p) => {
        let a = 0;
        for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; a += x0 * y1 - x1 * y0; }
        return Math.abs(a / 2) < 1e-10 * h * h;
      });
      assert.equal(tiny.length, 0, `${c} at ${h} mm: ${tiny.length} slivers`);
    }
  }
});

test('combineDrawing keeps the extent for a mark over the edge', () => {
  const old: SvgDrawing = { name: 'sq.svg', aspect: 1, shapes: [{ rule: 'EvenOdd', contours: [square(0.4)], color: BLACK }, { rule: 'EvenOdd', contours: [square(0.1)], color: RED }] };
  const mark: PictureMark = { strokes: [{ width: 0.3, points: [[0.4, 0], [0.4, 0.2]] }] };
  const fresh: SvgDrawing = { name: 'sq.svg', aspect: 1, shapes: [{ rule: 'EvenOdd', contours: [square(0.7)], color: RED }] };
  const r = combineDrawing(old, fresh, mark, C);
  const was = section(old).bounds(), now = section(r.drawing).bounds();
  for (const k of ['min', 'max'] as const) for (const i of [0, 1]) assert.ok(Math.abs(now[k][i] - was[k][i]) < 1e-9, `${k}[${i}] ${now[k][i]} vs ${was[k][i]}`);
  const M = new C(markContours(mark), 'NonZero');
  const box = C.square([0.8, 0.8], true);
  assert.ok(Math.abs(section(r.drawing, RED).intersect(M).area() - M.intersect(box).area()) < 1e-9, 'red fills the mark up to the old box');
  assert.equal(r.outsideSame, true);
});

test('combineDrawing stays under the point limit', () => {
  // Black with a speck of red (the fresh colours are the old drawing's own).
  const old: SvgDrawing = { name: 'dense.svg', aspect: 1, shapes: [{ rule: 'EvenOdd', contours: [disc(0.45, 0, 0, 39000)], color: BLACK }, { rule: 'EvenOdd', contours: [square(0.02, 0.3, 0.3)], color: RED }] };
  const mark: PictureMark = { strokes: [{ width: 0.2, points: [[0, 0]] }] };
  // A rough-edged blot of 20,000 points inside the mark, as a noisy picture traces.
  const star: Vec2[] = Array.from({ length: 20000 }, (_, i) => {
    const a = (2 * Math.PI * i) / 20000, r = 0.07 + 0.001 * Math.sin(a * 2000);
    return [r * Math.cos(a), r * Math.sin(a)];
  });
  const fresh: SvgDrawing = { name: 'dense.svg', aspect: 1, shapes: [{ rule: 'EvenOdd', contours: [square(0.5)], color: BLACK }, { rule: 'EvenOdd', contours: [star], color: RED }] };
  const r = combineDrawing(old, fresh, mark, C);
  assert.equal(r.simplified, true);
  assert.ok(points(r.drawing) <= MAX_SVG_POINTS, String(points(r.drawing)));
  assert.ok(cleanDrawing(r.drawing), 'a drawing the app keeps');
  assert.deepEqual(r.drawing.shapes[0].contours[0], old.shapes[0].contours[0], 'the old outline is never simplified');
  assert.ok(Math.abs(area(r.drawing, RED) - 0.04 ** 2 - Math.PI * 0.07 ** 2) < 0.001, `the star is still there: ${area(r.drawing, RED)}`);
  assert.equal(r.outsideSame, true);
});

test('combineDrawing says when the old drawing alone is too detailed to edit', () => {
  // The mark's outline alone takes it over the limit.
  const old: SvgDrawing = { name: 'full.svg', aspect: 1, shapes: [{ rule: 'EvenOdd', contours: [disc(0.45, 0, 0, 39990)], color: BLACK }] };
  const mark: PictureMark = { strokes: [{ width: 0.2, points: [[0, 0]] }] };
  assert.throws(() => combineDrawing(old, redFresh, mark, C), /The drawing is too detailed to edit: \d+ points/);
});

test('combineDrawing re-expresses a NonZero shape that meets the mark, and keeps one that does not', () => {
  const old: SvgDrawing = {
    name: 'nz.svg', aspect: 1,
    shapes: [{ rule: 'NonZero', contours: [square(0.3)], color: BLACK }, { rule: 'NonZero', contours: [square(0.05, 0.35, 0.35)], color: RED }],
  };
  const r = combineDrawing(old, redFresh, middle, C);
  assert.deepEqual(r.drawing.shapes[1], old.shapes[1]);
  const M = new C(markContours(middle), 'NonZero');
  assert.ok(Math.abs(section(r.drawing, BLACK).subtract(M).area() - section(old, BLACK).subtract(M).area()) < 1e-9);
  assert.equal(r.outsideSame, true);
});

test('traceCrop puts a traced window back where it came from', () => {
  // A window at 400 px, and a tall one at 2501 px that the tracer box-filters down by 2 first.
  for (const [win, heightPx] of [[{ x0: -0.3, y1: 0.35, w: 0.5, h: 0.4 }, 400], [{ x0: -0.05, y1: 0.45, w: 0.06, h: 0.9 }, 2501]] as const) {
    const r = renderDrawing(santa, [], win, heightPx);
    const bg = Uint8Array.from(r.labels, (l) => (l < 0 ? 1 : 0));
    const fresh = traceCrop(rasterOf(r), SANTA, win, bg, 'santa.svg', MAX_SVG_POINTS);
    const box = C.square([win.w, win.h]).translate([win.x0, win.y1 - win.h]);
    const px2 = (win.h / r.height) ** 2, total = win.w * win.h;
    const colours = drawingColors(santa);
    for (const c of SANTA) {
      const got = section(fresh, c).intersect(box);
      const labels = r.labels.reduce((n, l) => n + (colours[l] === c ? 1 : 0), 0) * px2;
      assert.ok(Math.abs(got.area() - labels) < 0.01 * total, `${heightPx} px, ${c}: ${got.area()} vs labels ${labels}`);
      // Where, not only how much: the traced colour lies on the drawing's own.
      const want = section(santa, c).intersect(box);
      const off = got.subtract(want).area() + want.subtract(got).area();
      assert.ok(off < 0.01 * total, `${heightPx} px, ${c}: ${off} off`);
    }
  }
});

test('traceCrop: background where the crop was background plus new white joined to it; white inside stays white', () => {
  // A black ring with a white filament inside, cut by the window so the white touches the crop's edge.
  const ring: SvgDrawing = { name: 'ring.svg', aspect: 1, shapes: [{ rule: 'EvenOdd', contours: [disc(0.4)], color: BLACK }, { rule: 'EvenOdd', contours: [disc(0.25)], color: WHITE }] };
  const win = { x0: -0.1, y1: 0.45, w: 0.5, h: 0.5 };
  const r = renderDrawing(ring, [], win, 200);
  const bg = Uint8Array.from(r.labels, (l) => (l < 0 ? 1 : 0));
  const crop = rasterOf(r);
  // The model whitened a patch of the ring where it meets the background (top right).
  const px = win.h / r.height;
  for (let j = 0; j < r.height; j++) for (let i = 0; i < r.width; i++) {
    const x = win.x0 + (i + 0.5) * px, y = win.y1 - (j + 0.5) * px;
    if (Math.hypot(x - 0.25, y - 0.25) < 0.08) crop.data.fill(255, (j * r.width + i) * 4, (j * r.width + i) * 4 + 3);
  }
  const fresh = traceCrop(crop, [BLACK, WHITE], win, bg, 'ring.svg', MAX_SVG_POINTS);
  const box = C.square([win.w, win.h]).translate([win.x0, win.y1 - win.h]);
  const white = section(fresh, WHITE).intersect(box), wantWhite = section(ring, WHITE).intersect(box);
  assert.ok(Math.abs(white.area() - wantWhite.area()) < 0.01 * win.w * win.h, `the white inside stays: ${white.area()} vs ${wantWhite.area()}`);
  const patch = new C([disc(0.06, 0.25, 0.25)]);
  assert.ok(section(fresh).intersect(patch).area() < 1e-4, 'the new white joined to the background is background');
});

/** The test picture of test/artwork.test.ts. */
function picture() {
  const W = 300, H = 200, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let v = 255;
    if ((x - 150) ** 2 + (y - 100) ** 2 < 80 ** 2) v = 10;
    if (Math.abs(x - 150) < 25 && Math.abs(y - 100) < 25) v = 128;
    if (x % 50 === 5 && y % 50 === 5) v = 128;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}
const sha = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex');

test('traceArtwork without opts traces as before; a background of the edges is the same', () => {
  // Hashes of the output before the background option existed.
  assert.equal(sha(traceArtwork(picture(), ['#000000', '#808080'], 4, 'disc')), '817faea4ff6f82376182c2fcb9e9b5db93d0869db5f97aa00191852d40562671');
  assert.equal(sha(traceArtwork(picture(), undefined, 3, 'disc')), '192f198f1c665b2147049b6554c018e7606b2f619c1c7abc45ede1893cb81c28');
  const edges = new Uint8Array(300 * 200);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 300; x++) if (!x || !y || x === 299 || y === 199) edges[y * 300 + x] = 1;
  assert.equal(sha(traceArtwork(picture(), ['#000000', '#808080'], 4, 'disc', [], { background: edges })), '817faea4ff6f82376182c2fcb9e9b5db93d0869db5f97aa00191852d40562671');
});

test('traceArtwork keeps to a smaller point budget', () => {
  const full = traceArtwork(picture(), ['#000000', '#808080'], 4, 'disc');
  const small = traceArtwork(picture(), ['#000000', '#808080'], 4, 'disc', [], { budget: Math.floor(full.points / 2) });
  assert.ok(small.points <= full.points / 2, `${small.points} vs ${full.points}`);
});

test('offPalette: a brown face against the Santa colours', () => {
  const W = 40, H = 40, data = new Uint8Array(W * H * 4).fill(255), mask = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const o = (j * W + i) * 4;
    if (i < 30) { data[o] = 0x8b + ((i * 7 + j) % 5) - 2; data[o + 1] = 0x5a; data[o + 2] = 0x2b; }
    if (i >= 10) mask[j * W + i] = 1;
  }
  const r = offPalette({ width: W, height: H, data }, mask, SANTA);
  assert.ok(r.share > 0.5 && r.share < 0.7, `share ${r.share}`);
  const [R, G, B] = [1, 3, 5].map((k) => parseInt(r.colour!.slice(k, k + 2), 16));
  assert.ok(R > G && G > B && Math.abs(R - 0x8b) < 4, `a brown: ${r.colour}`);
  // The design's own colours with a little noise, and the white paper, are on the palette.
  data.fill(0);
  for (let p = 0; p < W * H; p++) { const c = [[0x11, 0x11, 0x11], [0xd0, 0x1c, 0x1f], [0xe0, 0xa8, 0x68], [250, 251, 252]][p % 4]; data.set(c.map((v) => v + ((p % 7) - 3)), p * 4); }
  assert.deepEqual(offPalette({ width: W, height: H, data }, mask, [BLACK, RED, SKIN]), { share: 0, colour: null });
  assert.ok(OFF_PALETTE_DISTANCE > 20 && OFF_PALETTE_DISTANCE < 93, 'between noise and the nearest Santa colour to brown');
});
