// New starter ideas for the empty chat, written by Claude Haiku (one turn, no tools).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv } from './agent';
import { IDEAS_SYSTEM_PROMPT } from '../shared/ideas';

/** Asks the model for ideas with this prompt and returns its raw reply (parseIdeas reads it). */
export const IDEAS_TIMEOUT_MESSAGE = 'Coming up with ideas took too long';

/** `timeoutMs` and `run` (the SDK's query) can be swapped in tests. */
export async function writeIdeas(prompt: string, { timeoutMs = 30_000, run = query }: { timeoutMs?: number; run?: typeof query } = {}): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    let text = '';
    for await (const msg of run({
      prompt,
      options: {
        systemPrompt: IDEAS_SYSTEM_PROMPT,
        model: 'haiku',
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
      if (msg.type === 'result') {
        if (msg.subtype !== 'success') throw new Error(`Couldn't come up with ideas (${msg.subtype})`);
        text = msg.result;
      }
    }
    return text;
  } catch (e) {
    // The SDK reports our own timeout as "process aborted by user": say what happened.
    if (abort.signal.aborted) throw new Error(IDEAS_TIMEOUT_MESSAGE);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
