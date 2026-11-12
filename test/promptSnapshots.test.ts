// The full prompt each mode sends (system prompt, tool list, first user message), as files in
// test/fixtures/prompts. A change to the prompt code that changes the text fails here; if the
// change is meant, run `UPDATE_PROMPTS=1 pnpm test` and review the diff of the fixtures.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { GenerateRequest } from '../shared/api';
import { DEFAULT_PRINTER, setPrinter } from '../shared/printer';
import { drawingFingerprint } from '../shared/lineart/strokes';
import { PICTURE_MARKS_KEY } from '../shared/pictureEdit/mark';
import { photoFingerprint } from '../shared/pictureEdit/photo';
import { LAYERTONE_IMAGES_KEY, toBase64 } from '../shared/layertone';
import type { SvgDrawing } from '../shared/svgFeatures';

const dataDir = mkdtempSync(path.join(tmpdir(), 'ptp-prompts-'));
// server/config.ts reads these when it is first imported.
process.env.PTP_DATA = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
process.env.ANTHROPIC_API_KEY = 'test';
setPrinter(DEFAULT_PRINTER);
const { runGeneration } = await import('../server/agent');

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'prompts');
const update = !!process.env.UPDATE_PROMPTS;

type Registered = Record<string, { description?: string }>;

/** Runs one generation with a fake query and returns what would have been sent to Claude. */
async function captured(req: GenerateRequest): Promise<string> {
  let out = '';
  const fake = ((args: Parameters<typeof query>[0]) => {
    const options = args.options as Record<string, any>;
    const registered = (options.mcpServers?.cad?.instance as unknown as { _registeredTools?: Registered })?._registeredTools;
    if (!registered) throw new Error('the cad MCP server has no _registeredTools in this SDK version');
    const tools = Array.isArray(options.tools) ? options.tools.join(', ') : JSON.stringify(options.tools);
    const cad = Object.entries(registered).map(([name, t]) => `${name}: ${t.description ?? ''}`);
    const first = (args.prompt as AsyncIterable<any>)[Symbol.asyncIterator]().next();
    return (async function* () {
      const msg = (await first).value;
      const blocks: any[] = Array.isArray(msg.message.content) ? msg.message.content : [{ type: 'text', text: msg.message.content }];
      const message = blocks.map((b) => (b.type === 'image' ? `[image ${b.source.media_type}]` : b.text)).join('\n\n');
      out = `# system\n${options.systemPrompt}\n# tools\n${tools}\n${cad.join('\n')}\n# message\n${message}\n`;
    })();
  }) as unknown as typeof query;
  await runGeneration(req, () => {}, new AbortController(), fake);
  assert.ok(out, 'the fake query was never run');
  return out.split(dataDir).join('<data>');
}

