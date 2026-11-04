import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { publicPage, publicUrl, toolPolicy } from '../server/agent';

const ws = path.resolve('/tmp/ptp-test/workspaces/abc12345');
const file = path.join(ws, 'model.js');

test('only the design\'s own model.js can be read and written', async () => {
  const policy = toolPolicy(ws, false);
  for (const name of ['Read', 'Write', 'Edit']) {
    assert.equal(await policy(name, { file_path: file }), null);
    assert.equal(await policy(name, { file_path: 'model.js' }), null);
    assert.notEqual(await policy(name, { file_path: '../other/model.js' }), null);
    assert.notEqual(await policy(name, { file_path: '/etc/passwd' }), null);
    assert.notEqual(await policy(name, { file_path: 'model.js/../x' }), null);
  }
  assert.notEqual(await policy('Bash', {}), null);
  assert.notEqual(await policy('Glob', {}), null);
  assert.equal(await policy('mcp__cad__evaluate_model', {}), null);
});

test('the attached OpenSCAD files can be read, never written', async () => {
  const policy = toolPolicy(ws, false);
  const scad = path.join(ws, 'scad', 'box.scad');
  assert.equal(await policy('Read', { file_path: scad }), null);
  assert.equal(await policy('Read', { file_path: 'scad/box.scad' }), null);
  for (const name of ['Write', 'Edit']) assert.match(await policy(name, { file_path: scad }) ?? '', /may be changed/);
  // Only .scad files directly in the folder, of this design.
  assert.notEqual(await policy('Read', { file_path: path.join(ws, 'scad', 'notes.txt') }), null);
  assert.notEqual(await policy('Read', { file_path: path.join(ws, 'scad', 'sub', 'box.scad') }), null);
  assert.notEqual(await policy('Read', { file_path: 'scad/../../other/scad/box.scad' }), null);
  assert.notEqual(await policy('Read', { file_path: path.join(ws, 'box.scad') }), null);
  assert.notEqual(await policy('Read', { file_path: path.join(ws, 'scad') }), null);
});

// Stands in for DNS so the tests never touch the network.
const DNS: Record<string, string[]> = {
  'example.com': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
  '127.0.0.1.nip.io': ['127.0.0.1'],
  'printer.example.net': ['192.168.1.40'],
  'split.example.net': ['93.184.215.14', '10.0.0.5'],
  'v6.example.net': ['::1'],
  'mapped.example.net': ['::ffff:127.0.0.1'],
};
const fakeDns = async (host: string) => {
  const ips = DNS[host];
  if (!ips) throw new Error(`ENOTFOUND ${host}`);
  return ips;
};

test('web tools only with web search on, and only public pages', async () => {
  assert.notEqual(await toolPolicy(ws, false, fakeDns)('WebFetch', { url: 'https://example.com' }), null);
  const web = toolPolicy(ws, true, fakeDns);
  assert.equal(await web('WebSearch', { query: 'x' }), null);
  assert.equal(await web('WebFetch', { url: 'https://example.com/datasheet.pdf' }), null);
  for (const url of ['http://127.0.0.1:8787/api/designs', 'http://localhost:5173', 'http://[::1]/', 'http://10.0.0.1', 'http://192.168.1.1', 'http://169.254.169.254/latest', 'http://router/', 'http://nas.local', 'file:///etc/passwd']) {
    assert.equal(publicUrl(url), false, url);
  }
});

test('public names that resolve to this computer or the local network are refused', async () => {
  for (const host of ['127.0.0.1.nip.io', 'printer.example.net', 'split.example.net', 'v6.example.net', 'mapped.example.net', 'missing.example.net']) {
    assert.equal(await publicPage(`https://${host}/`, fakeDns), false, host);
  }
  assert.equal(await publicPage('https://example.com/', fakeDns), true);
  assert.equal(await publicPage('https://93.184.215.14/', fakeDns), true);
  assert.equal(await publicPage('http://[fe80::1]/', fakeDns), false);
  const web = toolPolicy(ws, true, fakeDns);
  assert.notEqual(await web('WebFetch', { url: 'https://127.0.0.1.nip.io:8787/api/designs' }), null);
});
