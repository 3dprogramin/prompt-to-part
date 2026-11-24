// The Export button: 3MF by default, the formats in order, 3MF and Export project set apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExportButton, ExportMenu, ThreeMfMenu, colourCount } from '../src/components/ExportButton';

const noop = () => undefined;
const common = { onExport: noop, blender: null, painted: false };

test('the Export button starts on 3MF', () => {
  const html = renderToStaticMarkup(createElement(ExportButton, {
    ...common, disabled: false, exporting: false, count: 1, colours: 1, flat: false, bambu: null, printChanges: 0, threeMf: { print: true, platePerColour: false },
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

const menu = (o: { colours: number; oneColour?: boolean; bambu?: string | null; platePerColour?: boolean }) => renderToStaticMarkup(createElement(ThreeMfMenu, {
  colours: o.colours, oneColour: !!o.oneColour, onOneColour: noop, painted: false, bambu: o.bambu === undefined ? '/usr/bin/bambu-studio' : o.bambu,
  printChanges: 0, threeMf: { print: true, platePerColour: !!o.platePerColour }, onThreeMf: noop, onExport: noop,
}));

test('3MF menu: "One plate per colour" only for a Bambu project of more than one colour', () => {
  assert.match(menu({ colours: 2 }), /One plate per colour/);
  assert.doesNotMatch(menu({ colours: 1 }), /One plate per colour/);
  assert.doesNotMatch(menu({ colours: 3, bambu: null }), /One plate per colour/);
});

test('3MF menu: "One plate per colour" is off and greyed in one filament', () => {
  const html = menu({ colours: 2, oneColour: true, platePerColour: true });
  const box = /<input type="checkbox" ([^>]*)\/>\s*<span><b>One plate per colour/.exec(html)!;
  assert.match(box[1], /disabled/);
  assert.doesNotMatch(box[1], /checked/);
  assert.match(menu({ colours: 2, platePerColour: true }), /<input type="checkbox" checked=""\/>\s*<span><b>One plate per colour/);
});

test('colourCount: part colours, LayerTone stacks and painted filaments, once each', () => {
  assert.equal(colourCount([{ color: '#FFFFFF' }, { color: '#ffffff' }]), 1);
  assert.equal(colourCount([{ color: '#ffffff', layerColors: [{ color: '#000000' }, { color: '#ffffff' }] }, { color: '#ff0000', paint: { filaments: [{ color: '#00ff00' }] } }]), 4);
});
