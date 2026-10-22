// A random sub-scene for a product photo, written by Claude: a fresh setting of the preset's kind.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv } from './agent';
import { claudeAuthProblem } from './config';
import { recordRateLimit } from './usage';
import { parseWrittenScene, SCENE_WRITER_PROMPT, sceneWriterPrompt } from '../shared/photos';

export async function writeScene(id: string): Promise<string> {
  const authProblem = claudeAuthProblem();
  if (authProblem) throw new Error(authProblem);
  const abort = new AbortController();
  // Short: the photo waits for it (and is made without it if it fails).
  const timer = setTimeout(() => abort.abort(), 45_000);
  try {
    let text = '';
    for await (const msg of query({
      prompt: sceneWriterPrompt(id),
      options: {
        systemPrompt: SCENE_WRITER_PROMPT,
        model: 'sonnet',
        tools: [],
        maxTurns: 1,
        settingSources: [],
        permissionMode: 'default',
        canUseTool: async () => ({ behavior: 'deny', message: 'No tools here.' }),
        env: claudeEnv(),
        abortController: abort,
        pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || undefined,
      },
    })) {
      if (msg.type === 'rate_limit_event') recordRateLimit(msg.rate_limit_info);
      if (msg.type === 'result') {
        if (msg.subtype !== 'success') throw new Error(`Jig couldn't write a scene (${msg.subtype})`);
        text = msg.result;
      }
    }
    return parseWrittenScene(text);
  } finally {
    clearTimeout(timer);
  }
}
