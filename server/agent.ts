import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { query, type SDKUserMessage, type EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, GenerateRequest, ImageData } from '../shared/api';
import { geometry, formatReport } from './geometry';
import { cadTools } from './cadTools';
import { buildSystemPrompt } from './systemPrompt';
import { partialFields } from './partialJson';
import { authMode, claudeAuthProblem, claudeViaOpenRouter, DATA_DIR } from './config';
import { pageKey } from '../shared/sources';
import { describeDrawings, DRAWINGS_KEY, parseDrawings } from '../shared/svgFeatures';
import { parseScadFiles } from '../shared/scad';
import { formatScadReport, runScad } from './openscad';
import { artworkAvailable, decodeImage } from './artwork';
import { HF_IMAGES_KEY, HF_KEY, parseHfImages, toHfImage } from '../shared/hueforge';
import { isLithophane } from '../shared/lithophane';
import { formatDuration } from '../shared/duration';
import { lineChanges } from '../shared/lineDiff';
import { cachedPrintDefaults } from './bambu';
import { readMyFilaments } from './myFilaments';
import { A1_DEFAULTS } from '../shared/print';
import type { ParamValues } from '../shared/types';
import { MESHES_KEY, parseMeshes } from '../shared/meshes';
import { describeImport, meshDir } from './meshes';
import { meshyClient } from './meshy';
import { recordRateLimit } from './usage';

const MODEL_FILE = 'model.js';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
/** Longest text kept with a step for the activity panel (it is saved with the design). */
const MAX_DETAIL = 8000;
const detail = (text: string, max = MAX_DETAIL) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text);

const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading a file',
  Write: 'Writing model.js',
  Edit: 'Editing model.js',
  mcp__cad__evaluate_model: 'Evaluating model',
  mcp__cad__render_model: 'Rendering preview',
  mcp__cad__render_scad: 'Rendering the OpenSCAD file',
  mcp__cad__generate_artwork: 'Generating artwork',
  mcp__cad__generate_picture: 'Generating a picture',
  mcp__cad__set_hueforge: 'Changing the LayerTone filaments',
  mcp__cad__generate_3d: 'Making a 3D model with Meshy',
  mcp__cad__submit_model: 'Validating & submitting',
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a web page',
};
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

/**
 * What Claude may do in a design's workspace: read and write its model.js, use the CAD tools, and
 * (only with web search on) search and read public web pages. Returns why a call is refused, or
 * null to allow it. `resolve` looks up a host name's addresses (replaceable in tests).
 */
export function toolPolicy(ws: string, webSearch: boolean, resolve = resolveHost) {
  const file = path.join(ws, MODEL_FILE);
  return async (name: string, input: Record<string, unknown>): Promise<string | null> => {
    if (['Read', 'Write', 'Edit'].includes(name)) {
      return path.resolve(ws, String(input.file_path ?? '')) === file ? null : `Only ${file} may be accessed.`;
    }
    if (name.startsWith('mcp__cad__')) return null;
    if (webSearch && name === 'WebSearch') return null;
    // A page Claude reads could tell it to fetch a local address (Jig's own API, a router), so local
    // and private addresses are never fetched. It could also tell it to put the design into a
    // public URL; that can't be told apart from a normal fetch, which is why web search can be
    // turned off per design.
    if (webSearch && name === 'WebFetch') return await publicPage(input.url, resolve) ? null : 'Only public http(s) web pages can be fetched.';
    return 'Tool not available in Jig.';
  };
}

/** Host name or address of an http(s) URL, or null for anything else. */
function urlHost(raw: unknown): string | null {
  let u: URL;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** An address on the internet: not this computer, the local network, link-local or multicast. */
function publicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
  }
  const h = ip.toLowerCase();
  return net.isIPv6(h) && !(h === '::' || h === '::1' || /^f[cdf]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:') || h.startsWith('64:ff9b:'));
}

/** http(s) URL on a public host: not this computer, the local network or a private address. */
export function publicUrl(raw: unknown): boolean {
  const h = urlHost(raw);
  if (h === null) return false;
  if (net.isIP(h)) return publicIp(h);
  // Single-label names (e.g. "router") and local-only domains resolve on the local network.
  return h.includes('.') && !/\.(localhost|local|internal|lan|home\.arpa)$/.test(h);
}

