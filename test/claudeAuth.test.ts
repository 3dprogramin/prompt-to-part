import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeEnv } from '../server/agent';
import { claudeAuthProblem } from '../server/config';

const KEYS = ['PTP_AUTH', 'PTP_DOCKER', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENROUTER_API_KEY'];

/** Runs `fn` with only these of the app's auth variables set, then puts the environment back. */
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

test('subscription with a setup-token: the token reaches Claude Code, no key or OpenRouter does', () => {
  withEnv({ PTP_AUTH: 'subscription', PTP_DOCKER: '1', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', ANTHROPIC_API_KEY: 'sk-ant-test', OPENROUTER_API_KEY: 'sk-or-test' }, () => {
    assert.equal(claudeAuthProblem(), null);
    const env = claudeEnv();
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-test');
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'an API key would win over the token');
    assert.equal(env.ANTHROPIC_BASE_URL, undefined, 'never through OpenRouter');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.OPENROUTER_API_KEY, undefined);
  });
});

test('subscription in Docker without a token or a login says how to make one', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-auth-'));
  try {
    withEnv({ PTP_AUTH: 'subscription', PTP_DOCKER: '1', CLAUDE_CONFIG_DIR: dir }, () => {
      assert.match(claudeAuthProblem() ?? '', /claude setup-token.*CLAUDE_CODE_OAUTH_TOKEN/);
      // A login made inside the container (kept in the CLAUDE_CONFIG_DIR volume) counts.
      writeFileSync(path.join(dir, '.credentials.json'), '{}');
      assert.equal(claudeAuthProblem(), null);
    });
    // Outside Docker the CLI's own login is used as before.
    withEnv({ PTP_AUTH: 'subscription', CLAUDE_CONFIG_DIR: path.join(dir, 'none') }, () => assert.equal(claudeAuthProblem(), null));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API-key mode never passes a subscription token on', () => {
  withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' }, () => {
    assert.match(claudeAuthProblem() ?? '', /No Claude API key/, 'a token alone is not an API key');
    assert.equal(claudeEnv().CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });
  withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', OPENROUTER_API_KEY: 'sk-or-test' }, () => {
    const env = claudeEnv();
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-or-test');
  });
});
