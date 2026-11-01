// A generation: Jig's request to Claude (Claude Code through the Agent SDK) with the CAD tools, and
// its stream of events for the page. The tool policy, the messages around the request and the
// activity panel's text are in generation/.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { query, type SDKUserMessage, type EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, GenerateRequest } from '../shared/api';
import { cadTools } from './cadTools';
import { buildSystemPrompt } from './systemPrompt';
import { partialFields } from './partialJson';
import { authMode, claudeAuthProblem, claudeKeyRefused, claudeViaOpenRouter, DATA_DIR } from './config';
import { pageKey } from '../shared/sources';
import { describeDrawings, DRAWINGS_KEY, parseDrawings } from '../shared/svgFeatures';
import { parseScadFiles } from '../shared/scad';
import { formatScadReport, runScad } from './openscad';
import { artworkAvailable, decodeImage } from './artwork';
import { LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, parseLayerToneImages, toLayerToneImage } from '../shared/layertone';
import { isLithophane } from '../shared/lithophane';
import { parsePartColors, PART_COLORS_KEY } from '../shared/params';
import { DEFAULT_LINE_ART_STYLE, isLineArt, LINEART_DEPTH_KEY, LINEART_EDITS_KEY, LINEART_ENDS_KEY, LINEART_JOIN_KEY, LINEART_LAYOUT_KEY, LINEART_SIZE_KEY, LINEART_SPLIT_KEY } from '../shared/lineart';
import { formatCost, formatDuration } from '../shared/duration';
import { lineChanges } from '../shared/lineDiff';
import { cachedPrintDefaults } from './bambu';
import { printerLoaded } from './printerSetting';
import { readMyFilaments } from './myFilaments';
import { A1_DEFAULTS } from '../shared/print';
import type { ParamValues } from '../shared/types';
import { CONCEPTS_KEY, MESHES_KEY, parseConcepts, parseMeshes } from '../shared/meshes';
import { describeImport, meshDir } from './meshes';
import { MESHY_CREDITS_PER_COLOR_MODEL, MESHY_CREDITS_PER_MODEL, meshyClient, meshyCredits } from './meshy';
import { recordRateLimit } from './usage';
import { MODEL_FILE, toolPolicy } from './generation/toolPolicy';
import { currentModelContext, IMAGE_TYPES, Inbox, recapOf, steering } from './generation/messages';
import { describeToolInput, detail, lastSentence, readText, TOOL_LABELS } from './generation/activity';
import { askFirstNote, lineArtNote } from './generation/notes';

export { publicPage, publicUrl, toolPolicy } from './generation/toolPolicy';
export { currentModelContext, steerGeneration } from './generation/messages';

const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/** The environment for the Claude Code process the Agent SDK starts. */
export function claudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'jig/1.0' };
  // Subscription mode uses the `claude` CLI's login or the CLAUDE_CODE_OAUTH_TOKEN from `claude
  // setup-token`, so no key may override it; in the default API-key mode the key (or token and base
  // URL) is passed on, and without one nothing runs at all (claudeAuthProblem), so the subscription
  // is never used silently.
  if (authMode() === 'subscription') { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.ANTHROPIC_BASE_URL; }
  else {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    // OpenRouter's Anthropic-compatible endpoint: its key is the token, and the API key must be empty.
    if (claudeViaOpenRouter()) Object.assign(env, { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: process.env.OPENROUTER_API_KEY, ANTHROPIC_API_KEY: '' });
  }
  // Claude has no use for other services' keys.
  delete env.ELEVENLABS_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.MESHY_API_KEY;
  return env;
}

export function workspaceDir(designId: string) {
  return path.join(DATA_DIR, 'workspaces', designId);
}

