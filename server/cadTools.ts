// The CAD tools Claude calls during a generation: evaluate, render and submit model.js.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { geometry, formatReport } from './geometry';
import { formatScadReport, runScad } from './openscad';
import { scadFileName } from '../shared/scad';
import { ASPECTS, conceptPrompt, decodeImage, generateArtwork, imageModel, lineArtPrompt, paintPrompt, picturePrompt, requestImage, traceLineArt } from './artwork';
import { LINE_ART_STYLE_INFO, LINE_ART_STYLES, type LineArtStyle } from '../shared/lineart';
import { checkSwaps, cleanFilaments, LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, MAX_LAYERTONE_FILAMENTS, parseLayerToneImages, parseLayerToneSetup, toLayerToneImage, type LayerToneSetup } from '../shared/layertone';

/** The user's photos (data URLs) an image model may work from, and the generation's abort signal. */
interface AiImages { references: string[]; signal?: AbortSignal }
import { DRAWINGS_KEY, MAX_DRAWINGS, MAX_SVG_POINTS, parseDrawings, type SvgDrawing } from '../shared/svgFeatures';
import { CONCEPT_URL, CONCEPTS_KEY, MESHES_KEY, parseConcepts, parseMeshes, withConcept } from '../shared/meshes';
import { forgetBalance, generateMeshyModel, MESHY_CREDITS_PER_COLOR_MODEL, MESHY_CREDITS_PER_MODEL, meshyCredits, meshyMaxPerReply, type MeshyClient } from './meshy';
import { readMyFilaments } from './myFilaments';
import { filamentLabel, matchFilaments, MAX_MESH_COLORS } from '../shared/meshColors';
import { describeImport, meshDir, storeConceptPicture, storeMesh } from './meshes';
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
 * and with `pictures` a picture made for H.layertone, or with `lithophane` for H.lithophane
 * (generate_picture), from the user's `references` photos if it likes. With `meshy`, Claude can have
 * Meshy make 3D models (generate_3d, at most meshyMaxPerReply() per reply) and, with `concepts`,
 * have a concept picture drawn first for the user to approve (generate_concept); `color` (the user
 * turned on Colour) makes figures coloured by default (a textured model, printed in up to 4 filaments).
 * With `lineArt` (Line art mode, or a line-art design), Claude can trace an attached picture that
 * already is line art (trace_line_art) and, with its `pictures`, have the image model draw some
 * (generate_line_art); both store a drawing for H.lineart.
 */
