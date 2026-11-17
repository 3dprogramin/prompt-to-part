// The Docker build and helper scripts: checked with small shell runs and file reads, no docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

/** Runs `rebuild.sh --check` with a stand-in `docker` whose `top` lists these processes. */
function checkWith(processes: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-fakedocker-'));
  const fake = path.join(dir, 'docker');
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = top ]; then printf '%s\\n' 'PID ARGS' ${JSON.stringify(processes)}; exit 0; fi\nexit 1\n`);
  chmodSync(fake, 0o755);
  return spawnSync('bash', [path.join(root, 'scripts/rebuild.sh'), '--check'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
}

test('rebuild.sh --check: a Blender export under way counts as busy', () => {
  assert.equal(checkWith('42 /opt/blender/blender --background --python /tmp/x.py').status, 1);
});

test('rebuild.sh --check: nothing but the server running is idle', () => {
  assert.equal(checkWith('1 node --import tsx server/index.ts --production').status, 0);
});

test('.dockerignore keeps the test server data folder out of the build', () => {
  const lines = readFileSync(path.join(root, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('test-data'));
});

test('Dockerfile sets PTP_COMMIT after the dependency layers, so a new commit does not recopy them', () => {
  const docker = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const commit = docker.indexOf('ENV PTP_COMMIT=');
  assert.ok(commit > 0);
  assert.ok(commit > docker.indexOf('COPY --from=prod-deps'));
  assert.ok(commit > docker.indexOf('COPY --from=build'));
});

test('test-server.sh only stops a pid that is still its own server', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-ts-'));
  // A pid file naming a live process that is not a server (this test's own shell sleeper).
  const sleeper = spawnSync('bash', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  const pid = Number(sleeper.stdout.trim());
  try {
    writeFileSync(path.join(dir, 'server.pid'), String(pid));
    const script = readFileSync(path.join(root, 'scripts/test-server.sh'), 'utf8')
      .replace('PID_FILE=test-data/server.pid', `PID_FILE=${dir}/server.pid`)
      .replace(/^npx vite build.*$/m, 'exit 0');
    spawnSync('bash', ['-c', script, path.join(root, 'scripts/test-server.sh'), 'stop'], { cwd: root, encoding: 'utf8' });
    assert.doesNotThrow(() => process.kill(pid, 0), 'the unrelated process was killed');
  } finally {
    try { process.kill(pid); } catch { /* gone */ }
  }
});