async function resolveHost(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

/**
 * publicUrl, and the host name resolves only to public addresses: anyone can make a public name
 * (e.g. 127.0.0.1.nip.io) point at this computer or the local network. A name that doesn't resolve
 * is refused too. (A DNS server built to answer differently a moment later could still get past
 * this; WebFetch itself refuses loopback and metadata hosts on cross-host redirects.)
 */
export async function publicPage(raw: unknown, resolve: (host: string) => Promise<string[]> = resolveHost): Promise<boolean> {
  if (!publicUrl(raw)) return false;
  const h = urlHost(raw)!;
  if (net.isIP(h)) return true;
  try {
    const ips = await resolve(h);
    return ips.length > 0 && ips.every(publicIp);
  } catch {
    return false;
  }
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
  // painting (H.hueforge) or a lithophane (H.lithophane); all only when turned on, and AI pictures
  // need an OpenRouter key.
  const mode = req.imageMode ?? (req.artwork ? 'artwork' : 'off');
  const artwork = mode === 'artwork' && artworkAvailable();
  // A LayerTone or lithophane design stays one in follow-ups, whatever the menu says now (unless it
  // asks for the other): Claude keeps its picture tools. A design is one or the other.
  // The design's pictures and LayerTone setup (sent with every request; the follow-up values win).
  const pictureValues: ParamValues = { ...req.pictures, ...req.renderValues };
  const lithophane = mode === 'lithophane' || (mode !== 'hueforge' && isLithophane(req.code));
  const hueforge = !lithophane && (mode === 'hueforge' || /\bH\.hueforge\s*\(/.test(req.code ?? '') || Object.keys(parseHfImages(pictureValues[HF_IMAGES_KEY])).length > 0);
  const references = (req.images ?? []).filter((img) => IMAGE_TYPES.has(img.mediaType)).map((img) => `data:${img.mediaType};base64,${img.data}`);
  // Pictures: the design's own, plus the photos attached now (kept with the design).
  const hfImages = parseHfImages(pictureValues[HF_IMAGES_KEY]);
  const newPictures: string[] = [];
  // In a LayerTone or lithophane design (whatever the menu says now) attached photos become pictures.
  if (hueforge || lithophane) {
    for (const img of (req.images ?? []).filter((i) => i.mediaType === 'image/png' || i.mediaType === 'image/jpeg')) {
      try {
        const raster = decodeImage(Buffer.from(img.data, 'base64'));
        let name = `photo-${Object.keys(hfImages).length + 1}`;
        while (hfImages[name]) name += '-b';
        hfImages[name] = toHfImage(name, raster.width, raster.height, raster.data);
        newPictures.push(name);
        emit({ type: 'hfImage', name, image: hfImages[name] });
      } catch (e) {
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `A photo couldn't be read for ${lithophane ? 'the lithophane' : 'LayerTone'}: ${(e as Error).message}` } });
      }
    }
  }
  // Meshes kept with the design (attached files and Meshy models), for H.mesh.
  const meshes = parseMeshes(pictureValues[MESHES_KEY]);
  const attachedMeshes = (req.meshes ?? []).filter((n) => meshes[n]);
  const figure = mode === 'figure';
  const meshy = meshyClient();
  // generate_3d: in 3D figure mode, and in follow-ups on designs that have meshes.
  const meshTools = !!meshy && (figure || Object.keys(meshes).length > 0);
  const base: ParamValues = {
    ...(Object.keys(meshes).length ? { [MESHES_KEY]: JSON.stringify(meshes) } : {}),
    ...(Object.keys(drawings).length ? { [DRAWINGS_KEY]: JSON.stringify(drawings) } : {}),
    ...(Object.keys(hfImages).length ? { [HF_IMAGES_KEY]: JSON.stringify(hfImages) } : {}),
    ...(typeof pictureValues[HF_KEY] === 'string' ? { [HF_KEY]: pictureValues[HF_KEY] } : {}),
  };
  // The user's own filaments, for Claude to prefer in a LayerTone print (a small file, read per request).
  const myFilaments = hueforge ? await readMyFilaments() : [];
  const { server: cad, state } = cadTools(file, emit, opened, base, {
    artwork: artwork ? { references, signal: abort.signal } : undefined,
    pictures: (hueforge || lithophane) && artworkAvailable() ? { references, signal: abort.signal } : undefined,
    hueforge,
    lithophane,
    meshy: meshTools ? { client: meshy!, designId: req.designId, references, signal: abort.signal } : undefined,
  });
  // The print baseline Claude is told about: the user's Bambu Studio profile, as the 3MF export uses.
  const printBase = (await cachedPrintDefaults()) ?? A1_DEFAULTS;

  const content: Exclude<SDKUserMessage['message']['content'], string> = [];
  const parts: string[] = [];
  const isFollowUp = !!req.code?.trim();

  // Follow-ups: show Claude exactly what the user is looking at before they describe the change.
  if (isFollowUp) {
    emit({ type: 'live', text: 'Jig is capturing the current model…' });
    const sent: string[] = [];
    if (req.currentView && IMAGE_TYPES.has(req.currentView.mediaType)) {
      content.push({ type: 'text', text: 'CURRENT VIEW – the model exactly as the user sees it in the app right now (their camera angle; labels are live measurements in mm):' });
      content.push({ type: 'image', source: { type: 'base64', media_type: req.currentView.mediaType as 'image/jpeg', data: req.currentView.data } });
      sent.push('your current view');
      emit({ type: 'step', step: { kind: 'render', verbose: true, text: 'Jig got your current view', image: `data:${req.currentView.mediaType};base64,${req.currentView.data}` } });
    }
    if (req.renderValues) {
      try {
        const r = await geometry.render(req.code!, req.renderValues);
        if (r.ok && r.png) {
          content.push({ type: 'text', text: `CURRENT MODEL – four-view render at the user's exact current settings (top-left ISO, top-right FRONT, bottom-left RIGHT, bottom-right TOP; grid ${r.gridStep} mm):` });
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: r.png } });
          parts.push(`Measurements of the current model at the user's settings:\n${formatReport(r)}`);
          sent.push('a four-view render with measurements');
          emit({ type: 'step', step: { kind: 'render', verbose: true, text: 'Jig got a four-view render at your settings', image: `data:image/png;base64,${r.png}`, detail: formatReport(r) } });
        }
      } catch { /* the request still works without the render */ }
    }
    if (sent.length) emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Jig got ${sent.join(' and ')} of the current model` } });
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
  if (hueforge) {
    const names = Object.keys(hfImages);
    const setup = typeof pictureValues[HF_KEY] === 'string' ? pictureValues[HF_KEY] : null;
    if (isFollowUp) parts.push(setup ? `The LayerTone setup (the user's panel; set_hueforge changes it, and it wins over the script): ${setup}` : 'The LayerTone setup is empty: the script\'s filaments and automatic swaps apply (set_hueforge changes that).');
    parts.push(`LayerTone mode is on: make this a LayerTone filament painting with H.hueforge (see the system prompt). ${newPictures.length ? `The attached photo${newPictures.length > 1 ? 's are' : ' is'} stored for it as ${newPictures.map((n) => `"${n}"`).join(', ')}.` : ''} ${names.length ? `Pictures available to H.hueforge: ${names.map((n) => `"${n}" (${hfImages[n].width}×${hfImages[n].height})`).join(', ')}.` : 'There is no picture yet: ' + (artworkAvailable() ? 'make one with generate_picture.' : 'ask the user to attach a photo (Jig has no image model without OPENROUTER_API_KEY).')}`);
  }
  if (lithophane) {
    const names = Object.keys(hfImages);
    parts.push(`Lithophane mode is on: make this a lithophane with H.lithophane (see the system prompt). ${newPictures.length ? `The attached photo${newPictures.length > 1 ? 's are' : ' is'} stored for it as ${newPictures.map((n) => `"${n}"`).join(', ')}.` : ''} ${names.length ? `Pictures available to H.lithophane: ${names.map((n) => `"${n}" (${hfImages[n].width}×${hfImages[n].height})`).join(', ')}.` : 'There is no picture yet: ' + (artworkAvailable() ? 'make one with generate_picture.' : 'ask the user to attach a photo (Jig has no image model without OPENROUTER_API_KEY).')}`);
  }
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
  if (figure && !meshy) parts.push('3D figure mode is on, but Jig has no Meshy key (MESHY_API_KEY), so generate_3d is not available.');
  else if (figure) parts.push(`3D figure mode is on: make the subject with generate_3d${references.length ? ' (from_photo: true builds it from the attached photo)' : ''} and build the design around it with H.mesh.`);
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
  if (Object.keys(drawings).length) parts.push(`SVG drawings the user attached (their pictures are among the images). Use their exact shapes with H.svg(name, { height, colors }) instead of redrawing them:\n${describeDrawings(drawings)}`);
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
    const q = query({
      prompt: messages(),
      options: {
        systemPrompt: buildSystemPrompt(file, !!req.webSearch, printBase, artwork, hueforge ? { pictures: artworkAvailable(), mine: myFilaments } : undefined, lithophane ? { pictures: artworkAvailable() } : undefined,
          figure || Object.keys(meshes).length ? { figure, meshy: meshTools } : undefined),
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
        emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Finished in ${formatDuration(msg.duration_ms)} · ${msg.num_turns} turns` } });
        // A message the user sent as the turn ended starts another turn: the reply goes on until
        // Claude has read and answered everything.
        if (!msg.is_error && inbox.unanswered()) {
          emit({ type: 'step', step: { kind: 'status', text: 'Answering your message…' } });
          continue;
        }
        inbox.close();
        // An API error ends the turn with is_error; the SDK then throws, and the catch below
        // either retries or reports it, so the reply isn't marked finished here.
        if (!msg.is_error) emit({ type: 'done', durationMs: Date.now() - t0, turns: msg.num_turns, submitted: state.submitted, text: finalText });
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
    if (req.sessionId && !gotOutput && !limitHit && /session|conversation|invalid .*request/i.test(msg)) {
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

/** The user's messages for one running reply, handed to Claude Code as it asks for them. */
class Inbox {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  /** Handed to Claude Code, and read by Claude (echoed back). */
  sent = 0;
  read = 0;
  push(m: SDKUserMessage): boolean {
    if (this.closed) return false;
    this.queue.push(m);
    this.wake?.();
    return true;
  }
  /** Sent or waiting messages Claude hasn't read yet. */
  unanswered() { return this.queue.length > 0 || this.sent > this.read; }
  close() { this.closed = true; this.wake?.(); }
  async *drain(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift();
      if (next) { this.sent++; yield next; continue; }
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }
}

/** Running replies by design, for messages sent while Claude works. */
const steering = new Map<string, { inbox: Inbox; emit: (e: AgentEvent) => void }>();

/**
 * A message for the reply Claude is working on: it reads it at its next step (after the current
 * tool call or thinking). False when no reply is running (or it has just ended): queue it instead.
 */
export function steerGeneration(designId: string, text: string, images: ImageData[] = []): boolean {
  const run = steering.get(designId);
  if (!run) return false;
  const pictures = images.filter((img) => IMAGE_TYPES.has(img.mediaType));
  const ok = run.inbox.push({
    type: 'user', parent_tool_use_id: null, priority: 'next',
    message: { role: 'user', content: [
      { type: 'text', text: `Message from the user while you work${pictures.length ? ' (with pictures)' : ''}:\n${text.trim() || '(see the pictures)'}` },
      ...pictures.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType as 'image/jpeg', data: img.data } })),
    ] },
  });
  if (ok) run.emit({ type: 'step', step: { kind: 'user', text: text.trim() || `${pictures.length} picture${pictures.length > 1 ? 's' : ''}`, ...(pictures[0] ? { image: `data:${pictures[0].mediaType};base64,${pictures[0].data}` } : {}) } });
  return ok;
}

/** A file's text, or '' if it doesn't exist yet. */
function readText(f: string): string {
  try { return readFileSync(f, 'utf8'); } catch { return ''; }
}

/** The earlier conversation as text for a fresh session (newest messages kept, each shortened). */
function recapOf(history: GenerateRequest['history']): string | undefined {
  const lines = (history ?? []).filter((h) => h.text.trim()).slice(-12)
    .map((h) => `${h.role === 'user' ? 'User' : 'You'}: ${h.text.replace(/\s+/g, ' ').trim().slice(0, 600)}`);
  if (!lines.length) return undefined;
  return `EARLIER CONVERSATION about this design (the previous session couldn't be continued, so here is what was said; model.js holds the current script):\n${lines.join('\n')}`;
}

function lastSentence(text: string) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 140 ? '…' + t.slice(-140) : t;
}

function describeToolInput(name: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  if (name === 'Write' && typeof input.content === 'string') {
    return `Writing model.js – ${input.content.split('\n').length} lines, ${(input.content.length / 1024).toFixed(1)} KB`;
  }
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const a = input.old_string.split('\n').length, b = input.new_string.split('\n').length;
    return `Editing model.js – replacing ${a} line${a === 1 ? '' : 's'} with ${b}${input.replace_all ? ' (all occurrences)' : ''}`;
  }
  if (name === 'Read') return 'Reading model.js';
  if (name === 'mcp__cad__generate_picture' && typeof input.subject === 'string') return `Picture "${String(input.name ?? '')}": ${input.subject.slice(0, 200)}`;
  if (name === 'mcp__cad__generate_3d') return `3D model "${String(input.name ?? '')}": ${input.from_photo ? 'from the attached photo' : String(input.prompt ?? '').slice(0, 200)}`;
  if (name === 'mcp__cad__generate_artwork' && typeof input.subject === 'string') return `Artwork "${String(input.name ?? '')}": ${input.subject.slice(0, 200)}`;
  if (name === 'mcp__cad__render_scad' && typeof input.file === 'string') return `OpenSCAD: ${input.file}${input.values && typeof input.values === 'object' && Object.keys(input.values).length ? ` with ${Object.entries(input.values as Record<string, unknown>).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}` : ''}`;
  if ((name === 'mcp__cad__evaluate_model' || name === 'mcp__cad__render_model') && input.values && typeof input.values === 'object' && Object.keys(input.values).length) {
    return `${name.endsWith('render_model') ? 'Rendering' : 'Evaluating'} with ${Object.entries(input.values as Record<string, unknown>).map(([k, v]) => `${k}=${v}`).join(', ')}`;
  }
  if (name === 'mcp__cad__submit_model' && typeof input.summary === 'string') return `Submitting: ${input.summary}`;
  if (name === 'WebSearch' && typeof input.query === 'string') return `Searching the web: ${input.query}`;
  if (name === 'WebFetch' && typeof input.url === 'string') return `Reading ${input.url}`;
  return null;
}