export async function runGeneration(req: GenerateRequest, rawEmit: (e: AgentEvent) => void, abort: AbortController): Promise<void> {
  const t0 = Date.now();
  const emit = (e: AgentEvent) => {
    if (e.type === 'step') e.step.at = Date.now() - t0;
    else if (e.type === 'block' && e.op === 'start') e.at = Date.now() - t0;
    rawEmit(e);
  };
  const authProblem = claudeAuthProblem();
  if (authProblem) { emit({ type: 'error', message: authProblem }); return; }
  emit({ type: 'live', text: 'Jig is starting…' });
  const ws = workspaceDir(req.designId);
  const file = path.join(ws, MODEL_FILE);
  await mkdir(ws, { recursive: true });
  if (req.code?.trim()) await writeFile(file, req.code);
  else await rm(file, { force: true });

  // Pages Claude actually read in this generation (WebFetch calls Jig allowed), by pageKey().
  const opened = new Set<string>();
  // Drawings attached in the chat: every check and render of the script can use them (H.svg).
  const drawings = parseDrawings(req.drawings);
  // The chat's picture mode: AI artwork (flat colours traced for H.svg), a LayerTone filament
  // painting (H.layertone), a lithophane (H.lithophane) or line art (H.lineart); all only when
  // turned on, and AI pictures need an OpenRouter key.
  const mode = req.imageMode ?? (req.artwork ? 'artwork' : 'off');
  const artwork = mode === 'artwork' && artworkAvailable();
  // A LayerTone or lithophane design stays one in follow-ups, whatever the menu says now (unless it
  // asks for the other): Claude keeps its picture tools. A design is one or the other.
  // The design's pictures and LayerTone setup (sent with every request; the follow-up values win).
  const pictureValues: ParamValues = { ...req.pictures, ...req.renderValues };
  // Line art stays line art the same way; a design is one kind of picture print.
  const lineArt = mode === 'lineart' || (isLineArt(req.code) && mode !== 'layertone' && mode !== 'lithophane');
  const lineArtStyle = req.lineArtStyle ?? DEFAULT_LINE_ART_STYLE;
  const lithophane = !lineArt && (mode === 'lithophane' || (mode !== 'layertone' && isLithophane(req.code)));
  const layerTone = !lineArt && !lithophane && (mode === 'layertone' || /\bH\.layertone\s*\(/.test(req.code ?? '') || Object.keys(parseLayerToneImages(pictureValues[LAYERTONE_IMAGES_KEY])).length > 0);
  const references = (req.images ?? []).filter((img) => IMAGE_TYPES.has(img.mediaType)).map((img) => `data:${img.mediaType};base64,${img.data}`);
  // Pictures: the design's own, plus the photos attached now (kept with the design).
  const layerToneImages = parseLayerToneImages(pictureValues[LAYERTONE_IMAGES_KEY]);
  const newPictures: string[] = [];
  // In a LayerTone or lithophane design (whatever the menu says now) attached photos become pictures.
  if (layerTone || lithophane) {
    for (const img of (req.images ?? []).filter((i) => i.mediaType === 'image/png' || i.mediaType === 'image/jpeg')) {
      try {
        const raster = decodeImage(Buffer.from(img.data, 'base64'));
        let name = `photo-${Object.keys(layerToneImages).length + 1}`;
        while (layerToneImages[name]) name += '-b';
        layerToneImages[name] = toLayerToneImage(name, raster.width, raster.height, raster.data);
        newPictures.push(name);
        emit({ type: 'layerToneImage', name, image: layerToneImages[name] });
      } catch (e) {
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `A photo couldn't be read for ${lithophane ? 'the lithophane' : 'LayerTone'}: ${(e as Error).message}` } });
      }
    }
  }
  // Meshes kept with the design (attached files and Meshy models), for H.mesh.
  const meshes = parseMeshes(pictureValues[MESHES_KEY]);
  const attachedMeshes = (req.meshes ?? []).filter((n) => meshes[n]);
  const figure = mode === 'figure';
  // Colour (3D figure mode): figures textured by Meshy and printed in up to 4 filaments.
  const figureColor = figure && !!req.figureColor;
  const meshy = meshyClient();
  // Concept pictures drawn earlier (generate_concept), for generate_3d's from_concept.
  const concepts = parseConcepts(pictureValues[CONCEPTS_KEY]);
  // generate_3d: in 3D figure mode, and in follow-ups on designs that have meshes or concepts.
  const meshTools = !!meshy && (figure || Object.keys(meshes).length > 0 || Object.keys(concepts).length > 0);
  // With the image model, a figure starts as a concept picture the user approves (no credits spent on a wrong one).
  const conceptTools = meshTools && artworkAvailable();
  const base: ParamValues = {
    ...(Object.keys(meshes).length ? { [MESHES_KEY]: JSON.stringify(meshes) } : {}),
    ...(Object.keys(concepts).length ? { [CONCEPTS_KEY]: JSON.stringify(concepts) } : {}),
    ...(Object.keys(drawings).length ? { [DRAWINGS_KEY]: JSON.stringify(drawings) } : {}),
    ...(Object.keys(layerToneImages).length ? { [LAYERTONE_IMAGES_KEY]: JSON.stringify(layerToneImages) } : {}),
    ...(typeof pictureValues[LAYERTONE_KEY] === 'string' ? { [LAYERTONE_KEY]: pictureValues[LAYERTONE_KEY] } : {}),
    ...(typeof pictureValues[LINEART_EDITS_KEY] === 'string' ? { [LINEART_EDITS_KEY]: pictureValues[LINEART_EDITS_KEY] } : {}),
    ...(typeof pictureValues[LINEART_SPLIT_KEY] === 'string' ? { [LINEART_SPLIT_KEY]: pictureValues[LINEART_SPLIT_KEY] } : {}),
    ...(typeof pictureValues[LINEART_SIZE_KEY] === 'string' ? { [LINEART_SIZE_KEY]: pictureValues[LINEART_SIZE_KEY] } : {}),
    ...(pictureValues[LINEART_JOIN_KEY] != null ? { [LINEART_JOIN_KEY]: pictureValues[LINEART_JOIN_KEY] } : {}),
    ...(pictureValues[LINEART_ENDS_KEY] != null ? { [LINEART_ENDS_KEY]: pictureValues[LINEART_ENDS_KEY] } : {}),
    ...(typeof pictureValues[LINEART_DEPTH_KEY] === 'string' ? { [LINEART_DEPTH_KEY]: pictureValues[LINEART_DEPTH_KEY] } : {}),
    ...(typeof pictureValues[LINEART_LAYOUT_KEY] === 'string' ? { [LINEART_LAYOUT_KEY]: pictureValues[LINEART_LAYOUT_KEY] } : {}),
    ...(typeof pictureValues[PART_COLORS_KEY] === 'string' ? { [PART_COLORS_KEY]: pictureValues[PART_COLORS_KEY] } : {}),
  };
  // The user's own filaments, for Claude to prefer in a LayerTone print (a small file, read per request).
  const myFilaments = layerTone ? await readMyFilaments() : [];
  const { server: cad, state, newUserMessage } = cadTools(file, emit, opened, base, {
    artwork: artwork ? { references, signal: abort.signal } : undefined,
    pictures: (layerTone || lithophane) && artworkAvailable() ? { references, signal: abort.signal } : undefined,
    layerTone,
    lithophane,
    meshy: meshTools ? { client: meshy!, designId: req.designId, references, signal: abort.signal, concepts: conceptTools, color: figureColor } : undefined,
    lineArt: lineArt ? { references, signal: abort.signal, style: lineArtStyle, pictures: artworkAvailable() } : undefined,
    askFirst: req.askFirst !== false,
  });
  // The print baseline Claude is told about: the chosen printer's Bambu Studio profile, as the 3MF export uses.
  await printerLoaded().catch(() => undefined);
  const printBase = (await cachedPrintDefaults()) ?? A1_DEFAULTS;

  const content: Exclude<SDKUserMessage['message']['content'], string> = [];
  const parts: string[] = [];
  const isFollowUp = !!req.code?.trim();
  // "Ask first": a few questions before building, only where the answer changes the design (every mode).
  parts.push(askFirstNote(req.askFirst));

  // Follow-ups: show Claude exactly what the user is looking at before they describe the change.
  if (isFollowUp) {
    const view = await currentModelContext(req, emit);
    content.push(...view.content);
    parts.push(...view.notes);
  }

  const refs = (req.images ?? []).filter((img) => IMAGE_TYPES.has(img.mediaType));
  if (refs.length) {
    content.push({ type: 'text', text: `REFERENCE IMAGE${refs.length > 1 ? 'S' : ''} attached by the user with this request:` });
    for (const img of refs) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType as 'image/jpeg', data: img.data } });
  }

  // OpenSCAD files: saved in the workspace (render_scad renders them, in later messages too) and
  // rendered now, so Claude sees what they make before rebuilding them as a Jig script.
  const scadDir = path.join(ws, 'scad');
  const attachedScad = parseScadFiles(req.scad) ?? [];
  const earlierScad = (await readdir(scadDir).catch(() => [] as string[])).filter((n) => n.endsWith('.scad') && !attachedScad.some((f) => f.name === n));
  for (const f of attachedScad) {
    await mkdir(scadDir, { recursive: true });
    await writeFile(path.join(scadDir, f.name), f.source);
    emit({ type: 'live', text: `Rendering ${f.name} with OpenSCAD…` });
    emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Rendering ${f.name} with OpenSCAD…` } });
    const source = f.source.length <= 40_000 ? `Its source:\n\`\`\`openscad\n${f.source}\n\`\`\`` : `Its source is long (${f.source.length} characters): Read ${path.join(scadDir, f.name)}.`;
    try {
      const r = await runScad(f.source, undefined, (text) => emit({ type: 'step', step: { kind: 'status', text } }));
      if (r.png) {
        content.push({ type: 'text', text: `OPENSCAD FILE ${f.name} – what OpenSCAD makes of it at its default values (views as in render_model; grid ${r.gridStep} mm):` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: r.png } });
        emit({ type: 'step', step: { kind: 'render', ok: true, text: `${f.name} in OpenSCAD`, image: `data:image/png;base64,${r.png}`, detail: formatScadReport(r) } });
      } else emit({ type: 'step', step: { kind: 'tool', ok: false, text: `${f.name}: OpenSCAD made no 3D model`, detail: formatScadReport(r) } });
      parts.push(`OpenSCAD file attached: ${f.name} (saved as ${path.join(scadDir, f.name)}).\n${formatScadReport(r)}\n${source}`);
    } catch (e) {
      emit({ type: 'step', step: { kind: 'tool', ok: false, text: `${f.name}: ${(e as Error).message}` } });
      parts.push(`OpenSCAD file attached: ${f.name} (saved as ${path.join(scadDir, f.name)}). OpenSCAD couldn't run it here (${(e as Error).message}), so there is no picture of it.\n${source}`);
    }
  }
  if (attachedScad.length) {
    parts.push('Jig runs model scripts, not OpenSCAD: build model.js so it reproduces the OpenSCAD design, then apply what the user asks. Keep its Customizer parameters as params (same names, defaults, ranges, steps, groups and captions; options become select, free text becomes text) and each color() as its own part, unless the user says otherwise. Compare your script with the original as you go: render_scad shows the OpenSCAD file at any parameter values, render_model your script.');
  }
  if (layerTone) {
    const names = Object.keys(layerToneImages);
    const setup = typeof pictureValues[LAYERTONE_KEY] === 'string' ? pictureValues[LAYERTONE_KEY] : null;
    if (isFollowUp) parts.push(setup ? `The LayerTone setup (the user's panel; set_layertone changes it, and it wins over the script): ${setup}` : 'The LayerTone setup is empty: the script\'s filaments and automatic swaps apply (set_layertone changes that).');
    parts.push(`LayerTone mode is on: make this a LayerTone filament painting with H.layertone (see the system prompt). ${newPictures.length ? `The attached photo${newPictures.length > 1 ? 's are' : ' is'} stored for it as ${newPictures.map((n) => `"${n}"`).join(', ')}.` : ''} ${names.length ? `Pictures available to H.layertone: ${names.map((n) => `"${n}" (${layerToneImages[n].width}×${layerToneImages[n].height})`).join(', ')}.` : 'There is no picture yet: ' + (artworkAvailable() ? 'make one with generate_picture.' : 'ask the user to attach a photo (Jig has no image model without OPENROUTER_API_KEY).')}`);
  }
  if (artwork) {
    // The user chose AI artwork for this design: the picture comes first, whatever the subject.
    const names = Object.keys(drawings);
    parts.push(`AI artwork mode is on: the user wants this as artwork – a flat multi-colour wall piece, relief, plaque or sign whose picture the image model draws, not a 3D model of the subject. ${names.length
      ? `Drawings in this design: ${names.map((n) => `"${n}"`).join(', ')}; keep using them unless the user asks for a new or different picture (then call generate_artwork again).`
      : 'There is no artwork yet: start with generate_artwork – for any subject, objects and machines included (a tommy gun, a car, a guitar are drawn as illustrations too) – then build the piece around it with H.svg.'} Model the subject in 3D geometry only if the user's message explicitly asks for a 3D object.`);
  }
  if (lithophane) {
    const names = Object.keys(layerToneImages);
    parts.push(`Lithophane mode is on: make this a lithophane with H.lithophane (see the system prompt). ${newPictures.length ? `The attached photo${newPictures.length > 1 ? 's are' : ' is'} stored for it as ${newPictures.map((n) => `"${n}"`).join(', ')}.` : ''} ${names.length ? `Pictures available to H.lithophane: ${names.map((n) => `"${n}" (${layerToneImages[n].width}×${layerToneImages[n].height})`).join(', ')}.` : 'There is no picture yet: ' + (artworkAvailable() ? 'make one with generate_picture.' : 'ask the user to attach a photo (Jig has no image model without OPENROUTER_API_KEY).')}`);
  }
  // Filaments the user picked for parts in the Object tab: they win over the script's colours.
  const picked = Object.entries(parsePartColors(pictureValues[PART_COLORS_KEY]));
  if (picked.length) parts.push(`The user picked the filaments for these parts in the Object tab, which win over the script's colours: ${picked.map(([n, f]) => `"${n}" → ${f.brand ? `${f.brand} ` : ''}${f.name ?? ''} ${f.color}`.replace(/\s+/g, ' ')).join(', ')}. Keep those part names (a renamed part loses its pick); to change one of these colours, tell the user to pick it in the Object tab (or reset it there) rather than editing the script's colour.`);
  if (lineArt) parts.push(lineArtNote(lineArtStyle, drawings, refs, pictureValues));
  // Mesh files attached now: a picture of each as imported, and what the import did.
  for (const name of attachedMeshes) {
    const entry = meshes[name];
    const pic = entry.preview && /^\/api\/designs\/([a-zA-Z0-9-]{8,64})\/meshes\/([0-9a-f]{32}\.png)$/.exec(entry.preview);
    const png = pic ? await readFile(path.join(meshDir(pic[1]), pic[2])).catch(() => null) : null;
    if (png) {
      content.push({ type: 'text', text: `MESH FILE ${entry.original ?? name} attached by the user – as imported (top-left ISO, top-right FRONT, bottom-left RIGHT, bottom-right TOP):` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
      emit({ type: 'step', step: { kind: 'render', verbose: true, text: `Jig got a render of ${entry.original ?? name}`, image: `data:image/png;base64,${png.toString('base64')}`, detail: describeImport(name, entry) } });
    }
    parts.push(`The user attached a mesh file. ${describeImport(name, entry)}`);
  }
  if (Object.keys(meshes).length && !attachedMeshes.length) {
    parts.push(`Meshes in this design (H.mesh): ${Object.entries(meshes).map(([n, m]) => `"${n}" (${m.source === 'meshy' ? `made with generate_3d${m.prompt ? `: ${m.prompt.slice(0, 120)}` : ''}` : `from ${m.original ?? 'a file'}`}; ${m.size.map((x) => x.toFixed(0)).join(' × ')} mm as stored, ${m.triangles.toLocaleString('en')} triangles)`).join(', ')}.`);
  }
  if (meshTools && Object.keys(concepts).length) {
    parts.push(`Concept pictures in this design (generate_3d from_concept builds one; the newest is last): ${Object.entries(concepts).map(([n, c]) => `"${n}" (${c.subject.slice(0, 160)}${c.painted ? '; in colour: the shape and its painted colours' : ''})`).join(', ')}.`);
  }
  if (figure && !meshy) parts.push('3D figure mode is on, but Jig has no Meshy key (MESHY_API_KEY), so generate_3d is not available.');
  else if (figure && references.length) parts.push('3D figure mode is on: make the subject with generate_3d (from_photo: true builds it from the attached photo) and build the design around it with H.mesh.');
  else if (figure && conceptTools) parts.push(`3D figure mode is on: if the user is approving a concept picture, build it with generate_3d({ name, from_concept }) and the design around it with H.mesh; if they want it changed, draw a new one with generate_concept. For a new figure, draw a concept picture with generate_concept and end your reply asking the user to approve it (no generate_3d in this reply) – unless they said to skip the picture and go straight to 3D. Each Meshy model costs ${meshyCredits(figureColor)} credits.`);
  else if (figure) parts.push('3D figure mode is on: make the subject with generate_3d and build the design around it with H.mesh.');
  if (figure && meshy) parts.push(figureColor
    ? `Colour is on: the figure is made in colour – each concept is a grey picture (the shape) and the same picture painted (the colours), generate_3d textured from the painted one (${MESHY_CREDITS_PER_COLOR_MODEL} credits a model), its colours printed in up to 4 filaments (see "Coloured figures").`
    : `Colour is off: figures are grey and print in one colour (${MESHY_CREDITS_PER_MODEL} credits a model). If the user asks for a figure in colour, use color: true on generate_concept and generate_3d (${MESHY_CREDITS_PER_COLOR_MODEL} credits) and tell them about the Colour switch next to the Figure button.`);
  if (earlierScad.length) parts.push(`OpenSCAD files attached earlier in this design (in ${scadDir}; render_scad renders them): ${earlierScad.join(', ')}`);

  if (isFollowUp) {
    parts.unshift(`This is a follow-up on the existing design. Its current script is in ${file} (Read it before editing). The images above show the current model – when the user says "this", "here" or refers to a part, use them to work out what they mean.`);
    if (req.values && Object.keys(req.values).length) parts.push(`The user's current slider values: ${JSON.stringify(req.values)}`);
    if (req.versionNote) parts.push(req.versionNote);
    if (req.scale && Math.abs(req.scale - 1) > 1e-6) {
      parts.push(`The user scaled the whole model uniformly to ${+(req.scale * 100).toFixed(1)} % in the app; the scale is applied after your build. Sizes the user mentions refer to the scaled model, while evaluate_model/render_model report unscaled sizes – convert accordingly.`);
    }
  } else {
    parts.push(`This is a new design. ${file} does not exist yet.`);
  }
  if (req.textNote) parts.push(`Text and SVG drawings the user placed with the app's Text and SVG tools (applied automatically after your build – do not add them again unless asked): ${req.textNote}`);
  if (Object.keys(drawings).length) parts.push(lineArt
    ? `Drawings in this design (attached SVGs and traced pictures; attached ones are among the images). Use their exact shapes with H.lineart(name, { … }) instead of redrawing them:\n${describeDrawings(drawings)}`
    : `SVG drawings the user attached (their pictures are among the images). Use their exact shapes with H.svg(name, { height, colors }) instead of redrawing them:\n${describeDrawings(drawings)}`);
  parts.push(`User request:\n${req.prompt.trim() || (attachedScad.length ? '(no text – rebuild the attached OpenSCAD file as it is)' : attachedMeshes.length ? '(no text – show the attached mesh as a printable model)' : '(no text – work from the reference images)')}`);
  content.push({ type: 'text', text: parts.join('\n\n') });

  const env = claudeEnv();

  // Whether Claude has answered at all: then a failure is not a missing session, and starting over
  // in a new one would repeat the work (and could produce a second version).
  let gotOutput = false;
  // A request was refused because the subscription's usage limit is reached.
  let limitHit = false;
  // Messages the user sends while Claude works go into the running reply (steerGeneration).
  const inbox = new Inbox();
  steering.set(req.designId, { inbox, emit });
  const run = async (resume?: string, recap?: string) => {
    async function* messages(): AsyncGenerator<SDKUserMessage> {
      // A fresh session after one that couldn't be continued starts with what was said before.
      yield { type: 'user', message: { role: 'user', content: recap ? [{ type: 'text', text: recap }, ...content] : content }, parent_tool_use_id: null };
      // Then whatever the user sends meanwhile; Claude Code reads each at Claude's next step.
      yield* inbox.drain();
    }
    let prompts = 0; // user messages Claude Code has read in this run (the first is the request itself)
    // Exactly what goes to Claude, for the activity panel.
    const pictures = content.filter((c) => c.type === 'image').length;
    const sentText = [recap, ...content.flatMap((c) => (c.type === 'text' ? [c.text] : []))].filter(Boolean).join('\n\n');
    emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Jig got the request${pictures ? ` with ${pictures} picture${pictures > 1 ? 's' : ''}` : ''}${recap ? ' and a summary of the earlier conversation' : ''}`, detail: detail(sentText, 30000) } });
    let finalText = '';
    // API keys: Claude Code's cost estimate is a running total for the session, and a continued
    // session starts from what it had cost before, so the reply's own cost is the difference (unknown
    // when the design doesn't know the earlier total, e.g. a session from before Jig kept it).
    const costBase = resume ? req.sessionCostUsd : 0;
    const q = query({
      prompt: messages(),
      options: {
        systemPrompt: buildSystemPrompt(file, !!req.webSearch, printBase, artwork, layerTone ? { pictures: artworkAvailable(), mine: myFilaments } : undefined, lithophane ? { pictures: artworkAvailable() } : undefined,
          figure || meshTools || Object.keys(meshes).length ? { figure, meshy: meshTools, concepts: conceptTools, color: figureColor } : undefined,
          lineArt ? { pictures: artworkAvailable() } : undefined),
        model: req.model || 'opus',
        effort: (req.effort ?? 'high') as EffortLevel,
        thinking: { type: 'adaptive', display: 'summarized' },
        cwd: ws,
        tools: ['Read', 'Write', 'Edit', ...(req.webSearch ? WEB_TOOLS : [])],
        mcpServers: { cad },
        permissionMode: 'default',
        canUseTool: async (name, input) => {
          const denied = await toolPolicy(ws, !!req.webSearch)(name, input);
          if (!denied && name === 'WebFetch') { const k = pageKey(String(input.url)); if (k) opened.add(k); }
          return denied ? { behavior: 'deny', message: denied } : { behavior: 'allow', updatedInput: input };
        },
        settingSources: [],
        includePartialMessages: true,
        // Claude Code echoes each user message when Claude reads it: how Jig knows a message sent mid-reply arrived.
        extraArgs: { 'replay-user-messages': null },
        maxTurns: 60,
        resume,
        abortController: abort,
        env,
        pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || undefined,
        stderr: (d) => { if (process.env.DEBUG_AGENT) process.stderr.write(d); },
      },
    });
    // Live line built from the partial stream, throttled so the client is not flooded.
    let live = '';
    let liveSent = 0;
    let liveTimer: ReturnType<typeof setTimeout> | null = null;
    const pushLive = (text: string) => {
      live = text;
      const now = Date.now();
      if (now - liveSent >= 250) { liveSent = now; emit({ type: 'live', text: live }); return; }
      if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = null; liveSent = Date.now(); emit({ type: 'live', text: live }); }, 250);
    };
    // Live transcript for the activity panel, batched: thinking and reply text are appended as they
    // stream; a tool call's input is re-sent as decoded fields (e.g. the model.js being written).
    let pending = '';
    let toolJson = '';
    let fieldsDirty = false;
    let blockTimer: ReturnType<typeof setTimeout> | null = null;
    const flushBlock = () => {
      if (blockTimer) { clearTimeout(blockTimer); blockTimer = null; }
      if (pending) { emit({ type: 'block', op: 'append', text: pending }); pending = ''; }
      if (fieldsDirty) { fieldsDirty = false; emit({ type: 'block', op: 'fields', fields: partialFields(toolJson) }); }
    };
    const flushSoon = () => { blockTimer ??= setTimeout(flushBlock, 150); };
    let block: { type: string; name?: string; chars: number; text: string } | null = null;
    const toolNames = new Map<string, string>();
    // Line counts of the Write/Edit calls in flight, by tool call.
    const edits = new Map<string, { added: number; removed: number }>();

    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        emit({ type: 'session', sessionId: msg.session_id });
        emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Jig is using ${msg.model} · ${resume ? 'continuing the previous conversation' : 'new conversation'}` } });
        pushLive('Waiting for Jig…');
      } else if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev.type === 'message_start') pushLive('Jig is responding…');
        else if (ev.type === 'content_block_start') {
          const cb = ev.content_block as { type: string; name?: string };
          block = { type: cb.type, name: cb.name, chars: 0, text: '' };
          flushBlock();
          toolJson = '';
          if (cb.type === 'thinking' || cb.type === 'text') emit({ type: 'block', op: 'start', kind: cb.type });
          else if (cb.type === 'tool_use') emit({ type: 'block', op: 'start', kind: 'tool', name: cb.name, label: TOOL_LABELS[cb.name ?? ''] ?? cb.name });
          if (cb.type === 'thinking') pushLive('Thinking…');
          else if (cb.type === 'text') pushLive('Writing a reply…');
          else if (cb.type === 'tool_use') pushLive(`Preparing: ${TOOL_LABELS[cb.name ?? ''] ?? cb.name}…`);
        } else if (ev.type === 'content_block_delta' && block) {
          const d = ev.delta as { type: string; thinking?: string; text?: string; partial_json?: string };
          if (d.type === 'thinking_delta' && d.thinking) {
            block.text = (block.text + d.thinking).slice(-400);
            pushLive(`Thinking: ${lastSentence(block.text)}`);
            pending += d.thinking;
            flushSoon();
          } else if (d.type === 'text_delta' && d.text) {
            block.text = (block.text + d.text).slice(-400);
            pushLive(`Writing a reply: ${lastSentence(block.text)}`);
            pending += d.text;
            flushSoon();
          } else if (d.type === 'input_json_delta' && d.partial_json) {
            block.chars += d.partial_json.length;
            toolJson += d.partial_json;
            fieldsDirty = true;
            flushSoon();
            pushLive(`${TOOL_LABELS[block.name ?? ''] ?? block.name}… ${(block.chars / 1024).toFixed(1)} KB`);
          }
        } else if (ev.type === 'content_block_stop') {
          flushBlock();
          block = null;
        }
      } else if (msg.type === 'assistant') {
        // The finished message arrives just before content_block_stop: send the streamed tail first.
        flushBlock();
        // A failed API call arrives as a made-up message carrying the error text: show it, but it
        // is not a reply (so the fresh-session retry below still applies).
        if (msg.error) {
          if (msg.error === 'rate_limit') limitHit = true;
          for (const b of msg.message.content) if (b.type === 'text' && b.text.trim()) emit({ type: 'step', step: { kind: 'status', ok: false, text: b.text.trim() } });
          continue;
        }
        gotOutput = true;
        for (const b of msg.message.content) {
          if (b.type === 'text' && b.text.trim()) {
            finalText = b.text.trim();
            emit({ type: 'step', step: { kind: 'text', text: finalText } });
          } else if (b.type === 'thinking' && b.thinking?.trim()) {
            emit({ type: 'step', step: { kind: 'thinking', verbose: true, text: b.thinking.trim() } });
          } else if (b.type === 'tool_use') {
            toolNames.set(b.id, b.name);
            // Writing or editing model.js shows as one step with its line counts once it is saved.
            if (b.name === 'Write' || b.name === 'Edit') {
              const input = b.input as { content?: unknown; old_string?: unknown; new_string?: unknown };
              const before = b.name === 'Write' ? readText(file) : String(input.old_string ?? '');
              edits.set(b.id, lineChanges(before, String(b.name === 'Write' ? input.content ?? '' : input.new_string ?? '')));
              pushLive(`${TOOL_LABELS[b.name]}…`);
              continue;
            }
            emit({ type: 'step', step: { kind: 'status', text: `${TOOL_LABELS[b.name] ?? b.name}…` } });
            const detail = describeToolInput(b.name, b.input as Record<string, unknown>);
            if (detail) emit({ type: 'step', step: { kind: 'status', verbose: true, text: detail } });
            pushLive(`Running: ${TOOL_LABELS[b.name] ?? b.name}…`);
          }
        }
      } else if (msg.type === 'user' && 'isReplay' in msg && msg.isReplay) {
        // A user message Claude has just read: the request, then any the user sent mid-reply.
        if (prompts++ > 0) {
          inbox.read++;
          newUserMessage();
          emit({ type: 'step', step: { kind: 'status', verbose: true, text: 'Jig read your message' } });
          pushLive('Jig is reading your message…');
        }
      } else if (msg.type === 'user') {
        // Tool results: everything Claude gets back goes to the activity panel (the CAD tools also
        // report a summary step of their own; the built-in tools' failures and saves show in the chat).
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type !== 'tool_result') continue;
            const name = toolNames.get(c.tool_use_id) ?? '';
            const label = TOOL_LABELS[name] ?? name;
            const blocks = Array.isArray(c.content) ? c.content : [];
            // (Pictures come back as placeholder lines naming a local file; the panel shows them as renders.)
            const text = (typeof c.content === 'string' ? c.content : blocks.map((x) => ('text' in x ? x.text : '')).filter(Boolean).join('\n')).replace(/^\[Image[^\]\n]*\]\n?/gm, '').trim();
            const images = blocks.filter((x) => x.type === 'image').length;
            const got = `Jig got the result of ${label}${images ? ` (with ${images} picture${images > 1 ? 's' : ''})` : ''}`;
            if (name.startsWith('mcp__cad__')) emit({ type: 'step', step: { kind: 'status', verbose: true, text: got, detail: detail(text) } });
            else if (c.is_error) emit({ type: 'step', step: { kind: 'tool', ok: false, verbose: true, text: `${label} failed: ${text.slice(0, 200)}`, detail: detail(text) } });
            else if (name === 'Write' || name === 'Edit') emit({ type: 'step', step: { kind: 'tool', ok: true, text: 'model.js', edit: { file: 'model.js', ...(edits.get(c.tool_use_id) ?? { added: 0, removed: 0 }) } } });
            else emit({ type: 'step', step: { kind: 'status', verbose: true, text: got, detail: detail(text) } });
          }
        }
        pushLive('Jig is reading the results…');
      } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
        // A refused key won't start working on a retry: stop at once and say which key to check
        // (Claude Code would otherwise retry it for minutes).
        if (authMode() === 'api-key' && (msg.error_status === 401 || msg.error_status === 403)) {
          q.close();
          throw new KeyRefusedError(claudeKeyRefused(msg.error_status));
        }
        const why = msg.error_status ? `HTTP ${msg.error_status}` : 'connection problem';
        emit({ type: 'step', step: { kind: 'status', ok: false, text: `Claude API ${why} – retrying in ${Math.round(msg.retry_delay_ms / 1000)} s (attempt ${msg.attempt}/${msg.max_retries})` } });
        pushLive(`Waiting to retry the Claude API (${why})…`);
      } else if (msg.type === 'system' && msg.subtype === 'status' && msg.status && String(msg.status) !== 'requesting') {
        emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Status: ${String(msg.status)}` } });
      } else if (msg.type === 'rate_limit_event') {
        if (msg.rate_limit_info) recordRateLimit(msg.rate_limit_info);
        if (msg.rate_limit_info?.status && msg.rate_limit_info.status !== 'allowed') emit({ type: 'step', step: { kind: 'status', ok: false, text: msg.rate_limit_info.status === 'rejected' ? 'Subscription usage limit reached – waiting for it to reset.' : 'Approaching the subscription usage limit.' } });
      } else if (msg.type === 'tool_progress') {
        pushLive(`${TOOL_LABELS[msg.tool_name] ?? msg.tool_name}… ${Math.round(msg.elapsed_time_seconds)} s`);
      } else if (msg.type === 'result') {
        if (liveTimer) clearTimeout(liveTimer);
        flushBlock();
        if (msg.subtype !== 'success') {
          emit({ type: 'error', message: `Agent stopped: ${msg.subtype}${'errors' in msg && msg.errors?.length ? ` – ${msg.errors.join('; ')}` : ''}` });
        }
        const sessionCostUsd = authMode() === 'api-key' ? msg.total_cost_usd : undefined;
        // (A total below the earlier one means Claude Code started this session's count from zero.)
        const costUsd = sessionCostUsd === undefined || costBase === undefined ? undefined : sessionCostUsd >= costBase ? sessionCostUsd - costBase : sessionCostUsd;
        emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Finished in ${formatDuration(msg.duration_ms)} · ${msg.num_turns} turns${costUsd !== undefined ? ` · ${formatCost(costUsd)}` : ''}` } });
        // A message the user sent as the turn ended starts another turn: the reply goes on until
        // Claude has read and answered everything.
        if (!msg.is_error && inbox.unanswered()) {
          emit({ type: 'step', step: { kind: 'status', text: 'Answering your message…' } });
          continue;
        }
        inbox.close();
        // An API error ends the turn with is_error; the SDK then throws, and the catch below
        // either retries or reports it, so the reply isn't marked finished here.
        if (!msg.is_error) emit({ type: 'done', durationMs: Date.now() - t0, turns: msg.num_turns, submitted: state.submitted, text: finalText, costUsd, sessionCostUsd });
      }
    }
  };

  try {
    await run(req.sessionId);
  } catch (e) {
    if (abort.signal.aborted) return;
    const msg = (e as Error).message ?? String(e);
    // The session may be gone, or the API refuses its history (e.g. a session started on a Claude
    // subscription, continued through another provider): retry once in a fresh session, with a
    // recap of the conversation so Claude knows what came before.
    if (req.sessionId && !gotOutput && !limitHit && !(e instanceof KeyRefusedError) && /session|conversation|invalid .*request/i.test(msg)) {
      emit({ type: 'step', step: { kind: 'status', text: 'The previous conversation can\'t be continued – starting a fresh one with a summary of it.' } });
      try {
        await run(undefined, recapOf(req.history));
      } catch (e2) {
        throw limitHit && !abort.signal.aborted ? new UsageLimitError((e2 as Error).message) : e2;
      }
    } else throw limitHit ? new UsageLimitError(msg) : e;
  } finally {
    inbox.close();
    if (steering.get(req.designId)?.inbox === inbox) steering.delete(req.designId);
  }
}

/** A reply that failed because the Claude subscription's usage limit is reached. */
export class UsageLimitError extends Error {}

/** A reply that failed because the Claude API refused Jig's API key or token (the message says which). */
export class KeyRefusedError extends Error {}
