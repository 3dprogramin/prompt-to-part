import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { publicUrl, toolPolicy } from '../server/agent';

const ws = path.resolve('/tmp/jig-test/workspaces/abc12345');
const file = path.join(ws, 'model.js');

test('only the design\'s own model.js can be read and written', () => {
  const policy = toolPolicy(ws, false);
  for (const name of ['Read', 'Write', 'Edit']) {
    assert.equal(policy(name, { file_path: file }), null);
    assert.equal(policy(name, { file_path: 'model.js' }), null);
    assert.notEqual(policy(name, { file_path: '../other/model.js' }), null);
    assert.notEqual(policy(name, { file_path: '/etc/passwd' }), null);
    assert.notEqual(policy(name, { file_path: 'model.js/../x' }), null);
  }
  assert.notEqual(policy('Bash', {}), null);
  assert.notEqual(policy('Glob', {}), null);
  assert.equal(policy('mcp__cad__evaluate_model', {}), null);
});

test('web tools only with web search on, and only public pages', () => {
  assert.notEqual(toolPolicy(ws, false)('WebFetch', { url: 'https://example.com' }), null);
  const web = toolPolicy(ws, true);
  assert.equal(web('WebSearch', { query: 'x' }), null);
  assert.equal(web('WebFetch', { url: 'https://example.com/datasheet.pdf' }), null);
  for (const url of ['http://127.0.0.1:8787/api/designs', 'http://localhost:5173', 'http://[::1]/', 'http://10.0.0.1', 'http://192.168.1.1', 'http://169.254.169.254/latest', 'http://router/', 'http://nas.local', 'file:///etc/passwd']) {
    assert.equal(publicUrl(url), false, url);
  }
});
