import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paramRows, planProject, printRows, projectReadme, safeName, type ReadmeInfo } from '../src/lib/project';
import { A1_DEFAULTS } from '../shared/print';

test('safe names: no characters a file system refuses, no hidden or reserved names', () => {
  assert.equal(safeName('Phone stand'), 'Phone stand');
  assert.equal(safeName('A/B: "C" <d>?'), 'A-B- -C- -d-');
  assert.equal(safeName('  ..hidden. '), 'hidden');
  assert.equal(safeName('con'), 'con-design');
  assert.equal(safeName('LPT1.txt'), 'LPT1.txt-design');
  assert.equal(safeName('tab\there'), 'tab-here');
  assert.equal(safeName(''), 'Untitled design');
  assert.equal(safeName('...'), 'Untitled design');
  assert.equal(safeName('Ünïcødé 😀 name'), 'Ünïcødé 😀 name');
  const long = safeName('😀'.repeat(100));
  assert.equal(Array.from(long).length, 80);
  assert.ok(!/[\ud800-\udbff]$/.test(long), 'no half emoji');
});

test('the file list: model files named like Export STL, .blend only with Blender, README last', () => {
  const plan = planProject({ base: 'hook', blend: true, images: ['a.png'], meshes: ['b.bin', 'b.stl'], pictures: ['photo', 'Photo', 'a/b'] });
  assert.deepEqual(plan.map((f) => f.path), [
    'model.js', 'values.json', 'design.jig.json', 'hook.stl', 'hook.blend', 'hook.3mf', 'images/a.png',
    'images/picture-photo.png', 'images/picture-Photo-2.png', 'images/picture-a-b.png', 'meshes/b.bin', 'meshes/b.stl', 'README.md',
  ]);
  assert.equal(plan.find((f) => f.kind === '3mf')?.label, '3MF');
  assert.deepEqual(planProject({ base: 'x', blend: false, images: [], meshes: [], pictures: [] }).map((f) => f.path),
    ['model.js', 'values.json', 'design.jig.json', 'x.stl', 'x.3mf', 'README.md']);
});

test('parameter rows and print settings that differ from the profile', () => {
  const rows = paramRows({
    width: { type: 'number', label: 'Width', min: 1, max: 100, value: 40, unit: 'mm', group: 'Size' },
    holes: { type: 'boolean', value: true },
    style: { type: 'select', label: 'Style', value: 'a', options: [{ value: 'a', label: 'Round' }, { value: 'b', label: 'Square' }] },
    text: { type: 'text', label: 'Text', value: 'Hi' },
  }, { width: 52.123456, style: 'b', $print: '{}' });
  assert.deepEqual(rows, [
    { label: 'Width', value: '52.1235 mm', group: 'Size' }, { label: 'holes', value: 'on' }, { label: 'Style', value: 'Square' }, { label: 'Text', value: '"Hi"' },
  ]);
  const print = printRows({ walls: 3 }, { infill: 30, parts: { Hook: { walls: 5 } } }, A1_DEFAULTS, ['Body', 'Hook']);
  assert.deepEqual(print.map((r) => [r.part ?? '', r.label, r.value, r.was]), [
    ['', 'Walls', '3', '2'], ['', 'Infill', '30 %', '15 %'], ['Hook', 'Walls', '5', '3'],
  ]);
});

test('README: name, summary, size, parameters, print settings, sources, files and what failed', () => {
  const info: ReadmeInfo = {
    name: 'Hook | wall', date: new Date(2026, 9, 18, 9, 5), version: '0.0.4', versionNo: 2, versions: 3, summary: 'A wall hook.',
    size: [40, 20.5, 60], parts: ['Body', 'Hook'], params: [{ label: 'Width', value: '40 mm' }],
    print: [{ label: 'Walls', value: '3', was: '2' }],
    sources: [{ dimension: 'Screw', value: 'Ø 4 mm', kind: 'official', url: 'https://example.com/screw' }],
    meshes: { fox: { file: `/api/designs/x/meshes/${'ab'.repeat(16)}.bin`, triangles: 12000, size: [30, 20, 40], source: 'upload', original: 'fox.stl' } },
    check: 'No problems found', bambuProject: false,
    files: ['model.js', 'values.json', 'design.jig.json', 'hook.stl', 'hook.3mf', 'images/a.png', 'meshes/b.bin', 'README.md'],
    notes: ['No `.blend` file: Blender is not installed on the computer prompt-to-part runs on.'],
    problems: ['`hook.blend`: Blender stopped'],
  };
  const md = projectReadme(info);
  assert.match(md, /^# Hook \| wall\n\nA wall hook\.\n/);
  assert.match(md, /Exported from prompt-to-part 0\.0\.4 on 2026-10-18 09:05 \(version 2 of 3\)/);
  assert.match(md, /\*\*Size:\*\* 40\.00 × 20\.50 × 60\.00 mm/);
  assert.match(md, /\*\*Parts:\*\* Body, Hook/);
  assert.match(md, /## Not exported\n\n- `hook\.blend`: Blender stopped/);
  assert.match(md, /\| Width \| 40 mm \|/);
  assert.match(md, /\| Walls \| 3 \| 2 \|/);
  assert.match(md, /- Screw: Ø 4 mm \(Official, <https:\/\/example\.com\/screw>\)/);
  assert.match(md, /- fox: from fox\.stl, 30\.0 × 20\.0 × 40\.0 mm, 12,000 triangles/);
  assert.match(md, /- `hook\.3mf` - the parts with their colours, for any slicer/);
  assert.match(md, /- `images\/` - 1 picture:/);
  assert.match(md, /No `\.blend` file: Blender is not installed/);
  assert.match(md, /Designs → Import designs…/);
  assert.doesNotMatch(md, /Claude|HueForge/);
  // No changes, no sources, no meshes: those sections say so or are left out.
  const plain = projectReadme({ ...info, print: [], sources: [], meshes: {}, problems: [], notes: [], bambuProject: true });
  assert.match(plain, /0\.20 mm Standard, no changes\./);
  assert.match(plain, /a Bambu Studio project with the print settings and colours/);
  assert.doesNotMatch(plain, /## (Not exported|Where the dimensions|Meshes)/);
});
