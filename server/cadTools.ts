// The CAD tools Claude calls during a generation: evaluate, render and submit model.js. The
// tools for pictures, line art, Meshy models and Ask first are in tools/.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { geometry, formatReport } from './geometry';
import { formatScadReport, runScad } from './openscad';
import { scadFileName } from '../shared/scad';
import { requestImage } from './artwork';
import type { AgentEvent } from '../shared/api';
import type { ParamValues } from '../shared/types';
import { PRINT_KEY, printDefaultsFor, type PrintSettings } from '../shared/print';
import { printer } from '../shared/printer';
import { formatPose, type StabilityReport } from '../shared/stability';
import { pageKey, SOURCE_KIND_NAMES, SOURCE_KINDS, sourcesProblem, type DimensionSource } from '../shared/sources';
import type { AiImages, LineArtOptions, MeshyOptions, ToolContext } from './tools/context';
import { layerToneTools } from './tools/layerTone';
import { artworkTools, pictureTools } from './tools/pictures';
import { lineArtTools } from './tools/lineArt';
import { meshyTools } from './tools/meshy';
import { questionTools } from './tools/questions';
import { designImageTools, type DesignImageOptions } from './tools/designImage';
import { withoutPictures } from './openRouterModels';

const sourcesSchema = z.array(z.object({
  dimension: z.string().max(120).describe('What the value is, e.g. "PCB size", "Mounting holes", "USB-C port centre"'),
  value: z.string().max(120).describe('The value you used, with units, e.g. "85 × 56 mm"'),
  kind: z.enum(SOURCE_KIND_NAMES).describe(`Where it came from: ${SOURCE_KIND_NAMES.map((k) => `${k} = ${SOURCE_KINDS[k].hint.toLowerCase()}`).join('; ')}`),
  url: z.string().max(1000).optional().describe('The page or document it came from (required for official, distributor, community and social)'),
})).max(40).describe('Every real-world dimension the design depends on (a product it must fit, a standard part, a size the user gave) and where it came from; [] if it depends on none.');

const stabilitySchema = z.object({
  poses: z.array(z.object({
    label: z.string().max(60).describe('What the pose is, e.g. "tilt 60"'),
    values: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).describe('The parameter values that make the pose, e.g. { tilt: 60 }'),
  })).max(12).optional().describe('Extra poses to check besides the defaults: one for every tilt, swivel or reach limit (each slider at its min and max) that moves weight over the edge of the base'),
  upright: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Only if the design is printed in a different orientation than it stands in use: the XYZ rotation in degrees that turns it upright, e.g. [0, -90, 0]'),
  explanation: z.string().max(300).optional().describe('Only if it can\'t tip in use: why, e.g. "screwed to the wall", "clamped to the desk", "lies flat"'),
}).optional().describe('The tipping check: the design must stand on its base with its declared loads in every pose');

const valuesSchema = z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional()
  .describe('Optional parameter values to test with (defaults are used for missing keys)');

/**
 * The `cad` MCP server for one generation, working on `file`. `state.submitted` tells whether
 * Claude got a model accepted. `opened` holds the pages Claude read (pageKey), so a source can be
 * marked as actually opened. With `artwork`, Claude can also have artwork drawn (generate_artwork),
 * and with `pictures` a picture made for H.layertone, or with `lithophane` for H.lithophane
 * (generate_picture), from the user's `references` photos if it likes. With `meshy`, Claude can have
 * Meshy make 3D models (generate_3d, at most meshyMaxPerReply() per reply) and, with `concepts`,
 * have a concept picture drawn first for the user to approve (generate_concept); `color` (the user
 * turned on Colour) makes figures coloured by default (a textured model, printed in up to 4 filaments).
 * With `lineArt` (Line art mode, or a line-art design), Claude can trace an attached picture that
 * already is line art (trace_line_art) and, with its `pictures`, have the image model draw some
 * (generate_line_art); both store a drawing for H.lineart. With `askFirst` (Ask first on), Claude can
 * ask the user a few questions before it builds (ask_questions), shown as a card of options. With
 * `designImage` (3D model mode), Claude can have a picture drawn of how the object should look (generate_image).
 */
