// The shop owner's production page: the order's photo and its `_litho` settings → the print-ready
// lithophane at full resolution, as STL and 3MF, with the print settings Jig recommends for it
// (lithoPrint). It embeds the same <litho-preview> the customer used, so the framing can be checked
// (and adjusted) before the files are made.
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import { lithophaneMesh, lithoPrint, resolveLithoOptions, type LithoResolved } from '../../shared/lithophane';
import { binaryStl } from '../../shared/stl';
import './element';
import type { LithoPreviewElement } from './element';
import { decodeOrder, type OrderSettings } from './order';
import { cropImage } from './photo';

/** A finished lithophane: its triangles and how to print it. */
interface Built {
  positions: Float32Array;
  indices: Uint32Array;
  r: LithoResolved;
  size: [number, number, number];
  /** The order it was built from, to tell when the framing changes. */
  from: string;
}

/** The order's lithophane at grid spacing `resolution` mm, from the widget's photo and framing. */
function build(el: LithoPreviewElement, resolution: number): Built | null {
  const order = el.order, photo = el.currentPhoto;
  if (!order || !photo) return null;
  const r = resolveLithoOptions({ ...order.litho, resolution }, 'high');
  const c = order.crop;
  const rect = { x: c.x * photo.width, y: c.y * photo.height, w: c.w * photo.width, h: c.h * photo.height };
  // Two photo pixels per grid cell: Jig's sampler averages them, so nothing is lost.
  const longMm = Math.max(r.width, (r.width * rect.h) / rect.w);
  const image = cropImage(photo, rect, Math.min(6000, Math.ceil((2 * longMm) / resolution)));
  const mesh = lithophaneMesh(image, r);
  const V = mesh.vertProperties, n = V.length / 4;
  const positions = new Float32Array(n * 3);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = V[i * 4 + k];
      positions[i * 3 + k] = v;
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  return { positions, indices: mesh.triVerts, r, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], from: JSON.stringify(order) };
}

const num = (v: number) => (Math.abs(v) < 1e-9 ? '0' : String(+v.toFixed(4)));
// Control characters other than tab, LF and CR are not allowed in XML at all (not even escaped):
// they are dropped, or slicers refuse the whole file.
const esc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/**
 * A plain 3MF (core spec, millimetres) with one object, as Bambu Studio, PrusaSlicer and Cura read
 * it. Written in chunks through a streaming zip: a full-resolution lithophane is tens of MB of XML.
 */
