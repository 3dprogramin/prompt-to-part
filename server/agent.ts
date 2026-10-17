import { lookup } from 'node:dns/promises';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { query, type SDKUserMessage, type EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, GenerateRequest } from '../shared/api';
import { geometry, formatReport } from './geometry';
import { cadTools } from './cadTools';
import { buildSystemPrompt } from './systemPrompt';
import { partialFields } from './partialJson';
import { DATA_DIR, USE_API_KEY } from './config';
import { pageKey } from '../shared/sources';
import { describeDrawings, DRAWINGS_KEY, parseDrawings } from '../shared/svgFeatures';
import { cachedPrintDefaults } from './bambu';
import { A1_DEFAULTS } from '../shared/print';

const MODEL_FILE = 'model.js';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading model.js',
  Write: 'Writing model.js',
  Edit: 'Editing model.js',
  mcp__cad__evaluate_model: 'Evaluating model',
  mcp__cad__render_model: 'Rendering preview',
  mcp__cad__submit_model: 'Validating & submitting',
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a web page',
};
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/** The environment for the Claude Code process the Agent SDK starts. */
export function claudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'jig/1.0' };
  // Use the Claude plan the `claude` CLI is logged in with, unless JIG_USE_API_KEY=1 asks for API billing.
  if (!USE_API_KEY) { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
  // Claude has no use for other services' keys.
  delete env.ELEVENLABS_API_KEY;
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
  emit({ type: 'live', text: 'Starting Claude…' });
  const ws = workspaceDir(req.designId);
  const file = path.join(ws, MODEL_FILE);
  await mkdir(ws, { recursive: true });
  if (req.code?.trim()) await writeFile(file, req.code);
  else await rm(file, { force: true });

  // Pages Claude actually read in this generation (WebFetch calls Jig allowed), by pageKey().
  const opened = new Set<string>();
  // Drawings attached in the chat: every check and render of the script can use them (H.svg).
  const drawings = parseDrawings(req.drawings);
  const { server: cad, state } = cadTools(file, emit, opened, Object.keys(drawings).length ? { [DRAWINGS_KEY]: JSON.stringify(drawings) } : {});
  // The print baseline Claude is told about: the user's Bambu Studio profile, as the 3MF export uses.
  const printBase = (await cachedPrintDefaults()) ?? A1_DEFAULTS;

  const content: Exclude<SDKUserMessage['message']['content'], string> = [];
  const parts: string[] = [];
  const isFollowUp = !!req.code?.trim();

  // Follow-ups: show Claude exactly what the user is looking at before they describe the change.
  if (isFollowUp) {
    emit({ type: 'live', text: 'Capturing the current model for Claude…' });
    const sent: string[] = [];
    if (req.currentView && IMAGE_TYPES.has(req.currentView.mediaType)) {
      content.push({ type: 'text', text: 'CURRENT VIEW – the model exactly as the user sees it in the app right now (their camera angle; labels are live measurements in mm):' });
      content.push({ type: 'image', source: { type: 'base64', media_type: req.currentView.mediaType as 'image/jpeg', data: req.currentView.data } });
      sent.push('your current view');
    }
    if (req.renderValues) {
      try {
        const r = await geometry.render(req.code!, req.renderValues);
        if (r.ok && r.png) {
          content.push({ type: 'text', text: `CURRENT MODEL – four-view render at the user's exact current settings (top-left ISO, top-right FRONT, bottom-left RIGHT, bottom-right TOP; grid ${r.gridStep} mm):` });
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: r.png } });
          parts.push(`Measurements of the current model at the user's settings:\n${formatReport(r)}`);
          sent.push('a four-view render with measurements');
        }
      } catch { /* the request still works without the render */ }
    }
    if (sent.length) emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Sent Claude ${sent.join(' and ')} of the current model` } });
  }

  const refs = (req.images ?? []).filter((img) => IMAGE_TYPES.has(img.mediaType));
  if (refs.length) {
    content.push({ type: 'text', text: `REFERENCE IMAGE${refs.length > 1 ? 'S' : ''} attached by the user with this request:` });
    for (const img of refs) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType as 'image/jpeg', data: img.data } });
  }

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
  parts.push(`User request:\n${req.prompt.trim() || '(no text – work from the reference images)'}`);
  content.push({ type: 'text', text: parts.join('\n\n') });

  const env = claudeEnv();

  // Whether Claude has answered at all: then a failure is not a missing session, and starting over
  // in a new one would repeat the work (and could produce a second version).
  let gotOutput = false;
  const run = async (resume?: string) => {
    async function* messages(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
    }
    let finalText = '';
    const q = query({
      prompt: messages(),
      options: {
        systemPrompt: buildSystemPrompt(file, !!req.webSearch, printBase),
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

    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        emit({ type: 'session', sessionId: msg.session_id });
        emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Connected to Claude (${msg.model}) · ${resume ? 'continuing the previous conversation' : 'new conversation'}` } });
        pushLive('Waiting for Claude…');
      } else if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev.type === 'message_start') pushLive('Claude is responding…');
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
        gotOutput = true;
        for (const b of msg.message.content) {
          if (b.type === 'text' && b.text.trim()) {
            finalText = b.text.trim();
            emit({ type: 'step', step: { kind: 'text', text: finalText } });
          } else if (b.type === 'thinking' && b.thinking?.trim()) {
            emit({ type: 'step', step: { kind: 'thinking', verbose: true, text: b.thinking.trim() } });
          } else if (b.type === 'tool_use') {
            toolNames.set(b.id, b.name);
            emit({ type: 'step', step: { kind: 'status', text: `${TOOL_LABELS[b.name] ?? b.name}…` } });
            const detail = describeToolInput(b.name, b.input as Record<string, unknown>);
            if (detail) emit({ type: 'step', step: { kind: 'status', verbose: true, text: detail } });
            pushLive(`Running: ${TOOL_LABELS[b.name] ?? b.name}…`);
          }
        }
      } else if (msg.type === 'user') {
        // Tool results for the built-in file tools (our CAD tools report their own results).
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type !== 'tool_result') continue;
            const name = toolNames.get(c.tool_use_id) ?? '';
            if (name.startsWith('mcp__cad__')) continue;
            const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => ('text' in x ? x.text : '')).join(' ') : '';
            if (c.is_error) emit({ type: 'step', step: { kind: 'tool', ok: false, verbose: true, text: `${TOOL_LABELS[name] ?? name} failed: ${text.slice(0, 200)}` } });
            else if (name === 'Write' || name === 'Edit') emit({ type: 'step', step: { kind: 'tool', ok: true, verbose: true, text: `${name === 'Write' ? 'Saved' : 'Edited'} model.js` } });
          }
        }
        pushLive('Claude is reading the results…');
      } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
        const why = msg.error_status ? `HTTP ${msg.error_status}` : 'connection problem';
        emit({ type: 'step', step: { kind: 'status', ok: false, text: `Claude API ${why} – retrying in ${Math.round(msg.retry_delay_ms / 1000)} s (attempt ${msg.attempt}/${msg.max_retries})` } });
        pushLive(`Waiting to retry the Claude API (${why})…`);
      } else if (msg.type === 'system' && msg.subtype === 'status' && msg.status && String(msg.status) !== 'requesting') {
        emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Status: ${String(msg.status)}` } });
      } else if (msg.type === 'rate_limit_event' && msg.rate_limit_info?.status && msg.rate_limit_info.status !== 'allowed') {
        emit({ type: 'step', step: { kind: 'status', ok: false, text: msg.rate_limit_info.status === 'rejected' ? 'Subscription usage limit reached – waiting for it to reset.' : 'Approaching the subscription usage limit.' } });
      } else if (msg.type === 'tool_progress') {
        pushLive(`${TOOL_LABELS[msg.tool_name] ?? msg.tool_name}… ${Math.round(msg.elapsed_time_seconds)} s`);
      } else if (msg.type === 'result') {
        if (liveTimer) clearTimeout(liveTimer);
        flushBlock();
        if (msg.subtype !== 'success') {
          emit({ type: 'error', message: `Agent stopped: ${msg.subtype}${'errors' in msg && msg.errors?.length ? ` – ${msg.errors.join('; ')}` : ''}` });
        }
        emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Finished in ${(msg.duration_ms / 1000).toFixed(0)} s · ${msg.num_turns} turns` } });
        emit({ type: 'done', durationMs: msg.duration_ms, turns: msg.num_turns, submitted: state.submitted, text: finalText });
      }
    }
  };

  try {
    await run(req.sessionId);
  } catch (e) {
    if (abort.signal.aborted) return;
    const msg = (e as Error).message ?? String(e);
    // Session may have been deleted – retry once without resuming.
    if (req.sessionId && !gotOutput && /session|conversation/i.test(msg)) {
      emit({ type: 'step', step: { kind: 'status', text: 'Previous session unavailable – starting a fresh one.' } });
      await run(undefined);
    } else throw e;
  }
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
  if ((name === 'mcp__cad__evaluate_model' || name === 'mcp__cad__render_model') && input.values && typeof input.values === 'object' && Object.keys(input.values).length) {
    return `${name.endsWith('render_model') ? 'Rendering' : 'Evaluating'} with ${Object.entries(input.values as Record<string, unknown>).map(([k, v]) => `${k}=${v}`).join(', ')}`;
  }
  if (name === 'mcp__cad__submit_model' && typeof input.summary === 'string') return `Submitting: ${input.summary}`;
  if (name === 'WebSearch' && typeof input.query === 'string') return `Searching the web: ${input.query}`;
  if (name === 'WebFetch' && typeof input.url === 'string') return `Reading ${input.url}`;
  return null;
}
