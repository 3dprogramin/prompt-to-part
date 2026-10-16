import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { query, tool, createSdkMcpServer, type SDKUserMessage, type EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { geometry, formatReport } from './geometry';
import { buildSystemPrompt } from './systemPrompt';
import type { AgentStep, ParamValues } from '../shared/types';

export const DATA_DIR = path.resolve(process.env.AI_DESIGNER_DATA ?? path.join(process.cwd(), 'data'));

export interface GenerateRequest {
  designId: string;
  prompt: string;
  images?: { mediaType: string; data: string }[];
  code?: string;
  values?: ParamValues;
  sessionId?: string;
  model?: string;
  effort?: EffortLevel;
  textNote?: string;
}

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'step'; step: AgentStep }
  | { type: 'model'; code: string; summary: string }
  | { type: 'done'; durationMs: number; turns: number; submitted: boolean; text: string }
  | { type: 'error'; message: string }
  /** Transient one-line status (throttled), replaced by the next one. */
  | { type: 'live'; text: string };

const MODEL_FILE = 'model.js';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const valuesSchema = z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional()
  .describe('Optional parameter values to test with (defaults are used for missing keys)');

const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading model.js',
  Write: 'Writing model.js',
  Edit: 'Editing model.js',
  mcp__cad__evaluate_model: 'Evaluating model',
  mcp__cad__render_model: 'Rendering preview',
  mcp__cad__submit_model: 'Validating & submitting',
};

export function workspaceDir(designId: string) {
  return path.join(DATA_DIR, 'workspaces', designId);
}

