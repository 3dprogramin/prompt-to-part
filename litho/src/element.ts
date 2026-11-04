// <litho-preview>: the customer-facing lithophane preview. A photo goes in (file, drop or camera),
// the customer frames it, picks a shape and size, and sees it lit from behind and as a 3D object,
// all in the browser with prompt-to-part's lithophane code (shared/lithophane.ts). On a Shopify product page
// it fills the product form, so the choices and the photo travel with the order (shopify.ts).
//
// Attributes: lang ("ro" default, "en"), config (JSON, see config.ts), variants (Liquid's
// `{{ product.variants | json }}`), form (the product form's id). config and variants may also be
// given as child <script type="application/json"> elements (variants with data-variants).
// Events: `litho-change` (detail: { order, price, variant, ready }), bubbling out of the shadow DOM.
import { lithophaneMesh, resolveLithoOptions, type LithophaneShape } from '../../shared/lithophane';
import { layerToneLuma, type LayerToneImage } from '../../shared/layertone';
import {
  DEFAULT_CONFIG, findVariant, formatPrice, parseConfig, parseVariants, shapesOf, sizeGeometry, sizeLabel, sizePrice,
  type LithoConfig, type Orientation, type ShopVariant, type SizeGeometry, type SizePreset,
} from './config';
import { CENTRED, clampCrop, cropFromRect, cropRect, MAX_ZOOM, normaliseRect, panCrop, zoomCrop, type Crop } from './crop';
import { pickLang, t, type Lang, type StringKey } from './i18n';
import { flatPreview } from './lit';
import { encodeOrder, ORDER_PROPERTY, type OrderSettings } from './order';
import { cropImage, loadPhoto, photoFile, putPixels, type Photo } from './photo';
import { FormBridge, findProductForm } from './shopify';
import { STYLES } from './styles';
import { photoStats, photoTips } from './tips';
import { LithoView } from './view3d';

type Tab = 'frame' | 'lit' | '3d';

/** Longest side of the preview picture, pixels (the lit view and the 3D mesh's source). */
const PREVIEW_PX = 480;
/** Grid cells along the 3D preview's longer side: a light mesh that rebuilds in a few milliseconds on a phone. */
const PREVIEW_CELLS = 170;
/** White PLA, for the frame drawn around the photo while framing. */
const PLA = '#f1ede5';

