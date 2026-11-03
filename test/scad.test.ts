import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOff, parseScadFiles, scadDefines, scadFileName } from '../shared/scad';
import { EventEmitter } from 'node:events';
import { engineInstalled, runScad, workerResult, type WorkerChild } from '../server/openscad';

test('OFF output: one part per face colour, polygons triangulated, sizes measured', () => {
  // A 10 mm cube (orange, quads) and a triangle-only tetrahedron (blue, 0–1 colours).
  const cube = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const tet = [[20, 0, 0], [26, 0, 0], [20, 6, 0], [20, 0, 6]].map((v) => v.join(' '));
  const off = [
    'OFF', `${cube.length + 4} ${quads.length + 4} 0`, ...cube.map((v) => v.join(' ')), ...tet,
    ...quads.map((q) => `4 ${q.join(' ')} 255 165 0`),
    ...[[8, 10, 9], [8, 9, 11], [8, 11, 10], [9, 10, 11]].map((t) => `3 ${t.join(' ')} 0.0 0.0 1.0 1.0`),
  ].join('\n');
  const parts = parseOff(off);
  assert.equal(parts.length, 2);
  const [box, tetra] = parts;
  assert.equal(box.color, '#ffa500');
  assert.equal(box.triCount, 12);
  assert.ok(Math.abs(box.volume - 1000) < 1e-6);
  assert.deepEqual(box.bbox, { min: [0, 0, 0], max: [10, 10, 10] });
  assert.equal(tetra.color, '#0000ff');
  assert.ok(Math.abs(tetra.volume - 36) < 1e-6);
  assert.equal(tetra.positions.length, 12, 'each part keeps only its own vertices');
  assert.match(box.name, /^Part 1/);
});

test('values become -D options; names are checked and strings quoted', () => {
  assert.deepEqual(scadDefines({ width: 60, lid: false, label: 'a"b', 'bad name': 1, x: Infinity }), ['-D', 'width=60', '-D', 'lid=false', '-D', 'label="a\\"b"']);
});

test('attached files: safe names, limits', () => {
  assert.equal(scadFileName('../../etc/passwd'), 'passwd.scad');
  assert.equal(scadFileName('My Box (v2).SCAD'), 'My_Box_v2_.scad');
  assert.deepEqual(parseScadFiles([{ name: 'a.scad', source: 'cube(1);' }]), [{ name: 'a.scad', source: 'cube(1);' }]);
  assert.equal(parseScadFiles([{ name: 'a.scad', source: 'x'.repeat(300_001) }]), null);
  assert.equal(parseScadFiles('nope'), null);
});

// Needs the OpenSCAD engine, which Jig downloads the first time a .scad file is attached.
test('OpenSCAD renders a file with its parameters (needs the downloaded engine)', { skip: !engineInstalled() }, async () => {
  const r = await runScad('/* [Size] */\nw = 10; // [5:1:50]\ncolor("red") cube([w, 5, 2]);\ncolor("blue") translate([0, 10, 0]) cube(3);\necho("hi");', { w: 20 });
  assert.ok(r.ok && r.png);
  assert.deepEqual(r.params.map((p) => [p.name, p.min, p.max]), [['w', 5, 50]]);
  assert.deepEqual(r.parts.map((p) => [p.color, +(p.bbox.max[0] - p.bbox.min[0]).toFixed(3)]), [['#ff0000', 20], ['#0000ff', 3]]);
  assert.deepEqual(r.messages, ['ECHO: "hi"']);
});

test('a worker that fails to start or to take the job rejects once and never crashes the server', async () => {
  /** A stand-in child process: send() answers through `onSend`. */
  const fake = (onSend: (child: EventEmitter, cb: (e: Error | null) => void) => void) => {
    const child = new EventEmitter() as EventEmitter & { kills: number };
    child.kills = 0;
    Object.assign(child, { send: (_m: unknown, cb: (e: Error | null) => void) => { onSend(child, cb); return true; }, kill: () => { child.kills++; return true; } });
    return child;
  };
  const job = { engineDir: '/nowhere', source: 'cube(1);' };
  // The fork fails (an 'error' event, twice, then 'exit'): one rejection, the child is killed.
  const broken = fake((c) => setImmediate(() => { c.emit('error', new Error('spawn EAGAIN')); c.emit('error', new Error('again')); c.emit('exit', null, null); }));
  await assert.rejects(workerResult(broken as unknown as WorkerChild, job, 5000), /OpenSCAD could not run: spawn EAGAIN/);
  assert.equal(broken.kills, 1);
  // The job can't be sent (a closed channel).
  const closed = fake((_c, cb) => setImmediate(() => cb(new Error('channel closed'))));
  await assert.rejects(workerResult(closed as unknown as WorkerChild, job, 5000), /channel closed/);
  // An answer, then the worker exits: the answer stands.
  const out = { ok: true, params: [], parts: [], messages: [], timeMs: 1 };
  const fine = fake((c, cb) => { cb(null); setImmediate(() => { c.emit('message', { out }); c.emit('exit', 0, null); c.emit('error', new Error('late')); }); });
  assert.deepEqual(await workerResult(fine as unknown as WorkerChild, job, 5000), out);
  // No answer in time.
  await assert.rejects(workerResult(fake(() => {}) as unknown as WorkerChild, job, 20), /longer than/);
});

test('Stop kills the OpenSCAD worker at once', async () => {
  const child = new EventEmitter() as EventEmitter & { kills: number };
  child.kills = 0;
  Object.assign(child, { send: (_m: unknown, cb: (e: Error | null) => void) => { cb(null); return true; }, kill: () => { child.kills++; return true; } });
  const job = { engineDir: '/nowhere', source: 'cube(1);' };
  const abort = new AbortController();
  const result = workerResult(child as unknown as WorkerChild, job, 5000, abort.signal);
  abort.abort();
  await assert.rejects(result, /Stopped/);
  assert.equal(child.kills, 1);
  // Already stopped: killed before the job is sent.
  const late = new EventEmitter() as EventEmitter & { kills: number; sent: number };
  Object.assign(late, { kills: 0, sent: 0, send: () => { late.sent++; return true; }, kill: () => { late.kills++; return true; } });
  await assert.rejects(workerResult(late as unknown as WorkerChild, job, 5000, abort.signal), /Stopped/);
  assert.deepEqual([late.kills, late.sent], [1, 0]);
  // runScad: no download, no worker.
  await assert.rejects(runScad('cube(1);', undefined, undefined, abort.signal), /Stopped/);
});
