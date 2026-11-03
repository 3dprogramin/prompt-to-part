import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeEnv } from '../server/agent';
import { claudeAuthProblem } from '../server/config';

const KEYS = ['JIG_AUTH', 'JIG_DOCKER', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENROUTER_API_KEY'];

/** Runs `fn` with only these of Jig's auth variables set, then puts the environment back. */
function withEnv(vars: Record<string, string>, fn: () => void) {
  const saved = { ...process.env };
  try {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, vars);
    fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('an old JIG_AUTH=subscription is refused, even next to an OpenRouter key', () => {
  withEnv({ JIG_AUTH: 'subscription', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', OPENROUTER_API_KEY: 'sk-or-test' }, () => {
    const problem = claudeAuthProblem() ?? '';
    assert.match(problem, /no longer runs on a Claude subscription/);
    assert.match(problem, /ANTHROPIC_API_KEY or OPENROUTER_API_KEY/);
    assert.match(problem, /remove JIG_AUTH/);
  });
  // The default value is fine.
  withEnv({ JIG_AUTH: 'api-key', ANTHROPIC_API_KEY: 'sk-ant-test' }, () => assert.equal(claudeAuthProblem(), null));
});

test('a subscription token never reaches Claude Code', () => {
  withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' }, () => {
    assert.match(claudeAuthProblem() ?? '', /no Claude API key/, 'a token alone is not an API key');
    assert.equal(claudeEnv().CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });
  withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', OPENROUTER_API_KEY: 'sk-or-test' }, () => {
    const env = claudeEnv();
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-or-test');
  });
});