export function cadTools(file: string, emit: (e: AgentEvent) => void, opened: ReadonlySet<string> = new Set(), base: ParamValues = {}, extra: {
  artwork?: AiImages; pictures?: AiImages; layerTone?: boolean; lithophane?: boolean;
  /** 3D models from Meshy (generate_3d), stored with this design; `concepts`: the image model can draw concept pictures for them. */
  meshy?: MeshyOptions;
  /** Line art: the menu's style (generate_line_art's default) and whether the image model can draw (`pictures`); `references` are the attached images, traced or drawn from. */
  lineArt?: LineArtOptions;
  /** 3D model mode with the image model: generate_image, a picture to model from. */
  designImage?: DesignImageOptions;
  /** The image model (replaceable in tests). */
  image?: typeof requestImage;
  /** "Ask first" is on: ask_questions is there. */
  askFirst?: boolean;
  /** The model takes no pictures: the tools' renders and pictures reach it as a note instead. */
  textOnly?: boolean;
  /** The print baseline (the chosen printer's profile), for weighing parts in the tipping check. */
  printBase?: Required<PrintSettings>;
  /** The user's own print settings (PRINT_KEY, as JSON), which weigh the parts in the tipping check too. */
  printProfile?: string;
  /** The generation's abort signal: Stop drops or kills its geometry jobs and OpenSCAD runs. */
  signal?: AbortSignal;
} = {}) {
  const { artwork, pictures, layerTone, lithophane, meshy, lineArt, designImage, askFirst, signal } = extra;
  const drawImage = extra.image ?? requestImage;
  // Values every evaluation starts from (the drawings attached in the chat, for H.svg).
  const v = (values?: ParamValues) => ({ ...base, ...values });
  // meshyCalls: generate_3d calls since the user's last message (each may cost credits);
  // newConcepts: concept pictures drawn since then, which the user hasn't approved yet; asked: the questions were asked.
  const state = { submitted: false, meshyCalls: 0, newConcepts: new Set<string>(), asked: false };
  /** The user sent a message (one read mid-reply too): a fresh Meshy allowance, and the concepts drawn before it are theirs to judge. */
  const newUserMessage = () => { state.meshyCalls = 0; state.newConcepts.clear(); state.asked = false; };
  const readModel = async () => {
    try { return await readFile(file, 'utf8'); } catch { return null; }
  };
  const ctx: ToolContext = { base, emit, state, drawImage, readModel, v };
  const noFile = { content: [{ type: 'text' as const, text: `model.js does not exist yet. Write the script to ${file} first.` }], isError: true };
  // Code of model.js at the last successful render: submit requires the current file to have been looked at.
  let renderedCode: string | null = null;

  // A model that takes no pictures gets a note in place of each one (an image would fail the request).
  const forModel = <T extends { handler: (...a: never[]) => Promise<{ content: { type: string }[] }> }>(tools: T[]): T[] =>
    extra.textOnly ? tools.map((t) => ({ ...t, handler: async (...a: Parameters<T['handler']>) => { const r = await t.handler(...a); return { ...r, content: withoutPictures(r.content) }; } })) : tools;
  const server = createSdkMcpServer({
    name: 'cad',
    version: '1.0.0',
    tools: forModel([
      tool('evaluate_model', 'Run model.js with the given (or default) parameter values. Returns errors with line numbers, or bounding boxes, volumes, connected-piece counts, dimension callouts and warnings.', { values: valuesSchema }, async ({ values }) => {
        const code = await readModel();
        if (code == null) return noFile;
        try {
          const r = await geometry.evaluate(code, v(values), undefined, signal);
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
          const r = await geometry.render(code, v(values), signal);
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
              ...(r.top ? [
                { type: 'image' as const, data: r.top, mimeType: 'image/png' },
                { type: 'text' as const, text: 'The line art straight on and large, as it will hang. Judge it as the product photo the user will see: lines clean and smooth, every detail readable, nothing merged into dark blotches. If it looks cluttered or blotchy, the drawing is too fine for this size: redraw it bolder and simpler – don\'t just report it.' },
              ] : []),
            ],
          };
        } catch (e) {
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: (e as Error).message } });
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      }),
      ...(layerTone ? layerToneTools(ctx) : []),
      ...(pictures ? pictureTools(ctx, pictures, lithophane) : []),
      ...(artwork ? artworkTools(ctx, artwork) : []),
      ...(lineArt ? lineArtTools(ctx, lineArt) : []),
      ...(meshy ? meshyTools(ctx, meshy) : []),
      ...(designImage ? designImageTools(ctx, designImage) : []),
      ...(askFirst ? questionTools(ctx) : []),
      tool('render_scad', 'Render an OpenSCAD file the user attached (saved in the workspace scad/ folder) with OpenSCAD itself, at the given Customizer parameter values (defaults for the rest): the same four views as render_model, plus its parameters and part sizes. Use it to compare your model.js with the original.', {
        file: z.string().max(100).describe('The attached file\'s name, e.g. "box.scad"'),
        values: valuesSchema,
      }, async ({ file: name, values }) => {
        let source: string;
        try { source = await readFile(path.join(path.dirname(file), 'scad', scadFileName(name)), 'utf8'); } catch {
          return { content: [{ type: 'text', text: `No attached OpenSCAD file named ${name}.` }], isError: true };
        }
        try {
          const r = await runScad(source, values, (text) => emit({ type: 'step', step: { kind: 'status', text } }), signal);
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
      tool('submit_model', 'Submit model.js as the finished design. Validates the defaults and stress-tests every parameter at its min/max (set force=true only if a stress failure is truly unavoidable and harmless). Then checks the design doesn\'t tip over: parts weighed as printed PLA plus the loads build() declares, at the defaults and every pose in stability.poses (give one for every tilt or swivel limit, and combine limits that act together, e.g. the maximum tilt at each swivel limit). Pass stability.upright if it is printed lying down, and stability.explanation only if it can\'t tip in use (wall-mounted, clamped, lies flat). Rejected if anything fails.', {
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
        stability: stabilitySchema,
      }, async ({ summary, sources: rawSources, force, assembly, stability: tipping }) => {
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
          const r = await geometry.evaluate(code, v(), undefined, signal);
          if (!r.ok || !r.parts.length) {
            emit({ type: 'step', step: { kind: 'tool', ok: false, text: 'Submit rejected: defaults fail' } });
            return { content: [{ type: 'text', text: `Rejected – the default parameters do not produce a valid model:\n${formatReport(r)}` }], isError: true };
          }
          const s = await geometry.stress(code, base, signal);
          if (s.failures.length && !force) {
            emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Stress test: ${s.failures.length} slider extreme(s) fail` } });
            return {
              content: [{ type: 'text', text: `Rejected – ${s.failures.length} of ${s.tested} slider-extreme cases fail:\n${s.failures.slice(0, 15).map((f) => `  - ${f.case}: ${f.error}`).join('\n')}\nClamp derived values inside build() or narrow the parameter ranges, then submit again.` }],
              isError: true,
            };
          }
          // The tipping check, at the defaults and every pose Claude names (assembled, for a multi-part design).
          let report: StabilityReport | undefined;
          let tippingStep: { ok: boolean; text: string; detail?: string; verbose?: boolean };
          const layout = assembly?.layoutParam && assembly.assembledValue ? { [assembly.layoutParam]: assembly.assembledValue } : {};
          const poses = [{ label: 'default', values: {} }, ...(tipping?.poses ?? [])].map((p) => ({ label: p.label, values: { ...p.values, ...layout } }));
          try {
            // The user's print settings weigh the parts too (only here: they don't change the shape).
            const weighWith = extra.printProfile ? { ...base, [PRINT_KEY]: extra.printProfile } : base;
            const t = await geometry.stability({ code, extra: weighWith, poses, printBase: extra.printBase ?? printDefaultsFor(printer()), nozzle: printer().nozzle, upright: tipping?.upright }, signal);
            const loadsLine = t.loads.length ? `\nLoads: ${t.loads.join(', ')}` : '';
            const detail = t.poses.map(formatPose).join('\n') + loadsLine;
            const failing = t.poses.filter((p) => !p.ok);
            // Nothing held and no poses: a plain object (keychain, line art, LayerTone) only needs a quiet check,
            // and a round or pointed bottom just rests where it lies.
            const plain = !t.loads.length && t.poses.length === 1;
            // An explanation covers tipping only: a pose that never ran (a misnamed or mistyped value) is always refused.
            const broken = failing.filter((p) => p.error && !p.noBase);
            const tipped = tipping?.explanation ? [] : failing.filter((p) => !p.error || p.noBase);
            if (plain && failing.length === 1 && failing[0].noBase) {
              tippingStep = { ok: true, verbose: true, text: 'Tipping check passed', detail: 'no flat base to check: rests on a point or a line' };
            } else if (tipped.length || broken.length) {
              const fixes = [...(tipped.some((p) => p.noBase) ? ['flatten the underside'] : []), 'wider or heavier base', 'lower hinge', 'load moved back over the base'];
              const text = [
                ...(tipped.length ? [`Rejected - the design tips over:\n${tipped.map(formatPose).join('\n')}`] : []),
                ...(broken.length ? [`${tipped.length ? 'It also fails in these poses' : 'Rejected - the design fails in these poses'}:\n${broken.map(formatPose).join('\n')}`] : []),
              ].join('\n') + loadsLine
                + (broken.length ? '\nA pose\'s values must be the script\'s own parameters, with values of the right type.' : '')
                + (tipped.length ? `\nFix it (${fixes.join(', ')}) or pass stability.explanation if it can't tip in use (wall-mounted, clamped, lies flat).` : '');
              emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Tipping check: ${tipped.length + broken.length} of ${t.poses.length} pose(s) ${broken.length ? 'fail' : 'tip over'}`, detail } });
              return { content: [{ type: 'text', text }], isError: true };
            } else if (plain && !failing.length) {
              tippingStep = { ok: true, verbose: true, text: 'Tipping check passed (1 pose)', detail };
            } else {
              report = { ...t, ...(tipping?.explanation ? { explanation: tipping.explanation } : {}) };
              tippingStep = { ok: true, text: failing.length ? `Tipping check: explained - ${tipping!.explanation}` : `Tipping check passed (${t.poses.length} pose${t.poses.length === 1 ? '' : 's'})`, detail };
            }
          } catch (e) {
            // A check that couldn't run (timeout, worker error) doesn't block the design.
            tippingStep = { ok: false, text: `Tipping check couldn't run: ${(e as Error).message}` };
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
            const asm = await geometry.evaluate(code, v({ [assembly.layoutParam]: assembly.assembledValue }), undefined, signal);
            if (!asm.ok) return reject(`The assembled layout fails: ${asm.error.message}`);
            if (!asm.assembly.length) {
              return reject('build() must also return an assembly sequence – assembly: [{ label, parts: [partNames], from?: [dx,dy,dz], rotate?: { axis, degrees, center? } }, …] – so the user can watch it being put together. Parts that never appear in a step are the base (already in place).');
            }
            const badSteps = asm.warnings.filter((w) => w.startsWith('Assembly step'));
            if (badSteps.length) return reject(`Fix the assembly sequence: ${badSteps.join('; ')}`);
            const shots: [string, string | undefined][] = [['Assembled', assembly.assembledValue], ['Exploded view', assembly.explodedValue]];
            for (const [label, value] of shots) {
              if (!value) continue;
              const shot = await geometry.iso(code, v({ [assembly.layoutParam]: value }), signal);
              if (!shot.ok || !shot.png) return reject(`Rendering the ${label.toLowerCase()} layout failed: ${shot.ok ? 'no geometry' : shot.error.message}`);
              pictures.push({ label, png: shot.png });
            }
          }
          state.submitted = true;
          emit({ type: 'step', step: { kind: 'tool', ok: true, text: `Stress test passed (${s.tested} cases)${s.skipped ? `, ${s.skipped} skipped for time` : ''}` } });
          emit({ type: 'step', step: { kind: 'tool', ...tippingStep } });
          emit({ type: 'model', code, summary, sources, ...(report ? { stability: report } : {}) });
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
    ]),
  });
  return { server, state, newUserMessage };
}

function oneLine(r: { ok: true; bbox: { min: number[]; max: number[] } | null; timeMs: number; parts: { triCount: number }[]; warnings: string[] }) {
  const b = r.bbox;
  const size = b ? `${(b.max[0] - b.min[0]).toFixed(1)} × ${(b.max[1] - b.min[1]).toFixed(1)} × ${(b.max[2] - b.min[2]).toFixed(1)} mm` : 'empty';
  const tris = r.parts.reduce((s, p) => s + p.triCount, 0);
  return `${size} · ${r.parts.length} part(s) · ${tris.toLocaleString()} tris · ${Math.round(r.timeMs)} ms`;
}
