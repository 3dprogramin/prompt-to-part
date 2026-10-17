import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScript } from '../shared/runtime';
import { HF_IMAGES_KEY, luma, toHfImage, toLinear, toSrgb } from '../shared/hueforge';
import {
  backlitRgb, cleanLithophaneSource, isLithophane, LITHO_MU, lithophaneMesh, lithoPrint, lithoThickness, lithoVertexColors,
  resolveLithoOptions, simulateLithophane, type LithophaneOptions,
} from '../shared/lithophane';

/** RGBA pixels from a function of (x, y) → grey level. */
function picture(w: number, h: number, grey: (x: number, y: number) => number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    rgba[p] = rgba[p + 1] = rgba[p + 2] = grey(x, y);
    rgba[p + 3] = 255;
  }
  return rgba;
}

// A gradient from black (left) to white (right), 2:1.
const gradient = toHfImage('gradient.png', 200, 100, picture(200, 100, (x) => Math.round((x / 199) * 255)));
const values = { [HF_IMAGES_KEY]: JSON.stringify({ 'gradient.png': gradient }) };
const script = (opts: string) => `
const params = { width: { value: 100, min: 40, max: 200 } };
function build(p) { return { name: 'Lithophane', ...H.lithophane('gradient.png', { width: p.width${opts ? `, ${opts}` : ''} }) }; }`;
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;
const lumaAt = (c: ArrayLike<number>, v: number) => luma([c[v * 3], c[v * 3 + 1], c[v * 3 + 2]]);

test('lithoThickness: dark → thick, bright → thin, monotonic, evenly lit steps', () => {
  const r = resolveLithoOptions({ width: 100 });
  assert.deepEqual([r.minThickness, r.maxThickness, r.border, r.shape, r.stand, r.upright], [0.8, 3, 3, 'flat', 0, true]);
  assert.ok(near(lithoThickness(0, r), 3, 1e-6) && near(lithoThickness(1, r), 0.8, 1e-6));
  let prev = Infinity;
  for (let b = 0; b <= 1.0001; b += 0.01) {
    const t = lithoThickness(b, r);
    assert.ok(t < prev, `thinner as it gets brighter (b = ${b.toFixed(2)})`);
    prev = t;
  }
  // Beer–Lambert: the light through it, relative to the thinnest point, taken through the sRGB
  // curve, rises evenly with the picture's brightness, from the panel's black level to white.
  const shown = (b: number) => toSrgb(Math.exp(-LITHO_MU * (lithoThickness(b, r) - r.minThickness)));
  const black = shown(0);
  for (const b of [0.25, 0.5, 0.75]) assert.ok(near(shown(b), black + b * (1 - black), 1e-4), `even at ${b}`);
  // Not a straight line: the mid-tone is thinner than halfway, as the first millimetres dim most.
  assert.ok(lithoThickness(0.5, r) < (0.8 + 3) / 2 - 0.1);
  // invert and gamma.
  const inv = resolveLithoOptions({ width: 100, invert: true });
  assert.ok(near(lithoThickness(0, inv), 0.8, 1e-6) && near(lithoThickness(1, inv), 3, 1e-6));
  assert.ok(lithoThickness(0.3, resolveLithoOptions({ width: 100, gamma: 0.6 })) < lithoThickness(0.3, r), 'gamma < 1 lifts the shadows');
  assert.throws(() => resolveLithoOptions({} as LithophaneOptions), /width must be > 0/);
});

