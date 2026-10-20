import './wasm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from 'fast-png';
import { lineArtPrompt, traceLineArt } from '../server/artwork';
import { cadTools } from '../server/cadTools';
import { lineArtLine } from '../server/geometry';
import { evaluateScript } from '../shared/runtime';
import { DRAWINGS_KEY, parseDrawings } from '../shared/svgFeatures';
import type { AgentEvent } from '../shared/api';
import { drawingFingerprint, LINEART_EDITS_KEY } from '../shared/lineart';

/** A 200×120 photo-like picture of line art: a black ring and a bar under it, 3–4 px lines, on a mid-grey, textured wall (half of it darker than mid grey). */
function picture() {
  const W = 200, H = 120, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r = Math.hypot(x - 100, y - 50);
    const ink = Math.abs(r - 35) < 2 || (y >= 100 && y < 104 && x >= 40 && x < 160) || (x >= 98 && x < 102 && y >= 85 && y < 100);
    const v = ink ? 20 : 120 + ((x * 7 + y * 13) % 15);
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}

test('line-art prompt: the house style and each style\'s composition', () => {
  const p = lineArtPrompt({ subject: 'a sport motorbike and a classic car side by side', style: 'keyholder' });
  assert.match(p, /Subject: a sport motorbike and a classic car/);
  assert.match(p, /bold, simplified black line art on pure white/);
  assert.match(p, /about 240 mm wide/);
  assert.match(p, /every line about 1\/171 of the picture's width thick \(about 9 px/);
  assert.match(lineArtPrompt({ subject: 'a cat', style: 'outline', width: 100, lineWidth: 1 }), /1\/71 of the picture's width/);
  assert.match(p, /ONE connected piece: no floating details/);
  assert.match(p, /every line starts and ends on another line/);
  assert.match(p, /no grey, shading, hatching, gradients/);
  assert.match(p, /no text, signature, watermark, frame, border/);
  assert.match(p, /ONE straight, horizontal ground line across the very bottom/);
  assert.match(p, /never cut off at the knees/);
  assert.doesNotMatch(p, /attached photo/);
  assert.match(lineArtPrompt({ subject: 'a woman in a long dress', style: 'framed' }), /filling the picture[\s\S]*all four sides/);
  assert.match(lineArtPrompt({ subject: 'a cat sitting', style: 'medallion' }), /fills a circle/);
  const ref = lineArtPrompt({ subject: 'my car', style: 'outline', references: ['data:image/png;base64,AA'], look: 'thin single-line drawing' });
  assert.match(ref, /exact model, proportions and signature features/);
  assert.match(ref, /Look: thin single-line drawing/);
});

test('tracing line art: one black shape on no background, the wall\'s grey ignored', () => {
  const { drawing, points } = traceLineArt(picture(), 'ring');
  assert.equal(drawing.aspect, 200 / 120);
  assert.equal(drawing.shapes.length, 1, 'only the black: its white is holes, not a shape');
  assert.equal(drawing.shapes[0].color, '#000000');
  assert.ok(points > 20 && points < 2000, `${points} points`);
  // Everything lies on the ring or the bar (units of the picture height, centred), nothing at the edges.
  for (const c of drawing.shapes[0].contours) for (const [x, y] of c) assert.ok(Math.abs(x) < 0.55 && y > -0.48 && y < 0.42, `${x},${y}`);
  // It makes a line-art piece: the ring joined to the bar by its stem, one piece.
  const r = evaluateScript("function build() { return H.lineart('ring', { width: 100 }); }", { [DRAWINGS_KEY]: JSON.stringify({ ring: drawing }) }, 'draft');
  assert.equal(r.parts[0].components, 1);
  assert.equal(r.parts[0].lineArt!.sources[0], 'ring');
});

test('trace_line_art and generate_line_art store a drawing for H.lineart', async () => {
  const p = picture();
  const png = Buffer.from(encode({ width: p.width, height: p.height, data: p.data, channels: 4 })).toString('base64');
  const events: AgentEvent[] = [];
  const base: Record<string, string> = {};
  const asked: { prompt: string; aspect: string; references?: string[] }[] = [];
  const image = async (prompt: string, aspect: string, references?: string[]) => { asked.push({ prompt, aspect, references }); return { image: { data: png, mediaType: 'image/png' }, model: 'test/image', cost: 0.04 }; };
  const references = [`data:image/png;base64,${png}`];
  const { server } = cadTools('/nonexistent/model.js', (e) => events.push(e), new Set(), base, { lineArt: { references, style: 'keyholder', pictures: true }, image });
  const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler: (a: unknown, x: unknown) => Promise<{ isError?: boolean; content: { text?: string }[] }> }> })._registeredTools;

  const traced = await tools.trace_line_art.handler({ name: 'ring', image: 1 }, {});
  assert.ok(!traced.isError, JSON.stringify(traced));
  assert.match(traced.content[0].text!, /H\.lineart\("ring", \{ style: 'keyholder'/);
  assert.equal(parseDrawings(base[DRAWINGS_KEY]).ring.shapes.length, 1);
  assert.ok(events.some((e) => e.type === 'drawing' && e.name === 'ring'));
  assert.match((await tools.trace_line_art.handler({ name: 'x', image: 2 }, {})).content[0].text!, /image must be 1–1/);
  assert.equal(asked.length, 0, 'tracing needs no image model');

  const drawn = await tools.generate_line_art.handler({ name: 'bike-and-car', subject: 'a motorbike and a car side by side', use_attached_photos: true }, {});
  assert.ok(!drawn.isError, JSON.stringify(drawn));
  assert.equal(asked[0].aspect, '16:9', 'a key holder is wide');
  assert.deepEqual(asked[0].references, references);
  assert.match(asked[0].prompt, /ground line/);
  assert.deepEqual(Object.keys(parseDrawings(base[DRAWINGS_KEY])), ['ring', 'bike-and-car']);

  // A partial edit: the drawing as it is, hand edits drawn in, goes first; the edits are baked in and dropped.
  const ring = parseDrawings(base[DRAWINGS_KEY]).ring;
  base[LINEART_EDITS_KEY] = JSON.stringify({ ring: { fp: drawingFingerprint(ring), strokes: [{ mode: 'draw', points: [[0, 0], [0.2, 0]] }] } });
  const edited = await tools.generate_line_art.handler({ name: 'ring', edit: 'ring', subject: 'make the ring thicker at the bottom' }, {});
  assert.ok(!edited.isError, JSON.stringify(edited));
  const last = asked[asked.length - 1];
  assert.match(last.prompt, /Change only this: make the ring thicker/);
  assert.equal(last.references?.length, 1);
  assert.match(last.references![0], /^data:image\/png;base64,/);
  assert.equal(base[LINEART_EDITS_KEY], undefined);
  assert.ok(events.some((e) => e.type === 'lineArtEditsBaked' && e.name === 'ring'));
  assert.match((await tools.generate_line_art.handler({ name: 'x', edit: 'nope', subject: 'change something here' }, {})).content[0].text!, /no drawing "nope"/);
});

test('the report\'s line-art line', () => {
  assert.equal(
    lineArtLine({ style: 'keyholder', sources: ['bike-and-car'], size: [240, 118.04], thickness: 2, lineWidth: 1, lines: 'even', bridges: 3, longestBridge: 6.21, dropped: 2, closed: 0, openings: 40, endsJoined: 0, endsFree: 0, hooks: 3, frames: [], edits: 0 }),
    'Line art (key holder) from "bike-and-car": 240 × 118 mm, 2 mm thick, 1 mm lines (even); 3 bridges added (longest 6.2 mm), 2 specks dropped; 3 pegs',
  );
  assert.match(lineArtLine({ style: 'outline', sources: ['a', 'b'], size: [200, 90], thickness: 2, lineWidth: 1.2, lines: 'keep', bridges: 0, longestBridge: 0, dropped: 0, closed: 6, openings: 20, endsJoined: 3, endsFree: 1, hooks: 0, frames: [], edits: 0 }), /from "a" \+ "b": .*at least 1\.2 mm \(the drawing's own weights\); no bridges needed, no specks dropped; 3 loose lines joined to a nearby line, 1 still loose \(held at one point only.*; 6 of 20 openings between lines closed up \(30 %/);
});