function to3mf(b: Built, title: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const parts: Uint8Array[] = [];
    const zip = new Zip((err, chunk, final) => {
      if (err) return reject(err);
      parts.push(chunk);
      if (final) resolve(new Blob(parts as BlobPart[], { type: 'model/3mf' }));
    });
    const file = (name: string, text: string) => { const f = new ZipDeflate(name, { level: 6 }); zip.add(f); f.push(strToU8(text), true); };
    file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
    file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
    const model = new ZipDeflate('3D/3dmodel.model', { level: 6 });
    zip.add(model);
    model.push(strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${esc(title)}</metadata>
<resources><object id="1" name="${esc(title)}" type="model"><mesh><vertices>`));
    const P = b.positions, I = b.indices, CHUNK = 20000;
    for (let i = 0; i < P.length / 3; i += CHUNK) {
      let s = '';
      for (let k = i; k < Math.min(P.length / 3, i + CHUNK); k++) s += `<vertex x="${num(P[k * 3])}" y="${num(P[k * 3 + 1])}" z="${num(P[k * 3 + 2])}"/>`;
      model.push(strToU8(s));
    }
    model.push(strToU8('</vertices><triangles>'));
    for (let i = 0; i < I.length / 3; i += CHUNK) {
      let s = '';
      for (let k = i; k < Math.min(I.length / 3, i + CHUNK); k++) s += `<triangle v1="${I[k * 3]}" v2="${I[k * 3 + 1]}" v3="${I[k * 3 + 2]}"/>`;
      model.push(strToU8(s));
    }
    model.push(strToU8('</triangles></mesh></object></resources>\n<build><item objectid="1"/></build>\n</model>'), true);
    zip.end();
  });
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const widget = $<LithoPreviewElement>('litho-preview');
const settingsBox = $<HTMLTextAreaElement>('#settings');
const status = $('#status');
let order: OrderSettings | null = null;
let built: Built | null = null;

const say = (msg: string, error = false) => { status.textContent = msg; status.classList.toggle('error', error); };
const name = () => {
  const o = widget.order, id = $<HTMLInputElement>('#order-id').value.trim().replace(/[^\w-]+/g, '-');
  const what = o ? `${o.shape}-${o.mm.map((v) => Math.round(v / 10)).join('x')}cm` : 'litho';
  return `${id ? `${id}-` : ''}lithophane-${what}`;
};

settingsBox.addEventListener('input', () => {
  const text = settingsBox.value.trim();
  order = text ? decodeOrder(text) : null;
  if (text && !order) return say('These settings could not be read: paste the `_litho` value from the order (it starts with {"v":1).', true);
  if (order) { widget.applyOrder(order); say(widget.currentPhoto ? 'Order settings applied.' : 'Settings read: now load the order\'s photo.'); }
  built = null;
  renderBuilt();
});

$<HTMLInputElement>('#photo').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (order) widget.applyOrder(order);
  await widget.loadFile(f);
  built = null;
  renderBuilt();
  say(order ? 'Photo loaded with the order\'s framing.' : 'Photo loaded. Paste the order\'s settings, or frame it here for a manual order.');
});

// Changed framing or size in the widget: the files must be built again.
widget.addEventListener('litho-change', () => {
  if (built && built.from !== JSON.stringify(widget.order)) { built = null; renderBuilt(); }
});

$('#build').addEventListener('click', () => {
  if (!widget.order) return say('Load the photo first.', true);
  say('Building the full-resolution lithophane…');
  // Let the message paint before the main thread is busy for a second or two.
  setTimeout(() => {
    const t0 = performance.now();
    try { built = build(widget, Number($<HTMLSelectElement>('#resolution').value)); } catch (err) { return say(`Build failed: ${(err as Error).message}`, true); }
    renderBuilt();
    say(`Built in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
  }, 30);
});

$('#stl').addEventListener('click', () => {
  if (!built) return;
  download(new Blob([binaryStl([built], name())], { type: 'model/stl' }), `${name()}.stl`);
});
$('#threemf').addEventListener('click', async () => {
  if (!built) return;
  say('Writing the 3MF…');
  download(await to3mf(built, name()), `${name()}.3mf`);
  say('3MF written.');
});

function renderBuilt() {
  for (const id of ['#stl', '#threemf']) $<HTMLButtonElement>(id).disabled = !built;
  const out = $('#result');
  if (!built) { out.hidden = true; return; }
  out.hidden = false;
  const { print, note } = lithoPrint(built.r);
  const r = built.r;
  const rows: [string, string][] = [
    ['Shape', r.shape + (r.shape === 'curved' ? ` (${r.angle}°)` : '')],
    ['Size (X × Y × Z)', built.size.map((v) => `${v.toFixed(1)}`).join(' × ') + ' mm'],
    ['Picture width', `${r.width.toFixed(1)} mm${r.shape === 'cylinder' ? ' (around)' : ''}`],
    ['Thickness', `${r.minThickness}–${r.maxThickness} mm, frame ${r.border} mm${r.stand ? `, foot ${r.stand} mm` : ''}`],
    ['Brightness (gamma)', String(r.gamma)],
    ['Triangles', (built.indices.length / 3).toLocaleString('en-GB')],
    ['Layer height', `${print.layerHeight} mm`],
    ['Infill', `${print.infill} % ${print.infillPattern}`],
    ['Walls', String(print.walls)],
    ['Brim', print.brim === 'auto' ? 'auto' : `${print.brim} mm`],
    ...(print.seam ? [['Seam', print.seam] as [string, string]] : []),
    ['Filament', 'White PLA'],
  ];
  $('#facts').innerHTML = rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  $('#note').textContent = note;
}
renderBuilt();