test('backlit colours: thin is warm white, thicker is darker and warmer', () => {
  const thin = backlitRgb(0.8, 0.8);
  assert.ok(thin[0] > 0.99 && thin[1] > 0.9 && thin[2] > 0.8 && thin[0] >= thin[1] && thin[1] >= thin[2], `warm white ${thin}`);
  let prev = Infinity;
  for (let t = 0.8; t <= 3.0001; t += 0.1) {
    const l = luma(backlitRgb(t, 0.8));
    assert.ok(l < prev, `darker at ${t.toFixed(1)} mm`);
    prev = l;
  }
  const thick = backlitRgb(3, 0.8);
  assert.ok(luma(thick) < 0.45, `dark ${thick}`);
  assert.ok(thick[0] / thick[2] > thin[0] / thin[2], 'warmer when thick');
  // Vertex colours: one RGB per vertex; 0 (the foot) is darker than the thickest picture point.
  const vc = lithoVertexColors(Float32Array.from([0.8, 3, 0]), { minThickness: 0.8, maxThickness: 3 });
  assert.equal(vc.length, 9);
  assert.ok(lumaAt(vc, 0) > lumaAt(vc, 1) && lumaAt(vc, 1) > lumaAt(vc, 2));
});

/** Every directed edge used once, and its reverse once: a closed, consistently oriented surface. */
function watertight(triVerts: Uint32Array): boolean {
  const edges = new Map<number, number>();
  const key = (a: number, b: number) => a * 4_194_304 + b;
  for (let t = 0; t < triVerts.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const e = key(triVerts[t + k], triVerts[t + ((k + 1) % 3)]);
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  for (const [e, n] of edges) if (n !== 1 || edges.get((e % 4_194_304) * 4_194_304 + Math.floor(e / 4_194_304)) !== 1) return false;
  return true;
}

test('lithophaneMesh: closed for every shape, with and without frame and foot', () => {
  const small = toHfImage('s.png', 12, 8, picture(12, 8, (x, y) => (x * 37 + y * 91) % 256));
  for (const shape of ['flat', 'curved', 'cylinder'] as const) {
    for (const border of [0, 2]) {
      for (const stand of [0, 12]) {
        for (const upright of shape === 'flat' ? [true, false] : [true]) {
          const m = lithophaneMesh(small, resolveLithoOptions({ width: 30, shape, border, stand, upright, resolution: 3 }));
          assert.ok(watertight(m.triVerts), `${shape}, border ${border}, stand ${stand}, upright ${upright}`);
          assert.equal(m.vertProperties.length % 4, 0);
        }
      }
    }
  }
});

test('H.lithophane flat: a solid upright panel of the right size, thickness from the picture, lit colours', () => {
  const r = evaluateScript(script(''), values, 'draft');
  const p = r.parts[0];
  assert.deepEqual(r.warnings, []);
  assert.equal(p.components, 1);
  assert.equal(p.genus, 0);
  // 100 × 50 picture plus a 3 mm frame, 3 mm deep, standing on the bed with its depth centred on Y.
  assert.ok(near(p.bbox.min[0], -53) && near(p.bbox.max[0], 53), JSON.stringify(p.bbox));
  assert.ok(near(p.bbox.min[1], -1.5) && near(p.bbox.max[1], 1.5), JSON.stringify(p.bbox));
  assert.ok(near(p.bbox.min[2], 0) && near(p.bbox.max[2], 56), JSON.stringify(p.bbox));
  assert.ok(p.volume > 106 * 56 * 0.8 && p.volume < 106 * 56 * 3, String(p.volume));
  // The front (−Y) is deep on the dark left and shallow on the bright right; the back is flat.
  let left = 0, right = Infinity;
  for (let v = 0; v < p.positions.length / 3; v++) {
    const [x, y, z] = [p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2]];
    if (z < 10 || z > 46) continue;
    const t = 1.5 - y;
    if (x > -48 && x < -46) left = Math.max(left, t);
    if (x > 46 && x < 48) right = Math.min(right, t);
  }
  assert.ok(left > 2.8 && right < 1, `left ${left}, right ${right}`);
  // Lit colours per vertex: the dark side of the front is dark, the bright side bright.
  assert.equal(p.vertexColors?.length, p.positions.length);
  let dark = 1, bright = 0;
  for (let v = 0; v < p.positions.length / 3; v++) {
    const [x, y, z] = [p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2]];
    if (z < 10 || z > 46 || y > 1) continue;
    if (x < -45) dark = Math.min(dark, lumaAt(p.vertexColors!, v));
    if (x > 45) bright = Math.max(bright, lumaAt(p.vertexColors!, v));
  }
  assert.ok(dark < 0.45 && bright > 0.9, `dark ${dark}, bright ${bright}`);
  // Print settings come with the part, for printing it upright.
  assert.deepEqual(r.print, { layerHeight: 0.12, walls: 4, infill: 100, infillPattern: 'zig-zag', brim: 5 });
  // What the side panel needs: the picture and the options.
  assert.equal(p.lithophane?.image, 'gradient.png');
  assert.deepEqual([p.lithophane!.options.width, p.lithophane!.options.maxThickness, p.lithophane!.options.shape], [100, 3, 'flat']);
  assert.equal(p.layerColors, undefined);
});