/** An artwork follow-up: two drawings, a saved mark on one, a picture edit kept in the brush editor. */
const FOX: SvgDrawing = { name: 'fox', aspect: 1, shapes: [{ rule: 'EvenOdd', contours: [[[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]]], color: '#111111' }] };
const SUN: SvgDrawing = { name: 'sun', aspect: 2, shapes: [{ rule: 'EvenOdd', contours: [[[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]]], color: '#e0a040' }] };
const ARTWORK_FOLLOWUP: Partial<GenerateRequest> = {
  imageMode: 'artwork', prompt: 'swap the fox\'s face for my dog\'s', code: 'const meta = { name: "fox" };\nfunction build(p) { return []; }',
  drawings: { fox: FOX, sun: SUN },
  pictures: { [PICTURE_MARKS_KEY]: JSON.stringify({ fox: { fp: drawingFingerprint(FOX), mark: { strokes: [{ width: 0.2, points: [[0, 0.1]] }] } } }) },
  pictureEdits: [{ picture: 'sun', change: 'a smiling sun', masked: true, version: 3 }],
};
/** A LayerTone follow-up: a stored photo with a saved mark, a picture edit kept in the picture editor. */
const CAT = { name: 'photo-1', width: 4, height: 3, luma: toBase64(Uint8Array.from({ length: 12 }, (_, i) => i * 20)) };
const LAYERTONE_FOLLOWUP: Partial<GenerateRequest> = {
  imageMode: 'layertone', prompt: 'put my dad in the empty chair', code: 'const meta = { name: "cat" };\nfunction build(p) { return { name: "Picture", ...H.layertone("photo-1", { width: 200 }) }; }',
  pictures: {
    [LAYERTONE_IMAGES_KEY]: JSON.stringify({ 'photo-1': CAT }),
    [PICTURE_MARKS_KEY]: JSON.stringify({ 'photo-1': { fp: photoFingerprint(CAT), mark: { strokes: [{ width: 0.2, points: [[0, 0.1]] }] } } }),
  },
  pictureEdits: [{ picture: 'photo-1', change: 'take out the lamp post', masked: true, version: 2 }],
};
/** A lithophane follow-up: the same stored photo with a saved mark, a picture edit kept in the picture editor. */
const LITHOPHANE_FOLLOWUP: Partial<GenerateRequest> = {
  imageMode: 'lithophane', prompt: 'put my dad in the empty chair', code: 'const meta = { name: "cat" };\nfunction build(p) { return { name: "Lithophane", ...H.lithophane("photo-1", { width: 100 }) }; }',
  pictures: LAYERTONE_FOLLOWUP.pictures,
  pictureEdits: [{ picture: 'photo-1', change: 'take out the lamp post', masked: true, version: 2 }],
};
const LINE_ART_CODE = 'const meta = { name: "fox" };\nfunction build(p) { return H.lineart("fox", { width: 200 }); }';
const cases: { name: string; req: Partial<GenerateRequest>; env?: ('OPENROUTER_API_KEY' | 'MESHY_API_KEY')[] }[] = [
  { name: 'plain-new', req: {} },
  { name: 'plain-web-askoff', req: { webSearch: true, askFirst: false } },
  { name: 'followup', req: { code: 'const meta = { name: "clip" };\nfunction build(p) { return []; }', values: { width: 10 }, scale: 1.5, versionNote: 'Version 2 of 2.', textNote: '"Hi" on the front' } },
  { name: 'artwork', req: { imageMode: 'artwork', prompt: 'a fox wall piece' }, env: ['OPENROUTER_API_KEY'] },
  { name: 'artwork-followup', req: ARTWORK_FOLLOWUP, env: ['OPENROUTER_API_KEY'] },
  { name: 'artwork-nokey', req: { imageMode: 'artwork', prompt: 'a fox wall piece' } },
  { name: 'legacy-artwork', req: { artwork: true }, env: ['OPENROUTER_API_KEY'] },
  { name: 'layertone', req: { imageMode: 'layertone', prompt: 'my cat' }, env: ['OPENROUTER_API_KEY'] },
  { name: 'layertone-followup', req: LAYERTONE_FOLLOWUP, env: ['OPENROUTER_API_KEY'] },
  { name: 'lithophane', req: { imageMode: 'lithophane', prompt: 'my cat' } },
  { name: 'lithophane-edit', req: { imageMode: 'lithophane', prompt: 'my cat' }, env: ['OPENROUTER_API_KEY'] },
  { name: 'lithophane-followup', req: LITHOPHANE_FOLLOWUP, env: ['OPENROUTER_API_KEY'] },
  { name: 'lineart', req: { imageMode: 'lineart', prompt: 'a motorbike key holder' }, env: ['OPENROUTER_API_KEY'] },
  { name: 'lineart-sticky', req: { imageMode: 'off', code: LINE_ART_CODE }, env: ['OPENROUTER_API_KEY'] },
  { name: 'figure', req: { imageMode: 'figure', figureColor: true, prompt: 'a dragon' }, env: ['OPENROUTER_API_KEY', 'MESHY_API_KEY'] },
  { name: 'figure-nokey', req: { imageMode: 'figure', prompt: 'a dragon' } },
];