const svg = (body: string, box = '0 0 24 24') => `<svg viewBox="${box}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  photo: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  bulb: svg('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>'),
  warn: svg('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>'),
  ok: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'),
  flat: svg('<rect x="8" y="3" width="18" height="18" rx="1.5"/>', '0 0 34 24'),
  curved: svg('<path d="M5 5q12 6 24 0v15q-12 6-24 0z"/>', '0 0 34 24'),
  cylinder: svg('<ellipse cx="17" cy="5" rx="8" ry="2.5"/><path d="M9 5v14c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5"/>', '0 0 34 24'),
};

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!);

export class LithoPreviewElement extends HTMLElement {
  static observedAttributes = ['lang', 'config', 'variants', 'form', 'theme'];

  private locale: Lang = 'ro';
  private cfg: LithoConfig = DEFAULT_CONFIG;
  private variants: ShopVariant[] = [];
  private photo: Photo | null = null;
  private shape: LithophaneShape = 'flat';
  private sizeId = '';
  private orient: Orientation = 'landscape';
  private crop: Crop = CENTRED;
  /** The brightness slider: −0.5 (darker) … 0.5 (lighter); gamma = 1 − tone. */
  private tone = 0;
  private lightsOn = true;
  private tab: Tab = 'frame';
  /** The framed picture at preview size, and what needs redrawing from it. */
  private preview: LayerToneImage | null = null;
  private dirty = { image: true, lit: true, mesh: true };
  private view3d: LithoView | null = null;
  private no3d = false;
  private bridge: FormBridge | null = null;
  private blockedNote = false;
  private pendingOrder: OrderSettings | null = null;
  private picBox = { x: 0, y: 0, w: 1, h: 1 };
  private updateTimer = 0;
  private syncTimer = 0;
  private started = false;
  private resizeObs: ResizeObserver | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    // Inside the page's HTML the element's children (config scripts) may not be parsed yet.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => this.start(), { once: true });
    else this.start();
  }

  disconnectedCallback() {
    this.bridge?.dispose();
    this.bridge = null;
    this.view3d?.dispose();
    this.view3d = null;
    this.resizeObs?.disconnect();
    this.started = false;
  }

  attributeChangedCallback(name: string) {
    // The theme is CSS, apart from the framing canvas's backdrop: a redraw, not a fresh start.
    if (name === 'theme') this.drawFrame();
    else if (this.started) this.start();
  }

  // -------------------------------------------------------------------------
  // Public API (also used by the production page)
  // -------------------------------------------------------------------------

  /** Loads a photo file (as if the customer chose it). */
  async loadFile(file: Blob) {
    const status = this.q('.status');
    status.textContent = t(this.locale, 'loading');
    status.classList.remove('error');
    try {
      this.photo = await loadPhoto(file, this.cfg.photoMaxSide);
    } catch {
      status.textContent = t(this.locale, 'badFile');
      status.classList.add('error');
      return;
    }
    status.textContent = '';
    this.crop = CENTRED;
    this.tab = 'frame';
    if (this.pendingOrder) this.applyOrder(this.pendingOrder);
    this.blockedNote = false;
    this.render();
    this.invalidate();
    const photo = this.photo;
    if (this.bridge) photoFile(photo).then((f) => { if (this.photo === photo) { this.bridge?.setPhoto(t(this.locale, 'propPhoto'), f); this.emit(); } }).catch(() => {});
  }

  /** The current choices as they go with the order; null until there is a photo. */
  get order(): OrderSettings | null {
    if (!this.photo) return null;
    const size = this.size(), g = this.geometry();
    const rect = cropRect(this.photo.width, this.photo.height, g.picture[0] / g.picture[1], this.crop);
    return {
      v: 1, size: size.id, label: sizeLabel(size, this.locale), shape: size.shape, orient: this.orient, mm: g.outer,
      crop: normaliseRect(rect, this.photo.width, this.photo.height), litho: g.options,
    };
  }

  /** The photo the widget works from (the order's attached file is this, as a JPEG). */
  get currentPhoto(): Photo | null { return this.photo; }

  /** Sets the widget to a saved order's choices (now, or once a photo is loaded). */
  applyOrder(o: OrderSettings) {
    if (!this.photo) { this.pendingOrder = o; return; }
    this.pendingOrder = null;
    const L = o.litho;
    // The order's thicknesses and frame win over the page's configuration.
    this.cfg = { ...this.cfg, minThickness: L.minThickness ?? this.cfg.minThickness, maxThickness: L.maxThickness ?? this.cfg.maxThickness, border: L.border ?? this.cfg.border };
    const known = this.cfg.sizes.find((s) => s.id === o.size && s.shape === o.shape);
    const cyl = o.shape === 'cylinder';
    const size: SizePreset = {
      ...(known ?? { id: o.size || 'order', label: o.label || undefined }),
      shape: o.shape,
      width: cyl ? o.mm[0] : Math.max(...o.mm), height: cyl ? o.mm[1] : Math.min(...o.mm),
      ...(o.shape === 'curved' && L.angle ? { angle: L.angle } : {}),
      ...(o.shape === 'flat' ? { stand: Number(L.stand ?? 0) } : {}),
    };
    this.cfg.sizes = known ? this.cfg.sizes.map((s) => (s === known ? size : s)) : [...this.cfg.sizes, size];
    this.shape = o.shape;
    this.sizeId = size.id;
    this.orient = o.orient;
    this.tone = Math.max(-0.5, Math.min(0.5, 1 - (L.gamma ?? 1)));
    const g = this.geometry();
    this.crop = cropFromRect(o.crop, this.photo.width, this.photo.height, g.picture[0] / g.picture[1]);
    if (this.started) { this.render(); this.invalidate(); }
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private start() {
    this.locale = pickLang(this.getAttribute('lang'));
    const json = (sel: string) => this.querySelector<HTMLScriptElement>(sel)?.textContent ?? null;
    this.cfg = parseConfig(this.getAttribute('config') ?? json('script[type="application/json"]:not([data-variants])'));
    this.variants = parseVariants(this.getAttribute('variants') ?? json('script[type="application/json"][data-variants]'));
    const shapes = shapesOf(this.cfg);
    if (!shapes.includes(this.shape)) this.shape = shapes[0];
    if (!this.cfg.sizes.some((s) => s.id === this.sizeId && s.shape === this.shape)) this.sizeId = this.cfg.sizes.find((s) => s.shape === this.shape)!.id;

    this.bridge?.dispose();
    this.bridge = null;
    const form = findProductForm(this, this.getAttribute('form'));
    if (form) this.bridge = new FormBridge(form, () => this.blocked());

    this.view3d?.dispose();
    this.view3d = null;
    this.build();
    this.started = true;
    this.render();
    if (this.photo) {
      this.invalidate();
      const photo = this.photo;
      if (this.bridge) photoFile(photo).then((f) => { if (this.photo === photo) this.bridge?.setPhoto(t(this.locale, 'propPhoto'), f); }).catch(() => {});
    }
  }

  private q<T extends Element = HTMLElement>(sel: string): T {
    return this.shadowRoot!.querySelector(sel) as T;
  }

  /** The shadow DOM's skeleton, in the current language, with its event handlers. */
  private build() {
    const L = (k: StringKey) => esc(t(this.locale, k));
    this.shadowRoot!.innerHTML = `<style>${STYLES}</style>