test('H.lithophane: foot, lying flat, curved and cylinder', () => {
  // A 20 mm foot, 4 mm high: the panel stands on it, still one piece.
  const foot = evaluateScript(script('stand: 20'), values, 'draft');
  const f = foot.parts[0];
  assert.equal(f.components, 1);
  assert.equal(f.genus, 0);
  assert.ok(near(f.bbox.min[1], -10) && near(f.bbox.max[1], 10) && near(f.bbox.min[2], 0) && near(f.bbox.max[2], 60), JSON.stringify(f.bbox));
  assert.equal(foot.print.brim, 'auto');
  // Lying flat: relief up, 0.08 mm layers.
  const flat = evaluateScript(script('upright: false, border: 0'), values, 'draft');
  assert.ok(near(flat.parts[0].bbox.max[2], 3, 0.01) && near(flat.parts[0].bbox.max[1], 25), JSON.stringify(flat.parts[0].bbox));
  assert.equal(flat.print.layerHeight, 0.08);
  // Curved over 90°: the 106 mm panel is an arc of radius 106 / (π/2) around Z, bulging to −Y.
  const curved = evaluateScript(script("shape: 'curved', angle: 90"), values, 'draft').parts[0];
  const R = 106 / (Math.PI / 2);
  assert.equal(curved.components, 1);
  assert.equal(curved.genus, 0);
  const halfChord = R * Math.sin(Math.PI / 4);
  assert.ok(curved.bbox.max[0] > halfChord && curved.bbox.max[0] < (R + 3) * Math.sin(Math.PI / 4) + 1e-3, JSON.stringify(curved.bbox));
  const depth = curved.bbox.max[1] - curved.bbox.min[1];
  assert.ok(depth > R * (1 - Math.cos(Math.PI / 4)) && depth < (R + 3) - R * Math.cos(Math.PI / 4) + 1e-3, String(depth));
  // Cylinder: a closed ring (genus 1) whose back radius is width / 2π, the picture outside.
  const cyl = evaluateScript(script("shape: 'cylinder', border: 2"), values, 'draft');
  const c = cyl.parts[0];
  assert.equal(c.components, 1);
  assert.equal(c.genus, 1);
  const Rc = 100 / (2 * Math.PI);
  let rMin = Infinity, rMax = 0;
  for (let v = 0; v < c.positions.length / 3; v++) {
    const rad = Math.hypot(c.positions[v * 3], c.positions[v * 3 + 1]);
    rMin = Math.min(rMin, rad); rMax = Math.max(rMax, rad);
  }
  assert.ok(near(rMin, Rc, 0.05) && near(rMax, Rc + 3, 0.05), `${rMin}…${rMax}`);
  assert.ok(near(c.bbox.max[2], 54), JSON.stringify(c.bbox));
  assert.equal(cyl.print.seam, 'back');
});