for (const c of cases) {
  test(`prompt for ${c.name}`, async () => {
    const saved = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, MESHY_API_KEY: process.env.MESHY_API_KEY };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.MESHY_API_KEY;
    for (const k of c.env ?? []) process.env[k] = 'test';
    try {
      const actual = await captured({ designId: `snap-${c.name}`, prompt: 'a cable clip for 6 mm cables', ...c.req });
      const file = path.join(FIXTURES, `${c.name}.md`);
      if (update) {
        mkdirSync(FIXTURES, { recursive: true });
        writeFileSync(file, actual);
      } else {
        assert.equal(actual, readFileSync(file, 'utf8'), `prompt for ${c.name} changed: run UPDATE_PROMPTS=1 pnpm test and review the diff`);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
}

// The image model's prompt for a picture edit (the app sends it, not Claude).
test('prompt for picture-edit-artwork', async () => {
  const { pictureEditPrompt } = await import('../server/pictureEdit/prompt');
  const colours = ['#111111', '#ffffff', '#d01c1f', '#e0a868'];
  const actual = [
    '# marked, with a photo',
    pictureEditPrompt({ mode: 'artwork', change: 'give him a big, friendly smile', masked: true, colours, photos: 1 }),
    '# the whole picture',
    pictureEditPrompt({ mode: 'artwork', change: 'make the hat green', masked: false, colours, photos: 0 }),
    '# the whole picture, padded to the aspect asked for',
    pictureEditPrompt({ mode: 'artwork', change: 'make the hat green', masked: false, colours, photos: 0, padded: true }),
    '# marked, padded, with two photos',
    pictureEditPrompt({ mode: 'artwork', change: 'a longer beard', masked: true, colours, photos: 2, padded: true }),
    '',
  ].join('\n');
  const file = path.join(FIXTURES, 'picture-edit-artwork.md');
  if (update) writeFileSync(file, actual);
  else assert.equal(actual, readFileSync(file, 'utf8'), 'prompt for picture-edit-artwork changed: run UPDATE_PROMPTS=1 pnpm test and review the diff');
});

test('prompt for picture-edit-layertone', async () => {
  const { pictureEditPrompt } = await import('../server/pictureEdit/prompt');
  const actual = [
    '# marked, with a photo',
    pictureEditPrompt({ mode: 'layertone', change: 'swap the man on the left for the man in the photo', masked: true, photos: 1 }),
    '# the whole picture',
    pictureEditPrompt({ mode: 'layertone', change: 'take out the lamp post', masked: false, photos: 0 }),
    '# marked, padded, with two photos',
    pictureEditPrompt({ mode: 'layertone', change: 'make her smile', masked: true, photos: 2, padded: true }),
    '',
  ].join('\n');
  const file = path.join(FIXTURES, 'picture-edit-layertone.md');
  if (update) writeFileSync(file, actual);
  else assert.equal(actual, readFileSync(file, 'utf8'), 'prompt for picture-edit-layertone changed: run UPDATE_PROMPTS=1 pnpm test and review the diff');
});

test('prompt for picture-edit-lithophane', async () => {
  const { pictureEditPrompt } = await import('../server/pictureEdit/prompt');
  const actual = [
    '# marked, with a photo',
    pictureEditPrompt({ mode: 'lithophane', change: 'swap the man on the left for the man in the photo', masked: true, photos: 1 }),
    '# the whole picture',
    pictureEditPrompt({ mode: 'lithophane', change: 'take out the lamp post', masked: false, photos: 0 }),
    '# marked, padded, with two photos',
    pictureEditPrompt({ mode: 'lithophane', change: 'make her smile', masked: true, photos: 2, padded: true }),
    '',
  ].join('\n');
  const file = path.join(FIXTURES, 'picture-edit-lithophane.md');
  if (update) writeFileSync(file, actual);
  else assert.equal(actual, readFileSync(file, 'utf8'), 'prompt for picture-edit-lithophane changed: run UPDATE_PROMPTS=1 pnpm test and review the diff');
});