<div class="root" part="root">
  <section class="upload">
    <div class="drop">
      ${ICONS.photo}
      <h3>${L('uploadTitle')}</h3>
      <p>${L('uploadHint')}</p>
      <div class="row">
        <button type="button" class="btn primary pick">${ICONS.photo}${L('choosePhoto')}</button>
        <button type="button" class="btn camera">${ICONS.camera}${L('takePhoto')}</button>
      </div>
      <p class="privacy">${ICONS.lock}<span>${L('privacy')}</span></p>
    </div>
  </section>
  <p class="status" role="status" aria-live="polite"></p>
  <section class="work" hidden>
    <div class="stage-col">
      <div class="seg tabs" role="tablist">
        <button type="button" role="tab" data-tab="frame">${L('tabFrame')}</button>
        <button type="button" role="tab" data-tab="lit">${L('tabLit')}</button>
        <button type="button" role="tab" data-tab="3d">${L('tab3d')}</button>
      </div>
      <div class="stage">
        <div class="pane frame"><canvas aria-label="${L('frameHint')}"></canvas></div>
        <div class="pane lit"><canvas></canvas><span class="badge unrolled">${L('unrolled')}</span></div>
        <div class="pane three"></div>
        <button type="button" class="lights">${ICONS.bulb}<span></span></button>
      </div>
      <p class="hint"></p>
      <div class="frame-tools">
        <label class="zoomrow">${L('zoom')}<input type="range" class="zoom" min="1" max="${MAX_ZOOM}" step="0.01" value="1"></label>
        <button type="button" class="btn primary next">${L('seePreview')} →</button>
      </div>
    </div>
    <div class="controls">
      <fieldset><legend>${L('shape')}</legend><div class="chips shapes"></div></fieldset>
      <fieldset><legend>${L('size')}</legend><div class="chips sizes"></div></fieldset>
      <fieldset class="orient"><legend>${L('orientation')}</legend>
        <div class="seg"><button type="button" data-orient="landscape">${L('landscape')}</button><button type="button" data-orient="portrait">${L('portrait')}</button></div>
      </fieldset>
      <fieldset><legend>${L('tones')}</legend>
        <div class="tones"><input type="range" class="tone" min="-0.5" max="0.5" step="0.05" aria-label="${L('tones')}"></div>
        <p class="sub">${L('tonesHint')}</p>
      </fieldset>
      <ul class="tips" aria-live="polite"></ul>
      <div class="summary">
        <div><div class="what"></div><div class="price"></div></div>
        <button type="button" class="link again">${L('newPhoto')}</button>
      </div>
      <p class="note form-note" aria-live="polite"></p>
    </div>
  </section>
  <input type="file" class="file" accept="image/*" hidden>
  <input type="file" class="file-cam" accept="image/*" capture="environment" hidden>