test('H.lithophane: scale, lite evaluations, moves and errors', () => {
  const r = evaluateScript(script(''), { ...values, $scale: 2 }, 'draft');
  const p = r.parts[0];
  assert.ok(near(p.bbox.max[0], 106) && near(p.bbox.max[2], 112), JSON.stringify(p.bbox));
  // The source scales with the part, so the preview still matches.
  const o = p.lithophane!.options;
  assert.deepEqual([o.width, o.minThickness, o.maxThickness, o.border].map((v) => +v.toFixed(9)), [200, 1.6, 6, 6]);
  // Thickness rides along through moves and booleans: a hole through the frame keeps the colours.
  const moved = evaluateScript(`function build() {
    const l = H.lithophane('gradient.png', { width: 100 });
    const hole = Manifold.cylinder(10, 2, 2, 24).rotate([90, 0, 0]).translate([0, 5, 54.5]);
    return { name: 'L', ...l, shape: l.shape.subtract(hole).translate([5, 0, 0]) };
  }`, values, 'draft').parts[0];
  assert.equal(moved.vertexColors?.length, moved.positions.length);
  let bright = 0;
  for (let v = 0; v < moved.positions.length / 3; v++) if (moved.positions[v * 3] > 50 && moved.positions[v * 3 + 1] < 1.4) bright = Math.max(bright, lumaAt(moved.vertexColors!, v));
  assert.ok(bright > 0.9, String(bright));
  const lite = evaluateScript(script(''), values, 'draft', { lite: true }).parts[0];
  assert.equal(lite.lithophane?.image, 'gradient.png');
  assert.equal(lite.vertexColors, undefined);
  assert.throws(() => evaluateScript("function build() { return H.lithophane('cat.jpg', { width: 50 }).shape; }", values, 'draft'), /no picture named "cat.jpg" \(pictures: "gradient.png"\)/);
  assert.equal(cleanLithophaneSource({ image: 'x', options: { width: 10, minThickness: 3, maxThickness: 1 } }), undefined);
});

test('simulateLithophane: the picture lit from behind, frame included', () => {
  const sim = simulateLithophane(gradient, { width: 100, border: 5 });
  assert.deepEqual([sim.width, sim.height], [220, 120]); // 5 mm of a 100 mm, 200 px picture: 10 px
  const at = (x: number, y: number) => luma([sim.rgba[(y * sim.width + x) * 4] / 255, sim.rgba[(y * sim.width + x) * 4 + 1] / 255, sim.rgba[(y * sim.width + x) * 4 + 2] / 255]);
  assert.ok(at(12, 60) < at(110, 60) && at(110, 60) < at(207, 60), 'dark to bright');
  assert.ok(Math.abs(at(0, 0) - at(10, 60)) < 0.01, 'the frame is as dark as the darkest point');
  // The lit mid-tone sits evenly between the panel's black and white (perceptually, through sRGB).
  const r = resolveLithoOptions({ width: 100 });
  const g = (x: number) => toSrgb(toLinear(sim.rgba[(60 * sim.width + x) * 4 + 1] / 255) / toLinear(0xf0 / 255));
  const black = toSrgb(Math.exp(-LITHO_MU * (r.maxThickness - r.minThickness)));
  assert.ok(Math.abs(g(110) - (black + 0.5 * (1 - black))) < 0.03, `${g(110)}`);
  // A cylinder shows unrolled, its frame only top and bottom.
  const cyl = simulateLithophane(gradient, { width: 100, border: 5, shape: 'cylinder' });
  assert.deepEqual([cyl.width, cyl.height], [200, 120]);
});

test('print settings, and recognising a lithophane script', () => {
  assert.equal(lithoPrint(resolveLithoOptions({ width: 100, maxThickness: 2 })).print.walls, 3);
  assert.equal(lithoPrint(resolveLithoOptions({ width: 100, maxThickness: 4 })).print.walls, 5);
  assert.match(lithoPrint(resolveLithoOptions({ width: 100 })).note, /white PLA, standing up/);
  assert.ok(isLithophane("function build() { return { name: 'L', ...H.lithophane('photo-1', { width: 80 }) }; }"));
  assert.ok(!isLithophane("function build() { return { name: 'P', ...H.hueforge('photo-1', { width: 80 }) }; }"));
  assert.ok(!isLithophane(undefined));
});