export function cadTools(file: string, emit: (e: AgentEvent) => void, opened: ReadonlySet<string> = new Set(), base: ParamValues = {}, extra: {
  artwork?: AiImages; pictures?: AiImages; layerTone?: boolean; lithophane?: boolean;
  /** 3D models from Meshy (generate_3d), stored with this design; `concepts`: the image model can draw concept pictures for them. */
  meshy?: AiImages & { client: MeshyClient; designId: string; concepts?: boolean; color?: boolean };
  /** Line art: the menu's style (generate_line_art's default) and whether the image model can draw (`pictures`); `references` are the attached images, traced or drawn from. */
  lineArt?: AiImages & { style: LineArtStyle; pictures: boolean };
  /** The image model (replaceable in tests). */
  image?: typeof requestImage;
} = {}) {
  const { artwork, pictures, layerTone, lithophane, meshy, lineArt } = extra;
  const drawImage = extra.image ?? requestImage;
  // What generate_picture's pictures are for.
  const use = lithophane ? { helper: 'H.lithophane', what: 'a lithophane (H.lithophane), a white panel lit from behind' } : { helper: 'H.layertone', what: 'a LayerTone filament painting (H.layertone)' };
  // Values every evaluation starts from (the drawings attached in the chat, for H.svg).
  const v = (values?: ParamValues) => ({ ...base, ...values });
  // meshyCalls: generate_3d calls since the user's last message (each may cost credits);
  // newConcepts: concept pictures drawn since then, which the user hasn't approved yet.
  const state = { submitted: false, meshyCalls: 0, newConcepts: new Set<string>() };
  /** The user sent a message (one read mid-reply too): a fresh Meshy allowance, and the concepts drawn before it are theirs to judge. */
  const newUserMessage = () => { state.meshyCalls = 0; state.newConcepts.clear(); };
  const readModel = async () => {
    try { return await readFile(file, 'utf8'); } catch { return null; }
  };
  // A traced line-art drawing: kept for every check and render from now on, and by the app with the design.
  const storeLineArt = (name: string, traced: { drawing: SvgDrawing; points: number }) => {
    if (traced.points > MAX_SVG_POINTS) throw new Error(`The drawing is too detailed to keep (${traced.points.toLocaleString('en')} points, at most ${MAX_SVG_POINTS.toLocaleString('en')}): ask for a simpler drawing with fewer, bolder lines.`);
    const drawings = parseDrawings(base[DRAWINGS_KEY]);
    if (!drawings[name] && Object.keys(drawings).length >= MAX_DRAWINGS) throw new Error(`This design already has ${MAX_DRAWINGS} drawings (${Object.keys(drawings).join(', ')}): reuse one of the names to replace it.`);
    base[DRAWINGS_KEY] = JSON.stringify({ ...drawings, [name]: traced.drawing });
    emit({ type: 'drawing', name, drawing: traced.drawing });
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
      ...(layerTone ? [tool('set_layertone', 'Change the LayerTone setup – the same one the user edits in the LayerTone panel (Print tab), which wins over the script\'s own filaments and swaps: the filaments bottom → top (order, colours, TDs) and the layers where each filament after the first starts. Omitted fields stay as they are; reset clears the setup so the script\'s choices apply again. Applies at once (no submit_model needed); to change filaments after the first version use this, not the script. Check the result with render_model (the report lists the stack used).', {
        filaments: z.array(z.object({
          name: z.string().max(120).describe('e.g. "PLA Basic Black"'),
          brand: z.string().max(60).optional().describe('e.g. "Bambu Lab", "eSUN"'),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('#rrggbb'),
          td: z.number().min(0.05).max(20).describe('Transmission distance, mm'),
        })).min(1).max(MAX_LAYERTONE_FILAMENTS).optional().describe('All filaments, bottom (printed first) → top'),
        swaps: z.union([z.array(z.number().int().min(1)).max(MAX_LAYERTONE_FILAMENTS - 1), z.literal('auto')]).optional()
          .describe('The layer (0-based from the bed: layer 0 is the first layer, layer n starts at firstLayerHeight + (n − 1) × layerHeight) where each filament after the first starts – one ascending number per filament after the first; "auto" lets Jig choose'),
        reset: z.boolean().optional().describe('Clear the setup (the script\'s filaments and automatic swaps apply)'),
      }, async (a) => {
        const now = parseLayerToneSetup(base[LAYERTONE_KEY]);
        let setup: LayerToneSetup = a.reset ? {} : { ...now };
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
        if (Object.keys(setup).length) base[LAYERTONE_KEY] = JSON.stringify(setup); else delete base[LAYERTONE_KEY];
        emit({ type: 'layerToneSetup', setup: Object.keys(setup).length ? setup : null });
        const text = !Object.keys(setup).length ? 'The LayerTone setup is cleared: the script\'s filaments and automatic swaps apply.'
          : `LayerTone setup: ${setup.filaments ? setup.filaments.map((f) => `${f.brand ? `${f.brand} ` : ''}${f.name} (${f.color}, TD ${f.td})`).join(' → ') : 'the script\'s filaments'}; swaps ${setup.swaps ? `at layers ${setup.swaps.join(', ')}` : 'automatic'}.`;
        emit({ type: 'step', step: { kind: 'tool', ok: true, text } });
        return { content: [{ type: 'text', text: `${text} The user sees it in the LayerTone panel. Call render_model to check the print.` }] };
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
          const prompt = picturePrompt({ subject: a.subject, style: a.style, references, use: lithophane ? 'lithophane' : 'layertone' });
          const { image, model, cost } = await requestImage(prompt, a.aspect ?? '1:1', references, pictures.signal, (text) => emit({ type: 'step', step: { kind: 'status', text } }));
          const raster = decodeImage(Buffer.from(image.data, 'base64'));
          const picture = toLayerToneImage(a.name, raster.width, raster.height, raster.data);
          base[LAYERTONE_IMAGES_KEY] = JSON.stringify({ ...parseLayerToneImages(base[LAYERTONE_IMAGES_KEY]), [a.name]: picture });
          emit({ type: 'layerToneImage', name: a.name, image: picture });
          emit({ type: 'step', step: {
            kind: 'render', ok: true, image: `data:${image.mediaType};base64,${image.data}`, detailOpen: true,
            text: `Picture "${a.name}" from ${model}${cost != null ? ` · $${cost.toFixed(3)}` : ''}`,
            detail: `Prompt sent to ${model}:\n\n${prompt}\n\nStored for ${use.helper} as ${picture.width}×${picture.height} pixels.`,
          } });
          return {
            content: [
              { type: 'image', data: image.data, mimeType: image.mediaType },
              { type: 'text', text: `Picture "${a.name}" is ready for ${use.helper}("${a.name}", { width, … }) (${picture.width}×${picture.height} pixels, ${(picture.width / picture.height).toFixed(3)} times as wide as high). Check the print with render_model; if the picture itself is wrong, call generate_picture again with a better subject.` },
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
          const art = await generateArtwork(a.name, { subject: a.subject, colors: a.colors, tones: a.tones, aspect: a.aspect, style: a.style, references: a.use_attached_photos ? artwork.references : undefined }, artwork.signal, (text) => emit({ type: 'step', step: { kind: 'status', text } }));
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
      ...(lineArt?.pictures ? [tool('generate_line_art', `Have an image model (${imageModel()}) draw line art for H.lineart in Jig's house style – bold, even, black lines on white that join into one piece – traced into a drawing. Use it when the user wants line art and attached no drawing: from a description, or from a photo of their own subject (a car, a bike, a person, a pet: use_attached_photos). Not for a picture that already is line art (trace_line_art) or an attached SVG (already a drawing: use H.lineart with it directly). Each call costs a few cents and takes ~10–20 s: describe the subject well and call again only if the drawing is wrong or not connected enough.`, {
        name: z.string().regex(/^[\w-]{1,40}$/).describe('Name to use with H.lineart, e.g. "bike-and-car"; an existing name is replaced'),
        subject: z.string().min(10).max(2000).describe('What to draw: the subject(s), left to right, their view and pose – be specific (e.g. "a sport motorbike on the left and a 1967 Ford Mustang fastback on the right, both in side view facing right")'),
        style: z.enum(LINE_ART_STYLES).optional().describe(`The piece it is drawn for, which sets the composition (default "${lineArt.style}", the user's menu): ${LINE_ART_STYLES.map((s) => `${s} = ${LINE_ART_STYLE_INFO[s].desc.toLowerCase()}`).join('; ')}`),
        aspect: z.enum(ASPECTS).optional().describe('Picture shape, width:height (default 16:9 for keyholder, sign and stand, else 1:1); 16:9 or 21:9 for a key holder with several subjects side by side, 3:4 or 4:5 for a standing figure'),
        look: z.string().max(400).optional().describe('A different line style, only when the user asks for one (e.g. "thin elegant single-line drawing", "bold comic outlines")'),
        use_attached_photos: z.boolean().optional().describe('Draw from the photos the user attached to this message (their own car, bike, pet or person)'),
      }, async (a) => {
        if (a.use_attached_photos && !lineArt.references.length) return { content: [{ type: 'text', text: 'The user attached no photos to this message.' }], isError: true };
        const style = a.style ?? lineArt.style;
        const status = (text: string) => emit({ type: 'step', step: { kind: 'status', text } });
        status(`Drawing line art "${a.name}" with ${imageModel()}…`);
        try {
          const references = a.use_attached_photos ? lineArt.references : undefined;
          const prompt = lineArtPrompt({ subject: a.subject, style, references, look: a.look });
          const { image, model, cost } = await drawImage(prompt, a.aspect ?? (BAR_STYLES.has(style) ? '16:9' : '1:1'), references, lineArt.signal, status);
          const traced = traceLineArt(decodeImage(Buffer.from(image.data, 'base64')), a.name);
          storeLineArt(a.name, traced);
          emit({ type: 'step', step: {
            kind: 'render', ok: true, image: `data:${image.mediaType};base64,${image.data}`, detailOpen: true,
            text: `Line art "${a.name}" from ${model}${cost != null ? ` · $${cost.toFixed(3)}` : ''}`,
            detail: `Prompt sent to ${model}:\n\n${prompt}\n\nTraced for H.lineart (${traced.points.toLocaleString('en')} points).`,
          } });
          return {
            content: [
              { type: 'image', data: image.data, mimeType: image.mediaType },
              { type: 'text', text: `${lineArtReady(a.name, traced.drawing.aspect, style)} Look at the picture: if it isn't one connected drawing (loose details, a broken outline) or the subject is wrong, call generate_line_art again with a better subject.` },
            ],
          };
        } catch (e) {
          if (lineArt.signal?.aborted) throw e;
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Line art: ${(e as Error).message}` } });
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      })] : []),
      ...(lineArt ? [tool('trace_line_art', 'Trace a picture the user attached that already IS line art (dark lines on a white background: a drawing, a scan, a design from their shop) into a drawing for H.lineart, exactly as it is – no image model, free. Not for a photo of a real subject (that needs generate_line_art with use_attached_photos to be redrawn as line art) or an attached SVG (already a drawing: use H.lineart with it directly).', {
        name: z.string().regex(/^[\w-]{1,40}$/).describe('Name to use with H.lineart, e.g. "woman"; an existing name is replaced'),
        image: z.number().int().min(1).max(8).describe('Which attached image, 1 = the first the user attached to this message'),
      }, async (a) => {
        const url = lineArt.references[a.image - 1];
        if (!url) return { content: [{ type: 'text', text: lineArt.references.length ? `The user attached ${lineArt.references.length} image${lineArt.references.length > 1 ? 's' : ''} to this message: image must be 1–${lineArt.references.length}.` : 'The user attached no images to this message.' }], isError: true };
        try {
          const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(url);
          if (!m) throw new Error(`Attached image ${a.image} isn't a PNG or JPEG picture, the only kinds Jig can trace.`);
          const traced = traceLineArt(decodeImage(Buffer.from(m[2], 'base64')), a.name);
          storeLineArt(a.name, traced);
          emit({ type: 'step', step: { kind: 'tool', ok: true, text: `Traced attached image ${a.image} as line art "${a.name}" (${traced.points.toLocaleString('en')} points)` } });
          return { content: [{ type: 'text', text: lineArtReady(a.name, traced.drawing.aspect, lineArt.style) }] };
        } catch (e) {
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Line art: ${(e as Error).message}` } });
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      })] : []),
      ...(meshy?.concepts ? [tool('generate_concept', `Have the image model (${imageModel()}) draw a concept picture of a 3D figure for generate_3d to build from: the subject alone, full body, on white, as a grey clay render (the shape). With color: true (a coloured figure) it then paints that same picture like a painted collectible figurine (the colours), so the user approves the pair. A few cents a picture and ~10–20 s each, no Meshy credits. The user sees it in the chat: end your reply asking them to approve it or say what to change; once they approve, generate_3d({ name, from_concept }) builds exactly this picture (the shape from the grey one, painted from the coloured one).`, {
        name: z.string().regex(/^[\w.-]{1,40}$/).describe('Name of the picture, e.g. "spiderman" (generate_3d takes it as from_concept); an existing name is replaced'),
        subject: z.string().min(10).max(2000).describe('The one subject: who or what it is, pose, proportions, clothes, hair, what it wears or holds, style – no base, scenery or props (those are built in the script)'),
        aspect: z.enum(ASPECTS).optional().describe('Picture shape, width:height (default 3:4, for a standing figure)'),
        color: z.boolean().optional().describe(`Also paint it in colour, for a coloured figure printed in up to ${MAX_MESH_COLORS} filaments (default: ${meshy.color ? 'on – the user turned on Colour' : 'off, grey only – on only when the user asks for a figure in colour'})`),
        palette: z.array(z.object({
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('The paint colour, #rrggbb, as it looks in plain light (e.g. skin "#d9a383", not its shadow)'),
          name: z.string().min(2).max(40).describe('e.g. "olive green"'),
          parts: z.string().min(2).max(200).describe('Every part painted in it, e.g. "both pairs of shorts and the belt"'),
        })).min(1).max(MAX_MESH_COLORS).optional().describe(`Required with color: the colours to paint it in, at most ${MAX_MESH_COLORS} (one AMS lite slot each), every part of the subject in one of them. Plan it from the subject: give parts that should differ clearly different colours, and parts that can share one the same colour (e.g. a grey shirt with a grey beard) rather than a fifth.`),
      }, async (a) => {
        const color = a.color ?? !!meshy.color;
        if (color && !a.palette?.length) return { content: [{ type: 'text' as const, text: `With color, give palette: at most ${MAX_MESH_COLORS} colours and every part in each, so the picture is painted in colours the AMS lite can print.` }], isError: true };
        const palette = color ? a.palette?.map((c) => ({ color: c.color.toLowerCase(), name: c.name.trim(), parts: c.parts.trim() })) : undefined;
        const aspect = a.aspect ?? '3:4';
        const status = (text: string) => emit({ type: 'step', step: { kind: 'status', text } });
        const toFile = (image: { data: string; mediaType: string }) => {
          const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const)[image.mediaType as 'image/png'];
          if (!ext) throw new Error(`The image model returned a ${image.mediaType} picture, which Meshy can't take`);
          return { bytes: Buffer.from(image.data, 'base64'), ext };
        };
        status(`Drawing concept "${a.name}"${color ? ' (the shape)' : ''} with ${imageModel()}…`);
        try {
          // The shape: the same grey clay render with or without colour (image to 3D reads the shape from its shading).
          const prompt = conceptPrompt(a.subject);
          const grey = await drawImage(prompt, aspect, undefined, meshy.signal, status);
          const greyUrl = `data:${grey.image.mediaType};base64,${grey.image.data}`;
          const image = await storeConceptPicture(meshy.designId, toFile(grey.image));
          const credits = meshyCredits(color);
          emit({ type: 'step', step: {
            kind: 'render', ok: true, image: greyUrl, detailOpen: true,
            text: `Concept "${a.name}"${color ? ' – shape' : ''} from ${grey.model}${grey.cost != null ? ` · $${grey.cost.toFixed(3)}` : ''}`,
            detail: `Prompt sent to ${grey.model}:\n\n${prompt}\n\nOnce you approve it, Meshy builds the 3D model ${color ? 'in this shape' : 'from this picture'} (${credits} credits).`,
          } });
          // The colours: that picture painted (image to image), Meshy's texture. Without it, Meshy paints the model itself.
          let painted: { url: string; image: { data: string; mediaType: string } } | undefined;
          let paintError = '';
          let plan = '';
          if (color) {
            status(`Painting concept "${a.name}" in colour with ${imageModel()}…`);
            const paint = paintPrompt(a.subject, palette);
            // The filament each planned colour prints with, shown before any Meshy credits are spent.
            if (palette) plan = matchFilaments(palette.map((c) => c.color), await readMyFilaments()).map((f, i) => `- ${palette[i].name} (${palette[i].parts}) → ${filamentLabel(f)}`).join('\n');
            try {
              const p = await drawImage(paint, aspect, [greyUrl], meshy.signal, status);
              painted = { url: await storeConceptPicture(meshy.designId, toFile(p.image)), image: p.image };
              emit({ type: 'step', step: {
                kind: 'render', ok: true, image: `data:${p.image.mediaType};base64,${p.image.data}`, detailOpen: true,
                text: `Concept "${a.name}" – colours from ${p.model}${p.cost != null ? ` · $${p.cost.toFixed(3)}` : ''}`,
                detail: `${plan ? `Prints in:\n${plan}\n\n` : ''}Prompt sent to ${p.model} with the shape picture:\n\n${paint}\n\nOnce you approve the pair, Meshy builds the shape from the grey picture and paints the model from this one (${credits} credits); Jig then reduces its colours to at most ${MAX_MESH_COLORS} filaments.`,
              } });
            } catch (e) {
              if (meshy.signal?.aborted) throw e;
              paintError = (e as Error).message;
              emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Concept colours: ${paintError} – Meshy will paint the model itself` } });
            }
          }
          const entry = { image, ...(painted ? { painted: painted.url } : {}), subject: a.subject.trim(), createdAt: Date.now(), ...(color ? { color: true } : {}), ...(painted && palette ? { palette } : {}) };
          base[CONCEPTS_KEY] = withConcept(base[CONCEPTS_KEY], a.name, entry);
          state.newConcepts.add(a.name);
          emit({ type: 'concept', name: a.name, entry });
          const check = painted
            ? `The first picture is the shape (grey clay), the second the colours (the same picture painted). Check that they show the subject asked for – one subject, whole, on white – and that the painted one matches the grey one (same pose and framing) and keeps to the palette: every part in its planned colour, no colour outside it (another colour would take a filament of its own or print in the wrong one). If not, call generate_concept again – once; if the second is still off, tell the user what differs.${plan ? ` The planned colours print with:\n${plan}\n` : ''} Then end your reply: tell the user this is the concept for their figure, the shape and its colours, and ask them to approve the pair or say what to change.`
            : `Check that it shows the subject asked for – one subject, whole, grey, on white – and call generate_concept again if not.${paintError ? ` Painting it in colour failed (${paintError}): there is only the grey picture, and Meshy will paint the model with its own texturing – tell the user the colours will come from Meshy.` : ''} Then end your reply: tell the user this is the concept for their figure and ask them to approve it or say what to change.`;
          return {
            content: [
              { type: 'image', data: grey.image.data, mimeType: grey.image.mediaType },
              ...(painted ? [{ type: 'image' as const, data: painted.image.data, mimeType: painted.image.mediaType }] : []),
              { type: 'text', text: `Concept picture "${a.name}" is ready; the user sees it in the chat. ${check} Don't call generate_3d now. When the user approves (their next message), call generate_3d({ name, from_concept: "${a.name}" }) (${credits} Meshy credits${color ? ', in colour' : ''}); if they want changes, draw a new concept instead.` },
            ],
          };
        } catch (e) {
          if (meshy.signal?.aborted) throw e;
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Concept: ${(e as Error).message}` } });
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      })] : []),
      ...(meshy ? [tool('generate_3d', `Have Meshy (an AI 3D generator) make a sculpted 3D model of the main subject – a figure, character, animal, statue or ornament – from an approved concept picture (from_concept: its grey picture gives the shape, and in colour its painted one the texture), the photo the user attached (from_photo) or a description. It comes back repaired into a watertight solid for H.mesh(name, …), with a four-view render and a report. With color it is textured and its colours are kept, reduced to at most ${MAX_MESH_COLORS} filaments (the A1's AMS lite) and painted on its triangles. Takes about 1–3 minutes and costs ${MESHY_CREDITS_PER_MODEL} Meshy credits (${MESHY_CREDITS_PER_COLOR_MODEL} in colour): only for the subject(s) the user asked for, never for bases, scenery or props; at most ${meshyMaxPerReply()} per reply.`, {
        name: z.string().regex(/^[\w.-]{1,40}$/).describe('Name to use with H.mesh, e.g. "fox"; an existing name is replaced'),
        prompt: z.string().max(700).optional().describe('The subject: what it is, pose, proportions, clothes, accessories, style – no printing instructions (Jig adds them). Required unless from_photo or from_concept'),
        from_photo: z.boolean().optional().describe('Build it from the photo the user attached to this message (image to 3D) instead of the description'),
        from_concept: z.string().regex(/^[\w.-]{1,40}$/).optional().describe('Build it from this concept picture (generate_concept) the user approved (image to 3D): Meshy gets exactly that picture, and in colour paints the model from its coloured version'),
        color: z.boolean().optional().describe(`A coloured figure (textured, ${MESHY_CREDITS_PER_COLOR_MODEL} credits instead of ${MESHY_CREDITS_PER_MODEL}), printed in up to ${MAX_MESH_COLORS} filaments. Default: ${meshy.color ? 'on (the user turned on Colour)' : 'off'}, or as the concept picture was drawn; turn it on only when the user asks for colour`),
        colors: z.number().int().min(1).max(MAX_MESH_COLORS).optional().describe(`With color: most colours (filaments) the figure gets (default ${MAX_MESH_COLORS}); fewer leave AMS slots for other parts in colours of their own`),
      }, async (a) => {
        const refuse = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
        if (a.from_photo && a.from_concept) return refuse('Use either from_photo or from_concept, not both.');
        if (a.from_photo && !meshy.references.length) return refuse('The user attached no photo to this message.');
        const concepts = parseConcepts(base[CONCEPTS_KEY]);
        const concept = a.from_concept ? concepts[a.from_concept] : undefined;
        if (a.from_concept && !concept) {
          const names = Object.keys(concepts);
          return refuse(`No concept picture named "${a.from_concept}"${names.length ? ` (there are: ${names.map((n) => `"${n}"`).join(', ')})` : ''}.`);
        }
        if (a.from_concept && state.newConcepts.has(a.from_concept)) {
          return refuse(`The user hasn't approved concept "${a.from_concept}" yet: end your reply and ask them to approve it or say what to change. Build it in their next message.`);
        }
        if (!a.from_photo && !a.from_concept && !a.prompt?.trim()) return refuse('Describe the subject in prompt (or use from_concept or from_photo).');
        const max = meshyMaxPerReply();
        const color = a.color ?? (concept?.color || !!meshy.color);
        const cost = meshyCredits(color);
        if (state.meshyCalls >= max) {
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Meshy: not making "${a.name}" – at most ${max} model${max === 1 ? '' : 's'} per reply` } });
          return refuse(`Refused – ${max ? `you have already had Meshy make ${state.meshyCalls} model${state.meshyCalls === 1 ? '' : 's'} in this reply, the most allowed per reply` : 'Meshy models are turned off (JIG_MESHY_MAX_PER_REPLY=0)'}. Stop calling generate_3d: build the rest (bases, scenery, props) in the script, or end your reply and ask the user whether to make "${a.name}" with Meshy – it would cost ${cost} Meshy credits${color ? ' (in colour)' : ''}. Their next message gets a fresh allowance.`);
        }
        // The slot is taken now (calls may run side by side) and given back if no task was started.
        state.meshyCalls++;
        let started = false;
        let image: string | undefined;
        let texture: string | undefined;
        if (concept) {
          const dataUri = async (url: string) => {
            const m = CONCEPT_URL.exec(url)!;
            const bytes = await readFile(path.join(meshDir(m[1]), m[2]));
            return `data:image/${m[2].endsWith('.jpg') ? 'jpeg' : m[2].slice(33)};base64,${bytes.toString('base64')}`;
          };
          try {
            // The grey picture is the shape; in colour, the painted one is the texture (Meshy paints it itself without one).
            image = await dataUri(concept.image);
            if (color && concept.painted) texture = await dataUri(concept.painted);
          } catch {
            state.meshyCalls--;
            return refuse(`The picture of concept "${a.from_concept}" is missing: draw it again with generate_concept.`);
          }
        }
        const how = concept ? `from concept "${a.from_concept}"` : a.from_photo ? 'from the photo' : 'from the description';
        emit({ type: 'step', step: { kind: 'status', text: `Meshy: making "${a.name}" ${how}${color ? ' in colour' : ''} (${cost} credits)…` } });
        let shown = -1;
        let status = '';
        const input = concept ? { image: image!, texture, label: `From concept picture "${a.from_concept}": ${concept.subject}` } : a.from_photo ? { image: meshy.references[0] } : { prompt: a.prompt! };
        try {
          const r = await generateMeshyModel(meshy.client, input, {
            signal: meshy.signal,
            color,
            onStarted: (id) => { started = true; emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Meshy task ${id}` } }); },
            onProgress: (t, stage) => {
              const p = Math.round(t.progress ?? 0);
              // A coloured model from a description is made in two stages: the shape, then its colours.
              const what = stage === 'texture' ? 'painting the colours, ' : color && 'prompt' in input ? 'the shape, ' : '';
              const line = t.status === 'PENDING' ? `Meshy: ${what}waiting in the queue${t.preceding_tasks ? ` (${t.preceding_tasks} ahead)` : ''}…` : `Meshy: ${what}${p} %…`;
              emit({ type: 'live', text: line });
              // The steps get the status changes and every quarter; the live line every poll.
              if (`${stage} ${t.status}` !== status || (t.status === 'IN_PROGRESS' && Math.floor(p / 25) > Math.floor(shown / 25))) {
                status = `${stage} ${t.status}`;
                shown = p;
                if (t.status === 'PENDING' || t.status === 'IN_PROGRESS') emit({ type: 'step', step: { kind: 'status', text: line } });
              }
            },
          });
          emit({ type: 'live', text: `Meshy: importing and repairing "${a.name}"…` });
          const imported = color
            ? await geometry.importMesh(r.model.bytes, r.model.filename, { colors: true }, { colors: a.colors ?? MAX_MESH_COLORS, mine: await readMyFilaments() })
            : await geometry.importMesh(r.model.bytes, r.model.filename);
          const entry = await storeMesh(meshy.designId, imported, r.model, { source: 'meshy', prompt: r.prompt, picture: r.picture });
          if (!entry) throw new Error('The design was deleted');
          base[MESHES_KEY] = JSON.stringify({ ...parseMeshes(base[MESHES_KEY]), [a.name]: entry });
          emit({ type: 'mesh', name: a.name, entry });
          const report = describeImport(a.name, entry, imported.report) + (color && !entry.palette ? '\nMeshy sent it without colours: it prints in one colour (the part\'s).' : '');
          const picture = r.picture ? `data:image/${r.picture.ext === 'jpg' ? 'jpeg' : r.picture.ext};base64,${Buffer.from(r.picture.bytes).toString('base64')}` : `data:image/png;base64,${imported.png}`;
          emit({ type: 'step', step: {
            kind: 'render', ok: true, image: picture, detailOpen: true,
            text: `${color ? 'Coloured 3D model' : '3D model'} "${a.name}" from Meshy${r.credits ? ` · ${r.credits} credits` : ''}`,
            detail: `${'prompt' in input ? 'Prompt sent to Meshy (text to 3D)' : `Sent to Meshy (image to 3D${texture ? ': the shape picture, painted from the colours picture' : ''})`}:\n\n${r.prompt}\n\n${report}`,
          } });
          return {
            content: [
              { type: 'image', data: imported.png, mimeType: 'image/png' },
              { type: 'text', text: `${report}\nThe picture shows it as stored (ISO, FRONT, RIGHT, TOP; grid ${imported.gridStep} mm). Check that it is the subject asked for and stands upright (rotate it with H.mesh's rotate if not), then build the design around it.` },
            ],
          };
        } catch (e) {
          if (!started) state.meshyCalls--;
          if (meshy.signal?.aborted) throw e;
          emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Meshy: ${(e as Error).message}` } });
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        } finally {
          // The credits changed: the next balance asks Meshy.
          if (started) forgetBalance();
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
  return { server, state, newUserMessage };
}

function oneLine(r: { ok: true; bbox: { min: number[]; max: number[] } | null; timeMs: number; parts: { triCount: number }[]; warnings: string[] }) {
  const b = r.bbox;
  const size = b ? `${(b.max[0] - b.min[0]).toFixed(1)} × ${(b.max[1] - b.min[1]).toFixed(1)} × ${(b.max[2] - b.min[2]).toFixed(1)} mm` : 'empty';
  const tris = r.parts.reduce((s, p) => s + p.triCount, 0);
  return `${size} · ${r.parts.length} part(s) · ${tris.toLocaleString()} tris · ${Math.round(r.timeMs)} ms`;
}

/** Line-art styles whose drawing stands on a bar or base: their subjects share one ground line. */
const BAR_STYLES = new Set<LineArtStyle>(['keyholder', 'sign', 'stand']);

/** What Claude is told when a line-art drawing is stored. */
function lineArtReady(name: string, aspect: number, style: LineArtStyle) {
  return `Line art "${name}" is ready for H.lineart("${name}", { style: '${style}', width, thickness, lineWidth, … }) (${aspect.toFixed(3)} times as wide as high; its white is open). Check the piece with render_model: the report's line-art line says how many bridges Jig had to add and how many specks it dropped.`;
}