</div>`;

    const file = this.q<HTMLInputElement>('.file'), cam = this.q<HTMLInputElement>('.file-cam');
    const onFile = (input: HTMLInputElement) => () => { const f = input.files?.[0]; input.value = ''; if (f) void this.loadFile(f); };
    file.addEventListener('change', onFile(file));
    cam.addEventListener('change', onFile(cam));
    this.q('.pick').addEventListener('click', () => file.click());
    this.q('.camera').addEventListener('click', () => cam.click());
    this.q('.again').addEventListener('click', () => file.click());

    // A photo dropped on the upload area or, later, on the stage.
    const drop = this.q('.drop');
    for (const el of [drop, this.q('.stage')]) {
      el.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      el.addEventListener('dragleave', () => drop.classList.remove('over'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        const f = [...((e as DragEvent).dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
        if (f) void this.loadFile(f);
      });
    }

    this.q('.tabs').addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab as Tab | undefined;
      if (tab) this.setTab(tab);
    });
    this.q('.next').addEventListener('click', () => this.setTab('lit'));
    this.q('.lights').addEventListener('click', () => {
      this.lightsOn = !this.lightsOn;
      this.dirty.lit = true;
      this.view3d?.setLights(this.lightsOn);
      this.render();
      this.schedule(0);
    });
    this.q('.shapes').addEventListener('click', (e) => {
      const shape = (e.target as HTMLElement).closest<HTMLElement>('[data-shape]')?.dataset.shape as LithophaneShape | undefined;
      if (!shape || shape === this.shape) return;
      this.shape = shape;
      this.sizeId = this.cfg.sizes.find((s) => s.shape === shape)!.id;
      this.reframe();
    });
    this.q('.sizes').addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-size]')?.dataset.size;
      if (!id || id === this.sizeId) return;
      this.sizeId = id;
      this.reframe();
    });
    this.q('.orient').addEventListener('click', (e) => {
      const o = (e.target as HTMLElement).closest<HTMLElement>('[data-orient]')?.dataset.orient as Orientation | undefined;
      if (!o || o === this.orient) return;
      this.orient = o;
      this.reframe();
    });
    const zoom = this.q<HTMLInputElement>('.zoom');
    zoom.addEventListener('input', () => this.setCrop({ ...this.crop, zoom: Number(zoom.value) }));
    const tone = this.q<HTMLInputElement>('.tone');
    tone.addEventListener('input', () => {
      this.tone = Number(tone.value);
      this.dirty.lit = this.dirty.mesh = true;
      this.schedule(60);
    });
    this.framePointers(this.q<HTMLCanvasElement>('.frame canvas'));

    this.resizeObs?.disconnect();
    this.resizeObs = new ResizeObserver(() => { this.drawFrame(); this.fitLit(); });
    this.resizeObs.observe(this.q('.stage'));
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private size(): SizePreset {
    return this.cfg.sizes.find((s) => s.id === this.sizeId && s.shape === this.shape) ?? this.cfg.sizes.find((s) => s.shape === this.shape) ?? this.cfg.sizes[0];
  }

  private geometry(): SizeGeometry {
    return sizeGeometry(this.size(), this.orient, this.cfg, 1 - this.tone);
  }

  private aspect(): number {
    const g = this.geometry();
    return g.picture[0] / g.picture[1];
  }

  /** A new shape, size or orientation: the same part of the photo, as near as the new proportions allow. */
  private reframe() {
    if (this.photo) this.crop = clampCrop(this.photo.width, this.photo.height, this.aspect(), this.crop);
    this.render();
    this.invalidate();
  }

  private setCrop(c: Crop, delay = 120) {
    if (!this.photo) return;
    this.crop = clampCrop(this.photo.width, this.photo.height, this.aspect(), c);
    this.q<HTMLInputElement>('.zoom').value = String(this.crop.zoom);
    this.dirty.image = this.dirty.lit = this.dirty.mesh = true;
    this.drawFrame();
    this.schedule(delay);
  }

  private setTab(tab: Tab) {
    if (!this.photo) return;
    this.tab = tab;
    this.render();
    if (tab === 'frame') this.drawFrame();
    this.schedule(0);
  }

  /** Everything derived from the photo is out of date. */
  private invalidate() {
    this.dirty = { image: true, lit: true, mesh: true };
    this.drawFrame();
    this.schedule(0);
  }

  /** Brings the previews up to date after `delay` ms (restarted by every change, so a drag updates once at its end). */
  private schedule(delay: number) {
    clearTimeout(this.updateTimer);
    this.updateTimer = window.setTimeout(() => requestAnimationFrame(() => this.update()), delay);
  }

  private update() {
    const photo = this.photo;
    if (!photo) return;
    const g = this.geometry();
    if (this.dirty.image) {
      const rect = cropRect(photo.width, photo.height, g.picture[0] / g.picture[1], this.crop);
      this.preview = cropImage(photo, rect, PREVIEW_PX);
      this.dirty.image = false;
      this.dirty.lit = this.dirty.mesh = true;
      // Pixels the order's photo has across the crop, in the original's resolution when it was downscaled.
      const long = Math.max(rect.w, rect.h) * (photo.originalLong / Math.max(photo.width, photo.height));
      this.renderTips(photoTips(photoStats(layerToneLuma(this.preview)), long, Math.max(...g.picture)));
    }
    const image = this.preview!;
    if (this.tab === 'lit' && this.dirty.lit) {
      putPixels(this.q<HTMLCanvasElement>('.lit canvas'), flatPreview(image, g.options, this.lightsOn));
      this.dirty.lit = false;
      this.fitLit();
    }
    if (this.tab === '3d' && this.dirty.mesh && !this.no3d) {
      if (!this.view3d) {
        try { this.view3d = new LithoView(this.q('.three')); this.view3d.setLights(this.lightsOn); }
        catch { this.no3d = true; this.q('.three').innerHTML = `<p class="note" style="color:#fff;padding:20px;text-align:center">${esc(t(this.locale, 'no3d'))}</p>`; }
      }
      if (this.view3d) {
        const r = resolveLithoOptions({ ...g.options, resolution: Math.max(0.3, Math.max(...g.picture) / PREVIEW_CELLS) });
        this.view3d.setMesh(lithophaneMesh(image, r), r);
        this.view3d.resize();
      }
      this.dirty.mesh = false;
    }
    this.syncSoon();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /** Shows the state: which section, tab, chips and labels. Cheap; the canvases are drawn elsewhere. */
  private render() {
    if (!this.started) return;
    const L = (k: StringKey, v?: Record<string, string | number>) => t(this.locale, k, v);
    const has = !!this.photo;
    this.q('.upload').hidden = has;
    this.q('.work').hidden = !has;
    if (!has) return;
    const size = this.size();
    const cyl = size.shape === 'cylinder';

    for (const b of this.shadowRoot!.querySelectorAll<HTMLElement>('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === this.tab));
    this.q('.frame').hidden = this.tab !== 'frame';
    this.q('.lit').hidden = this.tab !== 'lit';
    this.q('.three').hidden = this.tab !== '3d';
    this.q('.frame-tools').hidden = this.tab !== 'frame';
    this.q('.unrolled').hidden = !cyl;
    const lights = this.q('.lights');
    lights.hidden = this.tab === 'frame';
    lights.setAttribute('aria-pressed', String(this.lightsOn));
    lights.querySelector('span')!.textContent = L(this.lightsOn ? 'lightsOn' : 'lightsOff');
    const stage = this.q('.stage');
    stage.classList.toggle('dark', this.tab !== 'frame' && this.lightsOn);
    stage.classList.toggle('day', this.tab !== 'frame' && !this.lightsOn);
    this.q('.hint').textContent = this.tab === 'frame' ? L(cyl ? 'wrapHint' : 'frameHint') : this.tab === 'lit' ? L(this.lightsOn ? 'litHint' : 'unlitHint') : L('view3dHint');

    const shapes = shapesOf(this.cfg);
    this.q('.shapes').innerHTML = shapes.map((s) => `<button type="button" class="chip" data-shape="${s}" aria-pressed="${s === this.shape}">${ICONS[s]}<b>${esc(L(`shape_${s}`))}</b></button>`).join('');
    this.q('.shapes').closest('fieldset')!.hidden = shapes.length < 2;
    this.q('.sizes').innerHTML = this.cfg.sizes.filter((s) => s.shape === this.shape).map((s) => {
      const p = sizePrice(s, this.variants);
      return `<button type="button" class="chip" data-size="${esc(s.id)}" aria-pressed="${s.id === size.id}"><b>${esc(sizeLabel(s, this.locale))}</b>${p != null ? `<small>${esc(formatPrice(p, this.locale, this.cfg.currency))}</small>` : ''}</button>`;
    }).join('');
    this.q('.orient').hidden = cyl;
    for (const b of this.shadowRoot!.querySelectorAll<HTMLElement>('[data-orient]')) b.setAttribute('aria-pressed', String(b.dataset.orient === this.orient));
    this.q<HTMLInputElement>('.tone').value = String(this.tone);
    this.q<HTMLInputElement>('.zoom').value = String(this.crop.zoom);

    const price = sizePrice(size, this.variants);
    this.q('.what').textContent = `${L(`shape_${size.shape}`)} · ${sizeLabel(size, this.locale)}${cyl ? '' : ` · ${L(this.orient)}`}`;
    this.q('.price').textContent = price != null ? formatPrice(price, this.locale, this.cfg.currency) : '';
    const note = this.q('.form-note');
    note.textContent = this.blockedNote ? L('needPhoto') : this.bridge?.hasPhoto ? L('ready') : '';
    note.classList.toggle('warn', this.blockedNote);
  }

  private renderTips(tips: StringKey[]) {
    const items = tips.length ? tips.map((k) => `<li>${ICONS.warn}<span>${esc(t(this.locale, k))}</span></li>`) : [`<li class="good">${ICONS.ok}<span>${esc(t(this.locale, 'tipGood'))}</span></li>`];
    this.q('.tips').innerHTML = items.join('');
  }

  /**
   * The framing editor: the whole photo dimmed, the piece's outline over it (its frame in white
   * PLA), and the part that becomes the picture in grey, as the lithophane shows it.
   */
  private drawFrame() {
    const photo = this.photo, canvas = this.q<HTMLCanvasElement>('.frame canvas');
    if (!photo || !canvas || this.tab !== 'frame') return;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const g = this.geometry(), B = g.options.border ?? 0, cyl = g.options.shape === 'cylinder';
    // The piece flat (a lamp unrolled): the picture plus its frame, in mm.
    const ow = g.picture[0] + (cyl ? 0 : 2 * B), oh = g.picture[1] + 2 * B;
    const pad = 22, s = Math.min((cw - 2 * pad) / ow, (ch - 2 * pad) / oh);
    const ox = (cw - ow * s) / 2, oy = (ch - oh * s) / 2;
    const pic = { x: ox + (cyl ? 0 : B * s), y: oy + B * s, w: g.picture[0] * s, h: g.picture[1] * s };
    this.picBox = pic;
    const rect = cropRect(photo.width, photo.height, pic.w / pic.h, this.crop);
    const k = pic.w / rect.w;

    // The stage colour of the light or dark theme (styles.ts).
    ctx.fillStyle = getComputedStyle(this).getPropertyValue('--stage').trim() || '#ece8e1';
    ctx.fillRect(0, 0, cw, ch);
    // The rest of the photo, dimmed, for context while dragging.
    ctx.globalAlpha = 0.3;
    ctx.drawImage(photo.canvas, pic.x - rect.x * k, pic.y - rect.y * k, photo.width * k, photo.height * k);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PLA;
    ctx.shadowColor = 'rgb(40 30 20 / .25)';
    ctx.shadowBlur = 14;
    ctx.fillRect(ox, oy, ow * s, oh * s);
    ctx.shadowBlur = 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pic.x, pic.y, pic.w, pic.h);
    ctx.clip();
    // A lithophane is one colour: show the picture in grey (where the browser can).
    ctx.filter = 'grayscale(1)';
    ctx.drawImage(photo.canvas, rect.x, rect.y, rect.w, rect.h, pic.x, pic.y, pic.w, pic.h);
    ctx.filter = 'none';
    ctx.restore();
    ctx.strokeStyle = 'rgb(0 0 0 / .25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, ow * s - 1, oh * s - 1);
    if (cyl) {
      // The lamp's seam: the picture's left and right edges meet there.
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = 'rgb(180 83 26 / .9)';
      ctx.lineWidth = 2;
      for (const x of [pic.x, pic.x + pic.w]) { ctx.beginPath(); ctx.moveTo(x, oy - 8); ctx.lineTo(x, oy + oh * s + 8); ctx.stroke(); }
      ctx.setLineDash([]);
    }
  }

  /** Sizes the lit picture to fit the stage (canvas pixels are the preview's; CSS scales them). */
  private fitLit() {
    const canvas = this.q<HTMLCanvasElement>('.lit canvas'), stage = this.q('.stage');
    if (!canvas?.width || !stage) return;
    const aw = stage.clientWidth - 40, ah = stage.clientHeight - 64;
    const s = Math.min(aw / canvas.width, ah / canvas.height);
    canvas.style.width = `${Math.max(1, canvas.width * s)}px`;
    canvas.style.height = `${Math.max(1, canvas.height * s)}px`;
  }

  /** Drag to pan, pinch or wheel to zoom, on the framing canvas. */
  private framePointers(canvas: HTMLCanvasElement) {
    const pts = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; mx: number; my: number } | null = null;
    const local = (e: PointerEvent | WheelEvent) => { const b = canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
    const pair = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };
    const frac = (x: number, y: number) => [(x - this.picBox.x) / this.picBox.w, (y - this.picBox.y) / this.picBox.h].map((v) => Math.min(1, Math.max(0, v))) as [number, number];
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, local(e));
      pinch = pts.size === 2 ? pair() : null;
    });
    canvas.addEventListener('pointermove', (e) => {
      const prev = pts.get(e.pointerId);
      if (!prev || !this.photo) return;
      const p = local(e);
      pts.set(e.pointerId, p);
      const A = this.aspect(), W = this.photo.width, H = this.photo.height;
      if (pts.size === 1) {
        this.setCrop(panCrop(W, H, A, this.crop, p.x - prev.x, p.y - prev.y, this.picBox.w));
      } else if (pts.size === 2 && pinch) {
        const now = pair();
        let c = panCrop(W, H, A, this.crop, now.mx - pinch.mx, now.my - pinch.my, this.picBox.w);
        const [fx, fy] = frac(now.mx, now.my);
        c = zoomCrop(W, H, A, c, now.d / Math.max(1, pinch.d), fx, fy);
        pinch = now;
        this.setCrop(c);
      }
    });
    const end = (e: PointerEvent) => { pts.delete(e.pointerId); pinch = pts.size === 2 ? pair() : null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      if (!this.photo) return;
      e.preventDefault();
      const p = local(e), [fx, fy] = frac(p.x, p.y);
      this.setCrop(zoomCrop(this.photo.width, this.photo.height, this.aspect(), this.crop, Math.exp(-e.deltaY * 0.0015), fx, fy));
    }, { passive: false });
  }

  // -------------------------------------------------------------------------
  // The product form and the host page
  // -------------------------------------------------------------------------

  private syncSoon() {
    clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => { this.sync(); this.emit(); }, 150);
  }

  /** Writes the choices into the product form's line item properties and selects the size's variant. */
  private sync() {
    const order = this.order;
    if (!this.bridge || !order) return;
    const size = this.size(), cyl = size.shape === 'cylinder';
    this.bridge.setProperties({
      [t(this.locale, 'propShape')]: t(this.locale, `shape_${size.shape}`),
      [t(this.locale, 'propSize')]: `${sizeLabel(size, this.locale)}${cyl ? '' : ` (${t(this.locale, this.orient).toLowerCase()})`}`,
      [ORDER_PROPERTY]: encodeOrder(order),
    });
    this.bridge.setVariant(findVariant(size, this.variants)?.id);
    if (this.blockedNote && this.bridge.hasPhoto) { this.blockedNote = false; this.render(); }
  }

  private emit() {
    const size = this.size();
    this.dispatchEvent(new CustomEvent('litho-change', {
      bubbles: true, composed: true,
      detail: { order: this.order, price: sizePrice(size, this.variants), variant: findVariant(size, this.variants)?.id, ready: !!this.photo && (!this.bridge || this.bridge.hasPhoto) },
    }));
    this.render();
  }

  /** The customer pressed "add to cart" without a photo. */
  private blocked() {
    this.blockedNote = true;
    this.render();
    const status = this.q('.status');
    if (!this.photo) { status.textContent = t(this.locale, 'needPhoto'); status.classList.add('error'); }
    this.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

if (!customElements.get('litho-preview')) customElements.define('litho-preview', LithoPreviewElement);

declare global {
  interface HTMLElementTagNameMap { 'litho-preview': LithoPreviewElement }
}
