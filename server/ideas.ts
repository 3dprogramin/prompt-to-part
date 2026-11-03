// New starter ideas for the empty chat, written by Claude Haiku (one turn, no tools).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv } from './agent';
import { IDEAS_SYSTEM_PROMPT } from '../shared/ideas';

/** Asks Jig for ideas with this prompt and returns its raw reply (parseIdeas reads it). */
export async function writeIdeas(prompt: string): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    let text = '';
    for await (const msg of query({
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
        if (msg.subtype !== 'success') throw new Error(`Jig couldn't come up with ideas (${msg.subtype})`);
        text = msg.result;
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
