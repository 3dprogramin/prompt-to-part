// The CAD tools Claude calls during a generation: evaluate, render and submit model.js.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { geometry, formatReport } from './geometry';
import { formatScadReport, runScad } from './openscad';
import { scadFileName } from '../shared/scad';
import { ASPECTS, decodeImage, generateArtwork, imageModel, picturePrompt, requestImage } from './artwork';
import { checkSwaps, cleanFilaments, HF_IMAGES_KEY, HF_KEY, MAX_HF_FILAMENTS, parseHfImages, parseHueforgeSetup, toHfImage, type HueforgeSetup } from '../shared/hueforge';

/** The user's photos (data URLs) an image model may work from, and the generation's abort signal. */
interface AiImages { references: string[]; signal?: AbortSignal }
import { DRAWINGS_KEY, parseDrawings } from '../shared/svgFeatures';
import type { AgentEvent } from '../shared/api';
import type { ParamValues } from '../shared/types';
import { pageKey, SOURCE_KIND_NAMES, SOURCE_KINDS, sourcesProblem, type DimensionSource } from '../shared/sources';

const sourcesSchema = z.array(z.object({
  dimension: z.string().max(120).describe('What the value is, e.g. "PCB size", "Mounting holes", "USB-C port centre"'),
  value: z.string().max(120).describe('The value you used, with units, e.g. "85 × 56 mm"'),
  kind: z.enum(SOURCE_KIND_NAMES).describe(`Where it came from: ${SOURCE_KIND_NAMES.map((k) => `${k} = ${SOURCE_KINDS[k].hint.toLowerCase()}`).join('; ')}`),
  url: z.string().max(1000).optional().describe('The page or document it came from (required for official, distributor, community and social)'),
})).max(40).describe('Every real-world dimension the design depends on (a product it must fit, a standard part, a size the user gave) and where it came from; [] if it depends on none.');

const valuesSchema = z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional()
  .describe('Optional parameter values to test with (defaults are used for missing keys)');

/**
 * The `cad` MCP server for one generation, working on `file`. `state.submitted` tells whether
 * Claude got a model accepted. `opened` holds the pages Claude read (pageKey), so a source can be
 * marked as actually opened. With `artwork`, Claude can also have artwork drawn (generate_artwork),
 * and with `pictures` a picture made for H.hueforge, or with `lithophane` for H.lithophane
 * (generate_picture), from the user's `references` photos if it likes.
 */
