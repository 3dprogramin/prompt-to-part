// A scene for a product photo, written by Claude: a fresh setting of a preset's kind (its random
// sub-scene), or the user's short idea written out (the 'idea' scene).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv } from './agent';
import { claudeAuthProblem } from './config';
import { recordRateLimit } from './usage';
import { IDEA_SCENE, IDEA_WRITER_PROMPT, ideaWriterPrompt, parseWrittenScene, SCENE_WRITER_PROMPT, sceneWriterPrompt, type SceneIdea } from '../shared/photos';
import type { Vec3 } from '../shared/types';

export async function writeScene(id: string, size?: Vec3, idea?: SceneIdea): Promise<string> {
  const authProblem = claudeAuthProblem();
  if (authProblem) throw new Error(authProblem);
  const fromIdea = id === IDEA_SCENE && !!idea;
  const abort = new AbortController();
  // Short: the photo waits for it (and is made without it if it fails).
  const timer = setTimeout(() => abort.abort(), 45_000);
  try {
    let text = '';
    for await (const msg of query({
      prompt: fromIdea ? ideaWriterPrompt(idea, size) : sceneWriterPrompt(id, Math.random, size),
      options: {
        systemPrompt: fromIdea ? IDEA_WRITER_PROMPT : SCENE_WRITER_PROMPT,
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