export async function runGeneration(req: GenerateRequest, rawEmit: (e: AgentEvent) => void, abort: AbortController): Promise<void> {
  const t0 = Date.now();
  const emit = (e: AgentEvent) => {
    if (e.type === 'step') e.step.at = Date.now() - t0;
    rawEmit(e);
  };
  emit({ type: 'live', text: 'Starting Claude…' });
  const ws = workspaceDir(req.designId);
  const file = path.join(ws, MODEL_FILE);
  await mkdir(ws, { recursive: true });
  if (req.code?.trim()) await writeFile(file, req.code);
  else await rm(file, { force: true });

  const readModel = async () => {
    try { return await readFile(file, 'utf8'); } catch { return null; }
  };
  const noFile = { content: [{ type: 'text' as const, text: `model.js does not exist yet. Write the script to ${file} first.` }], isError: true };
  let submitted = false;
  // Code of model.js at the last successful render: submit requires the current file to have been looked at.
  let renderedCode: string | null = null;

  const cad = createSdkMcpServer({
    name: 'cad',
    version: '1.0.0',
    tools: [
      tool('evaluate_model', 'Run model.js with the given (or default) parameter values. Returns errors with line numbers, or bounding boxes, volumes, connected-piece counts, dimension callouts and warnings.', { values: valuesSchema }, async ({ values }) => {
        const code = await readModel();
        if (code == null) return noFile;
        try {
          const r = await geometry.evaluate(code, values);
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
          const r = await geometry.render(code, values);
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
      tool('submit_model', 'Submit model.js as the finished design. Validates the defaults and stress-tests every parameter at its min/max. Rejected if anything fails (set force=true only if a failure is truly unavoidable and harmless).', {
        summary: z.string().describe('One or two sentences describing this version (shown in version history)'),
        force: z.boolean().optional(),
      }, async ({ summary, force }) => {
        const code = await readModel();
        if (code == null) return noFile;
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
          const r = await geometry.evaluate(code);
          if (!r.ok || !r.parts.length) {
            emit({ type: 'step', step: { kind: 'tool', ok: false, text: 'Submit rejected: defaults fail' } });
            return { content: [{ type: 'text', text: `Rejected – the default parameters do not produce a valid model:\n${formatReport(r)}` }], isError: true };
          }
          const s = await geometry.stress(code);
          if (s.failures.length && !force) {
            emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Stress test: ${s.failures.length} slider extreme(s) fail` } });
            return {
              content: [{ type: 'text', text: `Rejected – ${s.failures.length} of ${s.tested} slider-extreme cases fail:\n${s.failures.slice(0, 15).map((f) => `  - ${f.case}: ${f.error}`).join('\n')}\nClamp derived values inside build() or narrow the parameter ranges, then submit again.` }],
              isError: true,
            };
          }
          submitted = true;
          emit({ type: 'step', step: { kind: 'tool', ok: true, text: `Stress test passed (${s.tested} cases)${s.skipped ? `, ${s.skipped} skipped for time` : ''}` } });
          emit({ type: 'model', code, summary });
          return { content: [{ type: 'text', text: 'Accepted and loaded in the user\'s viewer. Now end your turn with a short message to the user.' }] };
        } catch (e) {
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      }),
    ],
  });

  const content: Exclude<SDKUserMessage['message']['content'], string> = [];
  for (const img of req.images ?? []) {
    if (!IMAGE_TYPES.has(img.mediaType)) continue;
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType as 'image/jpeg', data: img.data } });
  }
  const parts: string[] = [];
  if (req.code?.trim()) {
    parts.push(`This is a follow-up on the existing design. Its current script is in ${file} (Read it before editing).`);
    if (req.values && Object.keys(req.values).length) parts.push(`The user's current slider values: ${JSON.stringify(req.values)}`);
  } else {
    parts.push(`This is a new design. ${file} does not exist yet.`);
  }
  if (req.textNote) parts.push(`Text the user placed with the app's text tool (applied automatically after your build – do not add it again unless asked): ${req.textNote}`);
  if (content.length) parts.push(`${content.length} reference image(s) are attached.`);
  parts.push(`User request:\n${req.prompt.trim() || '(no text – work from the reference images)'}`);
  content.push({ type: 'text', text: parts.join('\n\n') });

  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'ai-designer/1.0' };
  // Use the logged-in Claude Code subscription rather than API billing.
  if (!process.env.AI_DESIGNER_USE_API_KEY) { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }

  const run = async (resume?: string) => {
    async function* messages(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
    }
    let finalText = '';
    let gotOutput = false;
    const q = query({
      prompt: messages(),
      options: {
        systemPrompt: buildSystemPrompt(file),
        model: req.model || 'opus',
        effort: req.effort ?? 'high',
        thinking: { type: 'adaptive', display: 'summarized' },
        cwd: ws,
        tools: ['Read', 'Write', 'Edit'],
        mcpServers: { cad },
        permissionMode: 'default',
        canUseTool: async (name, input) => {
          if (['Read', 'Write', 'Edit'].includes(name)) {
            const p = path.resolve(ws, String(input.file_path ?? ''));
            if (p === file) return { behavior: 'allow', updatedInput: input };
            return { behavior: 'deny', message: `Only ${file} may be accessed.` };
          }
          if (name.startsWith('mcp__cad__')) return { behavior: 'allow', updatedInput: input };
          return { behavior: 'deny', message: 'Tool not available in AI Designer.' };
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
          if (cb.type === 'thinking') pushLive('Thinking…');
          else if (cb.type === 'text') pushLive('Writing a reply…');
          else if (cb.type === 'tool_use') pushLive(`Preparing: ${TOOL_LABELS[cb.name ?? ''] ?? cb.name}…`);
        } else if (ev.type === 'content_block_delta' && block) {
          const d = ev.delta as { type: string; thinking?: string; text?: string; partial_json?: string };
          if (d.type === 'thinking_delta' && d.thinking) {
            block.text = (block.text + d.thinking).slice(-400);
            pushLive(`Thinking: ${lastSentence(block.text)}`);
          } else if (d.type === 'text_delta' && d.text) {
            block.text = (block.text + d.text).slice(-400);
            pushLive(`Writing a reply: ${lastSentence(block.text)}`);
          } else if (d.type === 'input_json_delta' && d.partial_json) {
            block.chars += d.partial_json.length;
            pushLive(`${TOOL_LABELS[block.name ?? ''] ?? block.name}… ${(block.chars / 1024).toFixed(1)} KB`);
          }
        } else if (ev.type === 'content_block_stop') block = null;
      } else if (msg.type === 'assistant') {
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
        if (msg.subtype !== 'success') {
          emit({ type: 'error', message: `Agent stopped: ${msg.subtype}${'errors' in msg && msg.errors?.length ? ` – ${msg.errors.join('; ')}` : ''}` });
        }
        emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Finished in ${(msg.duration_ms / 1000).toFixed(0)} s · ${msg.num_turns} turns` } });
        emit({ type: 'done', durationMs: msg.duration_ms, turns: msg.num_turns, submitted, text: finalText });
      }
    }
    return gotOutput;
  };

  try {
    await run(req.sessionId);
  } catch (e) {
    if (abort.signal.aborted) return;
    const msg = (e as Error).message ?? String(e);
    // Session may have been deleted – retry once without resuming.
    if (req.sessionId && /session|conversation/i.test(msg)) {
      emit({ type: 'step', step: { kind: 'status', text: 'Previous session unavailable – starting a fresh one.' } });
      await run(undefined);
    } else throw e;
  }
}

function oneLine(r: { ok: true; bbox: { min: number[]; max: number[] } | null; timeMs: number; parts: { triCount: number }[]; warnings: string[] }) {
  const b = r.bbox;
  const size = b ? `${(b.max[0] - b.min[0]).toFixed(1)} × ${(b.max[1] - b.min[1]).toFixed(1)} × ${(b.max[2] - b.min[2]).toFixed(1)} mm` : 'empty';
  const tris = r.parts.reduce((s, p) => s + p.triCount, 0);
  return `${size} · ${r.parts.length} part(s) · ${tris.toLocaleString()} tris · ${Math.round(r.timeMs)} ms`;
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
  return null;
}