export function cadTools(file: string, emit: (e: AgentEvent) => void, opened: ReadonlySet<string> = new Set(), base: ParamValues = {}, extra: { artwork?: AiImages; pictures?: AiImages; hueforge?: boolean; lithophane?: boolean } = {}) {
  const { artwork, pictures, hueforge, lithophane } = extra;
  // What generate_picture's pictures are for.
  const use = lithophane ? { helper: 'H.lithophane', what: 'a lithophane (H.lithophane), a white panel lit from behind' } : { helper: 'H.hueforge', what: 'a HueForge filament painting (H.hueforge)' };
  // Values every evaluation starts from (the drawings attached in the chat, for H.svg).
  const v = (values?: ParamValues) => ({ ...base, ...values });
  const state = { submitted: false };
  const readModel = async () => {
    try { return await readFile(file, 'utf8'); } catch { return null; }
  };
  const noFile = { content: [{ type: 'text' as const, text: `model.js does not exist yet. Write the script to ${file} first.` }], isError: true };
  // Code of model.js at the last successful render: submit requires the current file to have been looked at.
  let renderedCode: string | null = null;

  const server = createSdkMcpServer({
    name: 'cad',
    version: '1.0.0',
    tools: [
      tool('evaluate_model', 'Run model.js with the given (or default) parameter values. Returns errors with line numbers, or bounding boxes, volumes, connected-piece counts, dimension callouts and warnings.', { values: valuesSchema }, async ({ values }) => {
        const code = await readModel();
        if (code == null) return noFile;
        try {
          const r = await geometry.evaluate(code, v(values));
          const report = formatReport(r);
          emit({ type: 'step', step: { kind: 'tool', ok: r.ok, text: r.ok ? oneLine(r) : `Error: ${r.error.message}${r.error.line ? ` (line ${r.error.line})` : ''}` } });
          return { content: [{ type: 'text', text: report }], isError: !r.ok };
        } catch (e) {
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: (e as Error).message } });
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      }),
      tool('render_model', 'Render model.js to an image sheet: top-left ISO view (from front-right, above), top-right FRONT (looking +Y; X right, Z up), bottom-left RIGHT (looking −X; Y right, Z up), bottom-right TOP (looking down; X right, Y up). Ortho views share one scale and show a mm grid. Use it to visually verify the design.', { values: valuesSchema }, async ({ values }) => {
        const code = await readModel();
        if (code == null) return noFile;
        try {
          const r = await geometry.render(code, v(values));
          if (!r.ok || !r.png) {
            const report = formatReport(r);
            emit({ type: 'step', step: { kind: 'tool', ok: false, text: r.ok ? 'Nothing to render' : `Error: ${r.error.message}` } });
            return { content: [{ type: 'text', text: report }], isError: true };
          }
          emit({ type: 'step', step: { kind: 'render', ok: true, text: oneLine(r), image: `data:image/png;base64,${r.png}` } });
          renderedCode = code;
          return {
            content: [
              { type: 'image', data: r.png, mimeType: 'image/png' },
              { type: 'text', text: `Grid spacing on FRONT/RIGHT/TOP views: ${r.gridStep} mm (darker lines = X/Y/Z axes through the origin).\n${formatReport(r)}` },
            ],
          };
        } catch (e) {
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: (e as Error).message } });
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      }),
      ...(hueforge ? [tool('set_hueforge', 'Change the HueForge setup – the same one the user edits in the HueForge panel (Print tab), which wins over the script\'s own filaments and swaps: the filaments bottom → top (order, colours, TDs) and the layers where each filament after the first starts. Omitted fields stay as they are; reset clears the setup so the script\'s choices apply again. Applies at once (no submit_model needed); to change filaments after the first version use this, not the script. Check the result with render_model (the report lists the stack used).', {
        filaments: z.array(z.object({
          name: z.string().max(120).describe('e.g. "PLA Basic Black"'),
          brand: z.string().max(60).optional().describe('e.g. "Bambu Lab", "eSUN"'),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('#rrggbb'),
          td: z.number().min(0.05).max(20).describe('Transmission distance, mm'),
        })).min(1).max(MAX_HF_FILAMENTS).optional().describe('All filaments, bottom (printed first) → top'),
        swaps: z.union([z.array(z.number().int().min(1)).max(MAX_HF_FILAMENTS - 1), z.literal('auto')]).optional()
          .describe('The layer (0-based from the bed: layer 0 is the first layer, layer n starts at firstLayerHeight + (n − 1) × layerHeight) where each filament after the first starts – one ascending number per filament after the first; "auto" lets Jig choose'),
        reset: z.boolean().optional().describe('Clear the setup (the script\'s filaments and automatic swaps apply)'),
      }, async (a) => {
        const now = parseHueforgeSetup(base[HF_KEY]);
        let setup: HueforgeSetup = a.reset ? {} : { ...now };
        if (a.filaments) setup.filaments = cleanFilaments(a.filaments);
        if (a.swaps === 'auto') delete setup.swaps;
        else if (a.swaps) setup.swaps = a.swaps;
        // New filaments without new swaps: the old swaps no longer fit, so they go automatic.
        else if (a.filaments && setup.swaps && setup.swaps.length !== setup.filaments!.length - 1) delete setup.swaps;
        const count = setup.filaments?.length;
        // Swaps only mean something against a known filament list (the script's may change without notice).
        if (setup.swaps && count == null) {
          return { content: [{ type: 'text', text: 'Pass the full filament list (bottom → top) together with the swaps.' }], isError: true };
        }
        if (setup.swaps && count != null && !checkSwaps(setup.swaps, count)) {
          return { content: [{ type: 'text', text: `swaps must be ${count - 1} ascending whole layer numbers, each ≥ 1 (one per filament after the first).` }], isError: true };
        }
        if (!setup.filaments) delete setup.filaments;
        if (!Object.keys(setup).length) setup = {};
        if (Object.keys(setup).length) base[HF_KEY] = JSON.stringify(setup); else delete base[HF_KEY];
        emit({ type: 'hfSetup', setup: Object.keys(setup).length ? setup : null });
        const text = !Object.keys(setup).length ? 'The HueForge setup is cleared: the script\'s filaments and automatic swaps apply.'
          : `HueForge setup: ${setup.filaments ? setup.filaments.map((f) => `${f.brand ? `${f.brand} ` : ''}${f.name} (${f.color}, TD ${f.td})`).join(' → ') : 'the script\'s filaments'}; swaps ${setup.swaps ? `at layers ${setup.swaps.join(', ')}` : 'automatic'}.`;
        emit({ type: 'step', step: { kind: 'tool', ok: true, text } });
        return { content: [{ type: 'text', text: `${text} The user sees it in the HueForge panel. Call render_model to check the print.` }] };
      })] : []),
      ...(pictures ? [tool('generate_picture', `Have an image model (${imageModel()}) make a picture for ${use.what}: realistic, with a full range of light and dark tones. Use it when the user wants a picture printed and attached no photo, or asks for a different picture. Each call costs a few cents and takes ~10–20 s.`, {
        name: z.string().regex(/^[\w-]{1,40}$/).describe(`Name to use with ${use.helper}, e.g. "portrait"`),
        subject: z.string().min(10).max(2000).describe('What to show: subject, pose, expression, lighting, composition – be specific'),
        aspect: z.enum(ASPECTS).optional().describe('Picture shape, width:height (default 1:1)'),
        style: z.string().max(400).optional().describe('The look, when not a realistic photo-like picture (e.g. "oil painting", "charcoal drawing")'),
        use_attached_photos: z.boolean().optional().describe('Work from the photos the user attached to this message'),
      }, async (a) => {
        if (a.use_attached_photos && !pictures.references.length) return { content: [{ type: 'text', text: 'The user attached no photos to this message.' }], isError: true };
        emit({ type: 'step', step: { kind: 'status', text: `Generating picture "${a.name}" with ${imageModel()}…` } });
        try {
          const references = a.use_attached_photos ? pictures.references : undefined;
          const prompt = picturePrompt({ subject: a.subject, style: a.style, references, use: lithophane ? 'lithophane' : 'hueforge' });
          const { image, model, cost } = await requestImage(prompt, a.aspect ?? '1:1', references, pictures.signal);
          const raster = decodeImage(Buffer.from(image.data, 'base64'));
          const hf = toHfImage(a.name, raster.width, raster.height, raster.data);
          base[HF_IMAGES_KEY] = JSON.stringify({ ...parseHfImages(base[HF_IMAGES_KEY]), [a.name]: hf });
          emit({ type: 'hfImage', name: a.name, image: hf });
          emit({ type: 'step', step: {
            kind: 'render', ok: true, image: `data:${image.mediaType};base64,${image.data}`, detailOpen: true,
            text: `Picture "${a.name}" from ${model}${cost != null ? ` · $${cost.toFixed(3)}` : ''}`,
            detail: `Prompt sent to ${model}:\n\n${prompt}\n\nStored for ${use.helper} as ${hf.width}×${hf.height} pixels.`,
          } });
          return {
            content: [
              { type: 'image', data: image.data, mimeType: image.mediaType },
              { type: 'text', text: `Picture "${a.name}" is ready for ${use.helper}("${a.name}", { width, … }) (${hf.width}×${hf.height} pixels, ${(hf.width / hf.height).toFixed(3)} times as wide as high). Check the print with render_model; if the picture itself is wrong, call generate_picture again with a better subject.` },
            ],
          };
        } catch (e) {
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Picture: ${(e as Error).message}` } });
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      })] : []),
      ...(artwork ? [tool('generate_artwork', `Have an image model (${imageModel()}) draw real artwork, traced into an SVG drawing for H.svg: people, characters, animals, portraits, scenes and illustrations on wall art, reliefs, signs, plaques and coasters – anything you can't draw convincingly with geometry. It comes back in flat colours (the filament colours you give, or shades of grey) on no background; each colour is one shape: H.svg(name, { height, colors: [colour] }). Each call costs a few cents and takes ~10–20 s: describe the subject well and call again only if the picture is wrong.`, {
        name: z.string().regex(/^[\w-]{1,40}$/).describe('Name to use with H.svg, e.g. "players"'),
        subject: z.string().min(10).max(2000).describe('What to draw: subject(s), pose, expression, composition and framing – be specific'),
        colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(6).optional().describe('Filament colours to draw with (#rrggbb), e.g. the ones the user has; omit for shades of grey'),
        tones: z.number().int().min(2).max(6).optional().describe('Without colors: how many shades of grey (default 4)'),
        aspect: z.enum(ASPECTS).optional().describe('Picture shape, width:height (default 1:1)'),
        style: z.string().max(400).optional().describe('The look, when it should not be the default realistic posterized print (e.g. "bold cartoon", "minimal line art")'),
        use_attached_photos: z.boolean().optional().describe('Draw from the photos the user attached to this message (a person, a pet, a place)'),
      }, async (a) => {
        if (a.use_attached_photos && !artwork.references.length) return { content: [{ type: 'text', text: 'The user attached no photos to this message.' }], isError: true };
        emit({ type: 'step', step: { kind: 'status', text: `Generating artwork "${a.name}" with ${imageModel()}…` } });
        try {
          const art = await generateArtwork(a.name, { subject: a.subject, colors: a.colors, tones: a.tones, aspect: a.aspect, style: a.style, references: a.use_attached_photos ? artwork.references : undefined }, artwork.signal);
          // From now on every check and render can use it, and the app keeps it with the design.
          base[DRAWINGS_KEY] = JSON.stringify({ ...parseDrawings(base[DRAWINGS_KEY]), [a.name]: art.drawing });
          emit({ type: 'drawing', name: a.name, drawing: art.drawing });
          const tones = art.tones.map((t) => `  - ${t.color}: ${(t.share * 100).toFixed(1)} % of the picture`).join('\n');
          emit({ type: 'step', step: {
            kind: 'render', ok: true, image: `data:${art.image.mediaType};base64,${art.image.data}`, detailOpen: true,
            text: `Artwork "${a.name}" from ${art.model}${art.cost != null ? ` · $${art.cost.toFixed(3)}` : ''}`,
            detail: `Prompt sent to ${art.model}:\n\n${art.prompt}\n\nTraced into ${art.tones.length} colours (${art.points} points):\n${tones}`,
          } });
          return {
            content: [
              { type: 'image', data: art.image.data, mimeType: art.image.mediaType },
              { type: 'text', text: `Artwork "${a.name}" is ready: H.svg("${a.name}", { height, colors }), ${art.drawing.aspect.toFixed(3)} times as wide as high. Its white background is removed.\nColours, darkest first (share of the picture without the background):\n${tones}\nEach colour is one shape. Build the relief from them, e.g. a backing plate with each colour raised on it at its own height, or stacked layers; keep each colour as its own part for the AMS (the A1's AMS lite holds 4 filaments). Check the result with render_model; if the picture itself is wrong, call generate_artwork again with a better subject.` },
            ],
          };
        } catch (e) {
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Artwork: ${(e as Error).message}` } });
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      })] : []),
      tool('render_scad', 'Render an OpenSCAD file the user attached (saved in the workspace scad/ folder) with OpenSCAD itself, at the given Customizer parameter values (defaults for the rest): the same four views as render_model, plus its parameters and part sizes. Use it to compare your model.js with the original.', {
        file: z.string().max(100).describe('The attached file\'s name, e.g. "box.scad"'),
        values: valuesSchema,
      }, async ({ file: name, values }) => {
        let source: string;
        try { source = await readFile(path.join(path.dirname(file), 'scad', scadFileName(name)), 'utf8'); } catch {
          return { content: [{ type: 'text', text: `No attached OpenSCAD file named ${name}.` }], isError: true };
        }
        try {
          const r = await runScad(source, values, (text) => emit({ type: 'step', step: { kind: 'status', text } }));
          if (!r.png) {
            emit({ type: 'step', step: { kind: 'tool', ok: false, text: `${scadFileName(name)}: OpenSCAD made no 3D model` } });
            return { content: [{ type: 'text', text: formatScadReport(r) }], isError: true };
          }
          emit({ type: 'step', step: { kind: 'render', ok: true, text: `${scadFileName(name)} in OpenSCAD`, image: `data:image/png;base64,${r.png}` } });
          return {
            content: [
              { type: 'image', data: r.png, mimeType: 'image/png' },
              { type: 'text', text: `Grid spacing on FRONT/RIGHT/TOP views: ${r.gridStep} mm.\n${formatScadReport(r)}` },
            ],
          };
        } catch (e) {
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: (e as Error).message } });
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      }),
      tool('submit_model', 'Submit model.js as the finished design. Validates the defaults and stress-tests every parameter at its min/max. Rejected if anything fails (set force=true only if a failure is truly unavoidable and harmless).', {
        summary: z.string().describe('One or two sentences describing this version (shown in version history)'),
        sources: sourcesSchema,
        force: z.boolean().optional(),
        assembly: z.object({
          layoutParam: z.string().optional().describe('Key of the select parameter that switches the layout'),
          assembledValue: z.string().optional().describe('Option value that shows the parts assembled in place'),
          explodedValue: z.string().optional().describe('Option value that shows the assembly with parts pulled apart along their assembly direction'),
          independentParts: z.string().optional().describe('Only if the parts are separate objects that are never assembled together: say why'),
          singlePrint: z.boolean().optional().describe('True if the parts are coloured regions of one object printed together in place (multi-colour)'),
        }).optional().describe('Required when the model has more than one part'),
      }, async ({ summary, sources: rawSources, force, assembly }) => {
        const code = await readModel();
        if (code == null) return noFile;
        const problem = sourcesProblem(rawSources);
        if (problem) return { content: [{ type: 'text', text: `Rejected – ${problem}` }], isError: true };
        const sources: DimensionSource[] = rawSources.map(({ url, ...s }) => ({ ...s, ...(url ? { url, opened: opened.has(pageKey(url)!) } : {}) }));
        if (code !== renderedCode) {
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: 'Submit rejected: render and inspect the current model first' } });
          return {
            content: [{ type: 'text', text: renderedCode == null
              ? 'Rejected – you have not looked at the model yet. Call render_model, inspect the image carefully (and compare it with the reference photos if any), fix what is wrong, then submit.'
              : 'Rejected – model.js changed since your last render. Call render_model again and verify the current version visually before submitting.' }],
            isError: true,
          };
        }
        try {
          const r = await geometry.evaluate(code, v());
          if (!r.ok || !r.parts.length) {
            emit({ type: 'step', step: { kind: 'tool', ok: false, text: 'Submit rejected: defaults fail' } });
            return { content: [{ type: 'text', text: `Rejected – the default parameters do not produce a valid model:\n${formatReport(r)}` }], isError: true };
          }
          const s = await geometry.stress(code, base);
          if (s.failures.length && !force) {
            emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Stress test: ${s.failures.length} slider extreme(s) fail` } });
            return {
              content: [{ type: 'text', text: `Rejected – ${s.failures.length} of ${s.tested} slider-extreme cases fail:\n${s.failures.slice(0, 15).map((f) => `  - ${f.case}: ${f.error}`).join('\n')}\nClamp derived values inside build() or narrow the parameter ranges, then submit again.` }],
              isError: true,
            };
          }
          // Multi-part designs: the user gets assembled + exploded pictures.
          const pictures: { label: string; png: string }[] = [];
          if (r.parts.length > 1 && !assembly?.independentParts && !assembly?.singlePrint) {
            const reject = (why: string) => {
              emit({ type: 'step', step: { kind: 'tool', ok: false, text: 'Submit rejected: assembly views missing' } });
              return { content: [{ type: 'text' as const, text: `Rejected – this design has ${r.parts.length} parts (${r.parts.map((p) => p.name).join(', ')}). ${why}` }], isError: true };
            };
            const def = assembly?.layoutParam ? r.params[assembly.layoutParam] : undefined;
            if (!assembly?.layoutParam || !assembly.assembledValue) {
              return reject('Add a select parameter (e.g. layout: [\'print\', \'assembled\', \'exploded\']) and pass assembly: { layoutParam, assembledValue, explodedValue } so the user gets assembly pictures. If the parts are coloured regions of one object printed together, pass assembly: { singlePrint: true }; if they are separate objects that are never assembled, pass assembly: { independentParts: "<why>" }.');
            }
            if (!def || def.type !== 'select') return reject(`"${assembly.layoutParam}" is not a select parameter.`);
            for (const v of [assembly.assembledValue, assembly.explodedValue]) {
              if (v && !def.options.some((o) => o.value === v)) return reject(`"${v}" is not an option of "${assembly.layoutParam}" (${def.options.map((o) => o.value).join(', ')}).`);
            }
            // The animated assembly needs a sequence returned from build() in the assembled layout.
            const asm = await geometry.evaluate(code, v({ [assembly.layoutParam]: assembly.assembledValue }));
            if (!asm.ok) return reject(`The assembled layout fails: ${asm.error.message}`);
            if (!asm.assembly.length) {
              return reject('build() must also return an assembly sequence – assembly: [{ label, parts: [partNames], from?: [dx,dy,dz], rotate?: { axis, degrees, center? } }, …] – so the user can watch it being put together. Parts that never appear in a step are the base (already in place).');
            }
            const badSteps = asm.warnings.filter((w) => w.startsWith('Assembly step'));
            if (badSteps.length) return reject(`Fix the assembly sequence: ${badSteps.join('; ')}`);
            const shots: [string, string | undefined][] = [['Assembled', assembly.assembledValue], ['Exploded view', assembly.explodedValue]];
            for (const [label, value] of shots) {
              if (!value) continue;
              const shot = await geometry.iso(code, v({ [assembly.layoutParam]: value }));
              if (!shot.ok || !shot.png) return reject(`Rendering the ${label.toLowerCase()} layout failed: ${shot.ok ? 'no geometry' : shot.error.message}`);
              pictures.push({ label, png: shot.png });
            }
          }
          state.submitted = true;
          emit({ type: 'step', step: { kind: 'tool', ok: true, text: `Stress test passed (${s.tested} cases)${s.skipped ? `, ${s.skipped} skipped for time` : ''}` } });
          emit({ type: 'model', code, summary, sources });
          for (const p of pictures) emit({ type: 'step', step: { kind: 'assembly', ok: true, text: p.label, image: `data:image/png;base64,${p.png}` } });
          if (!pictures.length) return { content: [{ type: 'text', text: 'Accepted and loaded in the user\'s viewer. Now end your turn with a short message to the user.' }] };
          return {
            content: [
              { type: 'text', text: 'Accepted and loaded in the user\'s viewer. The user also sees these assembly pictures. Check them: assembled parts must sit exactly where they belong, and the exploded view must show clearly how they go together. If something is wrong, fix it and submit again. Otherwise end your turn with your message to the user, including the assembly instructions.' },
              ...pictures.flatMap((p) => [{ type: 'text' as const, text: `${p.label}:` }, { type: 'image' as const, data: p.png, mimeType: 'image/png' }]),
            ],
          };
        } catch (e) {
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      }),
    ],
  });
  return { server, state };
}

function oneLine(r: { ok: true; bbox: { min: number[]; max: number[] } | null; timeMs: number; parts: { triCount: number }[]; warnings: string[] }) {
  const b = r.bbox;
  const size = b ? `${(b.max[0] - b.min[0]).toFixed(1)} × ${(b.max[1] - b.min[1]).toFixed(1)} × ${(b.max[2] - b.min[2]).toFixed(1)} mm` : 'empty';
  const tris = r.parts.reduce((s, p) => s + p.triCount, 0);
  return `${size} · ${r.parts.length} part(s) · ${tris.toLocaleString()} tris · ${Math.round(r.timeMs)} ms`;
}
