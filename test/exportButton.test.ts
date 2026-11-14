// The Export button: 3MF by default, the formats in order, 3MF and Export project set apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExportButton, ExportMenu } from '../src/components/ExportButton';

const noop = () => undefined;
const common = { onExport: noop, blender: null, painted: false };

test('the Export button starts on 3MF', () => {
  const html = renderToStaticMarkup(createElement(ExportButton, {
    ...common, disabled: false, exporting: false, count: 1, flat: false, bambu: null, printChanges: 0, threeMf: { print: true },
    onThreeMf: noop, oneColour: false, onOneColour: noop, onExport3mf: noop, onExportProject: noop,
  }));
  assert.match(html, /Export 3MF/);
  assert.doesNotMatch(html, /Export STL/);
});

test('the menu lists 3MF, STL, GLB, Blender, then Export project, with 3MF and Export project set apart', () => {
  const html = renderToStaticMarkup(createElement(ExportMenu, { ...common, pick: noop, open3mf: noop, openGlb: noop, project: noop }));
  const labels = [...html.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['3MF…', 'STL', 'GLB… (shop 3D view)', 'Blender (.blend)', 'Export project…']);
  const featured = [...html.matchAll(/<button[^>]*class="[^"]*export-featured[^"]*"[^>]*>[\s\S]*?<b>([^<]+)<\/b>/g)].map((m) => m[1]);
  assert.deepEqual(featured, ['3MF…', 'Export project…']);
  assert.match(html, /Best for printing/);
  assert.match(html, /Everything/);
  assert.match(html, /export-divider/);
  assert.doesNotMatch(html, /[–—]/, 'no en or em dashes in the menu');
});

test('a coloured figure: the STL line says only the 3MF keeps the colours', () => {
  const html = renderToStaticMarkup(createElement(ExportMenu, { ...common, painted: true, pick: noop, open3mf: noop, openGlb: noop, project: noop }));
  assert.match(html, /Geometry only: the figure(&#x27;|')s colours are lost\. Use 3MF for them/);
});
